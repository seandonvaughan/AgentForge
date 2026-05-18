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

export type MemberRole = 'owner' | 'admin' | 'operator' | 'viewer';

export interface Member {
  id: string;
  email: string;
  displayName: string;
  role: MemberRole;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface MembersOptions {
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// DB row type
// ---------------------------------------------------------------------------

interface MemberRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  created_at: string;
  last_seen_at: string | null;
}

function rowToMember(row: MemberRow): Member {
  const m: Member = {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role as MemberRole,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
  return m;
}

const VALID_ROLES = new Set<string>(['owner', 'admin', 'operator', 'viewer']);

/**
 * Validate an email address without using regex quantifiers on user-controlled
 * input, which CodeQL (js/redos) flags as a polynomial backtracking risk.
 *
 * Checks performed (equivalent to the previous /^[^\s@]+@[^\s@]+\.[^\s@]+$/):
 *   - No whitespace characters
 *   - Exactly one @ sign, not at position 0
 *   - The domain portion contains a dot that is neither first nor last
 */
function isValidEmail(email: string): boolean {
  if (!email || email.length > 254) return false;
  // No whitespace — check common whitespace chars individually to stay regex-free
  if (email.includes(' ') || email.includes('\t') || email.includes('\n') || email.includes('\r')) return false;
  const at = email.indexOf('@');
  // Must have @ and it must not be the first character
  if (at <= 0) return false;
  // Must have exactly one @
  if (email.lastIndexOf('@') !== at) return false;
  const domain = email.slice(at + 1);
  if (!domain) return false;
  // Domain must contain a dot that is not at position 0 or the last position
  const dot = domain.lastIndexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function openMembersDb(projectRoot: string): Sqlite.Database {
  const agentforgeDir = join(projectRoot, '.agentforge');
  if (!existsSync(agentforgeDir)) {
    mkdirSync(agentforgeDir, { recursive: true });
  }
  const db = new Sqlite(join(agentforgeDir, 'audit.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.prepare(`
    CREATE TABLE IF NOT EXISTS members (
      id           TEXT PRIMARY KEY,
      email        TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'viewer',
      created_at   TEXT NOT NULL,
      last_seen_at TEXT
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_members_email ON members(email)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_members_role  ON members(role)`).run();

  return db;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function membersRoutes(
  app: FastifyInstance,
  opts: MembersOptions = {},
): Promise<void> {
  const projectRoot = opts.projectRoot ?? DEFAULT_PROJECT_ROOT;
  const db = openMembersDb(projectRoot);
  const auditDb = openAuditDb(projectRoot);

  app.addHook('onClose', async () => {
    db.close();
    auditDb.close();
  });

  // GET /api/v5/members
  app.get('/api/v5/members', async (req, reply) => {
    const q = req.query as { role?: string };
    let sql = 'SELECT * FROM members';
    const params: string[] = [];
    if (q.role) {
      if (!VALID_ROLES.has(q.role)) {
        return reply.status(400).send({ error: `role must be one of: ${[...VALID_ROLES].join(', ')}` });
      }
      sql += ' WHERE role = ?';
      params.push(q.role);
    }
    sql += ' ORDER BY created_at ASC';
    const rows = db.prepare<string[], MemberRow>(sql).all(...params);
    return reply.send({
      data: rows.map(rowToMember),
      meta: { total: rows.length, timestamp: nowIso() },
    });
  });

  // GET /api/v5/members/:id
  app.get<{ Params: { id: string } }>('/api/v5/members/:id', async (req, reply) => {
    const row = db.prepare<[string], MemberRow>(
      'SELECT * FROM members WHERE id = ?',
    ).get(req.params.id);
    if (!row) return reply.status(404).send({ error: 'Member not found' });
    return reply.send({ data: rowToMember(row) });
  });

  // POST /api/v5/members
  app.post('/api/v5/members', async (req, reply) => {
    const body = req.body as { email?: string; displayName?: string; role?: string };

    if (!body.email) return reply.status(400).send({ error: 'email is required' });
    if (!isValidEmail(body.email)) return reply.status(400).send({ error: 'email is not valid' });
    if (!body.displayName) return reply.status(400).send({ error: 'displayName is required' });
    if (body.role !== undefined && !VALID_ROLES.has(body.role)) {
      return reply.status(400).send({ error: `role must be one of: ${[...VALID_ROLES].join(', ')}` });
    }

    // Check uniqueness
    const dupe = db.prepare<[string], MemberRow>(
      'SELECT id FROM members WHERE email = ?',
    ).get(body.email);
    if (dupe) return reply.status(409).send({ error: 'A member with that email already exists' });

    const id = generateId();
    const createdAt = nowIso();
    const role = body.role ?? 'viewer';

    db.prepare<[string, string, string, string, string]>(`
      INSERT INTO members (id, email, display_name, role, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, body.email, body.displayName, role, createdAt);

    appendAuditEntry(auditDb, {
      actor: 'system',
      action: 'CREATE_MEMBER',
      target: id,
      details: { email: body.email, role },
    });

    const row = db.prepare<[string], MemberRow>('SELECT * FROM members WHERE id = ?').get(id)!;
    return reply.status(201).send({ data: rowToMember(row) });
  });

  // PATCH /api/v5/members/:id
  app.patch<{ Params: { id: string } }>('/api/v5/members/:id', async (req, reply) => {
    const existing = db.prepare<[string], MemberRow>(
      'SELECT * FROM members WHERE id = ?',
    ).get(req.params.id);
    if (!existing) return reply.status(404).send({ error: 'Member not found' });

    const body = req.body as { displayName?: string; role?: string; lastSeenAt?: string };

    if (body.role !== undefined && !VALID_ROLES.has(body.role)) {
      return reply.status(400).send({ error: `role must be one of: ${[...VALID_ROLES].join(', ')}` });
    }

    const newDisplayName = body.displayName ?? existing.display_name;
    const newRole = body.role ?? existing.role;
    const newLastSeen = body.lastSeenAt !== undefined ? body.lastSeenAt : existing.last_seen_at;

    db.prepare<[string, string, string | null, string]>(`
      UPDATE members SET display_name = ?, role = ?, last_seen_at = ? WHERE id = ?
    `).run(newDisplayName, newRole, newLastSeen, req.params.id);

    appendAuditEntry(auditDb, {
      actor: 'system',
      action: 'UPDATE_MEMBER',
      target: req.params.id,
      details: { email: existing.email, newRole },
    });

    const updated = db.prepare<[string], MemberRow>(
      'SELECT * FROM members WHERE id = ?',
    ).get(req.params.id)!;
    return reply.send({ data: rowToMember(updated) });
  });

  // DELETE /api/v5/members/:id
  app.delete<{ Params: { id: string } }>('/api/v5/members/:id', async (req, reply) => {
    const existing = db.prepare<[string], MemberRow>(
      'SELECT * FROM members WHERE id = ?',
    ).get(req.params.id);
    if (!existing) return reply.status(404).send({ error: 'Member not found' });

    db.prepare<[string]>('DELETE FROM members WHERE id = ?').run(req.params.id);

    appendAuditEntry(auditDb, {
      actor: 'system',
      action: 'DELETE_MEMBER',
      target: req.params.id,
      details: { email: existing.email },
    });

    return reply.status(204).send();
  });
}
