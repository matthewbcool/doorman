import {policySchema, type InteractionCase, type Policy} from '../shared/contracts.js';

export const defaultPolicies: Policy[] = [
  policySchema.parse({
    id: 'delivery_dropoff',
    name: 'Delivery drop-off',
    enabled: true,
    minimum_confidence: 0.85,
    action: 'play_cached_clip',
    response_text: 'Thanks so much — have a great day!',
    notify: 'summary',
    dedupe_seconds: 120,
    visual_input: 'single_face_redacted_frame',
  }),
  policySchema.parse({
    id: 'solicitor',
    name: 'Solicitors',
    enabled: true,
    minimum_confidence: 0.85,
    action: 'politely_decline',
    response_text: 'Thanks for stopping by, but the household is not interested. Have a good day.',
    notify: 'never_unless_escalated',
    dedupe_seconds: 0,
    visual_input: 'none',
  }),
  policySchema.parse({
    id: 'halloween',
    name: 'Halloween mode',
    enabled: false,
    minimum_confidence: 0.75,
    action: 'friendly_costume_comment',
    response_text: 'Happy Halloween!',
    notify: 'summary',
    dedupe_seconds: 0,
    visual_input: 'single_face_redacted_frame',
  }),
];

export interface DoormanState {
  findCaseBySourceEventId(sourceEventId: string): Promise<InteractionCase | undefined>;
  getCase(caseId: string): Promise<InteractionCase | undefined>;
  listCases(): Promise<InteractionCase[]>;
  saveCase(interactionCase: InteractionCase): Promise<void>;
  getPolicy(policyId: string): Promise<Policy | undefined>;
  listPolicies(): Promise<Policy[]>;
  savePolicy(policy: Policy): Promise<void>;
}

export class InMemoryDoormanState implements DoormanState {
  private readonly cases = new Map<string, InteractionCase>();
  private readonly policies = new Map<string, Policy>(
    defaultPolicies.map((policy) => [policy.id, structuredClone(policy)]),
  );

  async findCaseBySourceEventId(sourceEventId: string) {
    const interactionCase = [...this.cases.values()].find(
      (candidate) => candidate.source_event_id === sourceEventId,
    );
    return interactionCase ? structuredClone(interactionCase) : undefined;
  }

  async getCase(caseId: string) {
    const interactionCase = this.cases.get(caseId);
    return interactionCase ? structuredClone(interactionCase) : undefined;
  }

  async listCases() {
    return [...this.cases.values()]
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .map((interactionCase) => structuredClone(interactionCase));
  }

  async saveCase(interactionCase: InteractionCase) {
    this.cases.set(interactionCase.case_id, structuredClone(interactionCase));
  }

  async getPolicy(policyId: string) {
    const policy = this.policies.get(policyId);
    return policy ? structuredClone(policy) : undefined;
  }

  async listPolicies() {
    return [...this.policies.values()].map((policy) => structuredClone(policy));
  }

  async savePolicy(policy: Policy) {
    this.policies.set(policy.id, structuredClone(policy));
  }
}
