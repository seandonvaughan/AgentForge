/**
 * SqliteAdapter — P0-2: Unified data access layer for AgentForge v4.7
 *
 * Implements FeedbackFileAdapter and FlywheelFileAdapter using SQLite,
 * replacing file-based persistence. Also exposes direct CRUD methods
 * for Sessions, Feedback, and Costs for use by the REST API.
 *
 * Path conventions:
 * - 'feedback/<sprintId>.json' → FeedbackDbRow array in feedback table
 * - Any other path             → stored as generic key-value in kv_store table
 */

import type { AgentDatabase } from './database.js';
import type { SessionRow } from './database.js';
import type { FeedbackFileAdapter } from '../feedback/feedback-protocol.js';
import type { FlywheelFileAdapter } from '../flywheel/flywheel-monitor.js';

// ---------------------------------------------------------------------------
// Row types matching the SQLite schema
// ---------------------------------------------------------------------------

export type { SessionRow };

export interface FeedbackDbRow {
  id: string;
  agent_id: string;
  session_id: string | null;
  category: string;
  message: string;
  sentiment: string | null;
  created_at: string;
}

export interface CostRow {
  id: string;
  session_id: string | null;
  agent_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  created_at: string;
}

export interface TaskOutcomeRow {
  id: string;
  session_id: string;
  agent_id: string;
  task: string;
  success: number;
  quality_score: number | null;
  model: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface PromotionRow {
  id: string;
  agent_id: string;
  previous_tier: number;
  new_tier: number;
  promoted: number;
  demoted: number;
  reason: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// SQL injection allowlist for updateSession
// ---------------------------------------------------------------------------

const SESSION_COLUMNS = new Set([
  'agent_id', 'agent_name', 'model', 'task', 'response', 'status',
  'started_at', 'completed_at', 'estimated_tokens', 'autonomy_tier',
  'resume_count', 'parent_session_id', 'delegation_depth'
]);

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SqliteAdapterOptions {
  db: AgentDatabase;
}

// ---------------------------------------------------------------------------
// SqliteAdapter
// ---------------------------------------------------------------------------

export class SqliteAdapter implements FeedbackFileAdapter, FlywheelFileAdapter {
  private readonly db: AgentDatabase;

  /** Expose AgentDatabase for delegation chain queries and other direct access */
  getAgentDatabase(): AgentDatabase {
    return this.db;
  }

  constructor(options: SqliteAdapterOptions) {
    this.db = options.db;
    this.ensureKvTable();
  }

  private ensureKvTable(): void {
    this.db.getDb().prepare(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run();
  }

  // -------------------------------------------------------------------------
  // FeedbackFileAdapter / FlywheelFileAdapter interface
  // -------------------------------------------------------------------------

  readFile(path: string): string {
    if (path.startsWith('feedback/')) {
      const sprintId = this.sprintIdFromPath(path);
      const rows = this.db.getDb()
        .prepare<[string], FeedbackDbRow>(
          'SELECT * FROM feedback WHERE category = ? ORDER BY created_at ASC'
        )
        .all(sprintId);

      if (rows.length === 0) {
        throw new Error(`File not found: ${path}`);
      }

      return JSON.stringify(rows);
    }

    // Generic kv_store lookup
    const row = this.db.getDb()
      .prepare<[string], { value: string }>('SELECT value FROM kv_store WHERE key = ?')
      .get(path);

    if (row === undefined) {
      throw new Error(`File not found: ${path}`);
    }

    return row.value;
  }

  writeFile(path: string, content: string): void {
    if (path.startsWith('feedback/')) {
      // NOTE: When persisting via writeFile('feedback/<sprintId>.json', ...),
      // the category column is forced to sprintId to ensure readFile round-trips work.
      // Direct insertFeedback() callers should set category = sprintId if they want
      // the data to be accessible via readFile.
      const sprintId = this.sprintIdFromPath(path);
      const entries: FeedbackDbRow[] = JSON.parse(content);

      const insert = this.db.getDb().prepare<FeedbackDbRow>(`
        INSERT INTO feedback (id, agent_id, session_id, category, message, sentiment, created_at)
        VALUES (@id, @agent_id, @session_id, @category, @message, @sentiment, @created_at)
        ON CONFLICT(id) DO UPDATE SET
          agent_id   = excluded.agent_id,
          session_id = excluded.session_id,
          category   = excluded.category,
          message    = excluded.message,
          sentiment  = excluded.sentiment,
          created_at = excluded.created_at
      `);

      const upsertAll = this.db.getDb().transaction((rows: FeedbackDbRow[]) => {
        for (const row of rows) {
          insert.run({ ...row, category: sprintId });
        }
      });

      upsertAll(entries);
      return;
    }

    // Generic kv_store upsert
    this.db.getDb().prepare(`
      INSERT INTO kv_store (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value      = excluded.value,
        updated_at = excluded.updated_at
    `).run(path, content);
  }

  fileExists(path: string): boolean {
    if (path.startsWith('feedback/')) {
      const sprintId = this.sprintIdFromPath(path);
      const row = this.db.getDb()
        .prepare<[string], { cnt: number }>(
          'SELECT COUNT(*) as cnt FROM feedback WHERE category = ?'
        )
        .get(sprintId);
      return (row?.cnt ?? 0) > 0;
    }

    const row = this.db.getDb()
      .prepare<[string], { cnt: number }>(
        'SELECT COUNT(*) as cnt FROM kv_store WHERE key = ?'
      )
      .get(path);
    return (row?.cnt ?? 0) > 0;
  }

  // -------------------------------------------------------------------------
  // Sessions CRUD
  // -------------------------------------------------------------------------

  insertSession(record: Omit<SessionRow, 'created_at'>): void {
    this.db.getDb().prepare(`
      INSERT INTO sessions (
        id, agent_id, agent_name, model, task, response, status,
        started_at, completed_at, estimated_tokens, autonomy_tier,
        resume_count, parent_session_id, delegation_depth
      ) VALUES (
        @id, @agent_id, @agent_name, @model, @task, @response, @status,
        @started_at, @completed_at, @estimated_tokens, @autonomy_tier,
        @resume_count, @parent_session_id, @delegation_depth
      )
    `).run(record);
  }

  getSession(id: string): SessionRow | null {
    const row = this.db.getDb()
      .prepare<[string], SessionRow>('SELECT * FROM sessions WHERE id = ?')
      .get(id);
    return row ?? null;
  }

  updateSession(id: string, updates: Partial<SessionRow>): void {
    const safeUpdates = Object.fromEntries(
      Object.entries(updates).filter(([k]) => SESSION_COLUMNS.has(k))
    );
    if (Object.keys(safeUpdates).length === 0) return;
    const fields = Object.keys(safeUpdates).map(k => `${k} = @${k}`).join(', ');
    this.db.getDb().prepare(`UPDATE sessions SET ${fields} WHERE id = @id`)
      .run({ ...safeUpdates, id });
  }

  listSessions(opts?: {
    agentId?: string;
    status?: string;
    limit?: number;
    offset?: number;
    since?: string;
    until?: string;
  }): SessionRow[] {
    let query = 'SELECT * FROM sessions';
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (opts?.agentId !== undefined) {
      conditions.push('agent_id = @agentId');
      params.agentId = opts.agentId;
    }
    if (opts?.status !== undefined) {
      conditions.push('status = @status');
      params.status = opts.status;
    }
    if (opts?.since !== undefined) {
      conditions.push('created_at >= @since');
      params.since = opts.since;
    }
    if (opts?.until !== undefined) {
      conditions.push('created_at <= @until');
      params.until = opts.until;
    }

    if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY created_at DESC';

    const hasOffset = opts?.offset !== undefined && opts.offset > 0;
    if (opts?.limit !== undefined) {
      query += ' LIMIT @limit';
      params.limit = opts.limit;
    } else if (hasOffset) {
      query += ' LIMIT -1'; // unlimited, but needed for OFFSET to work
    }

    if (hasOffset) {
      query += ' OFFSET @offset';
      params.offset = opts!.offset;
    }

    return this.db.getDb()
      .prepare<Record<string, unknown>, SessionRow>(query)
      .all(params);
  }

  countSessions(opts?: { agentId?: string; status?: string; since?: string; until?: string }): number {
    let query = 'SELECT COUNT(*) as total FROM sessions';
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts?.agentId) { conditions.push('agent_id = @agentId'); params.agentId = opts.agentId; }
    if (opts?.status) { conditions.push('status = @status'); params.status = opts.status; }
    if (opts?.since) { conditions.push('created_at >= @since'); params.since = opts.since; }
    if (opts?.until) { conditions.push('created_at <= @until'); params.until = opts.until; }
    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
    const row = this.db.getDb().prepare<Record<string, unknown>, { total: number }>(query).get(params);
    return row?.total ?? 0;
  }

  // -------------------------------------------------------------------------
  // Feedback CRUD
  // -------------------------------------------------------------------------

  insertFeedback(entry: FeedbackDbRow): void {
    this.db.getDb().prepare(`
      INSERT INTO feedback (id, agent_id, session_id, category, message, sentiment, created_at)
      VALUES (@id, @agent_id, @session_id, @category, @message, @sentiment, @created_at)
    `).run(entry);
  }

  listFeedback(opts?: { agentId?: string; limit?: number }): FeedbackDbRow[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (opts?.agentId !== undefined) {
      conditions.push('agent_id = @agentId');
      params.agentId = opts.agentId;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit !== undefined ? `LIMIT ${opts.limit}` : '';

    return this.db.getDb()
      .prepare<Record<string, unknown>, FeedbackDbRow>(
        `SELECT * FROM feedback ${where} ORDER BY created_at DESC ${limit}`
      )
      .all(params);
  }

  // -------------------------------------------------------------------------
  // Costs CRUD
  // -------------------------------------------------------------------------

  insertCost(entry: CostRow): void {
    this.db.getDb().prepare(`
      INSERT INTO agent_costs (id, session_id, agent_id, model, input_tokens, output_tokens, cost_usd, created_at)
      VALUES (@id, @session_id, @agent_id, @model, @input_tokens, @output_tokens, @cost_usd, @created_at)
    `).run(entry);
  }

  getAgentCosts(agentId: string): CostRow[] {
    return this.db.getDb()
      .prepare<[string], CostRow>(
        'SELECT * FROM agent_costs WHERE agent_id = ? ORDER BY created_at DESC'
      )
      .all(agentId);
  }

  getTotalCostUsd(): number {
    const row = this.db.getDb()
      .prepare<[], { total: number | null }>('SELECT SUM(cost_usd) as total FROM agent_costs')
      .get();
    return row?.total ?? 0;
  }

  getAllCosts(): CostRow[] {
    return this.db.getDb()
      .prepare<[], CostRow>('SELECT * FROM agent_costs ORDER BY created_at DESC')
      .all();
  }

  // -------------------------------------------------------------------------
  // Task Outcomes CRUD
  // -------------------------------------------------------------------------

  insertTaskOutcome(outcome: TaskOutcomeRow): void {
    this.db.getDb().prepare(`
      INSERT INTO task_outcomes (id, session_id, agent_id, task, success, quality_score, model, duration_ms, created_at)
      VALUES (@id, @session_id, @agent_id, @task, @success, @quality_score, @model, @duration_ms, @created_at)
    `).run(outcome);
  }

  listTaskOutcomes(opts?: { sessionId?: string; agentId?: string; limit?: number }): TaskOutcomeRow[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (opts?.sessionId !== undefined) {
      conditions.push('session_id = @sessionId');
      params.sessionId = opts.sessionId;
    }
    if (opts?.agentId !== undefined) {
      conditions.push('agent_id = @agentId');
      params.agentId = opts.agentId;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit !== undefined ? `LIMIT ${opts.limit}` : '';

    return this.db.getDb()
      .prepare<Record<string, unknown>, TaskOutcomeRow>(
        `SELECT * FROM task_outcomes ${where} ORDER BY created_at DESC ${limit}`
      )
      .all(params);
  }

  // -------------------------------------------------------------------------
  // Promotions CRUD
  // -------------------------------------------------------------------------

  insertPromotion(promotion: PromotionRow): void {
    this.db.getDb().prepare(`
      INSERT INTO promotions (id, agent_id, previous_tier, new_tier, promoted, demoted, reason, created_at)
      VALUES (@id, @agent_id, @previous_tier, @new_tier, @promoted, @demoted, @reason, @created_at)
    `).run(promotion);
  }

  listPromotions(opts?: { agentId?: string; limit?: number }): PromotionRow[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (opts?.agentId !== undefined) {
      conditions.push('agent_id = @agentId');
      params.agentId = opts.agentId;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit !== undefined ? `LIMIT ${opts.limit}` : '';

    return this.db.getDb()
      .prepare<Record<string, unknown>, PromotionRow>(
        `SELECT * FROM promotions ${where} ORDER BY created_at DESC ${limit}`
      )
      .all(params);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private sprintIdFromPath(path: string): string {
    // 'feedback/v4.7.json' → 'v4.7'
    const filename = path.replace('feedback/', '');
    return filename.endsWith('.json') ? filename.slice(0, -5) : filename;
  }
}
