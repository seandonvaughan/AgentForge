import type { FastifyInstance } from 'fastify';
import { generateId, nowIso } from '@agentforge/shared';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync } from 'node:fs';
import Sqlite from 'better-sqlite3';
import {
  runUnattendedChecks,
  type UnattendedCheckResult,
} from '@agentforge/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/server/src/routes/v5/ → up 5 levels to monorepo root
const DEFAULT_PROJECT_ROOT = join(__dirname, '../../../../../');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  ts: string;
  actor: string;
  action: string;
  target: string;
  details: Record<string, unknown>;
}

export interface AuditOptions {
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// Internal DB row type
// ---------------------------------------------------------------------------

interface AuditRow {
  id: string;
  ts: string;
  actor: string;
  action: string;
  target: string;
  details_json: string;
}

function rowToEntry(row: AuditRow): AuditEntry {
  let details: Record<string, unknown> = {};
  try {
    details = JSON.parse(row.details_json) as Record<string, unknown>;
  } catch { /* malformed JSON — omit */ }
  return {
    id: row.id,
    ts: row.ts,
    actor: row.actor,
    action: row.action,
    target: row.target,
    details,
  };
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

export function openAuditDb(projectRoot: string): Sqlite.Database {
  const agentforgeDir = join(projectRoot, '.agentforge');
  if (!existsSync(agentforgeDir)) {
    mkdirSync(agentforgeDir, { recursive: true });
  }
  const db = new Sqlite(join(agentforgeDir, 'audit.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.prepare(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id      TEXT PRIMARY KEY,
      ts      TEXT NOT NULL,
      actor   TEXT NOT NULL,
      action  TEXT NOT NULL,
      target  TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}'
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_ts    ON audit_log(ts)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor)`).run();

  return db;
}

/**
 * Append a single audit entry to the audit.db at projectRoot.
 * Call this from any route that performs an admin / autonomous mutation.
 */
export function appendAuditEntry(
  db: Sqlite.Database,
  entry: Omit<AuditEntry, 'id' | 'ts'>,
): AuditEntry {
  const id = generateId();
  const ts = nowIso();
  db.prepare<[string, string, string, string, string, string]>(`
    INSERT INTO audit_log (id, ts, actor, action, target, details_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, ts, entry.actor, entry.action, entry.target, JSON.stringify(entry.details));
  return { id, ts, ...entry };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function auditRoutes(
  app: FastifyInstance,
  opts: AuditOptions = {},
): Promise<void> {
  const projectRoot = opts.projectRoot ?? DEFAULT_PROJECT_ROOT;
  const db = openAuditDb(projectRoot);

  app.addHook('onClose', async () => {
    db.close();
  });

  // GET /api/v5/audit
  app.get('/api/v5/audit', async (req, reply) => {
    const q = req.query as { since?: string; actor?: string; limit?: string };
    const limit = Math.min(parseInt(q.limit ?? '100', 10), 1000);

    let sql = 'SELECT * FROM audit_log WHERE 1=1';
    const params: (string | number)[] = [];

    if (q.since) {
      sql += ' AND ts >= ?';
      params.push(q.since);
    }
    if (q.actor) {
      sql += ' AND actor = ?';
      params.push(q.actor);
    }
    sql += ' ORDER BY ts DESC LIMIT ?';
    params.push(limit);

    const rows = db.prepare<(string | number)[], AuditRow>(sql).all(...params);
    const entries = rows.map(rowToEntry);

    return reply.send({
      data: entries,
      meta: { total: entries.length, limit, timestamp: nowIso() },
    });
  });

  // POST /api/v5/audit
  app.post('/api/v5/audit', async (req, reply) => {
    const body = req.body as {
      actor?: string;
      action?: string;
      target?: string;
      details?: Record<string, unknown>;
    };

    if (!body.actor || !body.action || !body.target) {
      return reply.status(400).send({ error: 'actor, action, and target are required' });
    }

    const entry = appendAuditEntry(db, {
      actor: body.actor,
      action: body.action,
      target: body.target,
      details: body.details ?? {},
    });

    return reply.status(201).send({ data: entry });
  });

  // === wave5:T5 ===
  // GET /api/v5/audit/unattended-checks
  // Run the 5 pre-flight unattended-mode checks and return results.
  // Writes an audit entry for each check result.
  // Returns 200 with all checks when all pass; 424 (Failed Dependency) when any fail.
  app.get('/api/v5/audit/unattended-checks', async (req, reply) => {
    const q = req.query as { perCycleUsd?: string; spentUsd?: string };
    const perCycleUsd = parseFloat(q.perCycleUsd ?? '30');
    const spentUsd = parseFloat(q.spentUsd ?? '0');

    const results: UnattendedCheckResult[] = [];

    let guardError: Error | undefined;
    try {
      const checks = await runUnattendedChecks({
        cwd: projectRoot,
        perCycleUsd: isNaN(perCycleUsd) ? 30 : perCycleUsd,
        spentUsd: isNaN(spentUsd) ? 0 : spentUsd,
        onCheckResult: (r) => {
          results.push(r);
          // Write an audit row for each check.
          appendAuditEntry(db, {
            actor: 'unattended-guard',
            action: r.passed ? 'preflight.check.passed' : 'preflight.check.failed',
            target: r.check,
            details: {
              passed: r.passed,
              detail: r.detail,
              measuredValue: r.measuredValue,
              threshold: r.threshold,
            },
          });
        },
      });
      // runUnattendedChecks populates results via onCheckResult; use the returned array.
      void checks;
    } catch (err) {
      guardError = err instanceof Error ? err : new Error(String(err));
    }

    const allPassed = results.every((r) => r.passed);
    const status = allPassed ? 200 : 424;

    return reply.status(status).send({
      data: results,
      passed: allPassed,
      ...(guardError ? { error: guardError.message } : {}),
      meta: { timestamp: nowIso() },
    });
  });
  // === end wave5:T5 ===
}
