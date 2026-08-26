import {z} from 'zod';

export const interactionStateSchema = z.enum([
  'PERSON_DETECTED',
  'GREETING',
  'LISTENING',
  'PROCESSING',
  'RESPONDING',
  'WAITING_FOR_RESIDENT',
  'FOLLOW_UP_PENDING',
  'COMPLETE',
]);

export const visualObservationSchema = z.object({
  apparel: z.array(z.string()).default([]),
  carrying: z.array(z.string()).default([]),
  costume: z.string().nullable().default(null),
  scene_summary: z.string().max(500).optional(),
  identity_attempted: z.literal(false),
  image_persisted: z.literal(false),
});

export const doormanEventSchema = z.object({
  schema_version: z.literal('1.0').default('1.0'),
  event_id: z.string().min(1),
  source_event_id: z.string().min(1),
  occurred_at: z.string().datetime({offset: true}),
  type: z.enum([
    'person_entered',
    'person_left',
    'delivery_dropoff',
    'visitor_message',
    'solicitor_detected',
    'halloween_visitor',
  ]),
  zone: z.string().min(1),
  confidence: z.number().min(0).max(1),
  package_detected: z.boolean().default(false),
  intent: z.enum(['delivery', 'solicitor', 'resident_request', 'social', 'unknown']).optional(),
  visitor_message: z.string().max(1000).optional(),
  media_shared: z.boolean().default(false),
  visual_observation: visualObservationSchema.optional(),
  interaction_state: interactionStateSchema.default('PERSON_DETECTED'),
});

export type DoormanEvent = z.infer<typeof doormanEventSchema>;
export type VisualObservation = z.infer<typeof visualObservationSchema>;

export const allowedActionSchema = z.enum([
  'play_cached_clip',
  'start_visitor_conversation',
  'politely_decline',
  'ask_visitor_to_wait',
  'notify_homeowner',
  'friendly_costume_comment',
  'complete_interaction',
  'none',
]);

export type AllowedAction = z.infer<typeof allowedActionSchema>;

export const agentDecisionSchema = z.object({
  classification: z.enum(['delivery', 'solicitor', 'expected_visitor', 'social', 'unknown']),
  action: allowedActionSchema,
  response_text: z.string().max(500),
  decision_summary: z.string().max(300),
  confidence: z.number().min(0).max(1),
  notify_homeowner: z.boolean(),
  requires_visual_context: z.boolean(),
  policy_id: z.string().nullable(),
});

export type AgentDecision = z.infer<typeof agentDecisionSchema>;

export const policySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  minimum_confidence: z.number().min(0).max(1),
  action: allowedActionSchema,
  response_text: z.string().max(500),
  notify: z.enum(['always', 'summary', 'on_escalation', 'never_unless_escalated']),
  dedupe_seconds: z.number().int().nonnegative().default(0),
  visual_input: z.enum(['none', 'single_face_redacted_frame', 'single_consented_frame']).default('none'),
});

export type Policy = z.infer<typeof policySchema>;

export const timelineEntrySchema = z.object({
  id: z.string(),
  occurred_at: z.string().datetime({offset: true}),
  layer: z.enum(['edge', 'workflow', 'agent', 'command']),
  type: z.string(),
  summary: z.string(),
  policy_id: z.string().nullable().default(null),
  media_shared: z.boolean().default(false),
});

export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

export const edgeCommandSchema = z.object({
  schema_version: z.literal('1.0'),
  command_id: z.string(),
  case_id: z.string(),
  trace_id: z.string(),
  issued_at: z.string().datetime({offset: true}),
  action: allowedActionSchema.exclude(['none']),
  response_text: z.string().max(500),
  expires_at: z.string().datetime({offset: true}),
  dedupe_key: z.string(),
});

export type EdgeCommand = z.infer<typeof edgeCommandSchema>;

export const interactionCaseSchema = z.object({
  case_id: z.string(),
  trace_id: z.string(),
  source_event_id: z.string(),
  created_at: z.string().datetime({offset: true}),
  updated_at: z.string().datetime({offset: true}),
  status: z.enum(['active', 'waiting', 'completed', 'review']),
  event: doormanEventSchema,
  decision: agentDecisionSchema,
  timeline: z.array(timelineEntrySchema),
});

export type InteractionCase = z.infer<typeof interactionCaseSchema>;

export const pubSubPushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string().min(1),
    messageId: z.string().optional(),
    publishTime: z.string().optional(),
    attributes: z.record(z.string(), z.string()).optional(),
  }),
  subscription: z.string().optional(),
});

export type PubSubPushEnvelope = z.infer<typeof pubSubPushEnvelopeSchema>;
