# Raspberry Pi audio worker

This service runs on `doorkeeper-pi` and converts allowlisted local MQTT commands into cached ALSA playback through the Yeti Nano USB audio device. All cached speech is generated with Gemini; the Pi does not synthesize speech locally.

## MQTT contract

The worker subscribes to `doorman/pi/commands` at QoS 1. A valid command is:

```json
{
  "schema_version": "1.0",
  "command_id": "example-001",
  "action": "play_cached_clip",
  "clip_id": "thank_driver",
  "expires_at": "2026-08-29T00:00:00Z"
}
```

Only these clip identifiers are accepted:

- `greeting`
- `thank_driver`
- `please_wait`
- `no_soliciting`

The worker publishes lifecycle states to `doorman/pi/status` at QoS 1: `received`, `started`, `completed`, `failed`, or `duplicate`.

The worker does not execute command text, synthesize arbitrary speech, accept arbitrary file paths, record microphone audio, or contact Google Cloud.

## Pi filesystem layout

- Worker: `/opt/doorman/pi/doorman_audio_worker.py`
- Configuration: `/etc/doorman/audio-worker.env`
- Gemini-generated cached audio: `/var/lib/doorman/audio/*.wav`
- systemd unit: `/etc/systemd/system/doorman-audio.service`

MQTT credentials are intentionally not stored in this repository. Add them only to the Pi's root-owned environment file after Mosquitto authentication is configured.
