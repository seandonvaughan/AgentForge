import type { FastifyInstance } from 'fastify';
import { WorkflowRunner } from '@agentforge/core';
import type { WorkflowDefinition } from '@agentforge/core';

const runner = new WorkflowRunner(); // dry-run by default

export async function workflowRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v5/workflows/run — execute a workflow definition
  app.post('/api/v5/workflows/run', async (req, reply) => {
    const definition = req.body as WorkflowDefinition;

    if (!definition?.id || !Array.isArray(definition.steps)) {
      return reply.status(400).send({ error: 'Valid workflow definition with id and steps is required' });
    }

    const result = await runner.run(definition);
    return reply.status(result.status === 'completed' ? 200 : 422).send({ data: result });
  });

  // POST /api/v5/workflows/validate — validate a workflow definition without running
  app.post('/api/v5/workflows/validate', async (req, reply) => {
    const definition = req.body as WorkflowDefinition;
    const errors: string[] = [];

    if (!definition?.id) errors.push('id is required');
    if (!Array.isArray(definition?.steps)) errors.push('steps must be an array');
    if (definition?.steps?.length === 0) errors.push('steps must not be empty');

    return reply.send({
      valid: errors.length === 0,
      errors,
      stepCount: definition?.steps?.length ?? 0,
    });
  });
}
