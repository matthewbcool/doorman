import {
  PubSub,
  type Message,
  type Subscription,
  type Topic,
} from '@google-cloud/pubsub';

import {
  doormanEventSchema,
  edgeCommandSchema,
  type DoormanEvent,
  type EdgeCommand,
} from '../shared/contracts.js';

type CommandHandler = (command: EdgeCommand) => Promise<void>;

export interface EdgeCloudOptions {
  projectId: string;
  eventsTopic: string;
  commandSubscription: string;
}

export class EdgeCloudBridge {
  private readonly pubsub: PubSub;
  private readonly eventsTopic: Topic;
  private readonly commandSubscription: Subscription;
  private messageHandler?: (message: Message) => void;
  private errorHandler?: (error: Error) => void;

  constructor(options: EdgeCloudOptions) {
    this.pubsub = new PubSub({projectId: options.projectId});
    this.eventsTopic = this.pubsub.topic(options.eventsTopic);
    this.commandSubscription = this.pubsub.subscription(
      options.commandSubscription,
      {
        flowControl: {
          maxMessages: 1,
          allowExcessMessages: false,
        },
      },
    );
  }

  async publishEvent(event: DoormanEvent): Promise<string> {
    const parsed = doormanEventSchema.parse(event);
    return this.eventsTopic.publishMessage({
      data: Buffer.from(JSON.stringify(parsed)),
      attributes: {
        schema_version: parsed.schema_version,
        event_id: parsed.event_id,
        source_event_id: parsed.source_event_id,
        type: parsed.type,
      },
    });
  }

  startCommandConsumer(handler: CommandHandler): void {
    if (this.messageHandler) {
      throw new Error('The command consumer is already running.');
    }

    this.messageHandler = (message) => {
      void this.handleCommandMessage(message, handler);
    };
    this.errorHandler = (error) => {
      console.error('[cloud] command subscription error', error);
    };

    this.commandSubscription.on('message', this.messageHandler);
    this.commandSubscription.on('error', this.errorHandler);
    console.info(
      `[cloud] listening for commands on ${this.commandSubscription.name}`,
    );
  }

  async stop(): Promise<void> {
    if (this.messageHandler) {
      this.commandSubscription.removeListener('message', this.messageHandler);
    }
    if (this.errorHandler) {
      this.commandSubscription.removeListener('error', this.errorHandler);
    }
    await this.commandSubscription.close();
    await this.pubsub.close();
  }

  private async handleCommandMessage(
    message: Message,
    handler: CommandHandler,
  ): Promise<void> {
    let command: EdgeCommand;
    try {
      command = edgeCommandSchema.parse(
        JSON.parse(message.data.toString('utf8')),
      );
    } catch (error) {
      console.error(
        `[cloud] dropping invalid command message ${message.id}`,
        error,
      );
      message.ack();
      return;
    }

    try {
      await handler(command);
      message.ack();
    } catch (error) {
      console.error(`[cloud] command ${command.command_id} failed`, error);
      message.nack();
    }
  }
}
