import { readdir, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import Database from 'better-sqlite3';

export interface MigrationReport {
  agentsMigrated: number;
  sessionsMigrated: number;
  costsMigrated: number;
  warnings: string[];
  errors: string[];
  startedAt: string;
  completedAt?: string;
}

export async function migrateV4ToV5(projectRoot: string, targetDbPath: string): Promise<MigrationReport> {
  const report: MigrationReport = {
    agentsMigrated: 0,
    sessionsMigrated: 0,
    costsMigrated: 0,
    warnings: [],
    errors: [],
    startedAt: new Date().toISOString(),
  };

  // Ensure target dir exists
  const targetDir = targetDbPath.substring(0, targetDbPath.lastIndexOf('/'));
  await mkdir(targetDir, { recursive: true });

  const db = new Database(targetDbPath);

  // Create v5 schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      db_path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      active INTEGER NOT NULL DEFAULT 1,
      meta TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      agent_id TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'sonnet',
      task TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'completed',
      started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      completed_at TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      meta TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      name TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'sonnet',
      role TEXT,
      system_prompt TEXT,
      skills TEXT DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      meta TEXT DEFAULT '{}'
    );
  `);

  // Create default workspace for migrated v4 data
  const workspaceId = 'v4-migrated';
  db.prepare(`
    INSERT OR IGNORE INTO workspaces (id, name, db_path, meta)
    VALUES (?, ?, ?, ?)
  `).run(workspaceId, 'Migrated from v4', targetDbPath, JSON.stringify({ migratedAt: new Date().toISOString() }));

  // 1. Migrate agents from .agentforge/agents/*.yaml
  const agentsDir = join(projectRoot, '.agentforge/agents');
  if (existsSync(agentsDir)) {
    try {
      const files = (await readdir(agentsDir)).filter(f => f.endsWith('.yaml'));
      const insertAgent = db.prepare(`
        INSERT OR REPLACE INTO agents (id, workspace_id, name, model, role, system_prompt, skills, meta)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const migrateAgents = db.transaction(() => {
        for (const file of files) {
          try {
            const content = readFileSync(join(agentsDir, file), 'utf-8');
            const agentId = basename(file, '.yaml');
            const nameMatch = content.match(/^name:\s*(.+)$/m);
            const modelMatch = content.match(/^model:\s*(.+)$/m);
            const roleMatch = content.match(/^role:\s*(.+)$/m);

            insertAgent.run(
              agentId,
              workspaceId,
              nameMatch?.[1]?.trim() ?? agentId,
              modelMatch?.[1]?.trim() ?? 'sonnet',
              roleMatch?.[1]?.trim() ?? null,
              null, // system_prompt skipped for migration brevity
              '[]',
              JSON.stringify({ sourceFile: file }),
            );
            report.agentsMigrated++;
          } catch (e: unknown) {
            report.errors.push(`Agent ${file}: ${(e as Error).message}`);
          }
        }
      });
      migrateAgents();
    } catch (e: unknown) {
      report.warnings.push(`Could not read agents dir: ${(e as Error).message}`);
    }
  } else {
    report.warnings.push(`Agents directory not found: ${agentsDir}`);
  }

  // 2. Migrate sessions from .agentforge/sessions/index.json
  const sessionsIndexPath = join(projectRoot, '.agentforge/sessions/index.json');
  if (existsSync(sessionsIndexPath)) {
    try {
      const raw = readFileSync(sessionsIndexPath, 'utf-8');
      const sessions = JSON.parse(raw) as Array<{
        sessionId: string;
        agentId: string;
        model?: string;
        task?: string;
        status?: string;
        completedAt?: string;
      }>;
      const insertSession = db.prepare(`
        INSERT OR REPLACE INTO sessions (id, workspace_id, agent_id, model, task, status, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const migrateSessions = db.transaction(() => {
        for (const s of sessions) {
          try {
            insertSession.run(
              s.sessionId,
              workspaceId,
              s.agentId,
              s.model ?? 'sonnet',
              s.task ?? '',
              s.status ?? 'completed',
              s.completedAt ?? null,
            );
            report.sessionsMigrated++;
          } catch (e: unknown) {
            report.errors.push(`Session ${s.sessionId}: ${(e as Error).message}`);
          }
        }
      });
      migrateSessions();
    } catch (e: unknown) {
      report.warnings.push(`Could not migrate sessions: ${(e as Error).message}`);
    }
  } else {
    report.warnings.push(`Sessions index not found: ${sessionsIndexPath}`);
  }

  // 3. Migrate cost data from .agentforge/db/agentforge.db (v4 SQLite)
  const v4DbPath = join(projectRoot, '.agentforge/db/agentforge.db');
  if (existsSync(v4DbPath)) {
    try {
      const v4db = new Database(v4DbPath, { readonly: true });
      const tables = v4db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all() as Array<{ name: string }>;
      const tableNames = tables.map(t => t.name);

      if (tableNames.includes('sessions')) {
        try {
          const v4Sessions = v4db
            .prepare(`SELECT * FROM sessions`)
            .all() as Array<Record<string, unknown>>;

          const insertCostSession = db.prepare(`
            INSERT OR IGNORE INTO sessions
              (id, workspace_id, agent_id, model, task, status, started_at, completed_at,
               input_tokens, output_tokens, cost_usd, meta)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          const migrateCosts = db.transaction(() => {
            for (const s of v4Sessions) {
              try {
                const id = String(s['id'] ?? s['session_id'] ?? crypto.randomUUID());
                insertCostSession.run(
                  id,
                  workspaceId,
                  String(s['agent_id'] ?? 'unknown'),
                  String(s['model'] ?? 'sonnet'),
                  String(s['task'] ?? ''),
                  String(s['status'] ?? 'completed'),
                  String(s['started_at'] ?? s['created_at'] ?? new Date().toISOString()),
                  s['completed_at'] != null ? String(s['completed_at']) : null,
                  Number(s['input_tokens'] ?? 0),
                  Number(s['output_tokens'] ?? 0),
                  Number(s['cost_usd'] ?? s['cost'] ?? 0),
                  JSON.stringify({ migratedFromV4Db: true }),
                );
                report.costsMigrated++;
              } catch (e: unknown) {
                report.errors.push(`v4 DB session ${String(s['id'])}: ${(e as Error).message}`);
              }
            }
          });
          migrateCosts();
        } catch (e: unknown) {
          report.warnings.push(`Could not migrate v4 DB sessions: ${(e as Error).message}`);
        }
      }
      v4db.close();
    } catch (e: unknown) {
      report.warnings.push(`Could not open v4 SQLite DB: ${(e as Error).message}`);
    }
  }

  db.close();
  report.completedAt = new Date().toISOString();
  return report;
}
