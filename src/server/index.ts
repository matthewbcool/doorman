import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ZodError} from 'zod';

import {doormanEventSchema, policySchema} from '../shared/contracts.js';
import {InMemoryCommandSink} from './commands.js';
import {eventFromPubSubPush} from './pubsub.js';
import {InMemoryDoormanState} from './state.js';
import {DoormanWorkflow} from './workflow.js';

const app = express();
const port = Number(process.env.PORT ?? 8080);
const agentMode = process.env.DOORMAN_AGENT_MODE === 'gemini' ? 'gemini' : 'rules';
const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(serverDirectory, '../../dist');

const state = new InMemoryDoormanState();
const commandSink = new InMemoryCommandSink();
const planner = agentMode === 'gemini'
  ? new (await import('../agent/index.js')).AdkDecisionPlanner()
  : undefined;
const workflow = new DoormanWorkflow(state, commandSink, planner);
const policyUpdateSchema = policySchema.partial().omit({id: true});

app.disable('x-powered-by');
app.use(express.json({limit: '1mb'}));

app.get('/api/health', (_request, response) => {
  response.json({
    service: 'doorman',
    status: 'ready',
    state_backend: 'memory',
    command_backend: 'memory',
    agent_mode: agentMode,
  });
});

app.get('/api/status', async (_request, response) => {
  const [cases, policies, commands] = await Promise.all([
    state.listCases(),
    state.listPolicies(),
    commandSink.list(),
  ]);

  response.json({
    mode: 'local',
    agent_mode: agentMode,
    cases: cases.length,
    enabled_policies: policies.filter((policy) => policy.enabled).length,
    pending_debug_commands: commands.length,
    integrations: {
      firestore: false,
      pubsub: false,
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

app.get('/api/debug/commands', async (_request, response) => {
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
  console.log(`Doorman listening on port ${port} in ${agentMode} agent mode`);
});
