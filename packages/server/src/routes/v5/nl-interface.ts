import type { FastifyInstance } from 'fastify';
import { NLCommander, IntentClassifier } from '@agentforge/core';

const commander = new NLCommander();
const classifier = new IntentClassifier();

export async function nlInterfaceRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v5/nl/parse
  app.post('/api/v5/nl/parse', async (req, reply) => {
    const body = req.body as { input?: string };
    if (!body?.input) {
      return reply.status(400).send({ error: 'input is required', code: 'MISSING_FIELD' });
    }

    const result = commander.parse(body.input);

    return reply.send({
      data: result,
      meta: { timestamp: new Date().toISOString() },
    });
  });

  // POST /api/v5/nl/execute
  app.post('/api/v5/nl/execute', async (req, reply) => {
    const body = req.body as { input?: string };
    if (!body?.input) {
      return reply.status(400).send({ error: 'input is required', code: 'MISSING_FIELD' });
    }

    const result = commander.parse(body.input);

    if (!result.action) {
      return reply.send({
        data: {
          ...result,
          executionResult: null,
          message: 'No action mapped for intent: ' + result.parsed.intent,
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    // For the execute endpoint we return the action descriptor
    // (real execution would forward to the mapped route)
    return reply.send({
      data: {
        ...result,
        executionResult: {
          actionDispatched: result.action,
          status: 'dispatched',
        },
      },
      meta: { timestamp: new Date().toISOString() },
    });
  });

  // GET /api/v5/nl/intents
  app.get('/api/v5/nl/intents', async (_req, reply) => {
    const intents = classifier.listIntents();
    return reply.send({
      data: intents.map(intent => ({
        intent,
        description: INTENT_DESCRIPTIONS[intent] ?? intent,
      })),
      meta: { total: intents.length, timestamp: new Date().toISOString() },
    });
  });
}

const INTENT_DESCRIPTIONS: Record<string, string> = {
  run_agent: 'Execute a named agent',
  get_status: 'Get system or agent health status',
  list_agents: 'List all available agents',
  show_cost: 'Show cost and budget information',
  create_workflow: 'Create a new workflow or pipeline',
  query_knowledge: 'Search or query the knowledge graph',
  get_sprint: 'Get sprint planning information',
  unknown: 'Intent could not be determined',
};
