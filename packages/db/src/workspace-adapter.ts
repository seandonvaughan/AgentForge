import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { WORKSPACE_DDL } from './schema.js';
import { generateId, nowIso } from '@agentforge/shared';

export interface WorkspaceAdapterOptions {
  dbPath: string; // ':memory:' for tests
  workspaceId: string;
}

export interface SessionRow {
  id: string;
  agent_id: string;
  parent_session_id: string | null;
  task: string;
  status: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  delegation_depth: number;
  autonomy_tier: number;
  resume_count: number;
  started_at: string;
  completed_at: string | null;
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

export interface ScorecardRow {
  id: string;
  agent_id: string;
  total_sessions: number;
  completed_sessions: number;
  failed_sessions: number;
  total_cost_usd: number;
  total_latency_ms: number;
  last_updated: string;
}

export interface AgentScore {
  agentId: string;
  completionRate: number;   // 0–1
  costEfficiency: number;   // 1 / avg_cost_per_session (higher = cheaper)
  avgLatencyMs: number;
  successRate: number;
  totalSessions: number;
  score: number;            // composite 0–100
  lastUpdated: string;
}

export interface SessionFilters {
  agentId?: string;
  status?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export class WorkspaceAdapter {
  private readonly db: Database.Database;
  readonly workspaceId: string;

  constructor(options: WorkspaceAdapterOptions) {
    this.workspaceId = options.workspaceId;
    const dir = dirname(options.dbPath);
    if (options.dbPath !== ':memory:' && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(options.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(WORKSPACE_DDL);
  }

  // --- Sessions ---

  createSession(data: {
    agentId: string;
    task: string;
    model?: string;
    parentSessionId?: string;
    autonomyTier?: number;
  }): SessionRow {
    const id = generateId();
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO sessions (id, agent_id, parent_session_id, task, status, model, autonomy_tier, started_at, created_at)
      VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)
    `).run(id, data.agentId, data.parentSessionId ?? null, data.task, data.model ?? null, data.autonomyTier ?? 1, now, now);
    return this.getSession(id)!;
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  completeSession(id: string, status: 'completed' | 'failed', costUsd?: number): void {
    const now = nowIso();
    this.db.prepare(`
      UPDATE sessions SET status = ?, completed_at = ?, cost_usd = COALESCE(?, cost_usd) WHERE id = ?
    `).run(status, now, costUsd ?? null, id);
  }

  listSessions(filters: SessionFilters = {}): SessionRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.agentId) { conditions.push('agent_id = ?'); params.push(filters.agentId); }
    if (filters.status) { conditions.push('status = ?'); params.push(filters.status); }
    if (filters.since) { conditions.push('started_at >= ?'); params.push(filters.since); }
    if (filters.until) { conditions.push('started_at <= ?'); params.push(filters.until); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit ?? 50, 500);
    const offset = filters.offset ?? 0;

    return this.db.prepare(`
      SELECT * FROM sessions ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as SessionRow[];
  }

  countSessions(filters: Omit<SessionFilters, 'limit' | 'offset'> = {}): number {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.agentId) { conditions.push('agent_id = ?'); params.push(filters.agentId); }
    if (filters.status) { conditions.push('status = ?'); params.push(filters.status); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const row = this.db.prepare(`SELECT COUNT(*) as n FROM sessions ${where}`).get(...params) as { n: number };
    return row.n;
  }

  // --- Costs ---

  recordCost(data: {
    sessionId?: string;
    agentId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }): void {
    const id = generateId();
    this.db.prepare(`
      INSERT INTO costs (id, session_id, agent_id, model, input_tokens, output_tokens, cost_usd, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, data.sessionId ?? null, data.agentId, data.model, data.inputTokens, data.outputTokens, data.costUsd, nowIso());
  }

  getAllCosts(): CostRow[] {
    return this.db.prepare('SELECT * FROM costs ORDER BY created_at DESC').all() as CostRow[];
  }

  getAgentCosts(agentId: string): CostRow[] {
    return this.db.prepare('SELECT * FROM costs WHERE agent_id = ? ORDER BY created_at DESC').all(agentId) as CostRow[];
  }

  getTotalCost(): number {
    const row = this.db.prepare('SELECT SUM(cost_usd) as total FROM costs').get() as { total: number | null };
    return row.total ?? 0;
  }

  // --- Promotions / Autonomy ---

  listPromotions(agentId?: string): PromotionRow[] {
    if (agentId) {
      return this.db.prepare('SELECT * FROM promotions WHERE agent_id = ? ORDER BY created_at DESC').all(agentId) as PromotionRow[];
    }
    return this.db.prepare('SELECT * FROM promotions ORDER BY created_at DESC').all() as PromotionRow[];
  }

  recordPromotion(data: {
    agentId: string;
    previousTier: number;
    newTier: number;
    reason?: string;
  }): void {
    const promoted = data.newTier > data.previousTier ? 1 : 0;
    const demoted = data.newTier < data.previousTier ? 1 : 0;
    this.db.prepare(`
      INSERT INTO promotions (id, agent_id, previous_tier, new_tier, promoted, demoted, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(generateId(), data.agentId, data.previousTier, data.newTier, promoted, demoted, data.reason ?? null, nowIso());
  }

  // --- Agent Scorecards ---

  /** Record session outcome into the agent's scorecard. */
  recordSessionOutcome(agentId: string, status: 'completed' | 'failed', costUsd: number, latencyMs = 0): void {
    const existing = this.db
      .prepare('SELECT * FROM agent_scorecards WHERE agent_id = ?')
      .get(agentId) as ScorecardRow | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE agent_scorecards SET
          total_sessions = total_sessions + 1,
          completed_sessions = completed_sessions + ?,
          failed_sessions = failed_sessions + ?,
          total_cost_usd = total_cost_usd + ?,
          total_latency_ms = total_latency_ms + ?,
          last_updated = ?
        WHERE agent_id = ?
      `).run(
        status === 'completed' ? 1 : 0,
        status === 'failed' ? 1 : 0,
        costUsd,
        latencyMs,
        new Date().toISOString(),
        agentId,
      );
    } else {
      this.db.prepare(`
        INSERT INTO agent_scorecards (id, agent_id, total_sessions, completed_sessions, failed_sessions, total_cost_usd, total_latency_ms, last_updated)
        VALUES (?, ?, 1, ?, ?, ?, ?, ?)
      `).run(
        generateId(),
        agentId,
        status === 'completed' ? 1 : 0,
        status === 'failed' ? 1 : 0,
        costUsd,
        latencyMs,
        new Date().toISOString(),
      );
    }
  }

  /** Get computed score for an agent. Returns null if no data. */
  getAgentScore(agentId: string): AgentScore | null {
    const row = this.db
      .prepare('SELECT * FROM agent_scorecards WHERE agent_id = ?')
      .get(agentId) as ScorecardRow | undefined;
    if (!row || row.total_sessions === 0) return null;
    return this._computeScore(row);
  }

  /** List scores for all agents in this workspace. */
  listAgentScores(): AgentScore[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_scorecards ORDER BY last_updated DESC')
      .all() as ScorecardRow[];
    return rows.map(r => this._computeScore(r));
  }

  private _computeScore(row: ScorecardRow): AgentScore {
    const successRate = row.total_sessions > 0 ? row.completed_sessions / row.total_sessions : 0;
    const avgCost = row.total_sessions > 0 ? row.total_cost_usd / row.total_sessions : 0;
    const avgLatencyMs = row.total_sessions > 0 ? row.total_latency_ms / row.total_sessions : 0;
    const costEfficiency = avgCost > 0 ? Math.min(1 / avgCost, 100) : 50; // normalize

    // Composite score (0–100): 60% success rate, 30% cost efficiency, 10% latency
    const normalizedCostEff = Math.min(costEfficiency / 10, 1); // cap at 1
    const normalizedLatency = avgLatencyMs === 0 ? 1 : Math.max(0, 1 - avgLatencyMs / 60_000);
    const score = Math.round((successRate * 0.60 + normalizedCostEff * 0.30 + normalizedLatency * 0.10) * 100);

    return {
      agentId: row.agent_id,
      completionRate: successRate,
      costEfficiency: normalizedCostEff,
      avgLatencyMs,
      successRate,
      totalSessions: row.total_sessions,
      score,
      lastUpdated: row.last_updated,
    };
  }

  // --- KV Store ---

  kvGet(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM kv_store WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  kvSet(key: string, value: string): void {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, now);
  }

  kvList(): Array<{ key: string; value: string; updated_at: string }> {
    return this.db.prepare('SELECT key, value, updated_at FROM kv_store ORDER BY updated_at DESC').all() as Array<{ key: string; value: string; updated_at: string }>;
  }

  // --- Embeddings ---

  storeEmbedding(data: { sourceType: string; sourceId: string; content: string; vector: Float32Array }): void {
    const id = generateId();
    const vectorBlob = Buffer.from(data.vector.buffer);
    this.db.prepare(`
      INSERT INTO embeddings (id, source_type, source_id, content, vector, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_type, source_id) DO UPDATE SET content = excluded.content, vector = excluded.vector, created_at = excluded.created_at
    `).run(id, data.sourceType, data.sourceId, data.content, vectorBlob, nowIso());
  }

  getEmbeddings(sourceType?: string): Array<{ id: string; sourceType: string; sourceId: string; content: string; vector: Float32Array }> {
    const rows = sourceType
      ? this.db.prepare('SELECT * FROM embeddings WHERE source_type = ?').all(sourceType)
      : this.db.prepare('SELECT * FROM embeddings').all();
    return (rows as Array<{ id: string; source_type: string; source_id: string; content: string; vector: Buffer }>).map(row => ({
      id: row.id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      content: row.content,
      vector: new Float32Array(row.vector.buffer),
    }));
  }

  // --- Lifecycle ---

  getRawDb(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
