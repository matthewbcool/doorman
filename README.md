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
<!-- doorman-spin-up -->
## Reproduce Doorman

This runbook starts Doorman in a safe, software-only mode. It requires no camera, microphone, Gemini request, Firestore database, or Pub/Sub topic.

### 1. Prerequisites

- Git
- Docker with at least 4 GB available to the build
- Optional: Google Cloud CLI for cloud deployment
- Optional: Frigate, MQTT, a Jetson, and a Raspberry Pi for the complete doorstep build

### 2. Clone and run locally

~~~bash
git clone https://github.com/matthewbcool/doorman.git
cd doorman
docker build -t doorman:local .
docker run --rm --name doorman-local -p 8080:8080 -e DOORMAN_AGENT_MODE=rules -e DOORMAN_STATE_BACKEND=memory -e DOORMAN_COMMAND_BACKEND=memory doorman:local
~~~

Open http://localhost:8080 and verify the API:

~~~bash
curl --fail --silent http://localhost:8080/api/health | python3 -m json.tool
~~~

Expected modes:

~~~json
{
  "service": "doorman",
  "status": "ready",
  "state_backend": "memory",
  "command_backend": "memory",
  "agent_mode": "rules"
}
~~~

### 3. Replay a safe fixture

The fixture stays in memory and cannot reach a physical device:

~~~bash
curl --fail --silent -X POST http://localhost:8080/api/events -H 'Content-Type: application/json' -d '{"schema_version":"1.0","event_id":"fixture-person-001:entered","source_event_id":"fixture-person-001","occurred_at":"2026-08-30T12:00:00Z","type":"person_entered","zone":"front_porch","confidence":0.94,"package_detected":false,"media_shared":false,"interaction_state":"PERSON_DETECTED"}' | python3 -m json.tool
~~~

Refresh the console and open Activity to see the case timeline.

### 4. Run the checks

The Docker build runs both production builds. With Node.js 24 and Corepack installed, run the checks directly:

~~~bash
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
~~~

### 5. Optional Google Cloud deployment

Create least-privilege service accounts and keep credentials in Secret Manager or workload identity, never in the repository.

~~~bash
PROJECT_ID=your-project-id
REGION=us-west1
REPOSITORY=doorman
SERVICE=doorman-workflow
IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/$REPOSITORY/$SERVICE:latest
gcloud services enable aiplatform.googleapis.com run.googleapis.com pubsub.googleapis.com firestore.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --project=$PROJECT_ID
gcloud artifacts repositories describe $REPOSITORY --project=$PROJECT_ID --location=$REGION >/dev/null 2>&1 || gcloud artifacts repositories create $REPOSITORY --project=$PROJECT_ID --location=$REGION --repository-format=docker
gcloud builds submit --project=$PROJECT_ID --tag=$IMAGE .
gcloud run deploy $SERVICE --project=$PROJECT_ID --region=$REGION --image=$IMAGE --no-allow-unauthenticated --set-env-vars=DOORMAN_AGENT_MODE=gemini,DOORMAN_STATE_BACKEND=firestore,DOORMAN_COMMAND_BACKEND=pubsub,DOORMAN_COMMAND_TOPIC=doorman.commands
~~~

Before selecting cloud backends, create Firestore, the event and command topics, the edge command subscription, and the documented service identities and IAM bindings.

### 6. Optional edge and Pi deployment

- Jetson and Frigate bridge: see deploy/jetson.
- Raspberry Pi audio worker: see deploy/pi/README.md.
- Architecture, event contracts, privacy rules, and deployment inventory: see DOORMAN.md.

### Safety defaults

- Local startup uses deterministic rules and memory-only adapters.
- Video remains local by default.
- Visitor speech cannot modify policy or invoke privileged tools.
- Doorman never autonomously unlocks doors or grants physical access.
- Never commit credentials, visitor media, transcripts, identity data, or production case exports.
