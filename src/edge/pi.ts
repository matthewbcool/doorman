import mqtt, {type MqttClient} from 'mqtt';

export const piClipIds = [
  'greeting',
  'thank_driver',
  'please_wait',
  'no_soliciting',
] as const;

export type PiClipId = (typeof piClipIds)[number];

export interface PiPlaybackCommand {
  schema_version: '1.0';
  command_id: string;
  action: 'play_cached_clip';
  clip_id: PiClipId;
  expires_at: string;
}

export interface PiCommandSink {
  publish(command: PiPlaybackCommand): Promise<void>;
}

export interface PiMqttPublisherOptions {
  mqttUrl: string;
  commandTopic: string;
  username?: string;
  password?: string;
}

export class PiMqttPublisher implements PiCommandSink {
  private client: MqttClient | undefined;

  constructor(private readonly options: PiMqttPublisherOptions) {}

  async start(): Promise<void> {
    if (this.client) {
      return;
    }

    const client = mqtt.connect(this.options.mqttUrl, {
      clientId: 'doorman-edge-pi-publisher',
      username: this.options.username,
      password: this.options.password,
      reconnectPeriod: 1_000,
      connectTimeout: 10_000,
      clean: true,
    });

    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        client.off('error', onError);
        client.on('error', (error) => {
          console.error('[pi] MQTT client error', error);
        });
        resolve();
      };
      const onError = (error: Error) => {
        client.off('connect', onConnect);
        client.end(true);
        reject(error);
      };
      client.once('connect', onConnect);
      client.once('error', onError);
    });

    this.client = client;
    console.info(
      `[pi] connected to ${this.options.mqttUrl}; publishing on ${this.options.commandTopic}`,
    );
  }

  async publish(command: PiPlaybackCommand): Promise<void> {
    if (!this.client?.connected) {
      throw new Error('Pi MQTT publisher is not connected.');
    }

    await this.client.publishAsync(
      this.options.commandTopic,
      JSON.stringify(command),
      {qos: 1, retain: false},
    );
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) {
      await client.endAsync();
    }
  }
}
