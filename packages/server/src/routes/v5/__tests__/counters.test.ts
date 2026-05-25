/**
 * Tests for GET /api/v5/counters
 *
 * The counters endpoint aggregates system-wide metrics (open branches,
 * pending approvals, running cycles, spend, active agents, load) from the
 * workspace SQLite DB and cycle ledger fixtures.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceAdapter } from '@agentforge/db';
import { countersRoutes, _resetCache, type CountersResponse } from '../counters.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(): WorkspaceAdapter {
  return new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test-ws' });
}

async function buildApp(adapter: WorkspaceAdapter, projectRoot: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await countersRoutes(app, { adapter, projectRoot });
  await app.ready();
  return app;
}

async function getCounters(app: FastifyInstance): Promise<CountersResponse> {
  const res = await app.inject({ method: 'GET', url: '/api/v5/counters' });
  expect(res.statusCode).toBe(200);
  return res.json() as CountersResponse;
}

/** Seed a session row with a custom started_at (for windowing tests). */
function seedSessionAt(adapter: WorkspaceAdapter, agentId: string, startedAt: string): void {
  const db = adapter.getRawDb();
  db.prepare(
    `INSERT INTO sessions (id, agent_id, task, status, started_at, created_at)
     VALUES (?, ?, 'test', 'running', ?, ?)`,
  ).run(`sess-${String(Math.random()).slice(2)}`, agentId, startedAt, startedAt);
}

/** Insert a runtime_job row at status='running'. These are jobs, not cycles. */
function seedRunningJob(adapter: WorkspaceAdapter, agentId: string): void {
  const session = adapter.createSession({ agentId, task: 'run' });
  adapter.createRuntimeJob({ sessionId: session.id, agentId, task: 'run', status: 'running' });
}

/** Insert an abandoned runtime_job row that should not drive live counters. */
function seedStaleRunningJob(adapter: WorkspaceAdapter, agentId: string): void {
  const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const session = adapter.createSession({ agentId, task: 'stale-run' });
  adapter.createRuntimeJob({
    sessionId: session.id,
    agentId,
    task: 'stale-run',
    status: 'running',
    createdAt: stale,
  });
}

function seedCycleLedger(cycleId: string, payload: Record<string, unknown>): void {
  const cycleDir = join(projectRoot, '.agentforge', 'cycles', cycleId);
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(join(cycleDir, 'cycle.json'), JSON.stringify(payload, null, 2));
}

function seedFreshRunningCycle(cycleId: string, extra: Record<string, unknown> = {}): void {
  seedCycleLedger(cycleId, {
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
    stage: 'run',
    ...extra,
  });
}

/** Seed a cost record with a specific created_at for spend windowing tests. */
function seedCost(adapter: WorkspaceAdapter, costUsd: number, createdAt: string): void {
  const db = adapter.getRawDb();
  db.prepare(
    'INSERT INTO costs (id, session_id, agent_id, model, input_tokens, output_tokens, cost_usd, created_at) VALUES (?, NULL, ?, ?, 0, 0, ?, ?)',
  ).run(`cost-${Math.random()}`, 'agent-test', 'claude-sonnet', costUsd, createdAt);
}

/** Seed a git_branch row. */
function seedBranch(adapter: WorkspaceAdapter, status: string): void {
  adapter.insertGitBranch({
    id: `br-${Math.random()}`,
    name: `autonomous/branch-${Math.random()}`,
    agentId: 'agent-1',
    taskId: 'task-1',
    targetBranch: 'main',
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

/** Seed a pending approval. */
function seedApproval(adapter: WorkspaceAdapter, status: string): void {
  adapter.createApproval({
    proposalId: `prop-${Math.random()}`,
    proposalTitle: 'Test',
    executionId: `exec-${Math.random()}`,
    impactSummary: 'test',
  });
  // If non-pending, transition it
  if (status !== 'pending') {
    const row = adapter.listApprovals()[0];
    if (row) adapter.updateApprovalStatus(row.id, status as 'approved' | 'rejected' | 'rolled_back');
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let adapter: WorkspaceAdapter;
let app: FastifyInstance;
let projectRoot: string;

beforeEach(async () => {
  _resetCache(); // ensure no cross-test cache bleed
  projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-counters-'));
  adapter = makeAdapter();
  app = await buildApp(adapter, projectRoot);
});

afterEach(async () => {
  await app.close();
  adapter.close();
  rmSync(projectRoot, { recursive: true, force: true });
  _resetCache();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v5/counters — empty workspace', () => {
  it('returns 200 with all numeric counters at zero', async () => {
    const body = await getCounters(app);
    expect(body.openBranches).toBe(0);
    expect(body.pendingApprovals).toBe(0);
    expect(body.runningCycles).toBe(0);
    expect(body.todaySpendUsd).toBe(0);
    expect(body.weekSpendUsd).toBe(0);
    expect(body.agentsActive).toBe(0);
  });

  it('returns load=idle when no cycles are running', async () => {
    const body = await getCounters(app);
    expect(body.load).toBe('idle');
  });

  it('returns a valid ISO 8601 timestamp', async () => {
    const body = await getCounters(app);
    expect(typeof body.timestamp).toBe('string');
    expect(() => new Date(body.timestamp)).not.toThrow();
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });
});

describe('GET /api/v5/counters — pendingApprovals', () => {
  it('counts only pending approvals', async () => {
    seedApproval(adapter, 'pending');
    seedApproval(adapter, 'pending');
    seedApproval(adapter, 'approved');
    _resetCache();
    const body = await getCounters(app);
    expect(body.pendingApprovals).toBe(2);
  });
});

describe('GET /api/v5/counters — openBranches', () => {
  it('counts branches not in terminal states', async () => {
    seedBranch(adapter, 'open');
    seedBranch(adapter, 'open');
    seedBranch(adapter, 'merged');
    seedBranch(adapter, 'deleted');
    _resetCache();
    const body = await getCounters(app);
    expect(body.openBranches).toBe(2);
  });
});

describe('GET /api/v5/counters — runningCycles', () => {
  it('counts fresh running cycle ledger entries without counting per-agent jobs', async () => {
    seedFreshRunningCycle('cycle-running');
    seedRunningJob(adapter, 'agent-a');
    seedRunningJob(adapter, 'agent-b');
    // Seed a completed job that should NOT be counted
    const s = adapter.createSession({ agentId: 'agent-c', task: 'done' });
    const job = adapter.createRuntimeJob({ sessionId: s.id, agentId: 'agent-c', task: 'done' });
    adapter.completeRuntimeJob(job.id, { status: 'completed' });
    _resetCache();
    const body = await getCounters(app);
    expect(body.runningCycles).toBe(1);
  });

  it('counts heartbeat-only cycle ledger entries before a stage is written', async () => {
    seedFreshRunningCycle('cycle-heartbeat-only', { stage: undefined });
    _resetCache();
    const body = await getCounters(app);
    expect(body.runningCycles).toBe(1);
    expect(body.load).toBe('busy');
  });

  it('ignores SQL runtime_jobs left running by agent invocations', async () => {
    seedRunningJob(adapter, 'agent-fresh-a');
    seedRunningJob(adapter, 'agent-fresh-b');
    seedStaleRunningJob(adapter, 'agent-stale');
    _resetCache();
    const body = await getCounters(app);
    expect(body.runningCycles).toBe(0);
    expect(body.load).toBe('idle');
  });
});

describe('GET /api/v5/counters — load derivation', () => {
  it('load=busy when 1 or 2 cycles are running', async () => {
    seedFreshRunningCycle('cycle-a');
    _resetCache();
    const body = await getCounters(app);
    expect(body.load).toBe('busy');
  });

  it('load=overloaded when 3 or more cycles are running', async () => {
    seedFreshRunningCycle('cycle-a');
    seedFreshRunningCycle('cycle-b');
    seedFreshRunningCycle('cycle-c');
    _resetCache();
    const body = await getCounters(app);
    expect(body.load).toBe('overloaded');
  });
});

describe('GET /api/v5/counters — spend windowing', () => {
  it('todaySpendUsd sums costs from today only', async () => {
    const now = new Date();
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 6, 0, 0).toISOString();
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0).toISOString();
    seedCost(adapter, 2.50, todayMidnight);
    seedCost(adapter, 1.00, yesterday);
    _resetCache();
    const body = await getCounters(app);
    expect(body.todaySpendUsd).toBeCloseTo(2.5, 4);
  });

  it('weekSpendUsd includes costs from the last 7 days', async () => {
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    seedCost(adapter, 3.00, threeDaysAgo);
    seedCost(adapter, 99.99, tenDaysAgo); // outside 7-day window
    _resetCache();
    const body = await getCounters(app);
    expect(body.weekSpendUsd).toBeCloseTo(3.0, 4);
    expect(body.weekSpendUsd).toBeLessThan(10);
  });
});

describe('GET /api/v5/counters — agentsActive', () => {
  it('counts distinct agents with sessions in the last hour', async () => {
    const recentIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const oldIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    // Two recent sessions for the same agent — should only count as 1
    seedSessionAt(adapter, 'agent-recent', recentIso);
    seedSessionAt(adapter, 'agent-recent', recentIso);
    // Old session — outside 1hr window
    seedSessionAt(adapter, 'agent-old', oldIso);
    _resetCache();
    const body = await getCounters(app);
    expect(body.agentsActive).toBe(1);
  });
});

describe('GET /api/v5/counters — caching', () => {
  it('returns the same value within 5 seconds (cached)', async () => {
    const first = await getCounters(app);
    // Seed new data — should NOT appear in cached response
    seedRunningJob(adapter, 'agent-new');
    const second = await getCounters(app);
    expect(second.runningCycles).toBe(first.runningCycles);
    expect(second.timestamp).toBe(first.timestamp);
  });

  it('returns fresh data after cache expires', async () => {
    // Use fake timers to fast-forward past 5s TTL
    vi.useFakeTimers();
    try {
      const first = await getCounters(app);
      seedFreshRunningCycle('cycle-cache-refresh');
      // Advance time past TTL
      vi.advanceTimersByTime(6_000);
      _resetCache();
      const second = await getCounters(app);
      expect(second.runningCycles).toBeGreaterThan(first.runningCycles);
    } finally {
      vi.useRealTimers();
    }
  });
});
