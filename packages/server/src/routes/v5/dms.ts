/**
 * Direct-message REST routes (v1) — see `docs/v2-architecture/agent-comm-and-kb-spec.md`.
 *
 *   POST  /api/v5/dms              — create a DM
 *   GET   /api/v5/dms?agentId=X    — list DMs touching that agent (sent or received)
 *   GET   /api/v5/dms/threads      — same list grouped into reply chains
 *
 * v1 explicitly does NOT expose a "mark read" endpoint; the runtime owns
 * read-acknowledgement via `delivered_at` (ADR 0001). Adding `PATCH /:id/read`
 * is part of the v2 reply UX.
 */

import type { FastifyInstance } from 'fastify';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sendDirectMessage,
  listDirectMessagesForAgent,
  groupDirectMessagesIntoThreads,
} from '@agentforge/core';
import type { WorkspaceAdapter } from '@agentforge/db';
import { openAuditDb, appendAuditEntry } from './audit.js';
import { nowIso } from '@agentforge/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = join(__dirname, '../../../../../');

export interface DmsRouteOptions {
  adapter: WorkspaceAdapter;
  /** Project root for audit log resolution. Falls back to monorepo root. */
  projectRoot?: string;
}

interface PostDmBody {
  fromAgent?: string;
  toAgent?: string;
  body?: string;
  replyToId?: string;
}

interface ListDmsQuery {
  agentId?: string;
  limit?: string;
  offset?: string;
}

export async function dmsRoutes(app: FastifyInstance, opts: DmsRouteOptions): Promise<void> {
  const { adapter } = opts;
  const projectRoot = opts.projectRoot ?? DEFAULT_PROJECT_ROOT;
  const auditDb = openAuditDb(projectRoot);

  app.addHook('onClose', async () => {
    auditDb.close();
  });

  // POST /api/v5/dms
  app.post('/api/v5/dms', async (req, reply) => {
    const body = req.body as PostDmBody;
    if (!body?.fromAgent || !body.toAgent || !body.body) {
      return reply.status(400).send({
        error: 'fromAgent, toAgent, and body are required',
      });
    }

    try {
      const dm = sendDirectMessage(adapter, {
        from: body.fromAgent,
        to: body.toAgent,
        body: body.body,
        ...(body.replyToId ? { replyToId: body.replyToId } : {}),
      });
      appendAuditEntry(auditDb, {
        actor: body.fromAgent,
        action: 'dm.send',
        target: body.toAgent,
        details: { dmId: dm.id, replyToId: dm.replyToId },
      });
      return reply.status(201).send({ data: dm, meta: { timestamp: nowIso() } });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed to send DM';
      return reply.status(400).send({ error: message });
    }
  });

  // GET /api/v5/dms?agentId=X
  app.get('/api/v5/dms', async (req, reply) => {
    const q = req.query as ListDmsQuery;
    if (!q.agentId) {
      return reply.status(400).send({ error: 'agentId query parameter is required' });
    }
    const limit = q.limit ? Math.min(parseInt(q.limit, 10), 500) : 100;
    const offset = q.offset ? parseInt(q.offset, 10) : 0;
    const data = listDirectMessagesForAgent(adapter, q.agentId, { limit, offset });
    return reply.send({
      data,
      meta: {
        total: data.length,
        agentId: q.agentId,
        limit,
        offset,
        timestamp: nowIso(),
      },
    });
  });

  // GET /api/v5/dms/threads?agentId=X
  app.get('/api/v5/dms/threads', async (req, reply) => {
    const q = req.query as ListDmsQuery;
    if (!q.agentId) {
      return reply.status(400).send({ error: 'agentId query parameter is required' });
    }
    const data = listDirectMessagesForAgent(adapter, q.agentId, { limit: 500 });
    const threads = groupDirectMessagesIntoThreads(data);
    return reply.send({
      data: threads,
      meta: {
        total: threads.length,
        agentId: q.agentId,
        timestamp: nowIso(),
      },
    });
  });
}
