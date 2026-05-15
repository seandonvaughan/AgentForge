import type { FastifyInstance } from 'fastify';
import { generateId, nowIso } from '@agentforge/shared';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import Sqlite from 'better-sqlite3';
import { openAuditDb, appendAuditEntry } from './audit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = join(__dirname, '../../../../../');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ApiKey {
  id: string;
  label: string;
  /** sha256 hex of the raw key — NEVER returned to callers */
  keyHash: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
  revokedAt: string | null;
}

/** Returned ONCE on creation — raw key is never stored */
export interface ApiKeyCreated {
  key: ApiKey;
  rawKey: string;
}

export interface ApiKeysOptions {
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// DB row type
// ---------------------------------------------------------------------------

interface ApiKeyRow {
  id: string;
  label: string;
  key_hash: string;
  scopes_json: string;
  created_at: string;
  last_used_at: string | null;
  revoked: number;
  revoked_at: string | null;
}

function rowToApiKey(row: ApiKeyRow): ApiKey {
  let scopes: string[] = [];
  try {
    scopes = JSON.parse(row.scopes_json) as string[];
  } catch { /* malformed */ }
  const k: ApiKey = {
    id: row.id,
    label: row.label,
    keyHash: row.key_hash,
    scopes,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revoked: row.revoked === 1,
    revokedAt: row.revoked_at,
  };
  return k;
}

function sha256(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function generateRawKey(): string {
  return `agf_${randomBytes(32).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function openApiKeysDb(projectRoot: string): Sqlite.Database {
  const agentforgeDir = join(projectRoot, '.agentforge');
  if (!existsSync(agentforgeDir)) {
    mkdirSync(agentforgeDir, { recursive: true });
  }
  const db = new Sqlite(join(agentforgeDir, 'audit.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.prepare(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id          TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      key_hash    TEXT NOT NULL UNIQUE,
      scopes_json TEXT NOT NULL DEFAULT '[]',
      created_at  TEXT NOT NULL,
      last_used_at TEXT,
      revoked     INTEGER NOT NULL DEFAULT 0,
      revoked_at  TEXT
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_api_keys_revoked  ON api_keys(revoked)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_api_keys_hash     ON api_keys(key_hash)`).run();

  return db;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function apiKeysRoutes(
  app: FastifyInstance,
  opts: ApiKeysOptions = {},
): Promise<void> {
  const projectRoot = opts.projectRoot ?? DEFAULT_PROJECT_ROOT;
  const db = openApiKeysDb(projectRoot);
  const auditDb = openAuditDb(projectRoot);

  app.addHook('onClose', async () => {
    db.close();
    auditDb.close();
  });

  // GET /api/v5/keys
  // Returns keys WITHOUT keyHash — that field is internal
  app.get('/api/v5/keys', async (_req, reply) => {
    const rows = db.prepare<[], ApiKeyRow>(
      'SELECT * FROM api_keys ORDER BY created_at DESC',
    ).all();
    const data = rows.map(row => {
      const { keyHash: _kh, ...rest } = rowToApiKey(row);
      void _kh; // intentionally omitted from response
      return rest;
    });
    return reply.send({ data, meta: { total: data.length, timestamp: nowIso() } });
  });

  // GET /api/v5/keys/:id
  app.get<{ Params: { id: string } }>('/api/v5/keys/:id', async (req, reply) => {
    const row = db.prepare<[string], ApiKeyRow>(
      'SELECT * FROM api_keys WHERE id = ?',
    ).get(req.params.id);
    if (!row) return reply.status(404).send({ error: 'API key not found' });
    const { keyHash: _kh, ...rest } = rowToApiKey(row);
    void _kh;
    return reply.send({ data: rest });
  });

  // POST /api/v5/keys
  app.post('/api/v5/keys', async (req, reply) => {
    const body = req.body as { label?: string; scopes?: string[] };
    if (!body.label) return reply.status(400).send({ error: 'label is required' });

    const rawKey = generateRawKey();
    const keyHash = sha256(rawKey);
    const id = generateId();
    const createdAt = nowIso();

    db.prepare<[string, string, string, string, string]>(`
      INSERT INTO api_keys (id, label, key_hash, scopes_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, body.label, keyHash, JSON.stringify(body.scopes ?? []), createdAt);

    appendAuditEntry(auditDb, {
      actor: 'system',
      action: 'CREATE_API_KEY',
      target: id,
      details: { label: body.label },
    });

    const row = db.prepare<[string], ApiKeyRow>('SELECT * FROM api_keys WHERE id = ?').get(id)!;
    const { keyHash: _kh, ...keyData } = rowToApiKey(row);
    void _kh;

    // rawKey returned ONCE — never stored
    const result: ApiKeyCreated = { key: { ...keyData, keyHash: '' }, rawKey };
    return reply.status(201).send({ data: result });
  });

  // PATCH /api/v5/keys/:id — update label or scopes only (not the key itself)
  app.patch<{ Params: { id: string } }>('/api/v5/keys/:id', async (req, reply) => {
    const existing = db.prepare<[string], ApiKeyRow>(
      'SELECT * FROM api_keys WHERE id = ?',
    ).get(req.params.id);
    if (!existing) return reply.status(404).send({ error: 'API key not found' });
    if (existing.revoked === 1) return reply.status(409).send({ error: 'Cannot update a revoked key' });

    const body = req.body as { label?: string; scopes?: string[] };
    const newLabel = body.label ?? existing.label;
    const newScopes = body.scopes !== undefined ? JSON.stringify(body.scopes) : existing.scopes_json;

    db.prepare<[string, string, string]>(
      'UPDATE api_keys SET label = ?, scopes_json = ? WHERE id = ?',
    ).run(newLabel, newScopes, req.params.id);

    appendAuditEntry(auditDb, {
      actor: 'system',
      action: 'UPDATE_API_KEY',
      target: req.params.id,
      details: { label: newLabel },
    });

    const updated = db.prepare<[string], ApiKeyRow>(
      'SELECT * FROM api_keys WHERE id = ?',
    ).get(req.params.id)!;
    const { keyHash: _kh, ...rest } = rowToApiKey(updated);
    void _kh;
    return reply.send({ data: rest });
  });

  // DELETE /api/v5/keys/:id — revoke (soft-delete)
  app.delete<{ Params: { id: string } }>('/api/v5/keys/:id', async (req, reply) => {
    const existing = db.prepare<[string], ApiKeyRow>(
      'SELECT * FROM api_keys WHERE id = ?',
    ).get(req.params.id);
    if (!existing) return reply.status(404).send({ error: 'API key not found' });
    if (existing.revoked === 1) return reply.status(409).send({ error: 'Key is already revoked' });

    const revokedAt = nowIso();
    db.prepare<[string, string]>(
      'UPDATE api_keys SET revoked = 1, revoked_at = ? WHERE id = ?',
    ).run(revokedAt, req.params.id);

    appendAuditEntry(auditDb, {
      actor: 'system',
      action: 'REVOKE_API_KEY',
      target: req.params.id,
      details: { label: existing.label },
    });

    return reply.status(204).send();
  });
}
