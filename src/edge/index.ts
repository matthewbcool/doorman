import {EdgeCloudBridge} from './cloud.js';
import {ConversationBridge} from './conversation.js';
import {CommandExecutor} from './executor.js';
import {FrigateBridge} from './frigate.js';
import {PiMqttPublisher} from './pi.js';
import {LiveTokenBrokerClient} from './token-broker.js';
import {doormanLiveModel} from '../shared/live.js';

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

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

async function main(): Promise<void> {
  const projectId = requiredEnvironment('GOOGLE_CLOUD_PROJECT');
  const dryRun = process.env.DOORMAN_EDGE_DRY_RUN !== 'false';
  const mqttUrl = process.env.DOORMAN_MQTT_URL ?? 'mqtt://mosquitto:1883';
  const mqttUsername = optionalEnvironment('DOORMAN_MQTT_USERNAME');
  const mqttPassword = optionalEnvironment('DOORMAN_MQTT_PASSWORD');
  const greetingCooldownSeconds = positiveIntegerEnvironment(
    'DOORMAN_GREETING_COOLDOWN_SECONDS',
    60,
  );

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
    greetingCooldownSeconds,
  });

  const tokenBroker = dryRun
    ? undefined
    : new LiveTokenBrokerClient(
        requiredEnvironment('DOORMAN_LIVE_TOKEN_BROKER_URL'),
      );

  const conversation = dryRun
    ? undefined
    : new ConversationBridge({
        mqttUrl,
        piCommandSink: piPublisher,
        tokenBroker: tokenBroker!,
        timeoutSeconds: positiveIntegerEnvironment(
          'DOORMAN_CONVERSATION_TIMEOUT_SECONDS',
          60,
        ),
        inputTopicPrefix:
          process.env.DOORMAN_PI_AUDIO_INPUT_PREFIX ??
          'doorman/pi/audio/input',
        outputTopicPrefix:
          process.env.DOORMAN_PI_AUDIO_OUTPUT_PREFIX ??
          'doorman/pi/audio/output',
        controlTopicPrefix:
          process.env.DOORMAN_PI_AUDIO_CONTROL_PREFIX ??
          'doorman/pi/audio/control',
        username: mqttUsername,
        password: mqttPassword,
      });
  await conversation?.start();

  const frigate = new FrigateBridge(
    {
      mqttUrl,
      mqttTopic: process.env.DOORMAN_MQTT_TOPIC ?? 'frigate/events',
      requiredZone: optionalEnvironment('DOORMAN_FRIGATE_REQUIRED_ZONE'),
      username: mqttUsername,
      password: mqttPassword,
    },
    async (event) => {
      if (event.type === 'person_entered') {
        const greeted = await executor.greetImmediately(event);
        if (greeted && conversation) {
          void conversation.open(event.source_event_id).catch((error) => {
            console.error(
              `[conversation] unable to open for ${event.source_event_id}`,
              error,
            );
          });
        }
      } else if (event.type === 'person_left') {
        await conversation?.closeForSource(event.source_event_id);
      }

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
    await Promise.allSettled([
      cloud.stop(),
      conversation?.stop(),
      piPublisher.stop(),
    ]);
    throw error;
  }

  console.info(
    JSON.stringify({
      service: 'doorman-edge',
      mode: dryRun ? 'dry-run' : 'live',
      project_id: projectId,
      media_shared: false,
      pi_command_topic:
        process.env.DOORMAN_PI_COMMAND_TOPIC ?? 'doorman/pi/commands',
      conversation_model:
        doormanLiveModel,
      conversation_timeout_seconds: positiveIntegerEnvironment(
        'DOORMAN_CONVERSATION_TIMEOUT_SECONDS',
        60,
      ),
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
      conversation?.stop(),
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
