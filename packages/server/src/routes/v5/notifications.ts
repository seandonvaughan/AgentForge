import type { FastifyInstance } from 'fastify';
import { generateId, nowIso } from '@agentforge/shared';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync } from 'node:fs';
import Sqlite from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = join(__dirname, '../../../../../');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type NotificationKind = 'info' | 'warning' | 'action_required';

export interface Notification {
  id: string;
  ts: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  createdAt: string;
}

export interface NotificationsOptions {
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// DB row type
// ---------------------------------------------------------------------------

interface NotificationRow {
  id: string;
  ts: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  read: number;
  created_at: string;
}

function rowToNotification(row: NotificationRow): Notification {
  const notif: Notification = {
    id: row.id,
    ts: row.ts,
    kind: row.kind as NotificationKind,
    title: row.title,
    body: row.body,
    link: row.link,
    read: row.read === 1,
    createdAt: row.created_at,
  };
  return notif;
}

const VALID_KINDS = new Set<string>(['info', 'warning', 'action_required']);

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function openNotificationsDb(projectRoot: string): Sqlite.Database {
  const agentforgeDir = join(projectRoot, '.agentforge');
  if (!existsSync(agentforgeDir)) {
    mkdirSync(agentforgeDir, { recursive: true });
  }
  const db = new Sqlite(join(agentforgeDir, 'audit.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.prepare(`
    CREATE TABLE IF NOT EXISTS notifications (
      id         TEXT PRIMARY KEY,
      ts         TEXT NOT NULL,
      kind       TEXT NOT NULL,
      title      TEXT NOT NULL,
      body       TEXT NOT NULL,
      link       TEXT,
      read       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_notifications_ts   ON notifications(ts)`).run();

  return db;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function notificationsRoutes(
  app: FastifyInstance,
  opts: NotificationsOptions = {},
): Promise<void> {
  const projectRoot = opts.projectRoot ?? DEFAULT_PROJECT_ROOT;
  const db = openNotificationsDb(projectRoot);

  app.addHook('onClose', async () => {
    db.close();
  });

  // GET /api/v5/notifications
  app.get('/api/v5/notifications', async (req, reply) => {
    const q = req.query as { unread?: string; limit?: string };
    const limit = Math.min(parseInt(q.limit ?? '100', 10), 500);
    const unreadOnly = q.unread === 'true';

    let sql = 'SELECT * FROM notifications';
    const params: (string | number)[] = [];

    if (unreadOnly) {
      sql += ' WHERE read = 0';
    }
    sql += ' ORDER BY ts DESC LIMIT ?';
    params.push(limit);

    const rows = db.prepare<(string | number)[], NotificationRow>(sql).all(...params);
    const items = rows.map(rowToNotification);

    return reply.send({
      data: items,
      meta: {
        total: items.length,
        unread: items.filter(n => !n.read).length,
        limit,
        timestamp: nowIso(),
      },
    });
  });

  // POST /api/v5/notifications (internal — created by system)
  app.post('/api/v5/notifications', async (req, reply) => {
    const body = req.body as {
      kind?: string;
      title?: string;
      body?: string;
      link?: string;
    };

    if (!body.kind || !VALID_KINDS.has(body.kind)) {
      return reply.status(400).send({
        error: `kind is required and must be one of: ${[...VALID_KINDS].join(', ')}`,
      });
    }
    if (!body.title) return reply.status(400).send({ error: 'title is required' });
    if (!body.body) return reply.status(400).send({ error: 'body is required' });

    const id = generateId();
    const ts = nowIso();

    db.prepare<[string, string, string, string, string, string | null, string]>(`
      INSERT INTO notifications (id, ts, kind, title, body, link, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, ts, body.kind, body.title, body.body, body.link ?? null, ts);

    const row = db.prepare<[string], NotificationRow>(
      'SELECT * FROM notifications WHERE id = ?',
    ).get(id)!;
    return reply.status(201).send({ data: rowToNotification(row) });
  });

  // PATCH /api/v5/notifications/:id/read
  app.patch<{ Params: { id: string } }>('/api/v5/notifications/:id/read', async (req, reply) => {
    const existing = db.prepare<[string], NotificationRow>(
      'SELECT * FROM notifications WHERE id = ?',
    ).get(req.params.id);
    if (!existing) return reply.status(404).send({ error: 'Notification not found' });

    db.prepare<[string]>('UPDATE notifications SET read = 1 WHERE id = ?').run(req.params.id);

    const updated = db.prepare<[string], NotificationRow>(
      'SELECT * FROM notifications WHERE id = ?',
    ).get(req.params.id)!;
    return reply.send({ data: rowToNotification(updated) });
  });
}
