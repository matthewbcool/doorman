# Doorman

Doorman is a privacy-first, agentic front-door concierge built for the Google / Devpost All Things Agentic Hackathon. A Raspberry Pi Zero 2 W provides event-scoped microphone and speaker I/O, a Jetson Orin Nano runs Frigate and the local edge bridge, and Google Cloud provides the workflow, durable state, commands, and Gemini services.

## Verified end-to-end path

```text
Camera / Frigate on Jetson
  -> local Doorman edge bridge
  -> immediate cached AI disclosure on the Pi
  -> Pub/Sub event -> Cloud Run workflow -> Firestore
  -> private Cloud Run token broker -> one-use Gemini credential
  -> Pi Yeti microphone -> Jetson -> Gemini 3.1 Live
  -> Gemini audio -> Jetson -> Pi -> JBL Flip 5
```

The complete path was verified on August 28, 2026: a person entered the frame, heard the cached disclosure, said they were dropping off a package, and received an appropriate spoken Gemini response through the JBL speaker.

## Models and Google services

- Workflow reasoning: `gemini-3.7-flash` through Google Cloud and Google ADK for TypeScript.
- Live conversation: `gemini-3.1-flash-live-preview` through the Gemini Developer API with short-lived, single-use credentials.
- Cached speech generation: `gemini-3.1-flash-tts-preview`, voice `Achird`.
- Cloud Run: workflow/API/PWA plus a separate private Live token broker.
- Pub/Sub: privacy-minimized events and allowlisted edge commands.
- Firestore: policies, cases, and audit timelines.
- Secret Manager: the permanent Gemini Developer API key; it is not stored on either device or in this repository.

## Documentation

[`DOORMAN.md`](DOORMAN.md) is the project source of truth. It contains the architecture, privacy and safety boundaries, verified hardware/software inventory, deployment details, and complete power-cycle/recovery runbook.

Pi-specific deployment notes are in [`deploy/pi/README.md`](deploy/pi/README.md).

## Build

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

The build produces the React/Vite console, a shell-only PWA service worker, the Cloud Run server, the Jetson edge bridge, and the token broker. The current manifest does not yet include install icons or a custom install/update prompt, so browser-installability remains a release-check item.

## Security

Continuous video stays local. Microphone audio is streamed only during a bounded interaction and is not written by Doorman to disk, Pub/Sub, or Firestore. Visitor speech is untrusted and cannot unlock a door, grant access, change policy, reveal occupancy, or invoke privileged tools.
