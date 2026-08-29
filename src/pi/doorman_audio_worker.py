#!/usr/bin/env python3
"""Allowlisted MQTT-to-ALSA audio worker for the Doorman Raspberry Pi."""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
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
AUDIO_DEVICE = os.getenv("DOORMAN_AUDIO_DEVICE", "plughw:CARD=Nano,DEV=0")
AUDIO_DIRECTORY = Path(os.getenv("DOORMAN_AUDIO_DIRECTORY", "/var/lib/doorman/audio"))
PLAYBACK_TIMEOUT_SECONDS = int(os.getenv("DOORMAN_PLAYBACK_TIMEOUT_SECONDS", "30"))
CLIP_COOLDOWN_SECONDS = int(os.getenv("DOORMAN_CLIP_COOLDOWN_SECONDS", "60"))
MAX_MESSAGE_BYTES = 16_384
COMMAND_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")

if CLIP_COOLDOWN_SECONDS < 0:
    raise RuntimeError("DOORMAN_CLIP_COOLDOWN_SECONDS must be non-negative")

ALLOWED_CLIPS = {
    "greeting": "greeting.wav",
    "thank_driver": "thank_driver.wav",
    "please_wait": "please_wait.wav",
    "no_soliciting": "no_soliciting.wav",
}

processed_command_ids: deque[str] = deque(maxlen=256)
last_clip_started_at: dict[str, float] = {}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def publish_status(
    client: mqtt.Client,
    command_id: str,
    state: str,
    *,
    clip_id: str | None = None,
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
    if detail is not None:
        payload["detail"] = detail[:300]

    result = client.publish(
        STATUS_TOPIC,
        json.dumps(payload, separators=(",", ":")),
        qos=1,
        retain=False,
    )
    if result.rc != mqtt.MQTT_ERR_SUCCESS:
        LOGGER.error("Unable to publish %s status for %s: rc=%s", state, command_id, result.rc)


def parse_command(raw_payload: bytes) -> tuple[str, str]:
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
    clip_id = payload.get("clip_id")
    expires_at = payload.get("expires_at")

    if not isinstance(command_id, str) or not COMMAND_ID_PATTERN.fullmatch(command_id):
        raise ValueError("command_id is missing or invalid")
    if action != "play_cached_clip":
        raise ValueError("action is not allowed")
    if clip_id not in ALLOWED_CLIPS:
        raise ValueError("clip_id is not allowed")

    if expires_at is not None:
        if not isinstance(expires_at, str):
            raise ValueError("expires_at must be an ISO-8601 string")
        try:
            expiration = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError("expires_at is invalid") from error
        if expiration.tzinfo is None:
            raise ValueError("expires_at must include a timezone")
        if expiration <= datetime.now(timezone.utc):
            raise ValueError("command has expired")

    return command_id, clip_id


def play_clip(clip_id: str) -> None:
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
    LOGGER.info("Listening for allowlisted commands on %s", COMMAND_TOPIC)


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
    command_id = "unknown"
    clip_id: str | None = None
    try:
        command_id, clip_id = parse_command(message.payload)
        if command_id in processed_command_ids:
            LOGGER.info("Ignoring duplicate command %s", command_id)
            publish_status(client, command_id, "duplicate", clip_id=clip_id)
            return

        processed_command_ids.append(command_id)
        now = time.monotonic()
        last_started_at = last_clip_started_at.get(clip_id)
        if (
            last_started_at is not None
            and now - last_started_at < CLIP_COOLDOWN_SECONDS
        ):
            remaining_seconds = max(
                1,
                int(CLIP_COOLDOWN_SECONDS - (now - last_started_at) + 0.999),
            )
            LOGGER.info(
                "Suppressing cached clip %s for command %s; cooldown has %ss remaining",
                clip_id,
                command_id,
                remaining_seconds,
            )
            publish_status(
                client,
                command_id,
                "suppressed",
                clip_id=clip_id,
                detail=f"clip cooldown has {remaining_seconds}s remaining",
            )
            return

        # Reserve the cooldown before playback. If the output device fails, a
        # burst of distinct commands still cannot hammer the speaker process.
        last_clip_started_at[clip_id] = now
        publish_status(client, command_id, "received", clip_id=clip_id)
        publish_status(client, command_id, "started", clip_id=clip_id)
        LOGGER.info("Playing cached clip %s for command %s", clip_id, command_id)
        play_clip(clip_id)
        publish_status(client, command_id, "completed", clip_id=clip_id)
        LOGGER.info("Completed command %s", command_id)
    except (ValueError, FileNotFoundError, RuntimeError, subprocess.SubprocessError) as error:
        LOGGER.warning("Command %s failed: %s", command_id, error)
        publish_status(client, command_id, "failed", clip_id=clip_id, detail=str(error))
    except Exception:
        LOGGER.exception("Unexpected failure while handling command %s", command_id)
        publish_status(client, command_id, "failed", clip_id=clip_id, detail="unexpected worker error")


def main() -> None:
    if MQTT_PASSWORD and not MQTT_USERNAME:
        raise RuntimeError("DOORMAN_MQTT_USERNAME is required when a password is configured")

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
        "Starting Doorman audio worker; device=%s audio_directory=%s clip_cooldown=%ss",
        AUDIO_DEVICE,
        AUDIO_DIRECTORY,
        CLIP_COOLDOWN_SECONDS,
    )
    client.connect(MQTT_HOST, MQTT_PORT, keepalive=30)
    client.loop_forever(retry_first_connection=True)


if __name__ == "__main__":
    main()
