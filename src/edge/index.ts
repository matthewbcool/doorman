import {EdgeCloudBridge} from './cloud.js';
import {CommandExecutor} from './executor.js';
import {FrigateBridge} from './frigate.js';

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

  const cloud = new EdgeCloudBridge({
    projectId,
    eventsTopic: process.env.DOORMAN_EVENTS_TOPIC ?? 'doorman.events',
    commandSubscription:
      process.env.DOORMAN_COMMAND_SUBSCRIPTION ?? 'doorman-commands-edge',
  });
  const executor = new CommandExecutor({dryRun});
  const frigate = new FrigateBridge(
    {
      mqttUrl: process.env.DOORMAN_MQTT_URL ?? 'mqtt://mosquitto:1883',
      mqttTopic: process.env.DOORMAN_MQTT_TOPIC ?? 'frigate/events',
      requiredZone: optionalEnvironment('DOORMAN_FRIGATE_REQUIRED_ZONE'),
      username: optionalEnvironment('DOORMAN_MQTT_USERNAME'),
      password: optionalEnvironment('DOORMAN_MQTT_PASSWORD'),
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
    await cloud.stop();
    throw error;
  }

  console.info(
    JSON.stringify({
      service: 'doorman-edge',
      mode: 'dry-run',
      project_id: projectId,
      media_shared: false,
    }),
  );

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.info(`[edge] ${signal} received; shutting down`);
    const results = await Promise.allSettled([frigate.stop(), cloud.stop()]);
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
