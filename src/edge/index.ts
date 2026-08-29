import {randomUUID} from 'node:crypto';

import {EdgeCloudBridge} from './cloud.js';
import {CommandExecutor} from './executor.js';
import {FrigateBridge} from './frigate.js';
import {PiMqttPublisher} from './pi.js';

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function optionalEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function nonNegativeIntegerEnvironment(name: string, fallback: number): number {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

async function main(): Promise<void> {
  const projectId = requiredEnvironment('GOOGLE_CLOUD_PROJECT');
  const dryRun = process.env.DOORMAN_EDGE_DRY_RUN !== 'false';
  const mqttUrl = process.env.DOORMAN_MQTT_URL ?? 'mqtt://mosquitto:1883';
  const mqttUsername = optionalEnvironment('DOORMAN_MQTT_USERNAME');
  const mqttPassword = optionalEnvironment('DOORMAN_MQTT_PASSWORD');
  const greetingCooldownSeconds = nonNegativeIntegerEnvironment(
    'DOORMAN_GREETING_COOLDOWN_SECONDS',
    60,
  );
  const greetingCooldownMilliseconds = greetingCooldownSeconds * 1_000;
  const lastLocalGreetingByZone = new Map<string, number>();

  const cloud = new EdgeCloudBridge({
    projectId,
    eventsTopic: process.env.DOORMAN_EVENTS_TOPIC ?? 'doorman.events',
    commandSubscription:
      process.env.DOORMAN_COMMAND_SUBSCRIPTION ?? 'doorman-commands-edge',
  });
  const piPublisher = new PiMqttPublisher({
    mqttUrl,
    commandTopic: process.env.DOORMAN_PI_COMMAND_TOPIC ?? 'doorman/pi/commands',
    username: mqttUsername,
    password: mqttPassword,
  });
  if (!dryRun) {
    await piPublisher.start();
  }
  const executor = new CommandExecutor({
    dryRun,
    piCommandSink: dryRun ? undefined : piPublisher,
    clipCooldownSeconds: greetingCooldownSeconds,
  });
  const frigate = new FrigateBridge(
    {
      mqttUrl,
      mqttTopic: process.env.DOORMAN_MQTT_TOPIC ?? 'frigate/events',
      requiredZone: optionalEnvironment('DOORMAN_FRIGATE_REQUIRED_ZONE'),
      username: mqttUsername,
      password: mqttPassword,
    },
    async (event) => {
      if (!dryRun && event.type === 'person_entered') {
        const now = Date.now();
        const zoneKey = event.zone;
        const lastGreetingAt = lastLocalGreetingByZone.get(zoneKey);
        const cooldownActive =
          lastGreetingAt !== undefined &&
          now - lastGreetingAt < greetingCooldownMilliseconds;

        if (cooldownActive) {
          const remainingSeconds = Math.ceil(
            (greetingCooldownMilliseconds - (now - lastGreetingAt)) / 1_000,
          );
          console.info(
            `[edge] local greeting suppressed for ${zoneKey}; cooldown has ${remainingSeconds}s remaining`,
          );
        } else {
          // Reserve the cooldown before awaiting MQTT so simultaneous fragmented
          // Frigate tracks cannot both publish a greeting.
          lastLocalGreetingByZone.set(zoneKey, now);
          const commandId = `edge-greeting-${randomUUID()}`;
          try {
            await piPublisher.publish({
              schema_version: '1.0',
              command_id: commandId,
              action: 'play_cached_clip',
              clip_id: 'greeting',
              expires_at: new Date(now + 30_000).toISOString(),
            });
            executor.recordLocalPlayback('greeting', now);
            console.info(
              `[edge] published immediate local greeting ${commandId} for ${zoneKey}`,
            );
          } catch (error) {
            if (lastLocalGreetingByZone.get(zoneKey) === now) {
              lastLocalGreetingByZone.delete(zoneKey);
            }
            console.error('[edge] immediate local greeting failed', error);
          }
        }
      }

      // Cloud processing remains asynchronous from the visitor's perspective:
      // the cached greeting is already on its way before this publish begins.
      const messageId = await cloud.publishEvent(event);
      console.info(
        `[edge] published ${event.event_id} as Pub/Sub message ${messageId}`,
      );
    },
  );

  cloud.startCommandConsumer((command) => executor.execute(command));
  try {
    await frigate.start();
  } catch (error) {
    await Promise.allSettled([cloud.stop(), piPublisher.stop()]);
    throw error;
  }

  console.info(
    JSON.stringify({
      service: 'doorman-edge',
      mode: dryRun ? 'dry-run' : 'live',
      project_id: projectId,
      media_shared: false,
      pi_command_topic: process.env.DOORMAN_PI_COMMAND_TOPIC ?? 'doorman/pi/commands',
      greeting_cooldown_seconds: greetingCooldownSeconds,
      local_greeting_fast_path: !dryRun,
    }),
  );

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.info(`[edge] ${signal} received; shutting down`);
    const results = await Promise.allSettled([
      frigate.stop(),
      cloud.stop(),
      piPublisher.stop(),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('[edge] shutdown error', result.reason);
      }
    }
    process.exit(0);
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

void main().catch((error) => {
  console.error('[edge] fatal startup error', error);
  process.exitCode = 1;
});
