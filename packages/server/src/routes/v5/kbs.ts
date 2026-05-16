/**
 * Knowledge Bases REST routes (Subsystem C v1) — see
 * `docs/v2-architecture/agent-comm-and-kb-spec.md` section 5.
 *
 *   GET    /api/v5/kbs
 *   POST   /api/v5/kbs
 *   GET    /api/v5/kbs/:kbId
 *   PATCH  /api/v5/kbs/:kbId
 *   DELETE /api/v5/kbs/:kbId
 *   GET    /api/v5/kbs/:kbId/docs
 *   POST   /api/v5/kbs/:kbId/docs
 *   GET    /api/v5/kbs/:kbId/docs/:docSlug
 *   PATCH  /api/v5/kbs/:kbId/docs/:docSlug
 *   GET    /api/v5/kbs/:kbId/docs/:docSlug/versions
 *   GET    /api/v5/kbs/:kbId/docs/:docSlug/versions/:v
 *
 * v1 ACL: read-all + write-requires-authenticated. Visibility metadata is
 * persisted but NOT enforced by the route handlers — Phase 2 work.
 */

import type { FastifyInstance } from 'fastify';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createKb,
  listKbs,
  getKb,
  updateKb,
  deleteKb,
  createKbDoc,
  listKbDocs,
  getKbDoc,
  updateKbDoc,
  getKbDocVersionHistory,
  getKbDocAtVersion,
  type KbVisibility,
} from '@agentforge/core';
import type { WorkspaceAdapter } from '@agentforge/db';
import { openAuditDb, appendAuditEntry } from './audit.js';
import { nowIso } from '@agentforge/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = join(__dirname, '../../../../../');

export interface KbRouteOptions {
  adapter: WorkspaceAdapter;
  projectRoot?: string;
}

interface PostKbBody {
  slug?: string;
  title?: string;
  description?: string;
  owner?: string;
  visibility?: string;
}

interface PatchKbBody {
  title?: string;
  description?: string | null;
  visibility?: string;
}

interface ListKbsQuery {
  visibility?: string;
  owner?: string;
  limit?: string;
  offset?: string;
}

interface PostKbDocBody {
  slug?: string;
  title?: string;
  bodyMd?: string;
  authoredBy?: string;
  commitMessage?: string;
}

interface PatchKbDocBody {
  bodyMd?: string;
  authoredBy?: string;
  commitMessage?: string;
  title?: string;
}

const VALID_VISIBILITY: ReadonlySet<string> = new Set(['private', 'workspace', 'public']);

export async function kbsRoutes(app: FastifyInstance, opts: KbRouteOptions): Promise<void> {
  const { adapter } = opts;
  const projectRoot = opts.projectRoot ?? DEFAULT_PROJECT_ROOT;
  const auditDb = openAuditDb(projectRoot);

  app.addHook('onClose', async () => {
    auditDb.close();
  });

  // ── KBs ─────────────────────────────────────────────────────────────────

  // GET /api/v5/kbs
  app.get('/api/v5/kbs', async (req, reply) => {
    const q = req.query as ListKbsQuery;
    if (q.visibility !== undefined && !VALID_VISIBILITY.has(q.visibility)) {
      return reply.status(400).send({
        error: `visibility must be one of: ${[...VALID_VISIBILITY].join(', ')}`,
      });
    }
    const limit = q.limit ? Math.min(parseInt(q.limit, 10), 500) : 200;
    const offset = q.offset ? parseInt(q.offset, 10) : 0;
    const data = listKbs(adapter, {
      ...(q.visibility !== undefined ? { visibility: q.visibility as KbVisibility } : {}),
      ...(q.owner !== undefined ? { owner: q.owner } : {}),
      limit,
      offset,
    });
    return reply.send({
      data,
      meta: { total: data.length, limit, offset, timestamp: nowIso() },
    });
  });

  // POST /api/v5/kbs
  app.post('/api/v5/kbs', async (req, reply) => {
    const body = req.body as PostKbBody;
    if (!body?.slug || !body.title || !body.owner) {
      return reply.status(400).send({ error: 'slug, title, and owner are required' });
    }
    if (body.visibility !== undefined && !VALID_VISIBILITY.has(body.visibility)) {
      return reply.status(400).send({
        error: `visibility must be one of: ${[...VALID_VISIBILITY].join(', ')}`,
      });
    }
    try {
      const kb = createKb(adapter, {
        slug: body.slug,
        title: body.title,
        owner: body.owner,
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.visibility !== undefined
          ? { visibility: body.visibility as KbVisibility }
          : {}),
      });
      appendAuditEntry(auditDb, {
        actor: body.owner,
        action: 'kb.create',
        target: kb.id,
        details: { slug: kb.slug, visibility: kb.visibility },
      });
      return reply.status(201).send({ data: kb, meta: { timestamp: nowIso() } });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed to create KB';
      return reply.status(400).send({ error: message });
    }
  });

  // GET /api/v5/kbs/:kbId
  app.get<{ Params: { kbId: string } }>('/api/v5/kbs/:kbId', async (req, reply) => {
    const kb = getKb(adapter, req.params.kbId);
    if (!kb) return reply.status(404).send({ error: 'KB not found' });
    const docCount = adapter.countKbDocs(kb.id);
    return reply.send({
      data: kb,
      meta: { docCount, timestamp: nowIso() },
    });
  });

  // PATCH /api/v5/kbs/:kbId
  app.patch<{ Params: { kbId: string } }>('/api/v5/kbs/:kbId', async (req, reply) => {
    const body = req.body as PatchKbBody;
    if (body.visibility !== undefined && !VALID_VISIBILITY.has(body.visibility)) {
      return reply.status(400).send({
        error: `visibility must be one of: ${[...VALID_VISIBILITY].join(', ')}`,
      });
    }
    try {
      const kb = updateKb(adapter, req.params.kbId, {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.visibility !== undefined
          ? { visibility: body.visibility as KbVisibility }
          : {}),
      });
      if (!kb) return reply.status(404).send({ error: 'KB not found' });
      appendAuditEntry(auditDb, {
        actor: 'system',
        action: 'kb.update',
        target: kb.id,
        details: body as Record<string, unknown>,
      });
      return reply.send({ data: kb, meta: { timestamp: nowIso() } });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed to update KB';
      return reply.status(400).send({ error: message });
    }
  });

  // DELETE /api/v5/kbs/:kbId
  app.delete<{ Params: { kbId: string } }>('/api/v5/kbs/:kbId', async (req, reply) => {
    const existing = getKb(adapter, req.params.kbId);
    if (!existing) return reply.status(404).send({ error: 'KB not found' });
    deleteKb(adapter, req.params.kbId);
    appendAuditEntry(auditDb, {
      actor: 'system',
      action: 'kb.delete',
      target: req.params.kbId,
      details: { slug: existing.slug },
    });
    return reply.status(204).send();
  });

  // ── KB Documents ──────────────────────────────────────────────────────────

  // GET /api/v5/kbs/:kbId/docs
  app.get<{ Params: { kbId: string } }>('/api/v5/kbs/:kbId/docs', async (req, reply) => {
    const kb = getKb(adapter, req.params.kbId);
    if (!kb) return reply.status(404).send({ error: 'KB not found' });
    const docs = listKbDocs(adapter, req.params.kbId);
    return reply.send({
      data: docs,
      meta: { total: docs.length, timestamp: nowIso() },
    });
  });

  // POST /api/v5/kbs/:kbId/docs
  app.post<{ Params: { kbId: string } }>('/api/v5/kbs/:kbId/docs', async (req, reply) => {
    const body = req.body as PostKbDocBody;
    if (!body?.slug || !body.title || !body.bodyMd || !body.authoredBy) {
      return reply
        .status(400)
        .send({ error: 'slug, title, bodyMd, and authoredBy are required' });
    }
    const kb = getKb(adapter, req.params.kbId);
    if (!kb) return reply.status(404).send({ error: 'KB not found' });
    try {
      const doc = createKbDoc(adapter, req.params.kbId, {
        slug: body.slug,
        title: body.title,
        bodyMd: body.bodyMd,
        authoredBy: body.authoredBy,
        ...(body.commitMessage !== undefined ? { commitMessage: body.commitMessage } : {}),
      });
      appendAuditEntry(auditDb, {
        actor: body.authoredBy,
        action: 'kb.doc.create',
        target: doc.id,
        details: { kbId: kb.id, slug: doc.slug, version: doc.currentVersion },
      });
      return reply.status(201).send({ data: doc, meta: { timestamp: nowIso() } });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed to create doc';
      return reply.status(400).send({ error: message });
    }
  });

  // GET /api/v5/kbs/:kbId/docs/:docSlug
  app.get<{ Params: { kbId: string; docSlug: string } }>(
    '/api/v5/kbs/:kbId/docs/:docSlug',
    async (req, reply) => {
      const kb = getKb(adapter, req.params.kbId);
      if (!kb) return reply.status(404).send({ error: 'KB not found' });
      const doc = getKbDoc(adapter, req.params.kbId, req.params.docSlug);
      if (!doc) return reply.status(404).send({ error: 'Doc not found' });
      return reply.send({ data: doc, meta: { timestamp: nowIso() } });
    },
  );

  // PATCH /api/v5/kbs/:kbId/docs/:docSlug — appends a new version
  app.patch<{ Params: { kbId: string; docSlug: string } }>(
    '/api/v5/kbs/:kbId/docs/:docSlug',
    async (req, reply) => {
      const body = req.body as PatchKbDocBody;
      if (!body?.bodyMd || !body.authoredBy) {
        return reply.status(400).send({ error: 'bodyMd and authoredBy are required' });
      }
      const kb = getKb(adapter, req.params.kbId);
      if (!kb) return reply.status(404).send({ error: 'KB not found' });
      try {
        const doc = updateKbDoc(adapter, req.params.kbId, req.params.docSlug, {
          bodyMd: body.bodyMd,
          authoredBy: body.authoredBy,
          ...(body.commitMessage !== undefined ? { commitMessage: body.commitMessage } : {}),
          ...(body.title !== undefined ? { title: body.title } : {}),
        });
        if (!doc) return reply.status(404).send({ error: 'Doc not found' });
        appendAuditEntry(auditDb, {
          actor: body.authoredBy,
          action: 'kb.doc.update',
          target: doc.id,
          details: {
            kbId: kb.id,
            slug: doc.slug,
            version: doc.currentVersion,
            commitMessage: body.commitMessage ?? null,
          },
        });
        return reply.send({ data: doc, meta: { timestamp: nowIso() } });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'failed to update doc';
        return reply.status(400).send({ error: message });
      }
    },
  );

  // GET /api/v5/kbs/:kbId/docs/:docSlug/versions
  app.get<{ Params: { kbId: string; docSlug: string } }>(
    '/api/v5/kbs/:kbId/docs/:docSlug/versions',
    async (req, reply) => {
      const kb = getKb(adapter, req.params.kbId);
      if (!kb) return reply.status(404).send({ error: 'KB not found' });
      const docRow = adapter.getKbDocBySlug(req.params.kbId, req.params.docSlug);
      if (!docRow) return reply.status(404).send({ error: 'Doc not found' });
      const versions = getKbDocVersionHistory(adapter, docRow.id);
      return reply.send({
        data: versions,
        meta: { total: versions.length, timestamp: nowIso() },
      });
    },
  );

  // GET /api/v5/kbs/:kbId/docs/:docSlug/versions/:v
  app.get<{ Params: { kbId: string; docSlug: string; v: string } }>(
    '/api/v5/kbs/:kbId/docs/:docSlug/versions/:v',
    async (req, reply) => {
      const versionNumber = parseInt(req.params.v, 10);
      if (!Number.isFinite(versionNumber) || versionNumber < 1) {
        return reply.status(400).send({ error: 'version must be a positive integer' });
      }
      const kb = getKb(adapter, req.params.kbId);
      if (!kb) return reply.status(404).send({ error: 'KB not found' });
      const docRow = adapter.getKbDocBySlug(req.params.kbId, req.params.docSlug);
      if (!docRow) return reply.status(404).send({ error: 'Doc not found' });
      const version = getKbDocAtVersion(adapter, docRow.id, versionNumber);
      if (!version) return reply.status(404).send({ error: 'Version not found' });
      return reply.send({ data: version, meta: { timestamp: nowIso() } });
    },
  );
}
