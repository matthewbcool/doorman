import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {z, ZodError} from 'zod';

import {
  doormanEventSchema,
  edgeCommandSchema,
  interactionCaseSchema,
  policySchema,
} from '../shared/contracts.js';
import {InMemoryCommandSink, type CommandSink} from './commands.js';
import {eventFromPubSubPush} from './pubsub.js';
import {InMemoryDoormanState, type DoormanState} from './state.js';
import {DoormanWorkflow} from './workflow.js';

const app = express();
const port = Number(process.env.PORT ?? 8080);
const agentMode = process.env.DOORMAN_AGENT_MODE === 'gemini' ? 'gemini' : 'rules';
const stateBackend = process.env.DOORMAN_STATE_BACKEND === 'firestore' ? 'firestore' : 'memory';
const commandBackend = process.env.DOORMAN_COMMAND_BACKEND === 'pubsub' ? 'pubsub' : 'memory';
const projectId = process.env.GOOGLE_CLOUD_PROJECT;
const commandTopic = process.env.DOORMAN_COMMAND_TOPIC ?? 'doorman.commands';
const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(serverDirectory, '../../dist');

async function createState(): Promise<DoormanState> {
  if (stateBackend === 'memory') {
    return new InMemoryDoormanState();
  }

  const {FirestoreDoormanState} = await import('./firestore-state.js');
  const firestoreState = new FirestoreDoormanState(projectId);
  await firestoreState.ensureDefaultPolicies();
  return firestoreState;
}

async function createCommandSink(): Promise<CommandSink> {
  if (commandBackend === 'memory') {
    return new InMemoryCommandSink();
  }

  const {PubSubCommandSink} = await import('./pubsub-commands.js');
  return new PubSubCommandSink(commandTopic, projectId);
}

const state = await createState();
const commandSink = await createCommandSink();
const planner = agentMode === 'gemini'
  ? new (await import('../agent/index.js')).AdkDecisionPlanner()
  : undefined;
const workflow = new DoormanWorkflow(state, commandSink, planner);
const policyUpdateSchema = policySchema.partial().omit({id: true});
const homeownerActionSchema = z.discriminatedUnion('action', [
  z.object({action: z.literal('thank_visitor')}),
  z.object({action: z.literal('ask_to_wait')}),
  z.object({action: z.literal('relay_message'), message: z.string().trim().min(1).max(300)}),
  z.object({action: z.literal('end_interaction')}),
]);

app.disable('x-powered-by');
app.use(express.json({limit: '1mb'}));

app.get('/api/health', (_request, response) => {
  response.json({
    service: 'doorman',
    status: 'ready',
    state_backend: stateBackend,
    command_backend: commandBackend,
    agent_mode: agentMode,
  });
});

app.get('/api/status', async (_request, response) => {
  const [cases, policies, commands] = await Promise.all([
    state.listCases(),
    state.listPolicies(),
    commandSink.list?.() ?? Promise.resolve(null),
  ]);

  response.json({
    mode: stateBackend === 'memory' && commandBackend === 'memory' ? 'local' : 'cloud',
    agent_mode: agentMode,
    cases: cases.length,
    enabled_policies: policies.filter((policy) => policy.enabled).length,
    pending_debug_commands: commands?.length ?? null,
    integrations: {
      firestore: stateBackend === 'firestore',
      pubsub: commandBackend === 'pubsub',
      gemini: agentMode === 'gemini',
      frigate: false,
      edge: false,
    },
  });
});

app.get('/api/cases', async (_request, response) => {
  response.json({items: await state.listCases()});
});

app.get('/api/cases/:caseId', async (request, response) => {
  const interactionCase = await state.getCase(request.params.caseId);
  if (!interactionCase) {
    response.status(404).json({error: 'case_not_found'});
    return;
  }
  response.json(interactionCase);
});

app.get('/api/policies', async (_request, response) => {
  response.json({items: await state.listPolicies()});
});

app.put('/api/policies/:policyId', async (request, response) => {
  const current = await state.getPolicy(request.params.policyId);
  if (!current) {
    response.status(404).json({error: 'policy_not_found'});
    return;
  }

  const update = policyUpdateSchema.parse(request.body);
  const policy = policySchema.parse({...current, ...update, id: current.id});
  await state.savePolicy(policy);
  response.json(policy);
});

app.post('/api/cases/:caseId/actions', async (request, response) => {
  const interactionCase = await state.getCase(request.params.caseId);
  if (!interactionCase) {
    response.status(404).json({error: 'case_not_found'});
    return;
  }

  const actionRequest = homeownerActionSchema.parse(request.body);
  const issuedAt = new Date();
  const responseText =
    actionRequest.action === 'thank_visitor'
      ? 'The homeowner says: Thank you for letting us know.'
      : actionRequest.action === 'ask_to_wait'
        ? 'The homeowner is checking now. Please wait a moment.'
        : actionRequest.action === 'relay_message'
          ? actionRequest.message
          : '';
  const command = edgeCommandSchema.parse({
    schema_version: '1.0',
    command_id: randomUUID(),
    case_id: interactionCase.case_id,
    trace_id: interactionCase.trace_id,
    source_event_id: interactionCase.source_event_id,
    issued_at: issuedAt.toISOString(),
    action:
      actionRequest.action === 'end_interaction'
        ? 'complete_interaction'
        : 'relay_homeowner_message',
    response_text: responseText,
    expires_at: new Date(issuedAt.getTime() + 90_000).toISOString(),
    dedupe_key: `homeowner:${interactionCase.case_id}:${issuedAt.getTime()}`,
  });

  await commandSink.publish(command);
  const updatedCase = interactionCaseSchema.parse({
    ...interactionCase,
    updated_at: issuedAt.toISOString(),
    status: actionRequest.action === 'end_interaction' ? 'completed' : 'waiting',
    timeline: [
      ...interactionCase.timeline,
      {
        id: randomUUID(),
        occurred_at: issuedAt.toISOString(),
        layer: 'command',
        type: 'homeowner.action_published',
        summary:
          actionRequest.action === 'relay_message'
            ? 'Homeowner sent a message for Doorman to relay.'
            : `Homeowner selected ${actionRequest.action.replaceAll('_', ' ')}.`,
        policy_id: null,
        media_shared: false,
      },
    ],
  });
  await state.saveCase(updatedCase);
  response.status(202).json({command_id: command.command_id, interactionCase: updatedCase});
});

app.get('/api/debug/commands', async (_request, response) => {
  if (!commandSink.list) {
    response.status(404).json({error: 'debug_commands_unavailable'});
    return;
  }
  response.json({items: await commandSink.list()});
});

app.post('/api/events', async (request, response) => {
  const event = doormanEventSchema.parse(request.body);
  const result = await workflow.process(event);
  response.status(result.duplicate ? 200 : 201).json(result);
});

app.post('/api/events/pubsub', async (request, response) => {
  const event = eventFromPubSubPush(request.body);
  await workflow.process(event);
  response.status(204).send();
});

app.use(express.static(webDirectory));
app.get('/{*splat}', (_request, response) => {
  response.sendFile(path.join(webDirectory, 'index.html'));
});

const errorHandler: ErrorRequestHandler = (
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction,
) => {
  if (error instanceof ZodError) {
    response.status(400).json({
      error: 'invalid_request',
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
    return;
  }

  console.error(error);
  response.status(500).json({error: 'internal_error'});
};

app.use(errorHandler);

app.listen(port, () => {
  console.log(
    `Doorman listening on port ${port} with ${agentMode}/${stateBackend}/${commandBackend}`,
  );
});
