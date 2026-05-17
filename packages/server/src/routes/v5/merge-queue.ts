import type { FastifyInstance } from 'fastify';
import type { WorkspaceAdapter } from '@agentforge/db';
import { GitBranchManager } from '@agentforge/core';
import type { MergeQueueItem } from '@agentforge/core';

// Module-level singleton. When mergeQueueRoutes is called with an adapter the
// singleton is replaced with an adapter-backed instance so branch state persists
// across server restarts. Exported for other routes that emit branch events.
export let branchManager = new GitBranchManager(true);

export interface MergeQueueRouteOptions {
  // Allow explicit undefined so callers can safely pass options.adapter
  // (which may be WorkspaceAdapter | undefined) under exactOptionalPropertyTypes.
  adapter?: WorkspaceAdapter | undefined;
}

export async function mergeQueueRoutes(
  app: FastifyInstance,
  opts?: MergeQueueRouteOptions,
): Promise<void> {
  // Replace the in-memory singleton with an SQLite-backed instance when an
  // adapter is available so branch history survives server restarts.
  if (opts?.adapter) {
    branchManager = new GitBranchManager(true, opts.adapter);
  }

  // GET /api/v5/branches — list all agent branches
  app.get('/api/v5/branches', async (req, reply) => {
    const q = req.query as { status?: string };
    const branches = branchManager.listBranches(q.status as any);
    return reply.send({ data: branches, meta: { ...branchManager.report(), total: branches.length } });
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
    // Guard against absent body (e.g. no Content-Type / no payload) — priority is optional.
    const priority = (req.body as any)?.priority as MergeQueueItem['priority'] | undefined;
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
