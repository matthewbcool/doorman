import {
  doormanEventSchema,
  pubSubPushEnvelopeSchema,
  type DoormanEvent,
} from '../shared/contracts.js';

export function eventFromPubSubPush(input: unknown): DoormanEvent {
  const envelope = pubSubPushEnvelopeSchema.parse(input);
  const decoded = Buffer.from(envelope.message.data, 'base64').toString('utf8');
  return doormanEventSchema.parse(JSON.parse(decoded));
}
