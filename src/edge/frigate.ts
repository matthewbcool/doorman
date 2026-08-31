import mqtt, {type IClientOptions, type MqttClient} from 'mqtt';
import {z} from 'zod';

import {
  doormanEventSchema,
  type DoormanEvent,
} from '../shared/contracts.js';

const trackedObjectSchema = z
  .object({
    id: z.string().min(1),
    camera: z.string().min(1),
    label: z.string().min(1),
    top_score: z.number().optional(),
    score: z.number().optional(),
    start_time: z.number(),
    end_time: z.number().nullable().optional(),
    frame_time: z.number().optional(),
    current_zones: z.array(z.string()).default([]),
    entered_zones: z.array(z.string()).default([]),
  })
  .passthrough();

const frigateEventSchema = z
  .object({
    type: z.enum(['new', 'update', 'end']),
    before: trackedObjectSchema.nullable().optional(),
    after: trackedObjectSchema,
  })
  .passthrough();

type FrigateEvent = z.infer<typeof frigateEventSchema>;

export interface FrigateBridgeOptions {
  mqttUrl: string;
  mqttTopic: string;
  requiredZone?: string;
  username?: string;
  password?: string;
}

type EventHandler = (event: DoormanEvent) => Promise<void>;

export interface CatDetectedEvent {
  sourceEventId: string;
  occurredAt: string;
  zone: string;
}

type CatHandler = (event: CatDetectedEvent) => Promise<void>;

export class FrigateBridge {
  private client?: MqttClient;
  private readonly activeObjects = new Set<string>();
  private readonly activeCats = new Set<string>();

  constructor(
    private readonly options: FrigateBridgeOptions,
    private readonly eventHandler: EventHandler,
    private readonly catHandler?: CatHandler,
  ) {}

  async start(): Promise<void> {
    if (this.client) {
      throw new Error('The Frigate MQTT bridge is already running.');
    }

    const mqttOptions: IClientOptions = {
      clean: true,
      reconnectPeriod: 5_000,
      clientId: `doorman-edge-${process.pid}`,
    };
    if (this.options.username) {
      mqttOptions.username = this.options.username;
    }
    if (this.options.password) {
      mqttOptions.password = this.options.password;
    }

    const client = mqtt.connect(this.options.mqttUrl, mqttOptions);
    this.client = client;

    client.on('message', (topic, payload) => {
      if (topic !== this.options.mqttTopic) {
        return;
      }
      void this.handleMessage(payload);
    });
    client.on('error', (error) => {
      console.error('[frigate] MQTT error', error);
    });
    client.on('reconnect', () => {
      console.info('[frigate] reconnecting to MQTT');
    });

    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        client.removeListener('error', onInitialError);
        client.subscribe(this.options.mqttTopic, {qos: 1}, (error) => {
          if (error) {
            reject(error);
            return;
          }
          console.info(
            `[frigate] listening on ${this.options.mqttTopic} via ${this.options.mqttUrl}`,
          );
          resolve();
        });
      };
      const onInitialError = (error: Error) => {
        client.removeListener('connect', onConnect);
        reject(error);
      };
      client.once('connect', onConnect);
      client.once('error', onInitialError);
    });
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (!client) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      client.end(false, {}, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async handleMessage(payload: Buffer): Promise<void> {
    let frigateEvent: FrigateEvent;
    try {
      frigateEvent = frigateEventSchema.parse(
        JSON.parse(payload.toString('utf8')),
      );
    } catch (error) {
      console.error('[frigate] invalid event ignored', error);
      return;
    }

    if (frigateEvent.after.label === 'cat') {
      await this.handleCatEvent(frigateEvent);
      return;
    }

    const event = this.normalizeEvent(frigateEvent);
    if (!event) {
      return;
    }

    try {
      const parsed = doormanEventSchema.parse(event);
      await this.eventHandler(parsed);
    } catch (error) {
      console.error(
        `[frigate] failed to forward ${event.event_id}; a later Frigate update may retry it`,
        error,
      );
      if (event.type === 'person_entered') {
        this.activeObjects.delete(event.source_event_id);
      } else if (event.type === 'person_left') {
        this.activeObjects.add(event.source_event_id);
      }
    }
  }

  private async handleCatEvent(event: FrigateEvent): Promise<void> {
    if (!this.catHandler) {
      return;
    }

    const object = event.after;
    if (event.type === 'end') {
      this.activeCats.delete(object.id);
      return;
    }

    const zones = [...object.current_zones, ...object.entered_zones];
    const requiredZone = this.options.requiredZone;
    const isInRequiredZone = !requiredZone || zones.includes(requiredZone);
    if (!isInRequiredZone || this.activeCats.has(object.id)) {
      return;
    }

    this.activeCats.add(object.id);
    const occurredSeconds = object.frame_time ?? object.start_time;
    const zone = requiredZone ?? zones.at(-1) ?? object.camera;

    try {
      await this.catHandler({
        sourceEventId: object.id,
        occurredAt: new Date(occurredSeconds * 1_000).toISOString(),
        zone,
      });
    } catch (error) {
      this.activeCats.delete(object.id);
      console.error(`[frigate] cat greeting failed for ${object.id}`, error);
    }
  }

  private normalizeEvent(event: FrigateEvent): DoormanEvent | null {
    const object = event.after;
    if (object.label !== 'person') {
      return null;
    }

    const zones = [...object.current_zones, ...object.entered_zones];
    const requiredZone = this.options.requiredZone;
    const isInRequiredZone = !requiredZone || zones.includes(requiredZone);

    let type: DoormanEvent['type'];
    if (event.type === 'end') {
      if (!this.activeObjects.delete(object.id)) {
        return null;
      }
      type = 'person_left';
    } else {
      if (!isInRequiredZone || this.activeObjects.has(object.id)) {
        return null;
      }
      this.activeObjects.add(object.id);
      type = 'person_entered';
    }

    const occurredSeconds =
      type === 'person_left'
        ? (object.end_time ?? object.frame_time ?? object.start_time)
        : (object.frame_time ?? object.start_time);
    const rawConfidence = object.top_score ?? object.score ?? 0;
    const confidence = Math.max(0, Math.min(1, rawConfidence));
    const zone = requiredZone ?? zones.at(-1) ?? object.camera;

    return {
      schema_version: '1.0',
      event_id: `${object.id}:${type}`,
      source_event_id: object.id,
      occurred_at: new Date(occurredSeconds * 1_000).toISOString(),
      type,
      zone,
      confidence,
      package_detected: false,
      intent: 'unknown',
      media_shared: false,
      interaction_state: 'PERSON_DETECTED',
    };
  }
}
