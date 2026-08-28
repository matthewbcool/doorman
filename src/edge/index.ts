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

async function main(): Promise<void> {
  const projectId = requiredEnvironment('GOOGLE_CLOUD_PROJECT');
  const dryRun = process.env.DOORMAN_EDGE_DRY_RUN !== 'false';
  const mqttUrl = process.env.DOORMAN_MQTT_URL ?? 'mqtt://mosquitto:1883';
  const mqttUsername = optionalEnvironment('DOORMAN_MQTT_USERNAME');
  const mqttPassword = optionalEnvironment('DOORMAN_MQTT_PASSWORD');

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
