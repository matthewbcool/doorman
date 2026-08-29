# Raspberry Pi audio worker

This service runs on `doorkeeper-pi`. It plays allowlisted cached clips, opens the Yeti Nano only for an event-scoped conversation, sends raw microphone PCM to the Jetson over local MQTT, and plays returned Gemini PCM through the current PipeWire sink. The Pi does not hold Google credentials or synthesize speech locally.

## MQTT contract

The worker subscribes to `doorman/pi/commands` at QoS 1. Cached playback uses:

```json
{
  "schema_version": "1.0",
  "command_id": "example-001",
  "action": "play_cached_clip",
  "clip_id": "thank_driver",
  "expires_at": "2026-08-29T00:00:00Z"
}
```

Conversation control uses allowlisted `start_conversation` and `stop_conversation` commands with a validated `session_id` and expiry. During an active session:

```text
Pi microphone -> doorman/pi/audio/input/<session-id>   (QoS 0, raw PCM)
Jetson audio  -> doorman/pi/audio/output/<session-id>  (QoS 0, raw PCM)
Control       -> doorman/pi/audio/control/<session-id>
```

Input is signed 16-bit mono PCM at 16 kHz. Output is signed 16-bit mono PCM at 24 kHz. Audio topics stay on the local Mosquitto broker.

Only these cached clip identifiers are accepted:

- `greeting`
- `thank_driver`
- `please_wait`
- `no_soliciting`

The worker publishes lifecycle states to `doorman/pi/status` at QoS 1: `received`, `started`, `completed`, `failed`, or `duplicate`.

The worker does not execute command text, synthesize arbitrary speech, accept arbitrary file paths, persist microphone audio, or contact Google Cloud. Microphone capture is bounded to the active session and has a local timeout.

## Pi filesystem layout

- Worker: `/opt/doorman/pi/doorman_audio_worker.py`
- Configuration: `/home/mattbcool/.config/doorman/audio-worker.env`
- Gemini-generated cached audio: `/var/lib/doorman/audio/*.wav`
- User systemd unit: `/home/mattbcool/.config/systemd/user/doorman-audio.service`
- Headless Bluetooth configuration: `/home/mattbcool/.config/wireplumber/wireplumber.conf.d/10-headless-bluetooth.conf`

## Boot and restart

The deployed Pi has `Linger=yes`, and `pipewire`, `pipewire-pulse`, `wireplumber`, and `doorman-audio` are enabled as user services.

```bash
systemctl --user restart pipewire pipewire-pulse wireplumber
bluetoothctl connect 20:18:5B:D1:A6:7B
wpctl status -n
systemctl --user restart doorman-audio.service
systemctl --user status doorman-audio.service --no-pager -l -n 30
```

If the JBL sink is not the default, use the numeric sink ID shown by `wpctl status -n`:

```bash
wpctl set-default <JBL-sink-id>
```

## Installed environment

The environment example is intentionally credential-free. The deployed settings use `10.0.0.96` for local MQTT, `pipewire` for output, `plughw:CARD=Nano,DEV=0` for the microphone, a 60-second cached-clip cooldown, and a 60-second conversation cap.

MQTT credentials are intentionally not stored in this repository. Add them only to the user's private environment file after Mosquitto authentication is configured.
