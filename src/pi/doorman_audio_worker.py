#!/usr/bin/env python3
"""Allowlisted MQTT audio worker for the Doorman Raspberry Pi."""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import paho.mqtt.client as mqtt


logging.basicConfig(
    level=os.getenv("DOORMAN_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(message)s",
)
LOGGER = logging.getLogger("doorman-audio")

MQTT_HOST = os.getenv("DOORMAN_MQTT_HOST", "10.0.0.96")
MQTT_PORT = int(os.getenv("DOORMAN_MQTT_PORT", "1883"))
MQTT_USERNAME = os.getenv("DOORMAN_MQTT_USERNAME", "")
MQTT_PASSWORD = os.getenv("DOORMAN_MQTT_PASSWORD", "")
COMMAND_TOPIC = os.getenv("DOORMAN_PI_COMMAND_TOPIC", "doorman/pi/commands")
STATUS_TOPIC = os.getenv("DOORMAN_PI_STATUS_TOPIC", "doorman/pi/status")
AUDIO_INPUT_PREFIX = os.getenv(
    "DOORMAN_PI_AUDIO_INPUT_PREFIX", "doorman/pi/audio/input"
)
AUDIO_OUTPUT_PREFIX = os.getenv(
    "DOORMAN_PI_AUDIO_OUTPUT_PREFIX", "doorman/pi/audio/output"
)
AUDIO_CONTROL_PREFIX = os.getenv(
    "DOORMAN_PI_AUDIO_CONTROL_PREFIX", "doorman/pi/audio/control"
)
AUDIO_DEVICE = os.getenv("DOORMAN_AUDIO_DEVICE", "pipewire")
MIC_DEVICE = os.getenv("DOORMAN_MIC_DEVICE", "plughw:CARD=Nano,DEV=0")
AUDIO_DIRECTORY = Path(
    os.getenv("DOORMAN_AUDIO_DIRECTORY", "/var/lib/doorman/audio")
)
PLAYBACK_TIMEOUT_SECONDS = int(
    os.getenv("DOORMAN_PLAYBACK_TIMEOUT_SECONDS", "30")
)
CONVERSATION_TIMEOUT_SECONDS = int(
    os.getenv("DOORMAN_CONVERSATION_TIMEOUT_SECONDS", "60")
)
CLIP_COOLDOWN_SECONDS = int(
    os.getenv("DOORMAN_CLIP_COOLDOWN_SECONDS", "60")
)
MAX_MESSAGE_BYTES = 16_384
PCM_CHUNK_BYTES = 3_200  # 100 ms of 16-bit, 16 kHz, mono PCM.
COMMAND_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")

ALLOWED_CLIPS = {
    "greeting": "greeting.wav",
    "thank_driver": "thank_driver.wav",
    "please_wait": "please_wait.wav",
    "no_soliciting": "no_soliciting.wav",
}

processed_command_ids: deque[str] = deque(maxlen=256)
last_clip_played_at: dict[str, float] = {}


class ActiveConversation:
    def __init__(self, session_id: str, timeout_seconds: int) -> None:
        self.session_id = session_id
        self.stop_event = threading.Event()
        self.speaker_active = threading.Event()
        self.deadline = time.monotonic() + timeout_seconds
        self.capture_process: subprocess.Popen[bytes] | None = None
        self.playback_process: subprocess.Popen[bytes] | None = None
        self.capture_thread: threading.Thread | None = None
        self.process_lock = threading.Lock()


conversation_lock = threading.Lock()
active_conversation: ActiveConversation | None = None


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def publish_status(
    client: mqtt.Client,
    command_id: str,
    state: str,
    *,
    clip_id: str | None = None,
    session_id: str | None = None,
    detail: str | None = None,
) -> None:
    payload: dict[str, Any] = {
        "schema_version": "1.0",
        "device_id": "doorkeeper-pi",
        "command_id": command_id,
        "state": state,
        "occurred_at": utc_now(),
    }
    if clip_id is not None:
        payload["clip_id"] = clip_id
    if session_id is not None:
        payload["session_id"] = session_id
    if detail is not None:
        payload["detail"] = detail[:300]

    result = client.publish(
        STATUS_TOPIC,
        json.dumps(payload, separators=(",", ":")),
        qos=1,
        retain=False,
    )
    if result.rc != mqtt.MQTT_ERR_SUCCESS:
        LOGGER.error(
            "Unable to publish %s status for %s: rc=%s",
            state,
            command_id,
            result.rc,
        )


def parse_expiration(value: Any) -> datetime:
    if not isinstance(value, str):
        raise ValueError("expires_at must be an ISO-8601 string")
    try:
        expiration = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("expires_at is invalid") from error
    if expiration.tzinfo is None:
        raise ValueError("expires_at must include a timezone")
    if expiration <= datetime.now(timezone.utc):
        raise ValueError("command has expired")
    return expiration


def parse_command(raw_payload: bytes) -> dict[str, Any]:
    if len(raw_payload) > MAX_MESSAGE_BYTES:
        raise ValueError("message exceeds size limit")
    try:
        payload = json.loads(raw_payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("message is not valid UTF-8 JSON") from error
    if not isinstance(payload, dict):
        raise ValueError("message must be a JSON object")

    command_id = payload.get("command_id")
    action = payload.get("action")
    if not isinstance(command_id, str) or not COMMAND_ID_PATTERN.fullmatch(command_id):
        raise ValueError("command_id is missing or invalid")
    parse_expiration(payload.get("expires_at"))

    if action == "play_cached_clip":
        clip_id = payload.get("clip_id")
        if clip_id not in ALLOWED_CLIPS:
            raise ValueError("clip_id is not allowed")
        return {
            "command_id": command_id,
            "action": action,
            "clip_id": clip_id,
        }

    if action in {"start_conversation", "stop_conversation"}:
        session_id = payload.get("session_id")
        if not isinstance(session_id, str) or not SESSION_ID_PATTERN.fullmatch(
            session_id
        ):
            raise ValueError("session_id is missing or invalid")
        return {
            "command_id": command_id,
            "action": action,
            "session_id": session_id,
        }

    raise ValueError("action is not allowed")


def play_clip(clip_id: str) -> None:
    now = time.monotonic()
    last_played = last_clip_played_at.get(clip_id, 0.0)
    if now - last_played < CLIP_COOLDOWN_SECONDS:
        LOGGER.info("Ignoring %s clip; cooldown active", clip_id)
        return

    audio_path = (AUDIO_DIRECTORY / ALLOWED_CLIPS[clip_id]).resolve()
    expected_parent = AUDIO_DIRECTORY.resolve()
    if audio_path.parent != expected_parent:
        raise RuntimeError("resolved audio path escaped the configured directory")
    if not audio_path.is_file():
        raise FileNotFoundError(f"cached clip is unavailable: {clip_id}")

    subprocess.run(
        ["/usr/bin/aplay", "-q", "-D", AUDIO_DEVICE, str(audio_path)],
        check=True,
        timeout=PLAYBACK_TIMEOUT_SECONDS,
        stdin=subprocess.DEVNULL,
    )
    last_clip_played_at[clip_id] = now


def terminate_process(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=2)


def close_stream_playback(conversation: ActiveConversation) -> None:
    with conversation.process_lock:
        process = conversation.playback_process
        conversation.playback_process = None
    if process is not None:
        try:
            if process.stdin is not None:
                process.stdin.close()
            process.wait(timeout=5)
        except (BrokenPipeError, subprocess.TimeoutExpired):
            terminate_process(process)
    conversation.speaker_active.clear()


def stop_conversation(session_id: str, *, join_thread: bool = True) -> bool:
    global active_conversation
    with conversation_lock:
        conversation = active_conversation
        if conversation is None or conversation.session_id != session_id:
            return False
        active_conversation = None

    conversation.stop_event.set()
    with conversation.process_lock:
        capture_process = conversation.capture_process
    terminate_process(capture_process)
    close_stream_playback(conversation)

    thread = conversation.capture_thread
    if (
        join_thread
        and thread is not None
        and thread is not threading.current_thread()
    ):
        thread.join(timeout=3)
    LOGGER.info("Stopped conversation %s", session_id)
    return True


def capture_microphone(
    client: mqtt.Client,
    conversation: ActiveConversation,
) -> None:
    destination = f"{AUDIO_INPUT_PREFIX}/{conversation.session_id}"
    process: subprocess.Popen[bytes] | None = None
    try:
        process = subprocess.Popen(
            [
                "/usr/bin/arecord",
                "-q",
                "-D",
                MIC_DEVICE,
                "-t",
                "raw",
                "-f",
                "S16_LE",
                "-r",
                "16000",
                "-c",
                "1",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        with conversation.process_lock:
            conversation.capture_process = process
        if process.stdout is None:
            raise RuntimeError("arecord did not expose an audio stream")

        LOGGER.info("Microphone opened for conversation %s", conversation.session_id)
        while (
            not conversation.stop_event.is_set()
            and time.monotonic() < conversation.deadline
        ):
            chunk = process.stdout.read(PCM_CHUNK_BYTES)
            if not chunk:
                if process.poll() is not None:
                    raise RuntimeError(
                        f"arecord exited with status {process.returncode}"
                    )
                continue
            if conversation.speaker_active.is_set():
                continue
            result = client.publish(destination, chunk, qos=0, retain=False)
            if result.rc != mqtt.MQTT_ERR_SUCCESS:
                raise RuntimeError(f"microphone publish failed with rc={result.rc}")

        if time.monotonic() >= conversation.deadline:
            publish_status(
                client,
                f"conversation:{conversation.session_id}",
                "expired",
                session_id=conversation.session_id,
            )
    except Exception as error:
        if not conversation.stop_event.is_set():
            LOGGER.warning(
                "Conversation %s microphone failed: %s",
                conversation.session_id,
                error,
            )
            publish_status(
                client,
                f"conversation:{conversation.session_id}",
                "failed",
                session_id=conversation.session_id,
                detail=str(error),
            )
    finally:
        terminate_process(process)
        with conversation.process_lock:
            conversation.capture_process = None
        if time.monotonic() >= conversation.deadline:
            stop_conversation(conversation.session_id, join_thread=False)


def start_conversation(
    client: mqtt.Client,
    command_id: str,
    session_id: str,
) -> None:
    global active_conversation
    with conversation_lock:
        existing = active_conversation
    if existing is not None:
        if existing.session_id == session_id:
            LOGGER.info("Conversation %s is already active", session_id)
            return
        stop_conversation(existing.session_id)

    conversation = ActiveConversation(session_id, CONVERSATION_TIMEOUT_SECONDS)
    thread = threading.Thread(
        target=capture_microphone,
        args=(client, conversation),
        name=f"doorman-mic-{session_id[:8]}",
        daemon=True,
    )
    conversation.capture_thread = thread
    with conversation_lock:
        active_conversation = conversation
    thread.start()
    publish_status(
        client,
        command_id,
        "listening",
        session_id=session_id,
    )
    LOGGER.info("Started conversation %s", session_id)


def handle_output_audio(session_id: str, payload: bytes) -> None:
    with conversation_lock:
        conversation = active_conversation
    if conversation is None or conversation.session_id != session_id:
        return
    if not payload:
        return

    conversation.speaker_active.set()
    with conversation.process_lock:
        process = conversation.playback_process
        if process is None or process.poll() is not None:
            process = subprocess.Popen(
                [
                    "/usr/bin/aplay",
                    "-q",
                    "-D",
                    AUDIO_DEVICE,
                    "-t",
                    "raw",
                    "-f",
                    "S16_LE",
                    "-r",
                    "24000",
                    "-c",
                    "1",
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            conversation.playback_process = process
        try:
            if process.stdin is None:
                raise RuntimeError("aplay did not expose an audio stream")
            process.stdin.write(payload)
            process.stdin.flush()
        except (BrokenPipeError, OSError) as error:
            conversation.playback_process = None
            raise RuntimeError("Gemini playback stream failed") from error


def handle_control(session_id: str, payload: bytes) -> None:
    try:
        message = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        LOGGER.warning("Ignoring invalid conversation control for %s", session_id)
        return
    if not isinstance(message, dict) or message.get("session_id") != session_id:
        return

    with conversation_lock:
        conversation = active_conversation
    if conversation is None or conversation.session_id != session_id:
        return

    state = message.get("state")
    if state == "speaking":
        conversation.speaker_active.set()
    elif state == "listening":
        close_stream_playback(conversation)
    elif state == "closed":
        stop_conversation(session_id)


def handle_command(client: mqtt.Client, raw_payload: bytes) -> None:
    command_id = "unknown"
    clip_id: str | None = None
    session_id: str | None = None
    try:
        command = parse_command(raw_payload)
        command_id = command["command_id"]
        clip_id = command.get("clip_id")
        session_id = command.get("session_id")
        if command_id in processed_command_ids:
            LOGGER.info("Ignoring duplicate command %s", command_id)
            publish_status(
                client,
                command_id,
                "duplicate",
                clip_id=clip_id,
                session_id=session_id,
            )
            return

        processed_command_ids.append(command_id)
        publish_status(
            client,
            command_id,
            "received",
            clip_id=clip_id,
            session_id=session_id,
        )

        if command["action"] == "play_cached_clip":
            publish_status(client, command_id, "started", clip_id=clip_id)
            LOGGER.info("Playing cached clip %s for command %s", clip_id, command_id)
            play_clip(clip_id)
            publish_status(client, command_id, "completed", clip_id=clip_id)
            LOGGER.info("Completed command %s", command_id)
        elif command["action"] == "start_conversation":
            start_conversation(client, command_id, session_id)
        else:
            stopped = stop_conversation(session_id)
            publish_status(
                client,
                command_id,
                "completed" if stopped else "not_active",
                session_id=session_id,
            )
    except (ValueError, FileNotFoundError, RuntimeError, subprocess.SubprocessError) as error:
        LOGGER.warning("Command %s failed: %s", command_id, error)
        publish_status(
            client,
            command_id,
            "failed",
            clip_id=clip_id,
            session_id=session_id,
            detail=str(error),
        )
    except Exception:
        LOGGER.exception("Unexpected failure while handling command %s", command_id)
        publish_status(
            client,
            command_id,
            "failed",
            clip_id=clip_id,
            session_id=session_id,
            detail="unexpected worker error",
        )


def on_connect(
    client: mqtt.Client,
    userdata: Any,
    flags: mqtt.ConnectFlags,
    reason_code: mqtt.ReasonCode,
    properties: mqtt.Properties | None,
) -> None:
    del userdata, flags, properties
    if reason_code.is_failure:
        LOGGER.error("MQTT connection rejected: %s", reason_code)
        return
    LOGGER.info("Connected to MQTT broker at %s:%s", MQTT_HOST, MQTT_PORT)
    client.subscribe(COMMAND_TOPIC, qos=1)
    client.subscribe(f"{AUDIO_OUTPUT_PREFIX}/+", qos=0)
    client.subscribe(f"{AUDIO_CONTROL_PREFIX}/+", qos=0)
    LOGGER.info("Listening for commands on %s", COMMAND_TOPIC)


def on_disconnect(
    client: mqtt.Client,
    userdata: Any,
    disconnect_flags: mqtt.DisconnectFlags,
    reason_code: mqtt.ReasonCode,
    properties: mqtt.Properties | None,
) -> None:
    del client, userdata, disconnect_flags, properties
    if reason_code.is_failure:
        LOGGER.warning("MQTT connection lost: %s", reason_code)


def on_message(client: mqtt.Client, userdata: Any, message: mqtt.MQTTMessage) -> None:
    del userdata
    if message.topic == COMMAND_TOPIC:
        handle_command(client, message.payload)
        return
    if message.topic.startswith(f"{AUDIO_OUTPUT_PREFIX}/"):
        session_id = message.topic.removeprefix(f"{AUDIO_OUTPUT_PREFIX}/")
        try:
            handle_output_audio(session_id, message.payload)
        except RuntimeError as error:
            LOGGER.warning("Conversation %s output failed: %s", session_id, error)
            stop_conversation(session_id)
        return
    if message.topic.startswith(f"{AUDIO_CONTROL_PREFIX}/"):
        session_id = message.topic.removeprefix(f"{AUDIO_CONTROL_PREFIX}/")
        handle_control(session_id, message.payload)


def main() -> None:
    if MQTT_PASSWORD and not MQTT_USERNAME:
        raise RuntimeError(
            "DOORMAN_MQTT_USERNAME is required when a password is configured"
        )

    client = mqtt.Client(
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        client_id="doorkeeper-pi-audio",
        protocol=mqtt.MQTTv311,
        reconnect_on_failure=True,
    )
    if MQTT_USERNAME:
        client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    client.reconnect_delay_set(min_delay=1, max_delay=30)

    LOGGER.info(
        "Starting Doorman audio worker; output=%s mic=%s audio_directory=%s",
        AUDIO_DEVICE,
        MIC_DEVICE,
        AUDIO_DIRECTORY,
    )
    client.connect(MQTT_HOST, MQTT_PORT, keepalive=30)
    try:
        client.loop_forever(retry_first_connection=True)
    finally:
        with conversation_lock:
            conversation = active_conversation
        if conversation is not None:
            stop_conversation(conversation.session_id)


if __name__ == "__main__":
    main()
