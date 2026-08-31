import {randomUUID} from 'node:crypto';

import type {DecisionPlanner} from '../agent/index.js';
import {
  agentDecisionSchema,
  edgeCommandSchema,
  interactionCaseSchema,
  type AgentDecision,
  type DoormanEvent,
  type InteractionCase,
  type Policy,
  type TimelineEntry,
} from '../shared/contracts.js';
import type {CommandSink} from './commands.js';
import type {DoormanState} from './state.js';

const now = () => new Date().toISOString();

function timelineEntry(
  layer: TimelineEntry['layer'],
  type: string,
  summary: string,
  policyId: string | null,
  mediaShared: boolean,
): TimelineEntry {
  return {
    id: randomUUID(),
    occurred_at: now(),
    layer,
    type,
    summary,
    policy_id: policyId,
    media_shared: mediaShared,
  };
}

function enabledPolicy(policies: Policy[], id: string, confidence: number) {
  return policies.find(
    (policy) => policy.id === id && policy.enabled && confidence >= policy.minimum_confidence,
  );
}

function deliveryDecision(event: DoormanEvent, policy: Policy): AgentDecision {
  return agentDecisionSchema.parse({
    classification: 'delivery',
    action: policy.action,
    response_text: policy.response_text,
    decision_summary: 'Delivery evidence met the household policy threshold.',
    confidence: event.confidence,
    notify_homeowner: policy.notify === 'always',
    requires_visual_context: false,
    policy_id: policy.id,
  });
}

function solicitorDecision(event: DoormanEvent, policy: Policy): AgentDecision {
  return agentDecisionSchema.parse({
    classification: 'solicitor',
    action: policy.action,
    response_text: policy.response_text,
    decision_summary: 'Solicitor intent met the household policy threshold.',
    confidence: event.confidence,
    notify_homeowner: false,
    requires_visual_context: false,
    policy_id: policy.id,
  });
}

function halloweenDecision(event: DoormanEvent, policy: Policy): AgentDecision {
  const costume = event.visual_observation?.costume;
  const responseText = costume
    ? `That ${costume} costume looks fantastic. Happy Halloween!`
    : policy.response_text;

  return agentDecisionSchema.parse({
    classification: 'social',
    action: policy.action,
    response_text: responseText,
    decision_summary: costume
      ? 'Halloween mode used a supplied non-identifying costume observation.'
      : 'Halloween mode used its generic greeting because no costume was supplied.',
    confidence: event.confidence,
    notify_homeowner: false,
    requires_visual_context: !event.visual_observation,
    policy_id: policy.id,
  });
}

function safeFallbackDecision(event: DoormanEvent): AgentDecision {
  if (event.type === 'person_left') {
    return agentDecisionSchema.parse({
      classification: 'unknown',
      action: 'complete_interaction',
      response_text: '',
      decision_summary: 'The visitor left before an interaction was required.',
      confidence: event.confidence,
      notify_homeowner: false,
      requires_visual_context: false,
      policy_id: null,
    });
  }

  if (event.intent === 'resident_request') {
    return agentDecisionSchema.parse({
      classification: 'expected_visitor',
      action: 'ask_visitor_to_wait',
      response_text: 'Thanks — I’ll let the resident know you’re here. Please wait a moment.',
      decision_summary: 'The visitor explicitly requested the resident.',
      confidence: event.confidence,
      notify_homeowner: true,
      requires_visual_context: false,
      policy_id: null,
    });
  }

  return agentDecisionSchema.parse({
    classification: 'unknown',
    action: 'start_visitor_conversation',
    response_text: 'Hi — I’m the home’s AI assistant. How can I help with your visit?',
    decision_summary: 'The event needs a bounded visitor conversation before action.',
    confidence: event.confidence,
    notify_homeowner: false,
    requires_visual_context: !event.visual_observation,
    policy_id: null,
  });
}

export class DoormanWorkflow {
  constructor(
    private readonly state: DoormanState,
    private readonly commandSink: CommandSink,
    private readonly planner?: DecisionPlanner,
  ) {}

  async process(event: DoormanEvent): Promise<{interactionCase: InteractionCase; duplicate: boolean}> {
    const existing = await this.state.findCaseBySourceEventId(event.source_event_id);
    if (existing) {
      return {interactionCase: existing, duplicate: true};
    }

    const policies = await this.state.listPolicies();
    const decision = await this.decide(event, policies);
    const caseId = randomUUID();
    const traceId = randomUUID();
    const createdAt = now();
    const timeline: TimelineEntry[] = [
      timelineEntry(
        'edge',
        'event.received',
        `${event.type} received from ${event.zone}.`,
        null,
        event.media_shared,
      ),
      timelineEntry(
        'agent',
        'decision.made',
        decision.decision_summary,
        decision.policy_id,
        event.media_shared,
      ),
    ];

    if (decision.action !== 'none') {
      const issuedAt = new Date();
      const command = edgeCommandSchema.parse({
        schema_version: '1.0',
        command_id: randomUUID(),
        case_id: caseId,
        trace_id: traceId,
        source_event_id: event.source_event_id,
        issued_at: issuedAt.toISOString(),
        action: decision.action,
        response_text: decision.response_text,
        expires_at: new Date(issuedAt.getTime() + 90_000).toISOString(),
        dedupe_key: `${event.source_event_id}:${decision.action}`,
      });
      await this.commandSink.publish(command);
      timeline.push(
        timelineEntry(
          'command',
          'command.published',
          `${command.action} command prepared for the edge.`,
          decision.policy_id,
          false,
        ),
      );
    }

    const interactionCase = interactionCaseSchema.parse({
      case_id: caseId,
      trace_id: traceId,
      source_event_id: event.source_event_id,
      created_at: createdAt,
      updated_at: now(),
      status: decision.notify_homeowner
        ? 'waiting'
        : decision.action === 'complete_interaction' || decision.action === 'politely_decline'
          ? 'completed'
          : 'active',
      event,
      decision,
      timeline,
    });

    await this.state.saveCase(interactionCase);
    return {interactionCase, duplicate: false};
  }

  private async decide(event: DoormanEvent, policies: Policy[]): Promise<AgentDecision> {
    const isDelivery =
      event.type === 'delivery_dropoff' || event.intent === 'delivery' || event.package_detected;
    const deliveryPolicy = enabledPolicy(policies, 'delivery_dropoff', event.confidence);
    if (isDelivery && deliveryPolicy) {
      return deliveryDecision(event, deliveryPolicy);
    }

    const isSolicitor = event.type === 'solicitor_detected' || event.intent === 'solicitor';
    const solicitorPolicy = enabledPolicy(policies, 'solicitor', event.confidence);
    if (isSolicitor && solicitorPolicy) {
      return solicitorDecision(event, solicitorPolicy);
    }

    const halloweenPolicy = enabledPolicy(policies, 'halloween', event.confidence);
    if (event.type === 'halloween_visitor' && halloweenPolicy) {
      return halloweenDecision(event, halloweenPolicy);
    }

    if (this.planner && event.type !== 'person_left') {
      return agentDecisionSchema.parse(await this.planner.decide(event, policies));
    }

    return safeFallbackDecision(event);
  }
}
