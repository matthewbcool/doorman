import {z} from 'zod';

export const doormanEventSchema = z.object({
  event_id: z.string().min(1),
  source_event_id: z.string().min(1),
  occurred_at: z.string().datetime(),
  type: z.string().min(1),
  zone: z.string().min(1),
  confidence: z.number().min(0).max(1),
  media_shared: z.boolean().default(false),
  interaction_state: z.string().min(1),
});

export type DoormanEvent = z.infer<typeof doormanEventSchema>;

export const visualObservationSchema = z.object({
  apparel: z.array(z.string()),
  carrying: z.array(z.string()),
  costume: z.string().nullable(),
  identity_attempted: z.literal(false),
  image_persisted: z.literal(false),
});

export type VisualObservation = z.infer<typeof visualObservationSchema>;

