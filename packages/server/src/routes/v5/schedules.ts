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
// Cron validation — lightweight regex, no extra dependency
// ---------------------------------------------------------------------------

/**
 * Validate a 5-field cron expression: "min hr dom mon dow".
 * Accepts * / , - and digits. Does not validate range semantics.
 */
function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const fieldRe = /^(\*|(\d+(-\d+)?)(,(\d+(-\d+)?))*)(\/\d+)?$/;
  return fields.every(f => fieldRe.test(f));
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Schedule {
  id: string;
  name: string;
  cronExpression: string;
  cycleConfig: Record<string, unknown>;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

export interface SchedulesOptions {
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// DB row type
// ---------------------------------------------------------------------------

interface ScheduleRow {
  id: string;
  name: string;
  cron_expression: string;
  cycle_config_json: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
}

function rowToSchedule(row: ScheduleRow): Schedule {
  let cycleConfig: Record<string, unknown> = {};
  try {
    cycleConfig = JSON.parse(row.cycle_config_json) as Record<string, unknown>;
  } catch { /* malformed — fall back to empty */ }
  const sched: Schedule = {
    id: row.id,
    name: row.name,
    cronExpression: row.cron_expression,
    cycleConfig,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
  };
  return sched;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function openSchedulesDb(projectRoot: string): Sqlite.Database {
  const agentforgeDir = join(projectRoot, '.agentforge');
  if (!existsSync(agentforgeDir)) {
    mkdirSync(agentforgeDir, { recursive: true });
  }
  const db = new Sqlite(join(agentforgeDir, 'audit.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.prepare(`
    CREATE TABLE IF NOT EXISTS schedules (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      cron_expression   TEXT NOT NULL,
      cycle_config_json TEXT NOT NULL DEFAULT '{}',
      enabled           INTEGER NOT NULL DEFAULT 1,
      last_run_at       TEXT,
      next_run_at       TEXT,
      created_at        TEXT NOT NULL
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled)`).run();

  return db;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function schedulesRoutes(
  app: FastifyInstance,
  opts: SchedulesOptions = {},
): Promise<void> {
  const projectRoot = opts.projectRoot ?? DEFAULT_PROJECT_ROOT;
  const db = openSchedulesDb(projectRoot);
  const auditDb = openAuditDb(projectRoot);

  app.addHook('onClose', async () => {
    db.close();
    auditDb.close();
  });

  // GET /api/v5/schedules
  app.get('/api/v5/schedules', async (_req, reply) => {
    const rows = db.prepare<[], ScheduleRow>(
      'SELECT * FROM schedules ORDER BY created_at DESC',
    ).all();
    return reply.send({
      data: rows.map(rowToSchedule),
      meta: { total: rows.length, timestamp: nowIso() },
    });
  });

  // GET /api/v5/schedules/:id
  app.get<{ Params: { id: string } }>('/api/v5/schedules/:id', async (req, reply) => {
    const row = db.prepare<[string], ScheduleRow>(
      'SELECT * FROM schedules WHERE id = ?',
    ).get(req.params.id);
    if (!row) return reply.status(404).send({ error: 'Schedule not found' });
    return reply.send({ data: rowToSchedule(row) });
  });

  // POST /api/v5/schedules
  app.post('/api/v5/schedules', async (req, reply) => {
    const body = req.body as {
      name?: string;
      cronExpression?: string;
      cycleConfig?: Record<string, unknown>;
      enabled?: boolean;
    };

    if (!body.name) return reply.status(400).send({ error: 'name is required' });
    if (!body.cronExpression) return reply.status(400).send({ error: 'cronExpression is required' });
    if (!isValidCron(body.cronExpression)) {
      return reply.status(400).send({ error: 'cronExpression is not a valid 5-field cron expression' });
    }

    const id = generateId();
    const createdAt = nowIso();
    const enabled = body.enabled !== false ? 1 : 0;

    db.prepare<[string, string, string, string, number, string]>(`
      INSERT INTO schedules (id, name, cron_expression, cycle_config_json, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      body.name,
      body.cronExpression,
      JSON.stringify(body.cycleConfig ?? {}),
      enabled,
      createdAt,
    );

    appendAuditEntry(auditDb, {
      actor: 'system',
      action: 'CREATE_SCHEDULE',
      target: id,
      details: { name: body.name, cronExpression: body.cronExpression },
    });

    const row = db.prepare<[string], ScheduleRow>(
      'SELECT * FROM schedules WHERE id = ?',
    ).get(id)!;
    return reply.status(201).send({ data: rowToSchedule(row) });
  });

  // PATCH /api/v5/schedules/:id
  app.patch<{ Params: { id: string } }>('/api/v5/schedules/:id', async (req, reply) => {
    const existing = db.prepare<[string], ScheduleRow>(
      'SELECT * FROM schedules WHERE id = ?',
    ).get(req.params.id);
    if (!existing) return reply.status(404).send({ error: 'Schedule not found' });

    const body = req.body as {
      name?: string;
      cronExpression?: string;
      cycleConfig?: Record<string, unknown>;
      enabled?: boolean;
    };

    if (body.cronExpression !== undefined && !isValidCron(body.cronExpression)) {
      return reply.status(400).send({ error: 'cronExpression is not a valid 5-field cron expression' });
    }

    const newName = body.name ?? existing.name;
    const newCron = body.cronExpression ?? existing.cron_expression;
    const newConfig = body.cycleConfig !== undefined
      ? JSON.stringify(body.cycleConfig)
      : existing.cycle_config_json;
    const newEnabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled;

    db.prepare<[string, string, string, number, string]>(`
      UPDATE schedules SET name = ?, cron_expression = ?, cycle_config_json = ?, enabled = ?
      WHERE id = ?
    `).run(newName, newCron, newConfig, newEnabled, req.params.id);

    appendAuditEntry(auditDb, {
      actor: 'system',
      action: 'UPDATE_SCHEDULE',
      target: req.params.id,
      details: { name: newName },
    });

    const updated = db.prepare<[string], ScheduleRow>(
      'SELECT * FROM schedules WHERE id = ?',
    ).get(req.params.id)!;
    return reply.send({ data: rowToSchedule(updated) });
  });

  // DELETE /api/v5/schedules/:id
  app.delete<{ Params: { id: string } }>('/api/v5/schedules/:id', async (req, reply) => {
    const existing = db.prepare<[string], ScheduleRow>(
      'SELECT * FROM schedules WHERE id = ?',
    ).get(req.params.id);
    if (!existing) return reply.status(404).send({ error: 'Schedule not found' });

    db.prepare<[string]>('DELETE FROM schedules WHERE id = ?').run(req.params.id);

    appendAuditEntry(auditDb, {
      actor: 'system',
      action: 'DELETE_SCHEDULE',
      target: req.params.id,
      details: { name: existing.name },
    });

    return reply.status(204).send();
  });
}
