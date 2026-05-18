/**
 * Tests for GET /api/v5/costs/summary reading from cycle.json ledger with
 * SQL fallback UNION semantics.
 *
 * Acceptance criteria exercised:
 *   AC1 — No SQL rows + one cycle.json at $42 → totalCostUsd: 42
 *   AC3 — byModel attributes correctly when execute.json itemResults have model
 *   AC4 — UNION: SQL row $10 + cycle.json $5 on same date → $15
 *   AC5 — All tests in this file pass
 *
 * We do NOT assert existsSync on gitignored paths. We create temp dirs, write
 * test fixtures, then clean up — asserting only the API response, not the fs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { WorkspaceAdapter } from '@agentforge/db';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { costsRoutes } from '../costs.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let adapter: WorkspaceAdapter;
let projectRoot: string;

function makeCyclesDir(): void {
  mkdirSync(join(projectRoot, '.agentforge', 'cycles'), { recursive: true });
}

function writeCycleJson(id: string, data: Record<string, unknown>): void {
  const dir = join(projectRoot, '.agentforge', 'cycles', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cycle.json'), JSON.stringify(data));
}

function writeExecuteJson(id: string, data: Record<string, unknown>): void {
  const dir = join(projectRoot, '.agentforge', 'cycles', id, 'phases');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'execute.json'), JSON.stringify(data));
}

/** Insert a SQL cost row with a specific created_at timestamp. */
function addSqlCost(
  ad: WorkspaceAdapter,
  model: string,
  costUsd: number,
  createdAt: Date,
): void {
  ad.recordCost({
    agentId: 'test-agent',
    model,
    inputTokens: 100,
    outputTokens: 50,
    costUsd,
  });
  const db = (ad as unknown as { db: import('better-sqlite3').Database }).db;
  db.prepare(
    'UPDATE costs SET created_at = ? WHERE created_at = (SELECT MAX(created_at) FROM costs)',
  ).run(createdAt.toISOString());
}

beforeEach(async () => {
  // Use a unique temp dir per test to avoid cross-test bleed.
  projectRoot = join(tmpdir(), `costs-from-cycles-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(projectRoot, { recursive: true });
  makeCyclesDir();

  adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
  app = Fastify({ logger: false });
  await costsRoutes(app, { adapter, projectRoot });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  adapter.close();
  // Clean up temp dir.
  try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* non-fatal */ }
});

// ---------------------------------------------------------------------------
// AC1 — cycle.json only, no SQL rows → totalCostUsd = cycle amount
// ---------------------------------------------------------------------------

describe('AC1: cycle.json ledger with no SQL rows', () => {
  it('single cycle.json at $42 → totalCostUsd: 42', async () => {
    const completedAt = new Date().toISOString();
    writeCycleJson('cycle-001', {
      cycleId: 'cycle-001',
      stage: 'completed',
      startedAt: completedAt,
      completedAt,
      cost: { totalUsd: 42, budgetUsd: 100, byAgent: {}, byPhase: {} },
    });

    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/summary' });
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: { totalCostUsd: number } };
    expect(data.totalCostUsd).toBeCloseTo(42, 5);
  });

  it('two cycles summed correctly', async () => {
    const at = new Date().toISOString();
    writeCycleJson('cycle-002', {
      cycleId: 'cycle-002', stage: 'completed',
      startedAt: at, completedAt: at,
      cost: { totalUsd: 10, budgetUsd: 100, byAgent: {}, byPhase: {} },
    });
    writeCycleJson('cycle-003', {
      cycleId: 'cycle-003', stage: 'completed',
      startedAt: at, completedAt: at,
      cost: { totalUsd: 15, budgetUsd: 100, byAgent: {}, byPhase: {} },
    });

    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/summary' });
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: { totalCostUsd: number } };
    expect(data.totalCostUsd).toBeCloseTo(25, 5);
  });

  it('empty cycles dir → totalCostUsd: 0', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/summary' });
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: { totalCostUsd: number; totalSessions: number } };
    expect(data.totalCostUsd).toBe(0);
    expect(data.totalSessions).toBe(0);
  });

  it('cycle.json missing cost field is skipped', async () => {
    const at = new Date().toISOString();
    writeCycleJson('cycle-nocost', {
      cycleId: 'cycle-nocost', stage: 'completed',
      startedAt: at, completedAt: at,
      // no cost field
    });

    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/summary' });
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: { totalCostUsd: number } };
    expect(data.totalCostUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC3 — byModel attribution from execute.json itemResults
// ---------------------------------------------------------------------------

describe('AC3: byModel attribution from execute.json', () => {
  it('model field on itemResults populates byModel correctly', async () => {
    const at = new Date().toISOString();
    writeCycleJson('cycle-model', {
      cycleId: 'cycle-model', stage: 'completed',
      startedAt: at, completedAt: at,
      cost: { totalUsd: 10, budgetUsd: 100, byAgent: {}, byPhase: {} },
    });
    writeExecuteJson('cycle-model', {
      itemResults: [
        { itemId: 'i1', status: 'completed', costUsd: 6, model: 'claude-opus-4-6' },
        { itemId: 'i2', status: 'completed', costUsd: 4, model: 'claude-sonnet-4-5' },
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/summary' });
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as {
      data: { byModel: Array<{ model: string; costUsd: number }> };
    };

    const opusEntry = data.byModel.find((m) => m.model === 'opus');
    const sonnetEntry = data.byModel.find((m) => m.model === 'sonnet');
    expect(opusEntry?.costUsd).toBeCloseTo(6, 5);
    expect(sonnetEntry?.costUsd).toBeCloseTo(4, 5);
  });

  it('agentRuns (alias for itemResults) also works for model attribution', async () => {
    const at = new Date().toISOString();
    writeCycleJson('cycle-agentruns', {
      cycleId: 'cycle-agentruns', stage: 'completed',
      startedAt: at, completedAt: at,
      cost: { totalUsd: 5, budgetUsd: 100, byAgent: {}, byPhase: {} },
    });
    writeExecuteJson('cycle-agentruns', {
      agentRuns: [
        { agentId: 'haiku-agent', costUsd: 5, model: 'claude-haiku-3-5' },
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/summary' });
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as {
      data: { byModel: Array<{ model: string; costUsd: number }> };
    };

    const haikuEntry = data.byModel.find((m) => m.model === 'haiku');
    expect(haikuEntry?.costUsd).toBeCloseTo(5, 5);
  });

  it('cycle without execute.json falls back to sonnet tier', async () => {
    const at = new Date().toISOString();
    writeCycleJson('cycle-noexec', {
      cycleId: 'cycle-noexec', stage: 'completed',
      startedAt: at, completedAt: at,
      cost: { totalUsd: 7, budgetUsd: 100, byAgent: {}, byPhase: {} },
    });
    // No execute.json written.

    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/summary' });
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as {
      data: { byModel: Array<{ model: string; costUsd: number }> };
    };

    // With no model attribution, entire cost should land in sonnet (fallback tier).
    const sonnetEntry = data.byModel.find((m) => m.model === 'sonnet');
    expect(sonnetEntry?.costUsd).toBeCloseTo(7, 5);
  });
});

// ---------------------------------------------------------------------------
// AC4 — UNION: SQL row $10 + cycle.json $5 on same date → $15
// ---------------------------------------------------------------------------

describe('AC4: UNION semantics — SQL + cycle.json', () => {
  it('SQL $10 + ledger $5 on same date → totalCostUsd: 15', async () => {
    // Insert a SQL row at today's date.
    const today = new Date();
    addSqlCost(adapter, 'claude-sonnet-4-5', 10, today);

    // Write a cycle.json at today's date.
    const at = today.toISOString();
    writeCycleJson('cycle-union', {
      cycleId: 'cycle-union', stage: 'completed',
      startedAt: at, completedAt: at,
      cost: { totalUsd: 5, budgetUsd: 100, byAgent: {}, byPhase: {} },
    });

    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/summary' });
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: { totalCostUsd: number } };
    expect(data.totalCostUsd).toBeCloseTo(15, 5);
  });

  it('SQL-only path: no cycle dirs → SQL rows only', async () => {
    const today = new Date();
    addSqlCost(adapter, 'claude-sonnet-4-5', 20, today);

    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/summary' });
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: { totalCostUsd: number } };
    expect(data.totalCostUsd).toBeCloseTo(20, 5);
  });

  it('SQL rows filtered by ?since, ledger rows also filtered', async () => {
    // SQL row: 5 days ago ($8)
    const ago5 = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    addSqlCost(adapter, 'claude-sonnet-4-5', 8, ago5);

    // Ledger cycle: 2 days ago ($3) — within 3d window
    const ago2 = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    writeCycleJson('cycle-recent', {
      cycleId: 'cycle-recent', stage: 'completed',
      startedAt: ago2.toISOString(), completedAt: ago2.toISOString(),
      cost: { totalUsd: 3, budgetUsd: 100, byAgent: {}, byPhase: {} },
    });

    // Ledger cycle: 10 days ago ($99) — outside 3d window
    const ago10 = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    writeCycleJson('cycle-old', {
      cycleId: 'cycle-old', stage: 'completed',
      startedAt: ago10.toISOString(), completedAt: ago10.toISOString(),
      cost: { totalUsd: 99, budgetUsd: 100, byAgent: {}, byPhase: {} },
    });

    // Filter to last 3 days — should get ledger $3 only (SQL $8 is 5d ago, also excluded)
    const sinceDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/costs/summary?since=${sinceDate}`,
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: { totalCostUsd: number } };
    expect(data.totalCostUsd).toBeCloseTo(3, 5);
  });
});

// ---------------------------------------------------------------------------
// Resilience — malformed cycle.json must not crash the route
// ---------------------------------------------------------------------------

describe('resilience: bad cycle.json files are skipped gracefully', () => {
  it('malformed JSON in cycle.json does not crash the route', async () => {
    const dir = join(projectRoot, '.agentforge', 'cycles', 'bad-cycle');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cycle.json'), 'NOT VALID JSON {{{{');

    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/summary' });
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: { totalCostUsd: number } };
    expect(data.totalCostUsd).toBe(0);
  });

  it('malformed execute.json does not crash the route', async () => {
    const at = new Date().toISOString();
    writeCycleJson('cycle-badexec', {
      cycleId: 'cycle-badexec', stage: 'completed',
      startedAt: at, completedAt: at,
      cost: { totalUsd: 5, budgetUsd: 100, byAgent: {}, byPhase: {} },
    });
    const dir = join(projectRoot, '.agentforge', 'cycles', 'cycle-badexec', 'phases');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'execute.json'), '{ bad json }');

    const res = await app.inject({ method: 'GET', url: '/api/v5/costs/summary' });
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: { totalCostUsd: number } };
    // Should still report the cycle cost, just without model attribution.
    expect(data.totalCostUsd).toBeCloseTo(5, 5);
  });
});
