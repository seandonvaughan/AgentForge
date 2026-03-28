/**
 * tests/server/routes/flywheel.test.ts — Integration tests for GET /api/v1/flywheel
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../../../src/server/server.js';
import { AgentDatabase } from '../../../src/db/database.js';
import { SqliteAdapter } from '../../../src/db/sqlite-adapter.js';
import type { SessionRow } from '../../../src/db/database.js';
import type { CostRow } from '../../../src/db/sqlite-adapter.js';

process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;

function makeSession(overrides: Partial<Omit<SessionRow, 'created_at'>> = {}): Omit<SessionRow, 'created_at'> {
  _seq++;
  return {
    id: `sess-fw-${_seq}`,
    agent_id: 'agent-fw',
    agent_name: 'Flywheel Agent',
    model: 'sonnet',
    task: `task-${_seq}`,
    response: null,
    status: 'completed',
    started_at: new Date(1700000000000 + _seq * 5000).toISOString(),
    completed_at: new Date(1700000005000 + _seq * 5000).toISOString(),
    estimated_tokens: null,
    autonomy_tier: 1,
    resume_count: 0,
    parent_session_id: null,
    delegation_depth: 0,
    ...overrides,
  };
}

function makeCost(overrides: Partial<CostRow> = {}): CostRow {
  _seq++;
  return {
    id: `cost-fw-${_seq}`,
    session_id: null,
    agent_id: 'agent-fw',
    model: 'sonnet',
    input_tokens: 100,
    output_tokens: 50,
    cost_usd: 0.01,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v1/flywheel', () => {
  let app: FastifyInstance;
  let adapter: SqliteAdapter;
  let db: AgentDatabase;

  beforeEach(async () => {
    _seq = 0;
    db = new AgentDatabase({ path: ':memory:' });
    adapter = new SqliteAdapter({ db });
    const result = await createServer({ adapter });
    app = result.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('returns 200 status code', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/flywheel' });
    expect(res.statusCode).toBe(200);
  });

  it('returns Content-Type application/json', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/flywheel' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('returns { data: FlywheelMetrics, meta: { computedAt } }', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/flywheel' });
    const body = res.json();
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('meta');
    expect(body.meta).toHaveProperty('computedAt');
  });

  it('returns zeros when no session data', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/flywheel' });
    const body = res.json();
    expect(body.data.sessionCount).toBe(0);
    expect(body.data.successRate).toBe(0);
    expect(body.data.totalCostUsd).toBe(0);
    expect(body.data.avgDurationMs).toBe(0);
  });

  it('modelBreakdown is an empty object when no costs', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/flywheel' });
    const body = res.json();
    expect(body.data.modelBreakdown).toEqual({});
  });

  it('recentTrend is "stable" when no data', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/flywheel' });
    const body = res.json();
    expect(body.data.recentTrend).toBe('stable');
  });

  it('computedAt is a valid ISO timestamp', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/flywheel' });
    const body = res.json();
    const date = new Date(body.meta.computedAt);
    expect(isNaN(date.getTime())).toBe(false);
  });

  it('sessionCount matches actual session count in adapter', async () => {
    adapter.insertSession(makeSession());
    adapter.insertSession(makeSession());
    adapter.insertSession(makeSession());

    const res = await app.inject({ method: 'GET', url: '/api/v1/flywheel' });
    const body = res.json();
    expect(body.data.sessionCount).toBe(3);
  });

  it('successRate is between 0 and 1', async () => {
    adapter.insertSession(makeSession({ status: 'completed' }));
    adapter.insertSession(makeSession({ status: 'failed' }));

    const res = await app.inject({ method: 'GET', url: '/api/v1/flywheel' });
    const body = res.json();
    expect(body.data.successRate).toBeGreaterThanOrEqual(0);
    expect(body.data.successRate).toBeLessThanOrEqual(1);
  });

  it('successRate is 0.5 for one success and one failure', async () => {
    adapter.insertSession(makeSession({ id: 'success-1', status: 'completed' }));
    adapter.insertSession(makeSession({ id: 'failed-1', status: 'failed' }));

    const res = await app.inject({ method: 'GET', url: '/api/v1/flywheel' });
    const body = res.json();
    expect(body.data.successRate).toBeCloseTo(0.5, 5);
  });

  it('successRate is 1.0 when all sessions are completed', async () => {
    adapter.insertSession(makeSession({ id: 'c1', status: 'completed' }));
    adapter.insertSession(makeSession({ id: 'c2', status: 'completed' }));

    const res = await app.inject({ method: 'GET', url: '/api/v1/flywheel' });
    const body = res.json();
    expect(body.data.successRate).toBeCloseTo(1.0, 5);
  });

  it('successRate counts "success" status as a successful session', async () => {
    adapter.insertSession(makeSession({ id: 's1', status: 'success' }));
    adapter.insertSession(makeSession({ id: 's2', status: 'failed' }));

    const res = await app.inject({ method: 'GET', url: '/api/v1/flywheel' });
    const body = res.json();
    expect(body.data.successRate).toBeCloseTo(0.5, 5);
  });

  it('totalCostUsd is non-negative', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/flywheel' });
    const body = res.json();
    expect(body.data.totalCostUsd).toBeGreaterThanOrEqual(0);
  });

  it('totalCostUsd sums all cost records', async () => {
    adapter.insertCost(makeCost({ cost_usd: 0.05 }));
    adapter.insertCost(makeCost({ cost_usd: 0.10 }));
    adapter.insertCost(makeCost({ cost_usd: 0.25 }));

    const res = await app.inject({ method: 'GET', url: '/api/v1/flywheel' });
    const body = res.json();
    expect(body.data.totalCostUsd).toBeCloseTo(0.40, 5);
  });

  it('avgDurationMs is non-negative', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/flywheel' });
    const body = res.json();
    expect(body.data.avgDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('avgDurationMs reflects correct average from session timestamps', async () => {
    const start = new Date('2024-01-01T00:00:00.000Z').getTime();
    adapter.insertSession(makeSession({
      id: 'dur-1',
      started_at: new Date(start).toISOString(),
      completed_at: new Date(start + 10000).toISOString(), // 10 seconds
    }));
    adapter.insertSession(makeSession({
      id: 'dur-2',
      started_at: new Date(start + 100000).toISOString(),
      completed_at: new Date(start + 100000 + 30000).toISOString(), // 30 seconds
    }));

    const res = await app.inject({ method: 'GET', url: '/api/v1/flywheel' });
    const body = res.json();
    // Average of 10000ms and 30000ms = 20000ms
    expect(body.data.avgDurationMs).toBeCloseTo(20000, 0);
  });

  it('modelBreakdown keys are model names', async () => {
    adapter.insertCost(makeCost({ model: 'opus', cost_usd: 0.10 }));
    adapter.insertCost(makeCost({ model: 'sonnet', cost_usd: 0.02 }));

    const res = await app.inject({ method: 'GET', url: '/api/v1/flywheel' });
    const body = res.json();
    const keys = Object.keys(body.data.modelBreakdown);
    expect(keys).toContain('opus');
    expect(keys).toContain('sonnet');
  });

  it('modelBreakdown values are cost totals (numbers)', async () => {
    adapter.insertCost(makeCost({ model: 'opus', cost_usd: 0.10 }));
    adapter.insertCost(makeCost({ model: 'opus', cost_usd: 0.05 }));

    const res = await app.inject({ method: 'GET', url: '/api/v1/flywheel' });
    const body = res.json();
    expect(typeof body.data.modelBreakdown['opus']).toBe('number');
    expect(body.data.modelBreakdown['opus']).toBeCloseTo(0.15, 5);
  });

  it('recentTrend is one of "improving", "stable", "declining"', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/flywheel' });
    const body = res.json();
    expect(['improving', 'stable', 'declining']).toContain(body.data.recentTrend);
  });

  it('recentTrend is "stable" with fewer than 20 sessions', async () => {
    for (let i = 0; i < 15; i++) {
      adapter.insertSession(makeSession({ status: 'completed' }));
    }
    const res = await app.inject({ method: 'GET', url: '/api/v1/flywheel' });
    const body = res.json();
    expect(body.data.recentTrend).toBe('stable');
  });

  it('recentTrend computes "improving" when recent 10 outperform prior 10', async () => {
    // Prior 10 sessions: all failed — insert first with old created_at
    const rawDb = adapter.getAgentDatabase().getDb();
    for (let i = 0; i < 10; i++) {
      const s = makeSession({ status: 'failed' });
      adapter.insertSession(s);
      rawDb.prepare('UPDATE sessions SET created_at = ? WHERE id = ?')
        .run(new Date(1600000000000 + i * 1000).toISOString(), s.id);
    }
    // Recent 10 sessions: all completed — insert with newer created_at
    for (let i = 0; i < 10; i++) {
      const s = makeSession({ status: 'completed' });
      adapter.insertSession(s);
      rawDb.prepare('UPDATE sessions SET created_at = ? WHERE id = ?')
        .run(new Date(1700000000000 + i * 1000).toISOString(), s.id);
    }

    const res = await app.inject({ method: 'GET', url: '/api/v1/flywheel' });
    const body = res.json();
    expect(body.data.recentTrend).toBe('improving');
  });

  it('POST to /api/v1/flywheel returns 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/flywheel', payload: {} });
    expect(res.statusCode).toBe(404);
  });
});
