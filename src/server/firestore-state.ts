import {Firestore} from '@google-cloud/firestore';

import {
  interactionCaseSchema,
  policySchema,
  type InteractionCase,
  type Policy,
} from '../shared/contracts.js';
import {defaultPolicies, type DoormanState} from './state.js';

function isAlreadyExists(error: unknown) {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  return error.code === 6 || error.code === '6' || error.code === 'ALREADY_EXISTS';
}

export class FirestoreDoormanState implements DoormanState {
  private readonly firestore: Firestore;
  private readonly cases;
  private readonly policies;

  constructor(projectId?: string) {
    this.firestore = projectId ? new Firestore({projectId}) : new Firestore();
    this.cases = this.firestore.collection('cases');
    this.policies = this.firestore.collection('policies');
  }

  async ensureDefaultPolicies() {
    await Promise.all(
      defaultPolicies.map(async (policy) => {
        try {
          await this.policies.doc(policy.id).create(policy);
        } catch (error) {
          if (!isAlreadyExists(error)) {
            throw error;
          }
        }
      }),
    );
  }

  async findCaseBySourceEventId(sourceEventId: string) {
    const snapshot = await this.cases
      .where('source_event_id', '==', sourceEventId)
      .limit(1)
      .get();
    const document = snapshot.docs[0];
    return document ? interactionCaseSchema.parse(document.data()) : undefined;
  }

  async getCase(caseId: string) {
    const snapshot = await this.cases.doc(caseId).get();
    return snapshot.exists ? interactionCaseSchema.parse(snapshot.data()) : undefined;
  }

  async listCases() {
    const snapshot = await this.cases.orderBy('created_at', 'desc').limit(100).get();
    return snapshot.docs.map((document) => interactionCaseSchema.parse(document.data()));
  }

  async saveCase(interactionCase: InteractionCase) {
    const parsed = interactionCaseSchema.parse(interactionCase);
    await this.cases.doc(parsed.case_id).set(parsed);
  }

  async getPolicy(policyId: string) {
    const snapshot = await this.policies.doc(policyId).get();
    return snapshot.exists ? policySchema.parse(snapshot.data()) : undefined;
  }

  async listPolicies() {
    const snapshot = await this.policies.get();
    return snapshot.docs.map((document) => policySchema.parse(document.data()));
  }

  async savePolicy(policy: Policy) {
    const parsed = policySchema.parse(policy);
    await this.policies.doc(parsed.id).set(parsed);
  }
}
