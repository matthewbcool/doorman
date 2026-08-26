import {PubSub, type Topic} from '@google-cloud/pubsub';

import {edgeCommandSchema, type EdgeCommand} from '../shared/contracts.js';
import type {CommandSink} from './commands.js';

export class PubSubCommandSink implements CommandSink {
  private readonly topic: Topic;

  constructor(topicName: string, projectId?: string) {
    const pubsub = projectId ? new PubSub({projectId}) : new PubSub();
    this.topic = pubsub.topic(topicName);
  }

  async publish(command: EdgeCommand) {
    const parsed = edgeCommandSchema.parse(command);
    await this.topic.publishMessage({
      data: Buffer.from(JSON.stringify(parsed)),
      attributes: {
        schema_version: parsed.schema_version,
        case_id: parsed.case_id,
        action: parsed.action,
      },
    });
  }
}
