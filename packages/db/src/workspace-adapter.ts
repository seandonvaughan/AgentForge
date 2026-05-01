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

export interface DecisionEventRow {
  id: string;
  session_id: string | null;
  agent_id: string;
  decision_type: string;
  summary: string;
  rationale: string | null;
  payload_json: string;
  created_at: string;
}

export interface TaskOutcomeRow {
  id: string;
  session_id: string | null;
  agent_id: string;
  task: string;
  outcome: string;
  success: number;
  quality_score: number | null;
  model: string | null;
  duration_ms: number | null;
  summary: string | null;
  payload_json: string;
  created_at: string;
}

export interface TestObservationRow {
  id: string;
  session_id: string | null;
  agent_id: string | null;
  run_id: string | null;
  suite: string | null;
  test_name: string | null;
  file_path: string | null;
  status: string;
  message: string | null;
  payload_json: string;
  observed_at: string;
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

export type RuntimeJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface RuntimeJobRow {
  id: string;
  session_id: string;
  agent_id: string;
  task: string;
  status: RuntimeJobStatus;
  model: string | null;
  runtime_mode: string | null;
  provider_kind: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  error: string | null;
  result_json: string;
  cancel_requested: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RuntimeEventRow {
  sequence: number;
  id: string;
  job_id: string;
  session_id: string;
  agent_id: string;
  type: string;
  category: string;
  message: string;
  data_json: string;
  created_at: string;
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

export interface DecisionEventFilters {
  sessionId?: string;
  agentId?: string;
  decisionType?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface TaskOutcomeFilters {
  sessionId?: string;
  agentId?: string;
  outcome?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface TestObservationFilters {
  sessionId?: string;
  agentId?: string;
  runId?: string;
  status?: string;
  suite?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface RuntimeJobFilters {
  agentId?: string;
  status?: RuntimeJobStatus | string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface RuntimeEventFilters {
  jobId?: string;
  sessionId?: string;
  type?: string;
  afterSequence?: number;
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
    id?: string;
    agentId: string;
    task: string;
    model?: string;
    parentSessionId?: string;
    autonomyTier?: number;
  }): SessionRow {
    const id = data.id ?? generateId();
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

  completeSession(
    id: string,
    status: 'completed' | 'failed',
    costUsd?: number,
    metrics?: {
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
    },
  ): void {
    const now = nowIso();
    this.db.prepare(`
      UPDATE sessions
      SET
        status = ?,
        completed_at = ?,
        cost_usd = COALESCE(?, cost_usd),
        model = COALESCE(?, model),
        input_tokens = COALESCE(?, input_tokens),
        output_tokens = COALESCE(?, output_tokens)
      WHERE id = ?
    `).run(
      status,
      now,
      costUsd ?? null,
      metrics?.model ?? null,
      metrics?.inputTokens ?? null,
      metrics?.outputTokens ?? null,
      id,
    );
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

  // --- Runtime persistence ---

  recordDecisionEvent(data: {
    sessionId?: string;
    agentId: string;
    decisionType: string;
    summary: string;
    rationale?: string;
    payload?: unknown;
    createdAt?: string;
  }): DecisionEventRow {
    const id = generateId();
    const createdAt = data.createdAt ?? nowIso();
    this.db.prepare(`
      INSERT INTO decision_events (id, session_id, agent_id, decision_type, summary, rationale, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.sessionId ?? null,
      data.agentId,
      data.decisionType,
      data.summary,
      data.rationale ?? null,
      serializePayload(data.payload),
      createdAt,
    );
    return this.getDecisionEvent(id)!;
  }

  getDecisionEvent(id: string): DecisionEventRow | undefined {
    return this.db.prepare('SELECT * FROM decision_events WHERE id = ?').get(id) as DecisionEventRow | undefined;
  }

  listDecisionEvents(filters: DecisionEventFilters = {}): DecisionEventRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.sessionId) { conditions.push('session_id = ?'); params.push(filters.sessionId); }
    if (filters.agentId) { conditions.push('agent_id = ?'); params.push(filters.agentId); }
    if (filters.decisionType) { conditions.push('decision_type = ?'); params.push(filters.decisionType); }
    if (filters.since) { conditions.push('created_at >= ?'); params.push(filters.since); }
    if (filters.until) { conditions.push('created_at <= ?'); params.push(filters.until); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit ?? 100, 500);
    const offset = filters.offset ?? 0;

    return this.db.prepare(`
      SELECT * FROM decision_events ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as DecisionEventRow[];
  }

  recordTaskOutcome(data: {
    sessionId?: string;
    agentId: string;
    task: string;
    outcome?: 'success' | 'partial' | 'failure';
    success?: boolean;
    qualityScore?: number;
    model?: string;
    durationMs?: number;
    summary?: string;
    payload?: unknown;
    createdAt?: string;
  }): TaskOutcomeRow {
    const id = generateId();
    const createdAt = data.createdAt ?? nowIso();
    const normalizedOutcome = data.outcome ?? (data.success === false ? 'failure' : 'success');
    const success = normalizedOutcome === 'success' ? 1 : 0;

    this.db.prepare(`
      INSERT INTO task_outcomes (
        id, session_id, agent_id, task, outcome, success, quality_score,
        model, duration_ms, summary, payload_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.sessionId ?? null,
      data.agentId,
      data.task,
      normalizedOutcome,
      success,
      data.qualityScore ?? null,
      data.model ?? null,
      data.durationMs ?? null,
      data.summary ?? null,
      serializePayload(data.payload),
      createdAt,
    );
    return this.getTaskOutcome(id)!;
  }

  getTaskOutcome(id: string): TaskOutcomeRow | undefined {
    return this.db.prepare('SELECT * FROM task_outcomes WHERE id = ?').get(id) as TaskOutcomeRow | undefined;
  }

  listTaskOutcomes(filters: TaskOutcomeFilters = {}): TaskOutcomeRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.sessionId) { conditions.push('session_id = ?'); params.push(filters.sessionId); }
    if (filters.agentId) { conditions.push('agent_id = ?'); params.push(filters.agentId); }
    if (filters.outcome) { conditions.push('outcome = ?'); params.push(filters.outcome); }
    if (filters.since) { conditions.push('created_at >= ?'); params.push(filters.since); }
    if (filters.until) { conditions.push('created_at <= ?'); params.push(filters.until); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit ?? 100, 500);
    const offset = filters.offset ?? 0;

    return this.db.prepare(`
      SELECT * FROM task_outcomes ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as TaskOutcomeRow[];
  }

  recordTestObservation(data: {
    sessionId?: string;
    agentId?: string;
    runId?: string;
    suite?: string;
    testName?: string;
    filePath?: string;
    status: 'passed' | 'failed' | 'skipped' | 'flaky' | 'error' | string;
    message?: string;
    payload?: unknown;
    observedAt?: string;
    createdAt?: string;
  }): TestObservationRow {
    const id = generateId();
    const observedAt = data.observedAt ?? nowIso();
    const createdAt = data.createdAt ?? observedAt;

    this.db.prepare(`
      INSERT INTO test_observations (
        id, session_id, agent_id, run_id, suite, test_name, file_path,
        status, message, payload_json, observed_at, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.sessionId ?? null,
      data.agentId ?? null,
      data.runId ?? null,
      data.suite ?? null,
      data.testName ?? null,
      data.filePath ?? null,
      data.status,
      data.message ?? null,
      serializePayload(data.payload),
      observedAt,
      createdAt,
    );
    return this.getTestObservation(id)!;
  }

  getTestObservation(id: string): TestObservationRow | undefined {
    return this.db.prepare('SELECT * FROM test_observations WHERE id = ?').get(id) as TestObservationRow | undefined;
  }

  listTestObservations(filters: TestObservationFilters = {}): TestObservationRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.sessionId) { conditions.push('session_id = ?'); params.push(filters.sessionId); }
    if (filters.agentId) { conditions.push('agent_id = ?'); params.push(filters.agentId); }
    if (filters.runId) { conditions.push('run_id = ?'); params.push(filters.runId); }
    if (filters.status) { conditions.push('status = ?'); params.push(filters.status); }
    if (filters.suite) { conditions.push('suite = ?'); params.push(filters.suite); }
    if (filters.since) { conditions.push('observed_at >= ?'); params.push(filters.since); }
    if (filters.until) { conditions.push('observed_at <= ?'); params.push(filters.until); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit ?? 100, 500);
    const offset = filters.offset ?? 0;

    return this.db.prepare(`
      SELECT * FROM test_observations ${where} ORDER BY observed_at DESC, created_at DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as TestObservationRow[];
  }

  // --- Runtime Jobs / Events ---

  createRuntimeJob(data: {
    id?: string;
    sessionId: string;
    agentId: string;
    task: string;
    model?: string;
    runtimeMode?: string;
    status?: RuntimeJobStatus;
    createdAt?: string;
  }): RuntimeJobRow {
    const id = data.id ?? generateId();
    const now = data.createdAt ?? nowIso();
    this.db.prepare(`
      INSERT INTO runtime_jobs (
        id, session_id, agent_id, task, status, model, runtime_mode, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.sessionId,
      data.agentId,
      data.task,
      data.status ?? 'queued',
      data.model ?? null,
      data.runtimeMode ?? null,
      now,
      now,
    );
    return this.getRuntimeJob(id)!;
  }

  getRuntimeJob(id: string): RuntimeJobRow | undefined {
    return this.db.prepare('SELECT * FROM runtime_jobs WHERE id = ?').get(id) as RuntimeJobRow | undefined;
  }

  getRuntimeJobBySessionId(sessionId: string): RuntimeJobRow | undefined {
    return this.db.prepare('SELECT * FROM runtime_jobs WHERE session_id = ?').get(sessionId) as RuntimeJobRow | undefined;
  }

  startRuntimeJob(id: string, startedAt = nowIso()): RuntimeJobRow | undefined {
    this.db.prepare(`
      UPDATE runtime_jobs
      SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(startedAt, startedAt, id);
    return this.getRuntimeJob(id);
  }

  completeRuntimeJob(id: string, data: {
    status: Extract<RuntimeJobStatus, 'completed' | 'failed'>;
    model?: string;
    providerKind?: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    error?: string;
    result?: unknown;
    completedAt?: string;
  }): RuntimeJobRow | undefined {
    const completedAt = data.completedAt ?? nowIso();
    this.db.prepare(`
      UPDATE runtime_jobs
      SET
        status = ?,
        completed_at = ?,
        updated_at = ?,
        model = COALESCE(?, model),
        provider_kind = COALESCE(?, provider_kind),
        input_tokens = COALESCE(?, input_tokens),
        output_tokens = COALESCE(?, output_tokens),
        cost_usd = COALESCE(?, cost_usd),
        error = ?,
        result_json = ?
      WHERE id = ?
    `).run(
      data.status,
      completedAt,
      completedAt,
      data.model ?? null,
      data.providerKind ?? null,
      data.inputTokens ?? null,
      data.outputTokens ?? null,
      data.costUsd ?? null,
      data.error ?? null,
      serializePayload(data.result),
      id,
    );
    return this.getRuntimeJob(id);
  }

  cancelRuntimeJob(id: string, completedAt = nowIso(), error?: string): RuntimeJobRow | undefined {
    this.db.prepare(`
      UPDATE runtime_jobs
      SET
        status = 'cancelled',
        cancel_requested = 1,
        completed_at = COALESCE(completed_at, ?),
        updated_at = ?,
        error = COALESCE(?, error)
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(completedAt, completedAt, error ?? null, id);
    return this.getRuntimeJob(id);
  }

  requestRuntimeJobCancel(id: string): RuntimeJobRow | undefined {
    const now = nowIso();
    this.db.prepare(`
      UPDATE runtime_jobs
      SET cancel_requested = 1, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(now, id);
    return this.getRuntimeJob(id);
  }

  listRuntimeJobs(filters: RuntimeJobFilters = {}): RuntimeJobRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.agentId) { conditions.push('agent_id = ?'); params.push(filters.agentId); }
    if (filters.status) { conditions.push('status = ?'); params.push(filters.status); }
    if (filters.since) { conditions.push('created_at >= ?'); params.push(filters.since); }
    if (filters.until) { conditions.push('created_at <= ?'); params.push(filters.until); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit ?? 50, 500);
    const offset = filters.offset ?? 0;

    return this.db.prepare(`
      SELECT * FROM runtime_jobs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as RuntimeJobRow[];
  }

  countRuntimeJobs(filters: Omit<RuntimeJobFilters, 'limit' | 'offset'> = {}): number {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.agentId) { conditions.push('agent_id = ?'); params.push(filters.agentId); }
    if (filters.status) { conditions.push('status = ?'); params.push(filters.status); }
    if (filters.since) { conditions.push('created_at >= ?'); params.push(filters.since); }
    if (filters.until) { conditions.push('created_at <= ?'); params.push(filters.until); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const row = this.db.prepare(`SELECT COUNT(*) as n FROM runtime_jobs ${where}`).get(...params) as { n: number };
    return row.n;
  }

  recordRuntimeEvent(data: {
    id?: string;
    jobId: string;
    sessionId: string;
    agentId: string;
    type: string;
    category?: string;
    message: string;
    data?: unknown;
    createdAt?: string;
  }): RuntimeEventRow {
    const id = data.id ?? generateId();
    const createdAt = data.createdAt ?? nowIso();
    this.db.prepare(`
      INSERT INTO runtime_events (
        id, job_id, session_id, agent_id, type, category, message, data_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.jobId,
      data.sessionId,
      data.agentId,
      data.type,
      data.category ?? 'run',
      data.message,
      serializePayload(data.data),
      createdAt,
    );
    return this.getRuntimeEvent(id)!;
  }

  getRuntimeEvent(id: string): RuntimeEventRow | undefined {
    return this.db.prepare('SELECT * FROM runtime_events WHERE id = ?').get(id) as RuntimeEventRow | undefined;
  }

  listRuntimeEvents(filters: RuntimeEventFilters = {}): RuntimeEventRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.jobId) { conditions.push('job_id = ?'); params.push(filters.jobId); }
    if (filters.sessionId) { conditions.push('session_id = ?'); params.push(filters.sessionId); }
    if (filters.type) { conditions.push('type = ?'); params.push(filters.type); }
    if (filters.afterSequence !== undefined) { conditions.push('sequence > ?'); params.push(filters.afterSequence); }
    if (filters.since) { conditions.push('created_at >= ?'); params.push(filters.since); }
    if (filters.until) { conditions.push('created_at <= ?'); params.push(filters.until); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit ?? 100, 500);
    const offset = filters.offset ?? 0;

    return this.db.prepare(`
      SELECT * FROM runtime_events ${where} ORDER BY sequence ASC LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as RuntimeEventRow[];
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

function serializePayload(payload: unknown): string {
  if (payload === undefined) return '{}';
  if (typeof payload === 'string') return payload;
  return JSON.stringify(payload) ?? '{}';
}
