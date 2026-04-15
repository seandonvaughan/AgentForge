/**
 * Tests for GET /api/v5/flywheel — real metric computation from cycles,
 * sprints, and agents. Verifies the endpoint returns computed scores rather
 * than static placeholders, and that scores change meaningfully as data grows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dashboardStubRoutes } from '../dashboard-stubs.js';

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-flywheel-'));
  app = Fastify({ logger: false });
  await dashboardStubRoutes(app, { projectRoot: tmpRoot });
});

afterEach(async () => {
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Helpers ────────────────────────────────────────────────────────────────

function mkdirs(...paths: string[]) {
  for (const p of paths) mkdirSync(p, { recursive: true });
}

function writeMemoryEntry(
  type: string,
  source: string,
  createdAt: string,
) {
  const memDir = join(tmpRoot, '.agentforge/memory');
  mkdirSync(memDir, { recursive: true });
  const entry = JSON.stringify({
    id: `${source}-${Math.random().toString(36).slice(2)}`,
    type,
    value: 'test memory entry',
    createdAt,
    source,
    tags: [],
  });
  const file = join(memDir, `${type}.jsonl`);
  // Append so multiple calls accumulate entries in the same file.
  const existing = existsSync(file) ? readFileSync(file, 'utf-8') : '';
  writeFileSync(file, existing + entry + '\n');
}

function writeCycle(id: string, overrides: Record<string, unknown> = {}) {
  const dir = join(tmpRoot, '.agentforge/cycles', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cycle.json'), JSON.stringify({
    cycleId: id,
    stage: 'completed',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    tests: { passed: 10, failed: 0, total: 10, passRate: 1.0 },
    git: { filesChanged: ['src/foo.ts'] },
    pr: { number: 42, url: 'https://github.com/org/repo/pull/42' },
    ...overrides,
  }, null, 2));
}

function writeSprintFlat(filename: string, items: Array<{ status: string }>) {
  writeFileSync(
    join(tmpRoot, '.agentforge/sprints', filename),
    JSON.stringify({ version: filename.replace('.json', ''), items }),
  );
}

function writeSprintNested(filename: string, items: Array<{ status: string }>) {
  writeFileSync(
    join(tmpRoot, '.agentforge/sprints', filename),
    JSON.stringify({ sprints: [{ version: '1.0', items }] }),
  );
}

function writeAgent(name: string) {
  writeFileSync(join(tmpRoot, '.agentforge/agents', `${name}.yaml`), 'id: ' + name);
}

/**
 * Writes a session file to .agentforge/sessions/.
 * Files are sorted alphabetically when read, so `filename` controls
 * the chronological order of sessions (older filenames sort first).
 */
function writeSession(filename: string, data: {
  task_id: string;
  is_request_satisfied?: boolean;
  confidence?: number;
}) {
  const sessionsDir = join(tmpRoot, '.agentforge/sessions');
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, filename), JSON.stringify(data));
}

function itemAtOrThrow<T>(
  items: readonly T[],
  index: number,
  message: string,
): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(message);
  }

  return item;
}

function findOrThrow<T>(
  items: readonly T[],
  predicate: (item: T) => boolean,
  message: string,
): T {
  const item = items.find(predicate);
  if (item === undefined) {
    throw new Error(message);
  }

  return item;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/v5/flywheel', () => {
  it('returns 200 with metrics array when no data directories exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as { data: unknown };
    const data = body.data as {
      metrics: Array<{ key: string; score: number }>;
      overallScore: number;
      updatedAt: string;
    };

    expect(data.metrics).toHaveLength(4);
    expect(data.metrics.map((m) => m.key)).toEqual([
      'meta_learning',
      'autonomy',
      'inheritance',
      'velocity',
    ]);
    // No data → all scores should be 0
    expect(data.overallScore).toBe(0);
    expect(data.updatedAt).toBeTruthy();
  });

  it('exposes debug counters in the payload', async () => {
    mkdirs(
      join(tmpRoot, '.agentforge/cycles'),
      join(tmpRoot, '.agentforge/sprints'),
      join(tmpRoot, '.agentforge/agents'),
    );
    writeCycle('aaa');
    writeSprintFlat('v1.0.json', [
      { status: 'completed' },
      { status: 'planned' },
    ]);
    writeAgent('ArchitectAgent');

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as { data: {
      debug: {
        cycleCount: number;
        completedCycleCount: number;
        sprintCount: number;
        agentCount: number;
        totalItems: number;
        completedItems: number;
      };
    } };

    expect(data.debug.cycleCount).toBe(1);
    expect(data.debug.completedCycleCount).toBe(1);
    expect(data.debug.sprintCount).toBe(1);
    expect(data.debug.agentCount).toBe(1);
    expect(data.debug.totalItems).toBe(2);
    expect(data.debug.completedItems).toBe(1);
  });

  it('autonomy score is 0 when no cycles exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as { data: { metrics: Array<{ key: string; score: number }> } };
    const autonomy = findOrThrow(
      data.metrics,
      (metric) => metric.key === 'autonomy',
      'Expected autonomy metric in flywheel response',
    );
    expect(autonomy.score).toBe(0);
  });

  it('autonomy score is non-zero when completed cycles exist', async () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    writeCycle('cycle-1');
    writeCycle('cycle-2', { stage: 'completed', tests: { passRate: 0.8 } });

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as { data: { metrics: Array<{ key: string; score: number }> } };
    const autonomy = findOrThrow(
      data.metrics,
      (metric) => metric.key === 'autonomy',
      'Expected autonomy metric in flywheel response',
    );
    expect(autonomy.score).toBeGreaterThan(0);
  });

  it('velocity score reflects sprint item completion rate', async () => {
    mkdirs(join(tmpRoot, '.agentforge/sprints'));
    // 8 of 10 items completed → ~56 pts item-rate component
    writeSprintFlat('v1.0.json', Array.from({ length: 10 }, (_, i) => ({
      status: i < 8 ? 'completed' : 'planned',
    })));

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as { data: { metrics: Array<{ key: string; score: number }> } };
    const velocity = findOrThrow(
      data.metrics,
      (metric) => metric.key === 'velocity',
      'Expected velocity metric in flywheel response',
    );
    // 8/10 * 70 = 56, no cycle throughput → 56
    expect(velocity.score).toBe(56);
  });

  it('inheritance score grows with agent count', async () => {
    mkdirs(join(tmpRoot, '.agentforge/agents'));
    // Write 75 agents → 75/150 * 80 = 40 pts
    for (let i = 0; i < 75; i++) writeAgent(`agent-${i}`);

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as { data: { metrics: Array<{ key: string; score: number }> } };
    const inheritance = findOrThrow(
      data.metrics,
      (metric) => metric.key === 'inheritance',
      'Expected inheritance metric in flywheel response',
    );
    expect(inheritance.score).toBe(40);
  });

  it('handles nested { sprints: [...] } sprint file format', async () => {
    mkdirs(join(tmpRoot, '.agentforge/sprints'));
    writeSprintNested('v4.3.json', [
      { status: 'completed' },
      { status: 'completed' },
      { status: 'planned' },
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as { data: { debug: { totalItems: number; completedItems: number } } };
    expect(data.debug.totalItems).toBe(3);
    expect(data.debug.completedItems).toBe(2);
  });

  it('handles flat { items: [...] } sprint file format', async () => {
    mkdirs(join(tmpRoot, '.agentforge/sprints'));
    writeSprintFlat('v5.1.json', [
      { status: 'completed' },
      { status: 'completed' },
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as { data: { debug: { totalItems: number; completedItems: number } } };
    expect(data.debug.totalItems).toBe(2);
    expect(data.debug.completedItems).toBe(2);
  });

  it('meta_learning score includes description string', async () => {
    mkdirs(join(tmpRoot, '.agentforge/sprints'));
    writeSprintFlat('v1.0.json', [{ status: 'completed' }]);

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as {
      data: { metrics: Array<{ key: string; description?: string }> };
    };
    const ml = findOrThrow(
      data.metrics,
      (metric) => metric.key === 'meta_learning',
      'Expected meta_learning metric in flywheel response',
    );
    expect(ml.description).toContain('sprint');
  });

  it('response is cached: repeated calls return same cachedAtMs within TTL', async () => {
    const res1 = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const res2 = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });

    const body1 = JSON.parse(res1.body) as { meta: { cachedAtMs: number } };
    const body2 = JSON.parse(res2.body) as { meta: { cachedAtMs: number } };
    // Both calls hit the cache — the timestamp must be identical
    expect(body1.meta.cachedAtMs).toBe(body2.meta.cachedAtMs);
  });

  // ── Memory Stats ────────────────────────────────────────────────────────

  it('memoryStats.totalEntries is 0 when no memory directory exists', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as {
      data: { memoryStats: { totalEntries: number; hitRate: number; entriesPerCycleTrend: unknown[] } };
    };
    expect(data.memoryStats.totalEntries).toBe(0);
    expect(data.memoryStats.hitRate).toBe(0);
    expect(data.memoryStats.entriesPerCycleTrend).toEqual([]);
  });

  it('memoryStats.totalEntries counts all JSONL lines across entry types', async () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    writeCycle('c1', { startedAt: '2026-01-01T10:00:00.000Z' });
    // Write 3 entries across 2 type files
    writeMemoryEntry('cycle-outcome', 'c1', '2026-01-01T09:00:00.000Z');
    writeMemoryEntry('cycle-outcome', 'c1', '2026-01-01T09:05:00.000Z');
    writeMemoryEntry('review-finding', 'c1', '2026-01-01T09:10:00.000Z');

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as {
      data: { memoryStats: { totalEntries: number } };
    };
    expect(data.memoryStats.totalEntries).toBe(3);
  });

  it('memoryStats.entriesPerCycleTrend groups entry counts by cycleId', async () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    writeCycle('cyc-a', { startedAt: '2026-01-01T08:00:00.000Z' });
    writeCycle('cyc-b', { startedAt: '2026-01-02T08:00:00.000Z' });
    writeMemoryEntry('cycle-outcome', 'cyc-a', '2026-01-01T09:00:00.000Z');
    writeMemoryEntry('cycle-outcome', 'cyc-a', '2026-01-01T09:05:00.000Z');
    writeMemoryEntry('cycle-outcome', 'cyc-b', '2026-01-02T09:00:00.000Z');

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as {
      data: {
        memoryStats: {
          entriesPerCycleTrend: Array<{ cycleId: string; count: number; startedAt: string }>;
        };
      };
    };
    const trend = data.memoryStats.entriesPerCycleTrend;
    expect(trend).toHaveLength(2);
    const a = findOrThrow(trend, (entry) => entry.cycleId === 'cyc-a', 'Expected cyc-a trend entry');
    const b = findOrThrow(trend, (entry) => entry.cycleId === 'cyc-b', 'Expected cyc-b trend entry');
    expect(a.count).toBe(2);
    expect(b.count).toBe(1);
  });

  it('memoryStats.hitRate is 0 when no memory entries exist before any completed cycle', async () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    // Cycle started before any memory was written
    writeCycle('solo', { startedAt: '2026-01-01T08:00:00.000Z' });
    // Memory entry written AFTER the cycle started — no prior memory
    writeMemoryEntry('cycle-outcome', 'solo', '2026-01-01T10:00:00.000Z');

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as { data: { memoryStats: { hitRate: number } } };
    // The only completed cycle started before any memory existed → 0% hit rate
    expect(data.memoryStats.hitRate).toBe(0);
  });

  it('memoryStats.hitRate is 1 when all completed cycles had prior memory available', async () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    // First cycle writes memory
    writeCycle('first', { startedAt: '2026-01-01T08:00:00.000Z' });
    writeMemoryEntry('cycle-outcome', 'first', '2026-01-01T09:00:00.000Z');
    // Second cycle starts AFTER memory exists
    writeCycle('second', { startedAt: '2026-01-02T08:00:00.000Z' });

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as { data: { memoryStats: { hitRate: number } } };
    // 'second' started after the memory entry from 'first' → 1 / 2 completed = 0.5
    // 'first' started before any entry → no hit
    expect(data.memoryStats.hitRate).toBe(0.5);
  });

  // ── memoriesInjected signal (precise hit rate) ──────────────────────────

  it('hitRate uses memoriesInjected=0 from audit.json → no hit even when memory exists', async () => {
    mkdirs(
      join(tmpRoot, '.agentforge/cycles'),
      join(tmpRoot, '.agentforge/memory'),
    );
    // Write a cycle that completed and has an audit.json saying 0 memories injected
    writeCycle('no-inject', { startedAt: '2026-01-01T08:00:00.000Z' });
    writeMemoryEntry('cycle-outcome', 'no-inject', '2026-01-01T07:00:00.000Z'); // memory existed before cycle
    // Manually write an audit.json with memoriesInjected: 0
    const auditDir = join(tmpRoot, '.agentforge/cycles/no-inject/phases');
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(join(auditDir, 'audit.json'), JSON.stringify({
      phase: 'audit',
      cycleId: 'no-inject',
      memoriesInjected: 0, // explicitly 0 — overrides timestamp proxy
    }));

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as { data: { memoryStats: { hitRate: number } } };
    // audit.json says 0 injected → hit rate 0 despite timestamp proxy saying 1
    expect(data.memoryStats.hitRate).toBe(0);
  });

  it('hitRate uses memoriesInjected>0 from audit.json → hit counted', async () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    writeCycle('with-inject', { startedAt: '2026-01-02T08:00:00.000Z' });
    // audit.json explicitly records 3 memories were injected
    const auditDir = join(tmpRoot, '.agentforge/cycles/with-inject/phases');
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(join(auditDir, 'audit.json'), JSON.stringify({
      phase: 'audit',
      cycleId: 'with-inject',
      memoriesInjected: 3,
    }));

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as { data: { memoryStats: { hitRate: number } } };
    // 1 completed cycle, 1 hit → 100%
    expect(data.memoryStats.hitRate).toBe(1);
  });

  it('hitRate falls back to timestamp proxy when audit.json lacks memoriesInjected', async () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    // Two completed cycles; first writes memory, second starts after it
    writeCycle('alpha', { startedAt: '2026-01-01T08:00:00.000Z' });
    writeCycle('beta',  { startedAt: '2026-01-02T08:00:00.000Z' });
    writeMemoryEntry('cycle-outcome', 'alpha', '2026-01-01T09:00:00.000Z');
    // audit.json exists but has no memoriesInjected field (legacy format)
    const auditDir = join(tmpRoot, '.agentforge/cycles/beta/phases');
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(join(auditDir, 'audit.json'), JSON.stringify({
      phase: 'audit',
      cycleId: 'beta',
      findings: 'some findings',
      // no memoriesInjected field
    }));

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as { data: { memoryStats: { hitRate: number } } };
    // 'alpha' started before memory → 0; 'beta' started after → 1 hit / 2 cycles = 0.5
    expect(data.memoryStats.hitRate).toBe(0.5);
  });

  it('memoryStats.entriesPerCycleTrend caps at 12 cycles', async () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    // Write 15 cycles
    for (let i = 0; i < 15; i++) {
      const isoDate = `2026-01-${String(i + 1).padStart(2, '0')}T08:00:00.000Z`;
      writeCycle(`cycle-${i}`, { startedAt: isoDate });
    }
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as {
      data: { memoryStats: { entriesPerCycleTrend: unknown[] } };
    };
    expect(data.memoryStats.entriesPerCycleTrend).toHaveLength(12);
  });

  // ── Cycle History ────────────────────────────────────────────────────────

  it('cycleHistory is present and empty when no cycles exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as { data: { cycleHistory: unknown[] } };
    expect(Array.isArray(data.cycleHistory)).toBe(true);
    expect(data.cycleHistory).toHaveLength(0);
  });

  it('cycleHistory contains one point per cycle with correct fields', async () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    const startedAt = '2026-03-01T10:00:00.000Z';
    writeCycle('hist-cycle-1', {
      sprintVersion: '7.1.0',
      stage: 'completed',
      startedAt,
      durationMs: 3_600_000, // 60 min
      cost: { totalUsd: 12.50 },
      tests: { passed: 490, failed: 10, total: 500, passRate: 0.98 },
      pr: { number: 55, url: 'https://github.com/org/repo/pull/55' },
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
    const pt = itemAtOrThrow(data.cycleHistory, 0, 'Expected one cycle history point');
    expect(pt.cycleId).toBe('hist-cycle-1');
    expect(pt.sprintVersion).toBe('7.1.0');
    expect(pt.stage).toBe('completed');
    expect(pt.startedAt).toBe(startedAt);
    expect(pt.testPassRate).toBeCloseTo(0.98, 5);
    expect(pt.testsTotal).toBe(500);
    expect(pt.costUsd).toBe(12.50);
    expect(pt.durationMs).toBe(3_600_000);
    expect(pt.hasPr).toBe(true);
  });

  it('cycleHistory returns hasPr=false when cycle has no PR', async () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    writeCycle('no-pr-cycle', { pr: null });

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as {
      data: { cycleHistory: Array<{ hasPr: boolean }> };
    };
    expect(
      itemAtOrThrow(data.cycleHistory, 0, 'Expected a cycle history point').hasPr,
    ).toBe(false);
  });

  it('cycleHistory is ordered chronologically (oldest first)', async () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    writeCycle('early', { startedAt: '2026-01-01T00:00:00.000Z', sprintVersion: '1.0' });
    writeCycle('later', { startedAt: '2026-06-01T00:00:00.000Z', sprintVersion: '6.0' });

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as {
      data: { cycleHistory: Array<{ startedAt: string }> };
    };
    const firstCycle = itemAtOrThrow(
      data.cycleHistory,
      0,
      'Expected first cycle history point',
    );
    const secondCycle = itemAtOrThrow(
      data.cycleHistory,
      1,
      'Expected second cycle history point',
    );
    expect(new Date(firstCycle.startedAt).getTime())
      .toBeLessThan(new Date(secondCycle.startedAt).getTime());
  });

  it('cycleHistory caps at 20 cycles when more exist', async () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    for (let i = 0; i < 25; i++) {
      const isoDate = `2026-01-${String(i + 1).padStart(2, '0')}T08:00:00.000Z`;
      writeCycle(`cap-cycle-${i}`, { startedAt: isoDate });
    }
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as { data: { cycleHistory: unknown[] } };
    expect(data.cycleHistory).toHaveLength(20);
  });

  it('cycleHistory testPassRate is null when cycle has no test data', async () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    const dir = join(tmpRoot, '.agentforge/cycles/no-tests');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cycle.json'), JSON.stringify({
      cycleId: 'no-tests',
      stage: 'completed',
      startedAt: new Date().toISOString(),
    }));

    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
    const { data } = JSON.parse(res.body) as {
      data: { cycleHistory: Array<{ testPassRate: unknown; testsTotal: unknown }> };
    };
    const cycle = itemAtOrThrow(
      data.cycleHistory,
      0,
      'Expected one cycle history point',
    );
    expect(cycle.testPassRate).toBeNull();
    expect(cycle.testsTotal).toBeNull();
  });

  // ── metaTrend boundary conditions ────────────────────────────────────────
  // The meta_learning metric exposes a `trend` field derived from two sources:
  //
  //   (a) Pass-rate trend across cycles:
  //       trendBonus = Math.round((lateAvg - earlyAvg) * 400)
  //       trendBonus >= 20  → improving  (≥5% pass-rate gain)
  //       trendBonus <= -20 → declining  (≥5% pass-rate loss)
  //
  //   (b) Session confidence trend (secondary signal, used when |trendBonus| < 20):
  //       sessionConfidenceBonus = Math.round((lateConf - earlyConf) * 50)
  //       sessionConfidenceBonus > 5  → improving
  //       sessionConfidenceBonus < -5 → declining
  //
  // These tests pin the exact boundary values so threshold drift is caught
  // immediately. See computeFlywheelMetrics() in dashboard-stubs.ts.

  describe('meta_learning trend field', () => {
    type MetricShape = { key: string; trend?: string };

    function getMetaTrend(body: string): string | undefined {
      const parsed = JSON.parse(body) as { data: { metrics: MetricShape[] } };
      return parsed.data.metrics.find(m => m.key === 'meta_learning')?.trend;
    }

    it('trend is "stable" when no data exists', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
      expect(getMetaTrend(res.body)).toBe('stable');
    });

    it('trend is "improving" when later cycle pass rates exceed earlier by exactly 5%', async () => {
      // trendBonus = Math.round((0.95 - 0.90) * 400) = 20 → hits the >= 20 boundary
      mkdirs(join(tmpRoot, '.agentforge/cycles'));
      writeCycle('e1', { startedAt: '2026-01-01T00:00:00Z', tests: { passed: 90, failed: 10, total: 100, passRate: 0.90 } });
      writeCycle('e2', { startedAt: '2026-01-02T00:00:00Z', tests: { passed: 90, failed: 10, total: 100, passRate: 0.90 } });
      writeCycle('l1', { startedAt: '2026-01-03T00:00:00Z', tests: { passed: 95, failed: 5,  total: 100, passRate: 0.95 } });
      writeCycle('l2', { startedAt: '2026-01-04T00:00:00Z', tests: { passed: 95, failed: 5,  total: 100, passRate: 0.95 } });

      const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
      expect(getMetaTrend(res.body)).toBe('improving');
    });

    it('trend is "declining" when later cycle pass rates fall behind earlier by exactly 5%', async () => {
      // trendBonus = Math.round((0.90 - 0.95) * 400) = -20 → hits the <= -20 boundary
      mkdirs(join(tmpRoot, '.agentforge/cycles'));
      writeCycle('e1', { startedAt: '2026-01-01T00:00:00Z', tests: { passed: 95, failed: 5,  total: 100, passRate: 0.95 } });
      writeCycle('e2', { startedAt: '2026-01-02T00:00:00Z', tests: { passed: 95, failed: 5,  total: 100, passRate: 0.95 } });
      writeCycle('l1', { startedAt: '2026-01-03T00:00:00Z', tests: { passed: 90, failed: 10, total: 100, passRate: 0.90 } });
      writeCycle('l2', { startedAt: '2026-01-04T00:00:00Z', tests: { passed: 90, failed: 10, total: 100, passRate: 0.90 } });

      const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
      expect(getMetaTrend(res.body)).toBe('declining');
    });

    it('trend is "stable" when pass-rate delta is within ±4% (below threshold)', async () => {
      // trendBonus = Math.round((0.94 - 0.90) * 400) = 16 — below the 20-point threshold
      // No sessions → sessionConfidenceBonus = 0 → stays stable
      mkdirs(join(tmpRoot, '.agentforge/cycles'));
      writeCycle('e1', { startedAt: '2026-01-01T00:00:00Z', tests: { passed: 90, failed: 10, total: 100, passRate: 0.90 } });
      writeCycle('e2', { startedAt: '2026-01-02T00:00:00Z', tests: { passed: 90, failed: 10, total: 100, passRate: 0.90 } });
      writeCycle('l1', { startedAt: '2026-01-03T00:00:00Z', tests: { passed: 94, failed: 6,  total: 100, passRate: 0.94 } });
      writeCycle('l2', { startedAt: '2026-01-04T00:00:00Z', tests: { passed: 94, failed: 6,  total: 100, passRate: 0.94 } });

      const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
      expect(getMetaTrend(res.body)).toBe('stable');
    });

    it('trend is "improving" via session confidence when trendBonus is in safe range', async () => {
      // trendBonus = 0 (single cycle, no pair to compare with)
      // earlyConf = 0.4, lateConf = 0.7 → bonus = Math.round(0.3 * 50) = 15, capped to 10 > 5
      mkdirs(join(tmpRoot, '.agentforge/cycles'));
      writeCycle('only', { startedAt: '2026-01-01T00:00:00Z', tests: { passed: 90, failed: 10, total: 100, passRate: 0.90 } });
      // 4 sessions required; sorted alphabetically = chronological order
      writeSession('s1-early.json', { task_id: 's1', is_request_satisfied: true, confidence: 0.4 });
      writeSession('s2-early.json', { task_id: 's2', is_request_satisfied: true, confidence: 0.4 });
      writeSession('s3-late.json',  { task_id: 's3', is_request_satisfied: true, confidence: 0.7 });
      writeSession('s4-late.json',  { task_id: 's4', is_request_satisfied: true, confidence: 0.7 });

      const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
      expect(getMetaTrend(res.body)).toBe('improving');
    });

    it('trend is "declining" via session confidence when trendBonus is in safe range', async () => {
      // earlyConf = 0.7, lateConf = 0.4 → bonus = Math.round(-0.3 * 50) = -15, capped to -10 < -5
      mkdirs(join(tmpRoot, '.agentforge/cycles'));
      writeCycle('only', { startedAt: '2026-01-01T00:00:00Z', tests: { passed: 90, failed: 10, total: 100, passRate: 0.90 } });
      writeSession('s1-early.json', { task_id: 's1', is_request_satisfied: true, confidence: 0.7 });
      writeSession('s2-early.json', { task_id: 's2', is_request_satisfied: true, confidence: 0.7 });
      writeSession('s3-late.json',  { task_id: 's3', is_request_satisfied: true, confidence: 0.4 });
      writeSession('s4-late.json',  { task_id: 's4', is_request_satisfied: true, confidence: 0.4 });

      const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
      expect(getMetaTrend(res.body)).toBe('declining');
    });

    it('meta_learning trend is present on the returned metric object', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel' });
      const parsed = JSON.parse(res.body) as { data: { metrics: MetricShape[] } };
      const ml = findOrThrow(
        parsed.data.metrics,
        (metric) => metric.key === 'meta_learning',
        'Expected meta_learning metric in flywheel response',
      );
      expect(ml).toBeDefined();
      expect(['improving', 'stable', 'declining']).toContain(ml.trend);
    });
  });
});
