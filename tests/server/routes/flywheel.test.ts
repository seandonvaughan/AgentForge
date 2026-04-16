/**
 * tests/server/routes/flywheel.test.ts
 *
 * Integration tests for GET /api/v5/flywheel in the legacy server.
 *
 * Focus: verify that the route now returns `cycleHistory` (enabling the
 * trajectory panel in the HTML dashboard) and that metrics are computed from
 * real filesystem data rather than returning static zeros when the DB adapter
 * has no data.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../../../src/server/server.js';
import type { SqliteAdapter } from '../../../src/db/index.js';

process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------------
// Minimal SqliteAdapter stub — returns empty for everything so flywheel code
// falls back to filesystem reads. Mirrors the pattern in memory.test.ts.
// ---------------------------------------------------------------------------

function makeAdapter(): SqliteAdapter {
  const stub = {
    getAgentDatabase: () => ({
      getDb: () => ({
        prepare: (_sql: string) => ({
          all: () => [] as unknown[],
          run: () => ({ changes: 0 }),
        }),
      }),
    }),
    listSessions: (_opts?: unknown) => [],
    listTaskOutcomes: (_opts?: unknown) => [],
    listPromotions: () => [],
    getAllCosts: () => [],
    createSession: (_opts: unknown) => ({
      id: 'stub', agentId: 'stub', task: '', model: '', status: 'running',
      created_at: '', started_at: '', completed_at: null, cost_usd: 0, autonomy_tier: null,
    }),
    completeSession: () => {},
    recordCost: () => {},
  };
  return stub as unknown as SqliteAdapter;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;
let app: FastifyInstance;

function writeCycle(id: string, overrides: Record<string, unknown> = {}) {
  const dir = join(tmpRoot, '.agentforge/cycles', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cycle.json'), JSON.stringify({
    cycleId: id,
    stage: 'completed',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 120_000,
    tests: { passed: 95, failed: 5, total: 100, passRate: 0.95 },
    cost: { totalUsd: 5.00 },
    git: { filesChanged: ['src/foo.ts'] },
    pr: { number: null, url: null },
    ...overrides,
  }));
}

function writeSprint(filename: string, items: Array<{ status: string }>) {
  mkdirSync(join(tmpRoot, '.agentforge/sprints'), { recursive: true });
  writeFileSync(
    join(tmpRoot, '.agentforge/sprints', filename),
    JSON.stringify({ version: filename.replace('.json', ''), items }),
  );
}

function writeSession(filename: string, data: Record<string, unknown>) {
  mkdirSync(join(tmpRoot, '.agentforge/sessions'), { recursive: true });
  writeFileSync(join(tmpRoot, '.agentforge/sessions', filename), JSON.stringify(data));
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-fw-legacy-'));
  ({ app } = await createServer({
    adapter: makeAdapter(),
    projectRoot: tmpRoot,
  }));
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v5/flywheel (legacy server)', () => {

  it('returns 200 with all required top-level fields', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    expect(res.statusCode).toBe(200);

    const { data } = JSON.parse(res.body) as { data: Record<string, unknown> };
    expect(data).toHaveProperty('metrics');
    expect(data).toHaveProperty('overallScore');
    expect(data).toHaveProperty('updatedAt');
    expect(data).toHaveProperty('memoryStats');
    expect(data).toHaveProperty('debug');
    // The key new field: cycleHistory enables the trajectory chart
    expect(data).toHaveProperty('cycleHistory');
  });

  it('cycleHistory is an empty array when no cycles directory exists', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as { data: { cycleHistory: unknown[] } };
    expect(Array.isArray(data.cycleHistory)).toBe(true);
    expect(data.cycleHistory).toHaveLength(0);
  });

  it('cycleHistory contains one point per cycle with correct fields', async () => {
    const startedAt = '2026-03-01T10:00:00.000Z';
    writeCycle('c1', {
      startedAt,
      sprintVersion: '5.0.0',
      durationMs: 3_600_000,
      cost: { totalUsd: 12.50 },
      tests: { passed: 490, failed: 10, total: 500, passRate: 0.98 },
      pr: { number: 42, url: 'https://github.com/org/repo/pull/42' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as {
      data: {
        cycleHistory: Array<{
          cycleId: string;
          sprintVersion: string | null;
          startedAt: string;
          stage: string;
          testPassRate: number | null;
          testsTotal: number | null;
          costUsd: number | null;
          durationMs: number | null;
          hasPr: boolean;
        }>;
      };
    };

    expect(data.cycleHistory).toHaveLength(1);
    const pt = data.cycleHistory[0]!;
    expect(pt.cycleId).toBe('c1');
    expect(pt.sprintVersion).toBe('5.0.0');
    expect(pt.stage).toBe('completed');
    expect(pt.startedAt).toBe(startedAt);
    expect(pt.testPassRate).toBeCloseTo(0.98, 5);
    expect(pt.testsTotal).toBe(500);
    expect(pt.costUsd).toBe(12.5);
    expect(pt.durationMs).toBe(3_600_000);
    expect(pt.hasPr).toBe(true);
  });

  it('cycleHistory is ordered chronologically (oldest first)', async () => {
    writeCycle('early', { startedAt: '2026-01-01T00:00:00.000Z', sprintVersion: '1.0' });
    writeCycle('later', { startedAt: '2026-06-01T00:00:00.000Z', sprintVersion: '6.0' });

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as {
      data: { cycleHistory: Array<{ startedAt: string }> };
    };

    expect(data.cycleHistory).toHaveLength(2);
    expect(new Date(data.cycleHistory[0]!.startedAt).getTime())
      .toBeLessThan(new Date(data.cycleHistory[1]!.startedAt).getTime());
  });

  it('cycleHistory caps at 20 cycles when more exist', async () => {
    for (let i = 0; i < 25; i++) {
      writeCycle(`cap-${i}`, {
        startedAt: `2026-01-${String(i + 1).padStart(2, '0')}T08:00:00.000Z`,
      });
    }

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as { data: { cycleHistory: unknown[] } };
    expect(data.cycleHistory).toHaveLength(20);
  });

  it('autonomy score is non-zero when completed cycles exist in filesystem', async () => {
    // DB adapter returns [] for sessions and promotions, so autonomy must
    // derive a non-zero score purely from filesystem cycles.
    writeCycle('c1');
    writeCycle('c2');

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as {
      data: { metrics: Array<{ key: string; score: number }> };
    };
    const autonomy = data.metrics.find(m => m.key === 'autonomy');
    expect(autonomy?.score).toBeGreaterThan(0);
  });

  it('meta_learning metric has a trend field', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as {
      data: { metrics: Array<{ key: string; trend?: string }> };
    };
    const ml = data.metrics.find(m => m.key === 'meta_learning');
    expect(ml).toBeDefined();
    // trend is always set (defaults to 'stable' when no data)
    expect(['improving', 'stable', 'declining']).toContain(ml?.trend ?? 'stable');
  });

  it('meta_learning trend is "improving" when cycle pass rates increase over time', async () => {
    // Two early cycles at 90%, two late cycles at 95% → trendBonus = +20 → improving
    writeCycle('e1', { startedAt: '2026-01-01T00:00:00Z', tests: { passed: 90, failed: 10, total: 100, passRate: 0.90 } });
    writeCycle('e2', { startedAt: '2026-01-02T00:00:00Z', tests: { passed: 90, failed: 10, total: 100, passRate: 0.90 } });
    writeCycle('l1', { startedAt: '2026-01-03T00:00:00Z', tests: { passed: 95, failed: 5,  total: 100, passRate: 0.95 } });
    writeCycle('l2', { startedAt: '2026-01-04T00:00:00Z', tests: { passed: 95, failed: 5,  total: 100, passRate: 0.95 } });

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as {
      data: { metrics: Array<{ key: string; trend?: string }> };
    };
    const ml = data.metrics.find(m => m.key === 'meta_learning');
    expect(ml?.trend).toBe('improving');
  });

  it('velocity score is non-zero when sprint items exist', async () => {
    writeSprint('v1.0.json', Array.from({ length: 10 }, (_, i) => ({
      status: i < 8 ? 'completed' : 'planned',
    })));

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as {
      data: { metrics: Array<{ key: string; score: number }> };
    };
    const velocity = data.metrics.find(m => m.key === 'velocity');
    expect(velocity?.score).toBeGreaterThan(0);
  });

  it('debug.sessionCount reflects filesystem session files over empty DB', async () => {
    writeSession('s1.json', { task_id: 's1', is_request_satisfied: true });
    writeSession('s2.json', { task_id: 's2', is_request_satisfied: false });
    writeSession('s3.json', { task_id: 's3', is_request_satisfied: true });

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as {
      data: { debug: { sessionCount: number; satisfiedSessionCount: number } };
    };

    expect(data.debug.sessionCount).toBe(3);
    expect(data.debug.satisfiedSessionCount).toBe(2);
  });

});
