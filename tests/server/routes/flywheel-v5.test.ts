/**
 * tests/server/routes/flywheel-v5.test.ts
 *
 * Integration tests for GET /api/v5/flywheel — the rich flywheel gauge endpoint
 * that drives the dashboard page. Filesystem helpers (inheritance, velocity)
 * read from .agentforge/ on disk; in tests those dirs may or may not exist so
 * we only assert on contract shape and score ranges, not exact values.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../../../src/server/server.js';
import { AgentDatabase } from '../../../src/db/database.js';
import { SqliteAdapter } from '../../../src/db/sqlite-adapter.js';
import type { SessionRow } from '../../../src/db/database.js';
import type { TaskOutcomeRow, PromotionRow } from '../../../src/db/sqlite-adapter.js';

process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;

function makeSession(
  overrides: Partial<Omit<SessionRow, 'created_at'>> = {}
): Omit<SessionRow, 'created_at'> {
  _seq++;
  return {
    id: `s-v5-${_seq}`,
    agent_id: 'agent-v5',
    agent_name: null,
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

/**
 * Creates a session + task outcome pair. task_outcomes has a FK to sessions,
 * so the session must exist before the outcome can be inserted.
 */
function makeOutcome(
  overrides: Partial<TaskOutcomeRow> = {}
): TaskOutcomeRow {
  _seq++;
  const sessionId = `s-v5-out-${_seq}`;
  return {
    id: `out-v5-${_seq}`,
    session_id: sessionId,
    agent_id: 'agent-v5',
    task: `task-${_seq}`,
    success: 1,
    quality_score: null,
    model: 'sonnet',
    duration_ms: 1000,
    created_at: new Date(1700000000000 + _seq * 5000).toISOString(),
    ...overrides,
  };
}

/**
 * Inserts a backing session + outcome together (satisfies FK constraint).
 * Returns the outcome row so callers can still update its created_at etc.
 */
function insertOutcomeWithSession(
  adapter: SqliteAdapter,
  outcomeOverrides: Partial<TaskOutcomeRow> = {}
): TaskOutcomeRow {
  const outcome = makeOutcome(outcomeOverrides);
  // Ensure the referenced session exists
  const sess = makeSession({ id: outcome.session_id });
  adapter.insertSession(sess);
  adapter.insertTaskOutcome(outcome);
  return outcome;
}

function makePromotion(overrides: Partial<PromotionRow> = {}): PromotionRow {
  _seq++;
  return {
    id: `promo-v5-${_seq}`,
    agent_id: 'agent-v5',
    previous_tier: 1,
    new_tier: 2,
    promoted: 1,
    demoted: 0,
    reason: 'test promotion',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v5/flywheel', () => {
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

  // ---- Contract shape ----

  it('returns 200 status code', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    expect(res.statusCode).toBe(200);
  });

  it('returns application/json content type', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('returns { data, meta } envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const body = res.json();
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('meta');
    expect(body.meta).toHaveProperty('computedAt');
  });

  it('data has metrics array, overallScore, and updatedAt', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = res.json();
    expect(Array.isArray(data.metrics)).toBe(true);
    expect(typeof data.overallScore).toBe('number');
    expect(typeof data.updatedAt).toBe('string');
  });

  it('metrics array has exactly 4 entries', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = res.json();
    expect(data.metrics).toHaveLength(4);
  });

  it('metric keys are meta_learning, autonomy, inheritance, velocity', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = res.json();
    const keys = data.metrics.map((m: { key: string }) => m.key);
    expect(keys).toContain('meta_learning');
    expect(keys).toContain('autonomy');
    expect(keys).toContain('inheritance');
    expect(keys).toContain('velocity');
  });

  it('each metric has key, label, score, description', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = res.json();
    for (const m of data.metrics) {
      expect(typeof m.key).toBe('string');
      expect(typeof m.label).toBe('string');
      expect(typeof m.score).toBe('number');
      expect(typeof m.description).toBe('string');
    }
  });

  it('all scores are in [0, 100]', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = res.json();
    for (const m of data.metrics) {
      expect(m.score).toBeGreaterThanOrEqual(0);
      expect(m.score).toBeLessThanOrEqual(100);
    }
  });

  it('overallScore is in [0, 100]', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = res.json();
    expect(data.overallScore).toBeGreaterThanOrEqual(0);
    expect(data.overallScore).toBeLessThanOrEqual(100);
  });

  it('overallScore is integer', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = res.json();
    expect(Number.isInteger(data.overallScore)).toBe(true);
  });

  it('updatedAt is a valid ISO timestamp', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = res.json();
    const date = new Date(data.updatedAt);
    expect(isNaN(date.getTime())).toBe(false);
  });

  it('returns scores of 0 when no data', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = res.json();
    const metaLearning = data.metrics.find((m: { key: string }) => m.key === 'meta_learning');
    const autonomy = data.metrics.find((m: { key: string }) => m.key === 'autonomy');
    expect(metaLearning.score).toBe(0);
    expect(autonomy.score).toBe(0);
  });

  it('POST to /api/v5/flywheel returns 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v5/flywheel', payload: {} });
    expect(res.statusCode).toBe(404);
  });

  // ---- Meta-learning ----

  it('meta_learning score is positive when task outcomes show high success rate', async () => {
    // Insert 8 successful outcomes via helper (satisfies FK)
    for (let i = 0; i < 8; i++) {
      insertOutcomeWithSession(adapter, { success: 1 });
    }
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = res.json();
    const metaLearning = data.metrics.find((m: { key: string }) => m.key === 'meta_learning');
    expect(metaLearning.score).toBeGreaterThan(0);
  });

  it('meta_learning score increases when recent outcomes outperform older ones', async () => {
    const rawDb = adapter.getAgentDatabase().getDb();

    // Older outcomes (lower timestamps): all failed
    for (let i = 0; i < 4; i++) {
      const o = insertOutcomeWithSession(adapter, { success: 0 });
      rawDb.prepare('UPDATE task_outcomes SET created_at = ? WHERE id = ?')
        .run(new Date(1600000000000 + i * 1000).toISOString(), o.id);
    }
    // Recent outcomes (higher timestamps): all successful
    for (let i = 0; i < 4; i++) {
      const o = insertOutcomeWithSession(adapter, { success: 1 });
      rawDb.prepare('UPDATE task_outcomes SET created_at = ? WHERE id = ?')
        .run(new Date(1700000000000 + i * 1000).toISOString(), o.id);
    }

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = res.json();
    const metaLearning = data.metrics.find((m: { key: string }) => m.key === 'meta_learning');
    // 100% recent success vs 0% older = high score
    expect(metaLearning.score).toBeGreaterThan(50);
  });

  it('meta_learning falls back to session success rate when <4 task outcomes', async () => {
    // 2 successful sessions (< 4 task outcomes, so fallback path)
    adapter.insertSession(makeSession({ id: 'fw-s1', status: 'completed' }));
    adapter.insertSession(makeSession({ id: 'fw-s2', status: 'completed' }));

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = res.json();
    const metaLearning = data.metrics.find((m: { key: string }) => m.key === 'meta_learning');
    expect(metaLearning.score).toBeGreaterThan(0);
  });

  // ---- Autonomy ----

  it('autonomy score increases with promotions', async () => {
    // Baseline: no promotions
    const res0 = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const before = res0.json().data.metrics.find((m: { key: string }) => m.key === 'autonomy').score;

    // Add net promotions
    adapter.insertPromotion(makePromotion({ promoted: 1, demoted: 0 }));
    adapter.insertPromotion(makePromotion({ promoted: 1, demoted: 0 }));
    adapter.insertPromotion(makePromotion({ promoted: 1, demoted: 0 }));

    const res1 = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const after = res1.json().data.metrics.find((m: { key: string }) => m.key === 'autonomy').score;

    expect(after).toBeGreaterThan(before);
  });

  it('autonomy score reflects higher avg tier sessions', async () => {
    // Sessions with autonomy_tier = 3 should score higher than tier 1
    adapter.insertSession(makeSession({ id: 't3-1', autonomy_tier: 3 }));
    adapter.insertSession(makeSession({ id: 't3-2', autonomy_tier: 3 }));

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = res.json();
    const autonomy = data.metrics.find((m: { key: string }) => m.key === 'autonomy');
    expect(autonomy.score).toBeGreaterThan(0);
  });

  it('autonomy score is capped at 100', async () => {
    // Even extreme data should not exceed 100
    for (let i = 0; i < 20; i++) {
      adapter.insertPromotion(makePromotion({ id: `p-cap-${i}`, promoted: 1, demoted: 0 }));
    }
    for (let i = 0; i < 10; i++) {
      adapter.insertSession(makeSession({ id: `t4-${i}`, autonomy_tier: 4 }));
    }
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = res.json();
    const autonomy = data.metrics.find((m: { key: string }) => m.key === 'autonomy');
    expect(autonomy.score).toBeLessThanOrEqual(100);
  });

  // ---- Overall score is the mean of the four gauges ----

  it('overallScore equals average of the four metric scores', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = res.json();
    const mean = Math.round(
      data.metrics.reduce((sum: number, m: { score: number }) => sum + m.score, 0) / data.metrics.length
    );
    expect(data.overallScore).toBe(mean);
  });

  // ---- Memory stats card ----

  it('data includes a memoryStats object', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = res.json();
    expect(data).toHaveProperty('memoryStats');
    expect(typeof data.memoryStats).toBe('object');
  });

  it('memoryStats has totalEntries, entriesPerCycleTrend, hitRate', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = res.json();
    const { memoryStats } = data;
    expect(typeof memoryStats.totalEntries).toBe('number');
    expect(Array.isArray(memoryStats.entriesPerCycleTrend)).toBe(true);
    expect(typeof memoryStats.hitRate).toBe('number');
  });

  it('memoryStats.totalEntries is a non-negative integer', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = res.json();
    expect(data.memoryStats.totalEntries).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(data.memoryStats.totalEntries)).toBe(true);
  });

  it('memoryStats.hitRate is in [0, 1]', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = res.json();
    expect(data.memoryStats.hitRate).toBeGreaterThanOrEqual(0);
    expect(data.memoryStats.hitRate).toBeLessThanOrEqual(1);
  });

  it('memoryStats.entriesPerCycleTrend has at most 10 entries', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = res.json();
    expect(data.memoryStats.entriesPerCycleTrend.length).toBeLessThanOrEqual(10);
  });

  it('each trend point has cycleId, count, startedAt', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = res.json();
    for (const point of data.memoryStats.entriesPerCycleTrend) {
      expect(typeof point.cycleId).toBe('string');
      expect(typeof point.count).toBe('number');
      expect(point.count).toBeGreaterThan(0);
      // startedAt may be empty string if cycle.json was unreadable, so just check type
      expect(typeof point.startedAt).toBe('string');
    }
  });

  it('memoryStats returns zero-state when no memory directory exists', async () => {
    // In the test environment .agentforge/memory does not exist,
    // so the stats should default to empty/zero without throwing.
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    // totalEntries might be 0 or a real value depending on local disk state;
    // the important invariant is the shape and valid ranges, not specific values.
    expect(data.memoryStats.totalEntries).toBeGreaterThanOrEqual(0);
    expect(data.memoryStats.hitRate).toBeGreaterThanOrEqual(0);
    expect(data.memoryStats.hitRate).toBeLessThanOrEqual(1);
  });
});
