import type { FastifyInstance } from 'fastify';
import { GitBranchManager } from '@agentforge/core';

const branchManager = new GitBranchManager(true); // dry-run singleton

export { branchManager }; // exported so other routes can emit branch events

export async function mergeQueueRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v5/branches — list all agent branches
  app.get('/api/v5/branches', async (req, reply) => {
    const q = req.query as { status?: string };
    const branches = branchManager.listBranches(q.status as any);
    return reply.send({ data: branches, meta: { total: branches.length, ...branchManager.report() } });
  });

  // POST /api/v5/branches — create a new agent branch
  app.post('/api/v5/branches', async (req, reply) => {
    const { agentId, taskId, targetBranch } = req.body as any;
    if (!agentId || !taskId) return reply.status(400).send({ error: 'agentId and taskId required' });
    const branch = branchManager.createBranch(agentId, taskId, targetBranch);
    return reply.status(201).send({ data: branch });
  });

  // GET /api/v5/merge-queue — list the merge queue
  app.get('/api/v5/merge-queue', async (req, reply) => {
    const q = req.query as { status?: string };
    const queue = branchManager.getMergeQueue(q.status as any);
    return reply.send({ data: queue, meta: { total: queue.length } });
  });

  // POST /api/v5/branches/:id/submit — submit for review
  app.post<{ Params: { id: string } }>('/api/v5/branches/:id/submit', async (req, reply) => {
    const { priority } = req.body as any;
    try {
      const item = branchManager.submitForReview(req.params.id, priority ?? 'P1');
      return reply.status(201).send({ data: item });
    } catch (err) {
      return reply.status(404).send({ error: String(err) });
    }
  });

  // POST /api/v5/branches/:id/merge — merge a branch
  app.post<{ Params: { id: string } }>('/api/v5/branches/:id/merge', async (req, reply) => {
    try {
      const branch = branchManager.mergeBranch(req.params.id);
      return reply.send({ data: branch });
    } catch (err) {
      return reply.status(404).send({ error: String(err) });
    }
  });

  // POST /api/v5/branches/:id/conflict — mark conflict
  app.post<{ Params: { id: string } }>('/api/v5/branches/:id/conflict', async (req, reply) => {
    const { info } = req.body as { info?: string };
    branchManager.markConflict(req.params.id, info ?? 'Conflict detected');
    return reply.send({ ok: true });
  });

  // GET /api/v5/branches/report — summary stats
  app.get('/api/v5/branches/report', async (_req, reply) => {
    return reply.send({ data: branchManager.report() });
  });
}
