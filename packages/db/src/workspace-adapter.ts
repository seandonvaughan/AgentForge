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
  trace_id: string;
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
  trace_id: string;
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
  search?: string;
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

export interface GitBranchRow {
  id: string;
  name: string;
  agent_id: string;
  task_id: string;
  target_branch: string;
  status: string;
  review_status: string | null;
  reviewed_by: string | null;
  merged_at: string | null;
  conflict_info: string | null;
  created_at: string;
  updated_at: string;
}

export interface GitMergeQueueRow {
  id: string;
  branch_id: string;
  branch_name: string;
  agent_id: string;
  priority: string;
  status: string;
  queued_at: string;
  merged_at: string | null;
  block_reason: string | null;
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

export interface ApprovalRow {
  id: string;
  proposal_id: string;
  proposal_title: string;
  execution_id: string;
  status: string;
  diff: string | null;
  test_summary_json: string | null;
  impact_summary: string;
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  notes: string | null;
}

export interface ApprovalFilters {
  status?: string;
  limit?: number;
  offset?: number;
}

export interface KnowledgeEntityRow {
  id: string;
  type: string;
  name: string;
  description: string | null;
  source_cycle_id: string | null;
  source_type: string | null;
  embedding: Buffer | null;
  properties_json: string;
  updated_at: string;
  created_at: string;
}

export interface KnowledgeRelationshipRow {
  id: string;
  from_entity_id: string;
  to_entity_id: string;
  type: string;
  confidence: number;
  properties_json: string;
  created_at: string;
}

export interface KnowledgeEntityFilters {
  type?: string;
  sourceCycleId?: string;
  sourceType?: string;
  limit?: number;
  offset?: number;
}

export interface KnowledgeRelationshipFilters {
  entityId?: string;
  type?: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Agent comms (v1) — DMs + central inbox
// See docs/v2-architecture/agent-comm-and-kb-spec.md for the full design.
// ---------------------------------------------------------------------------

export interface DirectMessageRow {
  id: string;
  from_agent: string;
  to_agent: string;
  body: string;
  reply_to_id: string | null;
  sent_at: string;
  delivered_at: string | null;
}

export interface DirectMessageFilters {
  /** Match either fromAgent OR toAgent — "all DMs touching this agent". */
  agentId?: string;
  /** Restrict to messages sent BY this agent. */
  fromAgent?: string;
  /** Restrict to messages received BY this agent. */
  toAgent?: string;
  /** When true, only include messages whose `delivered_at IS NULL`. */
  undeliveredOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface InboxMessageRow {
  id: string;
  body: string;
  kind: string;
  source_id: string | null;
  source_type: string | null;
  thread_id: string | null;
  created_at: string;
}

export interface InboxRecipientRow {
  message_id: string;
  recipient: string;
  status: string;
  read_at: string | null;
}

export interface InboxListFilters {
  /** Recipient to fetch for. Required (v1 spec — '@user' only). */
  recipient: string;
  /** `unread` | `read` | `archived` | `all`. Defaults to `all`. */
  status?: 'unread' | 'read' | 'archived' | 'all';
  limit?: number;
  offset?: number;
}

// --- Knowledge Bases (Subsystem C v1) ---

export type KbVisibility = 'private' | 'workspace' | 'public';

export interface KbRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  owner: string;
  visibility: string;
  created_at: string;
  updated_at: string;
}

export interface KbDocRow {
  id: string;
  kb_id: string;
  slug: string;
  title: string;
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface KbDocVersionRow {
  id: string;
  doc_id: string;
  version: number;
  body_md: string;
  authored_by: string;
  authored_at: string;
  commit_message: string | null;
}

export interface KbListFilters {
  /** Filter by visibility tier; omit for all. */
  visibility?: KbVisibility | KbVisibility[];
  /** Filter by owner. */
  owner?: string;
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
    this.ensureRuntimeTraceColumns();
    this.ensureKnowledgeColumns();
  }

  private ensureRuntimeTraceColumns(): void {
    this.ensureColumn('runtime_jobs', 'trace_id', 'TEXT');
    this.ensureColumn('runtime_events', 'trace_id', 'TEXT');
    this.db.prepare("UPDATE runtime_jobs SET trace_id = 'trace-' || session_id WHERE trace_id IS NULL OR trace_id = ''").run();
    this.db.prepare("UPDATE runtime_events SET trace_id = 'trace-' || session_id WHERE trace_id IS NULL OR trace_id = ''").run();
    this.db.prepare('CREATE INDEX IF NOT EXISTS idx_runtime_jobs_trace ON runtime_jobs(trace_id)').run();
    this.db.prepare('CREATE INDEX IF NOT EXISTS idx_runtime_events_trace ON runtime_events(trace_id, sequence)').run();
  }

  /**
   * Add `properties_json` and `updated_at` to knowledge tables when upgrading
   * from an older DB that was created before these columns were introduced.
   * Safe to call on a fresh DB — `ensureColumn` is idempotent.
   */
  private ensureKnowledgeColumns(): void {
    this.ensureColumn('knowledge_entities', 'properties_json', "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn('knowledge_entities', 'updated_at', "TEXT NOT NULL DEFAULT (datetime('now'))");
    this.ensureColumn('knowledge_entities', 'source_type', "TEXT NOT NULL DEFAULT 'cycle'");
    this.ensureColumn('knowledge_relationships', 'properties_json', "TEXT NOT NULL DEFAULT '{}'");
    this.db.prepare('CREATE INDEX IF NOT EXISTS idx_knowledge_entities_source_type ON knowledge_entities(source_type)').run();
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) {
      this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    }
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
    if (filters.search?.trim()) {
      conditions.push('LOWER(task) LIKE LOWER(?)');
      params.push(`%${filters.search.trim()}%`);
    }
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
    if (filters.search?.trim()) {
      conditions.push('LOWER(task) LIKE LOWER(?)');
      params.push(`%${filters.search.trim()}%`);
    }

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
    traceId?: string;
    agentId: string;
    task: string;
    model?: string;
    runtimeMode?: string;
    status?: RuntimeJobStatus;
    createdAt?: string;
  }): RuntimeJobRow {
    const id = data.id ?? generateId();
    const traceId = data.traceId ?? `trace-${data.sessionId}`;
    const now = data.createdAt ?? nowIso();
    this.db.prepare(`
      INSERT INTO runtime_jobs (
        id, session_id, trace_id, agent_id, task, status, model, runtime_mode, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.sessionId,
      traceId,
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
    traceId?: string;
    agentId: string;
    type: string;
    category?: string;
    message: string;
    data?: unknown;
    createdAt?: string;
  }): RuntimeEventRow {
    const id = data.id ?? generateId();
    const createdAt = data.createdAt ?? nowIso();
    const traceId = data.traceId ?? `trace-${data.sessionId}`;
    this.db.prepare(`
      INSERT INTO runtime_events (
        id, job_id, session_id, trace_id, agent_id, type, category, message, data_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.jobId,
      data.sessionId,
      traceId,
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

  // --- Git Branches ---

  insertGitBranch(data: {
    id: string;
    name: string;
    agentId: string;
    taskId: string;
    targetBranch: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    mergedAt?: string;
    conflictInfo?: string;
    reviewStatus?: string;
    reviewedBy?: string;
  }): GitBranchRow {
    // INSERT OR IGNORE makes this idempotent on retry: if the name already exists
    // (e.g. because the runtime supervisor retried after a transient failure that
    // occurred after the first INSERT succeeded), the duplicate is silently dropped
    // and we return the existing row instead.
    this.db.prepare(`
      INSERT OR IGNORE INTO git_branches (id, name, agent_id, task_id, target_branch, status, review_status, reviewed_by, merged_at, conflict_info, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.id,
      data.name,
      data.agentId,
      data.taskId,
      data.targetBranch,
      data.status,
      data.reviewStatus ?? null,
      data.reviewedBy ?? null,
      data.mergedAt ?? null,
      data.conflictInfo ?? null,
      data.createdAt,
      data.updatedAt,
    );
    // Return the row that was either just inserted or already existed (idempotent).
    return (this.getGitBranch(data.id) ?? this.getGitBranchByName(data.name))!;
  }

  updateGitBranch(id: string, updates: {
    status?: string;
    review_status?: string | null;
    reviewed_by?: string | null;
    merged_at?: string | null;
    conflict_info?: string | null;
  }): void {
    const now = nowIso();
    const setClauses: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    if (updates.status !== undefined) { setClauses.push('status = ?'); params.push(updates.status); }
    if ('review_status' in updates) { setClauses.push('review_status = ?'); params.push(updates.review_status ?? null); }
    if ('reviewed_by' in updates) { setClauses.push('reviewed_by = ?'); params.push(updates.reviewed_by ?? null); }
    if ('merged_at' in updates) { setClauses.push('merged_at = ?'); params.push(updates.merged_at ?? null); }
    if ('conflict_info' in updates) { setClauses.push('conflict_info = ?'); params.push(updates.conflict_info ?? null); }

    params.push(id);
    this.db.prepare(`UPDATE git_branches SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
  }

  getGitBranch(id: string): GitBranchRow | undefined {
    return this.db.prepare('SELECT * FROM git_branches WHERE id = ?').get(id) as GitBranchRow | undefined;
  }

  getGitBranchByName(name: string): GitBranchRow | undefined {
    return this.db.prepare('SELECT * FROM git_branches WHERE name = ?').get(name) as GitBranchRow | undefined;
  }

  listGitBranches(status?: string): GitBranchRow[] {
    if (status) {
      return this.db.prepare('SELECT * FROM git_branches WHERE status = ? ORDER BY created_at DESC').all(status) as GitBranchRow[];
    }
    return this.db.prepare('SELECT * FROM git_branches ORDER BY created_at DESC').all() as GitBranchRow[];
  }

  deleteGitBranch(id: string): void {
    // ON DELETE CASCADE handles git_merge_queue cleanup automatically.
    this.db.prepare('DELETE FROM git_branches WHERE id = ?').run(id);
  }

  // --- Git Merge Queue ---

  insertGitMergeQueueItem(data: {
    id: string;
    branchId: string;
    branchName: string;
    agentId: string;
    priority: string;
    status: string;
    queuedAt: string;
    mergedAt?: string;
    blockReason?: string;
  }): GitMergeQueueRow {
    // INSERT OR IGNORE makes this idempotent on retry: if a queue entry for this
    // branch already exists (e.g. runtime supervisor retried submitForReview), the
    // duplicate is dropped and we return the existing entry.
    this.db.prepare(`
      INSERT OR IGNORE INTO git_merge_queue (id, branch_id, branch_name, agent_id, priority, status, queued_at, merged_at, block_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.id,
      data.branchId,
      data.branchName,
      data.agentId,
      data.priority,
      data.status,
      data.queuedAt,
      data.mergedAt ?? null,
      data.blockReason ?? null,
    );
    // Return the row that was either just inserted or already existed (idempotent).
    return (this.db.prepare('SELECT * FROM git_merge_queue WHERE id = ?').get(data.id) ??
      this.getGitMergeQueueItemByBranchId(data.branchId)) as GitMergeQueueRow;
  }

  updateGitMergeQueueItem(id: string, updates: {
    status?: string;
    mergedAt?: string | null;
    blockReason?: string | null;
  }): void {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (updates.status !== undefined) { setClauses.push('status = ?'); params.push(updates.status); }
    if ('mergedAt' in updates) { setClauses.push('merged_at = ?'); params.push(updates.mergedAt ?? null); }
    if ('blockReason' in updates) { setClauses.push('block_reason = ?'); params.push(updates.blockReason ?? null); }

    if (setClauses.length === 0) return;
    params.push(id);
    this.db.prepare(`UPDATE git_merge_queue SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
  }

  getGitMergeQueueItemByBranchId(branchId: string): GitMergeQueueRow | undefined {
    return this.db
      .prepare('SELECT * FROM git_merge_queue WHERE branch_id = ? ORDER BY queued_at DESC LIMIT 1')
      .get(branchId) as GitMergeQueueRow | undefined;
  }

  listGitMergeQueue(status?: string): GitMergeQueueRow[] {
    if (status) {
      return this.db.prepare('SELECT * FROM git_merge_queue WHERE status = ? ORDER BY queued_at ASC').all(status) as GitMergeQueueRow[];
    }
    return this.db.prepare('SELECT * FROM git_merge_queue ORDER BY queued_at ASC').all() as GitMergeQueueRow[];
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

  // --- Approvals ---

  createApproval(data: {
    id?: string;
    proposalId: string;
    proposalTitle?: string;
    executionId: string;
    diff?: string | null;
    testSummaryJson?: string | null;
    impactSummary?: string;
    submittedAt?: string;
  }): ApprovalRow {
    const id = data.id ?? generateId();
    const submittedAt = data.submittedAt ?? nowIso();
    this.db.prepare(`
      INSERT INTO approvals
        (id, proposal_id, proposal_title, execution_id, diff, test_summary_json, impact_summary, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.proposalId,
      data.proposalTitle ?? 'Untitled',
      data.executionId,
      data.diff ?? null,
      data.testSummaryJson ?? null,
      data.impactSummary ?? 'No impact summary provided.',
      submittedAt,
    );
    return this.getApproval(id)!;
  }

  getApproval(id: string): ApprovalRow | undefined {
    return this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
  }

  listApprovals(filters: ApprovalFilters = {}): ApprovalRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filters.status) { conditions.push('status = ?'); params.push(filters.status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit ?? 500, 2000);
    const offset = filters.offset ?? 0;
    return this.db.prepare(`
      SELECT * FROM approvals ${where} ORDER BY submitted_at DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as ApprovalRow[];
  }

  updateApprovalStatus(
    id: string,
    status: 'approved' | 'rejected' | 'rolled_back',
    updates: { reviewedBy?: string; reviewedAt?: string; notes?: string } = {},
  ): void {
    const reviewedAt = updates.reviewedAt ?? nowIso();
    this.db.prepare(`
      UPDATE approvals
      SET status = ?, reviewed_at = ?, reviewed_by = COALESCE(?, reviewed_by), notes = COALESCE(?, notes)
      WHERE id = ?
    `).run(status, reviewedAt, updates.reviewedBy ?? null, updates.notes ?? null, id);
  }

  // --- Knowledge Graph ---

  upsertKnowledgeEntity(data: {
    id?: string;
    type: string;
    name: string;
    description?: string | null;
    sourceCycleId?: string | null;
    sourceType?: string | null;
    embedding?: Float32Array | null;
    propertiesJson?: string;
    updatedAt?: string;
    createdAt?: string;
  }): KnowledgeEntityRow {
    const id = data.id ?? generateId();
    const now = nowIso();
    const createdAt = data.createdAt ?? now;
    const updatedAt = data.updatedAt ?? now;
    const embeddingBlob = data.embedding ? Buffer.from(data.embedding.buffer) : null;
    this.db.prepare(`
      INSERT INTO knowledge_entities
        (id, type, name, description, source_cycle_id, source_type, embedding, properties_json, updated_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        name = excluded.name,
        description = excluded.description,
        source_cycle_id = excluded.source_cycle_id,
        source_type = excluded.source_type,
        embedding = COALESCE(excluded.embedding, embedding),
        properties_json = excluded.properties_json,
        updated_at = excluded.updated_at
    `).run(
      id,
      data.type,
      data.name,
      data.description ?? null,
      data.sourceCycleId ?? null,
      data.sourceType ?? 'cycle',
      embeddingBlob,
      data.propertiesJson ?? '{}',
      updatedAt,
      createdAt,
    );
    return this.getKnowledgeEntity(id)!;
  }

  getKnowledgeEntity(id: string): KnowledgeEntityRow | undefined {
    return this.db.prepare('SELECT * FROM knowledge_entities WHERE id = ?').get(id) as KnowledgeEntityRow | undefined;
  }

  listKnowledgeEntities(filters: KnowledgeEntityFilters = {}): KnowledgeEntityRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.type) { conditions.push('type = ?'); params.push(filters.type); }
    if (filters.sourceCycleId) { conditions.push('source_cycle_id = ?'); params.push(filters.sourceCycleId); }
    if (filters.sourceType) { conditions.push('source_type = ?'); params.push(filters.sourceType); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit ?? 200, 2000);
    const offset = filters.offset ?? 0;

    return this.db.prepare(`
      SELECT * FROM knowledge_entities ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as KnowledgeEntityRow[];
  }

  countKnowledgeEntities(type?: string): number {
    const row = type
      ? this.db.prepare('SELECT COUNT(*) as n FROM knowledge_entities WHERE type = ?').get(type) as { n: number }
      : this.db.prepare('SELECT COUNT(*) as n FROM knowledge_entities').get() as { n: number };
    return row.n;
  }

  upsertKnowledgeEntityByName(data: {
    type: string;
    name: string;
    description?: string | null;
    sourceCycleId?: string | null;
    sourceType?: string | null;
    embedding?: Float32Array | null;
    propertiesJson?: string;
  }): KnowledgeEntityRow {
    const existing = this.db.prepare(`
      SELECT * FROM knowledge_entities WHERE type = ? AND name = ? LIMIT 1
    `).get(data.type, data.name) as KnowledgeEntityRow | undefined;

    return this.upsertKnowledgeEntity({
      ...(existing?.id ? { id: existing.id } : {}),
      type: data.type,
      name: data.name,
      description: data.description ?? existing?.description ?? null,
      sourceCycleId: data.sourceCycleId ?? existing?.source_cycle_id ?? null,
      sourceType: data.sourceType ?? existing?.source_type ?? 'cycle',
      ...(data.embedding !== undefined ? { embedding: data.embedding } : {}),
      propertiesJson: data.propertiesJson ?? existing?.properties_json ?? '{}',
    });
  }

  deleteKnowledgeEntity(id: string): boolean {
    // ON DELETE CASCADE removes associated relationships automatically.
    const result = this.db.prepare('DELETE FROM knowledge_entities WHERE id = ?').run(id);
    return result.changes > 0;
  }

  insertKnowledgeRelationship(data: {
    id?: string;
    fromEntityId: string;
    toEntityId: string;
    type: string;
    confidence?: number;
    propertiesJson?: string;
    createdAt?: string;
  }): KnowledgeRelationshipRow {
    const id = data.id ?? generateId();
    const createdAt = data.createdAt ?? nowIso();
    this.db.prepare(`
      INSERT INTO knowledge_relationships
        (id, from_entity_id, to_entity_id, type, confidence, properties_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.fromEntityId,
      data.toEntityId,
      data.type,
      data.confidence ?? 0.5,
      data.propertiesJson ?? '{}',
      createdAt,
    );
    return this.getKnowledgeRelationship(id)!;
  }

  getKnowledgeRelationship(id: string): KnowledgeRelationshipRow | undefined {
    return this.db.prepare('SELECT * FROM knowledge_relationships WHERE id = ?').get(id) as KnowledgeRelationshipRow | undefined;
  }

  listKnowledgeRelationships(filters: KnowledgeRelationshipFilters = {}): KnowledgeRelationshipRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.type) { conditions.push('type = ?'); params.push(filters.type); }
    if (filters.entityId) {
      conditions.push('(from_entity_id = ? OR to_entity_id = ?)');
      params.push(filters.entityId, filters.entityId);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit ?? 500, 5000);
    const offset = filters.offset ?? 0;

    return this.db.prepare(`
      SELECT * FROM knowledge_relationships ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as KnowledgeRelationshipRow[];
  }

  countKnowledgeRelationships(): number {
    const row = this.db.prepare('SELECT COUNT(*) as n FROM knowledge_relationships').get() as { n: number };
    return row.n;
  }

  deleteKnowledgeRelationship(id: string): boolean {
    const result = this.db.prepare('DELETE FROM knowledge_relationships WHERE id = ?').run(id);
    return result.changes > 0;
  }

  deleteKnowledgeRelationshipsByEntity(entityId: string): number {
    const result = this.db.prepare(
      'DELETE FROM knowledge_relationships WHERE from_entity_id = ? OR to_entity_id = ?',
    ).run(entityId, entityId);
    return result.changes;
  }

  // --- Direct Messages (v1) ---

  /**
   * Insert a new DM. Caller is responsible for ensuring `fromAgent`/`toAgent`
   * are non-empty. Returns the fully-materialised row.
   *
   * The runtime injects undelivered DMs into the recipient's next prompt;
   * see `injectAgentDms` in @agentforge/core.
   */
  createDirectMessage(data: {
    id?: string;
    fromAgent: string;
    toAgent: string;
    body: string;
    replyToId?: string;
    sentAt?: string;
  }): DirectMessageRow {
    const id = data.id ?? generateId();
    const sentAt = data.sentAt ?? nowIso();
    this.db.prepare(`
      INSERT INTO direct_messages (id, from_agent, to_agent, body, reply_to_id, sent_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, data.fromAgent, data.toAgent, data.body, data.replyToId ?? null, sentAt);
    return this.getDirectMessage(id)!;
  }

  getDirectMessage(id: string): DirectMessageRow | undefined {
    return this.db.prepare('SELECT * FROM direct_messages WHERE id = ?').get(id) as DirectMessageRow | undefined;
  }

  listDirectMessages(filters: DirectMessageFilters = {}): DirectMessageRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.agentId) {
      conditions.push('(from_agent = ? OR to_agent = ?)');
      params.push(filters.agentId, filters.agentId);
    }
    if (filters.fromAgent) {
      conditions.push('from_agent = ?');
      params.push(filters.fromAgent);
    }
    if (filters.toAgent) {
      conditions.push('to_agent = ?');
      params.push(filters.toAgent);
    }
    if (filters.undeliveredOnly) {
      conditions.push('delivered_at IS NULL');
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit ?? 100, 500);
    const offset = filters.offset ?? 0;

    return this.db.prepare(`
      SELECT * FROM direct_messages ${where} ORDER BY sent_at ASC LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as DirectMessageRow[];
  }

  /** Mark a set of DMs delivered (idempotent — already-delivered rows untouched). */
  markDirectMessagesDelivered(ids: readonly string[], at: string = nowIso()): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(',');
    const result = this.db
      .prepare(`UPDATE direct_messages SET delivered_at = ? WHERE delivered_at IS NULL AND id IN (${placeholders})`)
      .run(at, ...ids);
    return result.changes;
  }

  // --- Central Inbox (v1) ---

  /**
   * Insert an inbox message + one recipient row per `recipients[]`. The two
   * inserts run inside a transaction so a single failure rolls both back.
   *
   * v1 limits enforced upstream (helper layer): recipient must be '@user'.
   */
  createInboxMessage(data: {
    id?: string;
    body: string;
    kind?: 'info' | 'warning' | 'action_required';
    sourceId?: string | null;
    sourceType?: string | null;
    threadId?: string | null;
    recipients: readonly string[];
    createdAt?: string;
  }): { message: InboxMessageRow; recipients: InboxRecipientRow[] } {
    if (data.recipients.length === 0) {
      throw new Error('createInboxMessage: recipients must be non-empty');
    }
    const id = data.id ?? generateId();
    const createdAt = data.createdAt ?? nowIso();
    const kind = data.kind ?? 'info';

    const tx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO inbox_messages (id, body, kind, source_id, source_type, thread_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, data.body, kind, data.sourceId ?? null, data.sourceType ?? null, data.threadId ?? null, createdAt);
      const insertRecipient = this.db.prepare(`
        INSERT INTO inbox_recipients (message_id, recipient, status) VALUES (?, ?, 'unread')
      `);
      for (const r of data.recipients) {
        insertRecipient.run(id, r);
      }
    });
    tx();

    return {
      message: this.getInboxMessage(id)!,
      recipients: this.listInboxRecipients(id),
    };
  }

  getInboxMessage(id: string): InboxMessageRow | undefined {
    return this.db.prepare('SELECT * FROM inbox_messages WHERE id = ?').get(id) as InboxMessageRow | undefined;
  }

  /**
   * Find an existing inbox message by its `(source_type, source_id)` pair.
   * Used by `InboxBridge` to dedupe gate/finding mirrors on bus replay so
   * the same memory entry never produces two inbox rows.
   *
   * Indexed via `idx_inbox_messages_source` — O(1).
   */
  findInboxMessageBySource(
    sourceType: string,
    sourceId: string,
  ): InboxMessageRow | undefined {
    return this.db
      .prepare(
        'SELECT * FROM inbox_messages WHERE source_type = ? AND source_id = ? LIMIT 1',
      )
      .get(sourceType, sourceId) as InboxMessageRow | undefined;
  }

  listInboxRecipients(messageId: string): InboxRecipientRow[] {
    return this.db.prepare('SELECT * FROM inbox_recipients WHERE message_id = ? ORDER BY recipient').all(messageId) as InboxRecipientRow[];
  }

  /**
   * List inbox messages for a recipient, ordered newest first. The status
   * filter joins against `inbox_recipients` so per-recipient state is honoured.
   */
  listInboxForRecipient(filters: InboxListFilters): Array<InboxMessageRow & { status: string; read_at: string | null }> {
    const status = filters.status ?? 'all';
    const conditions: string[] = ['ir.recipient = ?'];
    const params: unknown[] = [filters.recipient];
    if (status !== 'all') {
      conditions.push('ir.status = ?');
      params.push(status);
    }
    const limit = Math.min(filters.limit ?? 100, 500);
    const offset = filters.offset ?? 0;
    return this.db.prepare(`
      SELECT im.*, ir.status AS status, ir.read_at AS read_at
      FROM inbox_messages im
      INNER JOIN inbox_recipients ir ON ir.message_id = im.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY im.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<InboxMessageRow & { status: string; read_at: string | null }>;
  }

  countInboxForRecipient(recipient: string, status?: 'unread' | 'read' | 'archived'): number {
    const conditions: string[] = ['recipient = ?'];
    const params: unknown[] = [recipient];
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM inbox_recipients WHERE ${conditions.join(' AND ')}`).get(...params) as { n: number };
    return row.n;
  }

  /** Mark an inbox message read for a specific recipient. Idempotent. */
  markInboxRead(messageId: string, recipient: string, at: string = nowIso()): InboxRecipientRow | undefined {
    this.db.prepare(`
      UPDATE inbox_recipients
      SET status = 'read', read_at = COALESCE(read_at, ?)
      WHERE message_id = ? AND recipient = ?
    `).run(at, messageId, recipient);
    return this.db
      .prepare('SELECT * FROM inbox_recipients WHERE message_id = ? AND recipient = ?')
      .get(messageId, recipient) as InboxRecipientRow | undefined;
  }

  // --- Knowledge Bases (Subsystem C v1) ---

  /**
   * Insert a KB row. Returns the persisted row. Slug uniqueness is enforced
   * by the DB; callers should treat constraint failures as bad-request.
   */
  createKb(data: {
    id?: string;
    slug: string;
    title: string;
    description?: string | null;
    owner: string;
    visibility?: KbVisibility;
    createdAt?: string;
  }): KbRow {
    const id = data.id ?? generateId();
    const now = data.createdAt ?? nowIso();
    this.db
      .prepare(
        `INSERT INTO kbs (id, slug, title, description, owner, visibility, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.slug,
        data.title,
        data.description ?? null,
        data.owner,
        data.visibility ?? 'workspace',
        now,
        now,
      );
    return this.getKb(id)!;
  }

  getKb(id: string): KbRow | undefined {
    return this.db.prepare('SELECT * FROM kbs WHERE id = ?').get(id) as KbRow | undefined;
  }

  getKbBySlug(slug: string): KbRow | undefined {
    return this.db.prepare('SELECT * FROM kbs WHERE slug = ?').get(slug) as KbRow | undefined;
  }

  listKbs(filters: KbListFilters = {}): KbRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filters.visibility) {
      const list = Array.isArray(filters.visibility) ? filters.visibility : [filters.visibility];
      if (list.length > 0) {
        const placeholders = list.map(() => '?').join(', ');
        conditions.push(`visibility IN (${placeholders})`);
        params.push(...list);
      }
    }
    if (filters.owner) {
      conditions.push('owner = ?');
      params.push(filters.owner);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(filters.limit ?? 200, 500);
    const offset = filters.offset ?? 0;
    return this.db
      .prepare(`SELECT * FROM kbs ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as KbRow[];
  }

  updateKb(
    id: string,
    patch: { title?: string; description?: string | null; visibility?: KbVisibility },
  ): KbRow | undefined {
    const existing = this.getKb(id);
    if (!existing) return undefined;
    const next = {
      title: patch.title ?? existing.title,
      description: patch.description !== undefined ? patch.description : existing.description,
      visibility: patch.visibility ?? (existing.visibility as KbVisibility),
      updated_at: nowIso(),
    };
    this.db
      .prepare(
        `UPDATE kbs SET title = ?, description = ?, visibility = ?, updated_at = ? WHERE id = ?`,
      )
      .run(next.title, next.description, next.visibility, next.updated_at, id);
    return this.getKb(id);
  }

  deleteKb(id: string): boolean {
    const res = this.db.prepare('DELETE FROM kbs WHERE id = ?').run(id);
    return res.changes > 0;
  }

  /**
   * Create a KB document at version 1. Atomically writes both `kb_docs` and
   * an initial `kb_doc_versions` row, linking via `current_version_id`.
   */
  createKbDoc(data: {
    id?: string;
    kbId: string;
    slug: string;
    title: string;
    bodyMd: string;
    authoredBy: string;
    commitMessage?: string | null;
    createdAt?: string;
  }): { doc: KbDocRow; version: KbDocVersionRow } {
    const docId = data.id ?? generateId();
    const versionId = generateId();
    const now = data.createdAt ?? nowIso();
    const commitMessage = data.commitMessage ?? null;

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO kb_docs (id, kb_id, slug, title, current_version_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(docId, data.kbId, data.slug, data.title, versionId, now, now);
      this.db
        .prepare(
          `INSERT INTO kb_doc_versions
             (id, doc_id, version, body_md, authored_by, authored_at, commit_message)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(versionId, docId, 1, data.bodyMd, data.authoredBy, now, commitMessage);
      this.db.prepare('UPDATE kbs SET updated_at = ? WHERE id = ?').run(now, data.kbId);
    });
    tx();

    return {
      doc: this.getKbDocById(docId)!,
      version: this.getKbDocVersionById(versionId)!,
    };
  }

  getKbDocById(id: string): KbDocRow | undefined {
    return this.db.prepare('SELECT * FROM kb_docs WHERE id = ?').get(id) as KbDocRow | undefined;
  }

  getKbDocBySlug(kbId: string, slug: string): KbDocRow | undefined {
    return this.db
      .prepare('SELECT * FROM kb_docs WHERE kb_id = ? AND slug = ?')
      .get(kbId, slug) as KbDocRow | undefined;
  }

  listKbDocs(kbId: string): KbDocRow[] {
    return this.db
      .prepare('SELECT * FROM kb_docs WHERE kb_id = ? ORDER BY updated_at DESC')
      .all(kbId) as KbDocRow[];
  }

  countKbDocs(kbId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM kb_docs WHERE kb_id = ?')
      .get(kbId) as { n: number };
    return row.n;
  }

  /**
   * Append a new version to an existing document. Bumps `current_version_id`.
   * NEVER mutates an existing version row. Returns the new version.
   */
  appendKbDocVersion(data: {
    docId: string;
    bodyMd: string;
    authoredBy: string;
    title?: string;
    commitMessage?: string | null;
    authoredAt?: string;
  }): { doc: KbDocRow; version: KbDocVersionRow } | undefined {
    const doc = this.getKbDocById(data.docId);
    if (!doc) return undefined;
    const versionId = generateId();
    const now = data.authoredAt ?? nowIso();
    const commitMessage = data.commitMessage ?? null;

    const tx = this.db.transaction(() => {
      const maxRow = this.db
        .prepare('SELECT COALESCE(MAX(version), 0) AS m FROM kb_doc_versions WHERE doc_id = ?')
        .get(data.docId) as { m: number };
      const nextVersion = maxRow.m + 1;
      this.db
        .prepare(
          `INSERT INTO kb_doc_versions
             (id, doc_id, version, body_md, authored_by, authored_at, commit_message)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(versionId, data.docId, nextVersion, data.bodyMd, data.authoredBy, now, commitMessage);
      this.db
        .prepare(
          `UPDATE kb_docs SET current_version_id = ?, title = ?, updated_at = ? WHERE id = ?`,
        )
        .run(versionId, data.title ?? doc.title, now, data.docId);
      this.db.prepare('UPDATE kbs SET updated_at = ? WHERE id = ?').run(now, doc.kb_id);
    });
    tx();

    return {
      doc: this.getKbDocById(data.docId)!,
      version: this.getKbDocVersionById(versionId)!,
    };
  }

  getKbDocVersionById(id: string): KbDocVersionRow | undefined {
    return this.db
      .prepare('SELECT * FROM kb_doc_versions WHERE id = ?')
      .get(id) as KbDocVersionRow | undefined;
  }

  getKbDocVersion(docId: string, version: number): KbDocVersionRow | undefined {
    return this.db
      .prepare('SELECT * FROM kb_doc_versions WHERE doc_id = ? AND version = ?')
      .get(docId, version) as KbDocVersionRow | undefined;
  }

  listKbDocVersions(docId: string): KbDocVersionRow[] {
    return this.db
      .prepare('SELECT * FROM kb_doc_versions WHERE doc_id = ? ORDER BY version DESC')
      .all(docId) as KbDocVersionRow[];
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
