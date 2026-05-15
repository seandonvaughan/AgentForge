import type { FastifyInstance } from 'fastify';
import { generateId, nowIso } from '@agentforge/shared';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync } from 'node:fs';
import Sqlite from 'better-sqlite3';
import { openAuditDb, appendAuditEntry } from './audit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = join(__dirname, '../../../../../');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Webhook {
  id: string;
  name: string;
  url: string;
  secret: string | null;
  events: string[];
  enabled: boolean;
  lastDeliveryAt: string | null;
  lastDeliveryStatus: 'success' | 'failure' | null;
  createdAt: string;
}

export interface WebhooksOptions {
  projectRoot?: string;
  /** Injected HTTP client for test doubles */
  fetch?: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;
}

// ---------------------------------------------------------------------------
// DB row type
// ---------------------------------------------------------------------------

interface WebhookRow {
  id: string;
  name: string;
  url: string;
  secret: string | null;
  events_json: string;
  enabled: number;
  last_delivery_at: string | null;
  last_delivery_status: string | null;
  created_at: string;
}

function rowToWebhook(row: WebhookRow): Webhook {
  let events: string[] = [];
  try {
    events = JSON.parse(row.events_json) as string[];
  } catch { /* malformed */ }
  const hook: Webhook = {
    id: row.id,
    name: row.name,
    url: row.url,
    secret: row.secret,
    events,
    enabled: row.enabled === 1,
    lastDeliveryAt: row.last_delivery_at,
    lastDeliveryStatus: (row.last_delivery_status as Webhook['lastDeliveryStatus']) ?? null,
    createdAt: row.created_at,
  };
  return hook;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function openWebhooksDb(projectRoot: string): Sqlite.Database {
  const agentforgeDir = join(projectRoot, '.agentforge');
  if (!existsSync(agentforgeDir)) {
    mkdirSync(agentforgeDir, { recursive: true });
  }
  const db = new Sqlite(join(agentforgeDir, 'audit.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.prepare(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id                    TEXT PRIMARY KEY,
      name                  TEXT NOT NULL,
      url                   TEXT NOT NULL,
      secret                TEXT,
      events_json           TEXT NOT NULL DEFAULT '[]',
      enabled               INTEGER NOT NULL DEFAULT 1,
      last_delivery_at      TEXT,
      last_delivery_status  TEXT,
      created_at            TEXT NOT NULL
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_webhooks_enabled ON webhooks(enabled)`).run();

  return db;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function webhooksRoutes(
  app: FastifyInstance,
  opts: WebhooksOptions = {},
): Promise<void> {
  const projectRoot = opts.projectRoot ?? DEFAULT_PROJECT_ROOT;
  const db = openWebhooksDb(projectRoot);
  const auditDb = openAuditDb(projectRoot);
  const httpFetch = opts.fetch ?? ((u, i) => fetch(u, i as Parameters<typeof fetch>[1]));

  app.addHook('onClose', async () => {
    db.close();
    auditDb.close();
  });

  // GET /api/v5/webhooks
  app.get('/api/v5/webhooks', async (_req, reply) => {
    const rows = db.prepare<[], WebhookRow>(
      'SELECT * FROM webhooks ORDER BY created_at DESC',
    ).all();
    return reply.send({
      data: rows.map(rowToWebhook),
      meta: { total: rows.length, timestamp: nowIso() },
    });
  });

  // GET /api/v5/webhooks/:id
  app.get<{ Params: { id: string } }>('/api/v5/webhooks/:id', async (req, reply) => {
    const row = db.prepare<[string], WebhookRow>(
      'SELECT * FROM webhooks WHERE id = ?',
    ).get(req.params.id);
    if (!row) return reply.status(404).send({ error: 'Webhook not found' });
    return reply.send({ data: rowToWebhook(row) });
  });

  // POST /api/v5/webhooks
  app.post('/api/v5/webhooks', async (req, reply) => {
    const body = req.body as {
      name?: string;
      url?: string;
      secret?: string;
      events?: string[];
      enabled?: boolean;
    };

    if (!body.name) return reply.status(400).send({ error: 'name is required' });
    if (!body.url) return reply.status(400).send({ error: 'url is required' });

    try {
      new URL(body.url);
    } catch {
      return reply.status(400).send({ error: 'url must be a valid URL' });
    }

    const id = generateId();
    const createdAt = nowIso();
    const enabled = body.enabled !== false ? 1 : 0;

    db.prepare<[string, string, string, string | null, string, number, string]>(`
      INSERT INTO webhooks (id, name, url, secret, events_json, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      body.name,
      body.url,
      body.secret ?? null,
      JSON.stringify(body.events ?? []),
      enabled,
      createdAt,
    );

    appendAuditEntry(auditDb, {
      actor: 'system',
      action: 'CREATE_WEBHOOK',
      target: id,
      details: { name: body.name, url: body.url },
    });

    const row = db.prepare<[string], WebhookRow>(
      'SELECT * FROM webhooks WHERE id = ?',
    ).get(id)!;
    return reply.status(201).send({ data: rowToWebhook(row) });
  });

  // PATCH /api/v5/webhooks/:id
  app.patch<{ Params: { id: string } }>('/api/v5/webhooks/:id', async (req, reply) => {
    const existing = db.prepare<[string], WebhookRow>(
      'SELECT * FROM webhooks WHERE id = ?',
    ).get(req.params.id);
    if (!existing) return reply.status(404).send({ error: 'Webhook not found' });

    const body = req.body as {
      name?: string;
      url?: string;
      secret?: string;
      events?: string[];
      enabled?: boolean;
    };

    if (body.url !== undefined) {
      try {
        new URL(body.url);
      } catch {
        return reply.status(400).send({ error: 'url must be a valid URL' });
      }
    }

    const newName = body.name ?? existing.name;
    const newUrl = body.url ?? existing.url;
    const newSecret = body.secret !== undefined ? body.secret : existing.secret;
    const newEvents = body.events !== undefined ? JSON.stringify(body.events) : existing.events_json;
    const newEnabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled;

    db.prepare<[string, string, string | null, string, number, string]>(`
      UPDATE webhooks SET name = ?, url = ?, secret = ?, events_json = ?, enabled = ?
      WHERE id = ?
    `).run(newName, newUrl, newSecret, newEvents, newEnabled, req.params.id);

    appendAuditEntry(auditDb, {
      actor: 'system',
      action: 'UPDATE_WEBHOOK',
      target: req.params.id,
      details: { name: newName },
    });

    const updated = db.prepare<[string], WebhookRow>(
      'SELECT * FROM webhooks WHERE id = ?',
    ).get(req.params.id)!;
    return reply.send({ data: rowToWebhook(updated) });
  });

  // DELETE /api/v5/webhooks/:id
  app.delete<{ Params: { id: string } }>('/api/v5/webhooks/:id', async (req, reply) => {
    const existing = db.prepare<[string], WebhookRow>(
      'SELECT * FROM webhooks WHERE id = ?',
    ).get(req.params.id);
    if (!existing) return reply.status(404).send({ error: 'Webhook not found' });

    db.prepare<[string]>('DELETE FROM webhooks WHERE id = ?').run(req.params.id);

    appendAuditEntry(auditDb, {
      actor: 'system',
      action: 'DELETE_WEBHOOK',
      target: req.params.id,
      details: { name: existing.name },
    });

    return reply.status(204).send();
  });

  // POST /api/v5/webhooks/:id/test
  app.post<{ Params: { id: string } }>('/api/v5/webhooks/:id/test', async (req, reply) => {
    const row = db.prepare<[string], WebhookRow>(
      'SELECT * FROM webhooks WHERE id = ?',
    ).get(req.params.id);
    if (!row) return reply.status(404).send({ error: 'Webhook not found' });

    const samplePayload = {
      event: 'test',
      webhookId: row.id,
      ts: nowIso(),
      data: { message: 'This is a test delivery from AgentForge.' },
    };

    let deliveryStatus: 'success' | 'failure' = 'failure';
    let httpStatus = 0;

    try {
      const response = await httpFetch(row.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(row.secret ? { 'X-AgentForge-Secret': row.secret } : {}),
        },
        body: JSON.stringify(samplePayload),
      });
      deliveryStatus = response.ok ? 'success' : 'failure';
      httpStatus = response.status;
    } catch {
      deliveryStatus = 'failure';
    }

    const deliveryAt = nowIso();
    db.prepare<[string, string, string]>(`
      UPDATE webhooks SET last_delivery_at = ?, last_delivery_status = ? WHERE id = ?
    `).run(deliveryAt, deliveryStatus, row.id);

    appendAuditEntry(auditDb, {
      actor: 'system',
      action: 'TEST_WEBHOOK',
      target: row.id,
      details: { deliveryStatus, httpStatus },
    });

    return reply.send({
      data: {
        webhookId: row.id,
        deliveryStatus,
        httpStatus,
        deliveredAt: deliveryAt,
      },
    });
  });
}
