/**
 * Central-inbox REST routes (v1) — see `docs/v2-architecture/agent-comm-and-kb-spec.md`.
 *
 *   POST   /api/v5/inbox                       — internal create
 *   GET    /api/v5/inbox?recipient=@user[&status=unread]
 *   GET    /api/v5/inbox/:id
 *   PATCH  /api/v5/inbox/:id/read?recipient=@user
 *
 * v1 limits enforced here and in the core helper: `recipient` must be `@user`.
 * `@team-*` resolution + multi-recipient mutations land in v2.
 */

import type { FastifyInstance } from 'fastify';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sendInboxMessage,
  listInboxForRecipient,
  getInboxMessage,
  markInboxRead,
  countUnread,
  resolveTeamRecipients,
  UnsupportedRecipientError,
  type InboxKind,
  type InboxStatus,
  type MessageBusV2,
} from '@agentforge/core';
import type { WorkspaceAdapter } from '@agentforge/db';
import { openAuditDb, appendAuditEntry } from './audit.js';
import { nowIso } from '@agentforge/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = join(__dirname, '../../../../../');

export interface InboxRouteOptions {
  adapter: WorkspaceAdapter;
  projectRoot?: string;
  /**
   * Optional bus. When provided, inbox writes publish
   * `inbox.message.created` so SSE consumers refresh live (Phase 2).
   */
  bus?: MessageBusV2;
}

interface PostInboxBody {
  body?: string;
  kind?: string;
  sourceId?: string;
  sourceType?: string;
  threadId?: string;
  recipients?: string[];
}

interface ListInboxQuery {
  recipient?: string;
  status?: string;
  limit?: string;
  offset?: string;
}

interface PatchReadQuery {
  recipient?: string;
}

const VALID_KINDS: ReadonlySet<string> = new Set(['info', 'warning', 'action_required']);
const VALID_STATUS: ReadonlySet<string> = new Set(['unread', 'read', 'archived', 'all']);

export async function inboxRoutes(app: FastifyInstance, opts: InboxRouteOptions): Promise<void> {
  const { adapter } = opts;
  const projectRoot = opts.projectRoot ?? DEFAULT_PROJECT_ROOT;
  const auditDb = openAuditDb(projectRoot);

  app.addHook('onClose', async () => {
    auditDb.close();
  });

  // POST /api/v5/inbox
  app.post('/api/v5/inbox', async (req, reply) => {
    const body = req.body as PostInboxBody;
    if (!body?.body || !body.kind || !VALID_KINDS.has(body.kind)) {
      return reply.status(400).send({
        error: 'body and a valid kind ("info" | "warning" | "action_required") are required',
      });
    }
    if (!Array.isArray(body.recipients) || body.recipients.length === 0) {
      return reply.status(400).send({ error: 'recipients must be a non-empty array' });
    }

    const agentforgeDir = join(projectRoot, '.agentforge');
    try {
      const result = sendInboxMessage(
        adapter,
        {
          body: body.body,
          kind: body.kind as InboxKind,
          ...(body.sourceId !== undefined ? { sourceId: body.sourceId } : {}),
          ...(body.sourceType !== undefined ? { sourceType: body.sourceType } : {}),
          ...(body.threadId !== undefined ? { threadId: body.threadId } : {}),
          recipients: body.recipients,
        },
        {
          ...(opts.bus ? { bus: opts.bus } : {}),
          // Phase 2: expand `@team-*` aliases against
          // `.agentforge/agents/*.yaml` + `team.yaml`. The helper returns
          // `null` for non-team-alias inputs (preserving the v1 `@user`
          // invariant in the core layer) and an empty array for unknown
          // aliases (treated as bad-request by `sendInboxMessage`).
          expandRecipients: (recipient: string) =>
            resolveTeamRecipients(agentforgeDir, recipient),
        },
      );
      appendAuditEntry(auditDb, {
        actor: body.sourceType ?? 'system',
        action: 'inbox.send',
        target: body.recipients.join(','),
        details: {
          messageId: result.message.id,
          kind: result.message.kind,
          sourceId: result.message.sourceId,
        },
      });
      return reply.status(201).send({ data: result, meta: { timestamp: nowIso() } });
    } catch (err) {
      if (err instanceof UnsupportedRecipientError) {
        return reply.status(400).send({ error: err.message });
      }
      const message = err instanceof Error ? err.message : 'failed to create inbox message';
      return reply.status(400).send({ error: message });
    }
  });

  // GET /api/v5/inbox?recipient=@user
  app.get('/api/v5/inbox', async (req, reply) => {
    const q = req.query as ListInboxQuery;
    if (!q.recipient) {
      return reply.status(400).send({ error: 'recipient query parameter is required' });
    }
    if (q.status && !VALID_STATUS.has(q.status)) {
      return reply.status(400).send({ error: `status must be one of: ${[...VALID_STATUS].join(', ')}` });
    }
    const limit = q.limit ? Math.min(parseInt(q.limit, 10), 500) : 100;
    const offset = q.offset ? parseInt(q.offset, 10) : 0;

    try {
      const data = listInboxForRecipient(adapter, q.recipient, {
        status: (q.status as InboxStatus | 'all') ?? 'all',
        limit,
        offset,
      });
      const unread = countUnread(adapter, q.recipient);
      return reply.send({
        data,
        meta: {
          total: data.length,
          unread,
          recipient: q.recipient,
          limit,
          offset,
          timestamp: nowIso(),
        },
      });
    } catch (err) {
      if (err instanceof UnsupportedRecipientError) {
        return reply.status(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // GET /api/v5/inbox/:id
  app.get<{ Params: { id: string } }>('/api/v5/inbox/:id', async (req, reply) => {
    const result = getInboxMessage(adapter, req.params.id);
    if (!result) {
      return reply.status(404).send({ error: 'Inbox message not found' });
    }
    return reply.send({ data: result, meta: { timestamp: nowIso() } });
  });

  // PATCH /api/v5/inbox/:id/read?recipient=@user
  app.patch<{ Params: { id: string }; Querystring: PatchReadQuery }>(
    '/api/v5/inbox/:id/read',
    async (req, reply) => {
      const recipient = req.query.recipient;
      if (!recipient) {
        return reply.status(400).send({ error: 'recipient query parameter is required' });
      }
      const message = adapter.getInboxMessage(req.params.id);
      if (!message) {
        return reply.status(404).send({ error: 'Inbox message not found' });
      }
      try {
        const updated = markInboxRead(adapter, req.params.id, recipient);
        if (!updated) {
          return reply
            .status(404)
            .send({ error: `Recipient "${recipient}" not found on message "${req.params.id}"` });
        }
        appendAuditEntry(auditDb, {
          actor: recipient,
          action: 'inbox.read',
          target: req.params.id,
          details: { readAt: updated.readAt },
        });
        return reply.send({ data: updated, meta: { timestamp: nowIso() } });
      } catch (err) {
        if (err instanceof UnsupportedRecipientError) {
          return reply.status(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );
}
