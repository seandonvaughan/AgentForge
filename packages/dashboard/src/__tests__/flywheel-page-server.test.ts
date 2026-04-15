/**
 * Unit tests for the SSR-side flywheel metric computation in
 * packages/dashboard/src/routes/flywheel/+page.server.ts.
 *
 * The API-server copy (dashboard-stubs.ts) is covered by a separate 32-test
 * suite.  This file pins the SSR copy's threshold boundary conditions so that
 * drift between the two implementations is caught immediately.
 *
 * Specifically addresses the code-review MINOR flag from sprint v10.4.0:
 * "metaTrend thresholds are magic numbers with no unit tests in
 *  +page.server.ts:205–211".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _computeMetrics as computeMetrics } from '../routes/flywheel/+page.server.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-flywheel-ssr-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function mkdirs(...paths: string[]) {
  for (const p of paths) mkdirSync(p, { recursive: true });
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
    pr: { number: 42 },
    ...overrides,
  }, null, 2));
}

function writeSprintFlat(filename: string, items: Array<{ status: string }>) {
  const dir = join(tmpRoot, '.agentforge/sprints');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, filename),
    JSON.stringify({ version: filename.replace('.json', ''), items }),
  );
}

function writeAgent(name: string) {
  const dir = join(tmpRoot, '.agentforge/agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), `id: ${name}`);
}

function writeSession(filename: string, data: {
  task_id: string;
  is_request_satisfied?: boolean;
  confidence?: number;
}) {
  const dir = join(tmpRoot, '.agentforge/sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), JSON.stringify(data));
}

// ── Baseline: empty project ──────────────────────────────────────────────────

describe('computeMetrics — empty project', () => {
  it('returns four metrics all with score 0', () => {
    const payload = computeMetrics(tmpRoot);
    expect(payload.metrics).toHaveLength(4);
    expect(payload.metrics.map(m => m.key)).toEqual([
      'meta_learning', 'autonomy', 'inheritance', 'velocity',
    ]);
    for (const m of payload.metrics) {
      expect(m.score).toBe(0);
    }
    expect(payload.overallScore).toBe(0);
  });

  it('returns debug counters all at 0', () => {
    const payload = computeMetrics(tmpRoot);
    expect(payload.debug.cycleCount).toBe(0);
    expect(payload.debug.sprintCount).toBe(0);
    expect(payload.debug.agentCount).toBe(0);
    expect(payload.debug.totalItems).toBe(0);
  });

  it('returns empty cycleHistory array', () => {
    expect(computeMetrics(tmpRoot).cycleHistory).toEqual([]);
  });

  it('returns zero memory stats', () => {
    const { memoryStats } = computeMetrics(tmpRoot);
    expect(memoryStats.totalEntries).toBe(0);
    expect(memoryStats.hitRate).toBe(0);
    expect(memoryStats.entriesPerCycleTrend).toEqual([]);
  });
});

// ── Memory stats card ─────────────────────────────────────────────────────────
//
// These tests pin the three quantitative signals shown in the /flywheel memory
// stats card: total entries, per-cycle sparkline trend, and hit rate.
// They mirror the API-level tests in packages/server/src/routes/v5/__tests__/
// flywheel.test.ts so that any drift between the SSR and API implementations
// surfaces immediately.

describe('computeMetrics — memoryStats (memory loop health card)', () => {
  function writeMemoryEntry(type: string, source: string, createdAt: string) {
    const memDir = join(tmpRoot, '.agentforge/memory');
    mkdirSync(memDir, { recursive: true });
    const entry = JSON.stringify({
      id: `${source}-${Math.random().toString(36).slice(2)}`,
      type,
      value: 'v',
      createdAt,
      source,
      tags: [],
    }) + '\n';
    appendFileSync(join(memDir, `${type}.jsonl`), entry);
  }

  it('totalEntries counts all valid JSONL lines across types', () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    writeCycle('c1', { startedAt: '2026-01-01T08:00:00Z' });
    writeMemoryEntry('cycle-outcome', 'c1', '2026-01-01T09:00:00Z');
    writeMemoryEntry('cycle-outcome', 'c1', '2026-01-01T09:05:00Z');
    writeMemoryEntry('review-finding', 'c1', '2026-01-01T09:10:00Z');
    expect(computeMetrics(tmpRoot).memoryStats.totalEntries).toBe(3);
  });

  it('entriesPerCycleTrend groups by cycleId with correct counts', () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    writeCycle('ca', { startedAt: '2026-01-01T08:00:00Z' });
    writeCycle('cb', { startedAt: '2026-01-02T08:00:00Z' });
    writeMemoryEntry('cycle-outcome', 'ca', '2026-01-01T09:00:00Z');
    writeMemoryEntry('cycle-outcome', 'ca', '2026-01-01T09:05:00Z');
    writeMemoryEntry('cycle-outcome', 'cb', '2026-01-02T09:00:00Z');
    const { entriesPerCycleTrend } = computeMetrics(tmpRoot).memoryStats;
    const a = entriesPerCycleTrend.find(p => p.cycleId === 'ca');
    const b = entriesPerCycleTrend.find(p => p.cycleId === 'cb');
    expect(a?.count).toBe(2);
    expect(b?.count).toBe(1);
  });

  it('entriesPerCycleTrend includes cycles with 0 memory entries', () => {
    // Cycles that haven't produced memory yet should still appear in the
    // sparkline so the chart accurately reflects "silent" cycles.
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    writeCycle('silent-1', { startedAt: '2026-01-01T08:00:00Z' });
    writeCycle('silent-2', { startedAt: '2026-01-02T08:00:00Z' });
    // No memory entries written for either cycle.
    const { entriesPerCycleTrend } = computeMetrics(tmpRoot).memoryStats;
    expect(entriesPerCycleTrend).toHaveLength(2);
    expect(entriesPerCycleTrend.every(p => p.count === 0)).toBe(true);
  });

  it('entriesPerCycleTrend caps at 12 cycles', () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    for (let i = 0; i < 15; i++) {
      writeCycle(`cap-${i}`, { startedAt: `2026-01-${String(i + 1).padStart(2, '0')}T08:00:00Z` });
    }
    const { entriesPerCycleTrend } = computeMetrics(tmpRoot).memoryStats;
    expect(entriesPerCycleTrend).toHaveLength(12);
  });

  it('hitRate is 0 when no completed cycles have prior memory', () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    writeCycle('solo', { startedAt: '2026-01-01T08:00:00Z' });
    writeMemoryEntry('cycle-outcome', 'solo', '2026-01-01T10:00:00Z'); // after cycle
    expect(computeMetrics(tmpRoot).memoryStats.hitRate).toBe(0);
  });

  it('hitRate uses memoriesInjected from audit.json when available', () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    writeCycle('injected', { startedAt: '2026-01-02T08:00:00Z' });
    const auditDir = join(tmpRoot, '.agentforge/cycles/injected/phases');
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(join(auditDir, 'audit.json'), JSON.stringify({ memoriesInjected: 5 }));
    expect(computeMetrics(tmpRoot).memoryStats.hitRate).toBe(1);
  });
});

// ── Scores ────────────────────────────────────────────────────────────────────

describe('computeMetrics — autonomy score', () => {
  it('is 0 when no cycles exist', () => {
    const m = computeMetrics(tmpRoot).metrics.find(m => m.key === 'autonomy')!;
    expect(m.score).toBe(0);
  });

  it('is non-zero when completed cycles exist', () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    writeCycle('c1');
    const m = computeMetrics(tmpRoot).metrics.find(m => m.key === 'autonomy')!;
    expect(m.score).toBeGreaterThan(0);
  });
});

describe('computeMetrics — velocity score', () => {
  it('reflects sprint item completion rate (8 of 10 → 56)', () => {
    writeSprintFlat('v1.json', Array.from({ length: 10 }, (_, i) => ({
      status: i < 8 ? 'completed' : 'planned',
    })));
    const m = computeMetrics(tmpRoot).metrics.find(m => m.key === 'velocity')!;
    expect(m.score).toBe(56);
  });
});

describe('computeMetrics — inheritance score', () => {
  it('grows proportionally with agent count (75 agents → 40)', () => {
    for (let i = 0; i < 75; i++) writeAgent(`agent-${i}`);
    const m = computeMetrics(tmpRoot).metrics.find(m => m.key === 'inheritance')!;
    expect(m.score).toBe(40);
  });
});

// ── metaTrend boundary conditions ─────────────────────────────────────────────
//
// These tests pin the exact boundary values used in +page.server.ts:
//
//   trendBonus = Math.round((lateAvg - earlyAvg) * 400)
//   trendBonus >= +20  → 'improving'   (≥5% pass-rate gain)
//   trendBonus <= -20  → 'declining'   (≥5% pass-rate loss)
//   |trendBonus| < 20  → use sessionConfidenceBonus (±5 threshold)
//
// These mirror the identical boundary tests in
// packages/server/src/routes/v5/__tests__/flywheel.test.ts — any drift
// between the SSR and API implementations will surface immediately.

describe('computeMetrics — meta_learning trend field', () => {
  function getTrend(root: string): string | undefined {
    return computeMetrics(root).metrics.find(m => m.key === 'meta_learning')?.trend;
  }

  it('is "stable" when no data exists', () => {
    expect(getTrend(tmpRoot)).toBe('stable');
  });

  it('is "improving" when later cycles exceed earlier by exactly 5% (trendBonus = 20)', () => {
    // trendBonus = Math.round((0.95 - 0.90) * 400) = 20 → hits >= 20 boundary
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    writeCycle('e1', { startedAt: '2026-01-01T00:00:00Z', tests: { passRate: 0.90 } });
    writeCycle('e2', { startedAt: '2026-01-02T00:00:00Z', tests: { passRate: 0.90 } });
    writeCycle('l1', { startedAt: '2026-01-03T00:00:00Z', tests: { passRate: 0.95 } });
    writeCycle('l2', { startedAt: '2026-01-04T00:00:00Z', tests: { passRate: 0.95 } });
    expect(getTrend(tmpRoot)).toBe('improving');
  });

  it('is "declining" when later cycles fall behind by exactly 5% (trendBonus = -20)', () => {
    // trendBonus = Math.round((0.90 - 0.95) * 400) = -20 → hits <= -20 boundary
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    writeCycle('e1', { startedAt: '2026-01-01T00:00:00Z', tests: { passRate: 0.95 } });
    writeCycle('e2', { startedAt: '2026-01-02T00:00:00Z', tests: { passRate: 0.95 } });
    writeCycle('l1', { startedAt: '2026-01-03T00:00:00Z', tests: { passRate: 0.90 } });
    writeCycle('l2', { startedAt: '2026-01-04T00:00:00Z', tests: { passRate: 0.90 } });
    expect(getTrend(tmpRoot)).toBe('declining');
  });

  it('is "stable" when pass-rate delta is within ±4% (trendBonus = 16, below threshold)', () => {
    // trendBonus = Math.round((0.94 - 0.90) * 400) = 16 — below the ±20 boundary
    // No sessions → sessionConfidenceBonus = 0 → remains stable
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    writeCycle('e1', { startedAt: '2026-01-01T00:00:00Z', tests: { passRate: 0.90 } });
    writeCycle('e2', { startedAt: '2026-01-02T00:00:00Z', tests: { passRate: 0.90 } });
    writeCycle('l1', { startedAt: '2026-01-03T00:00:00Z', tests: { passRate: 0.94 } });
    writeCycle('l2', { startedAt: '2026-01-04T00:00:00Z', tests: { passRate: 0.94 } });
    expect(getTrend(tmpRoot)).toBe('stable');
  });

  it('is "improving" via session confidence when trendBonus is in safe range', () => {
    // trendBonus = 10 (single rated cycle fallback)
    // earlyConf = 0.4, lateConf = 0.7 → sessionConfidenceBonus = Math.round(0.3 * 50) = 15, capped to 10 > 5
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    writeCycle('only', { startedAt: '2026-01-01T00:00:00Z', tests: { passRate: 0.90 } });
    writeSession('s1.json', { task_id: 's1', is_request_satisfied: true, confidence: 0.4 });
    writeSession('s2.json', { task_id: 's2', is_request_satisfied: true, confidence: 0.4 });
    writeSession('s3.json', { task_id: 's3', is_request_satisfied: true, confidence: 0.7 });
    writeSession('s4.json', { task_id: 's4', is_request_satisfied: true, confidence: 0.7 });
    expect(getTrend(tmpRoot)).toBe('improving');
  });

  it('is "declining" via session confidence when trendBonus is in safe range', () => {
    // earlyConf = 0.7, lateConf = 0.4 → sessionConfidenceBonus = -10 < -5
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    writeCycle('only', { startedAt: '2026-01-01T00:00:00Z', tests: { passRate: 0.90 } });
    writeSession('s1.json', { task_id: 's1', is_request_satisfied: true, confidence: 0.7 });
    writeSession('s2.json', { task_id: 's2', is_request_satisfied: true, confidence: 0.7 });
    writeSession('s3.json', { task_id: 's3', is_request_satisfied: true, confidence: 0.4 });
    writeSession('s4.json', { task_id: 's4', is_request_satisfied: true, confidence: 0.4 });
    expect(getTrend(tmpRoot)).toBe('declining');
  });

  it('trend is always one of the three valid values', () => {
    const trend = getTrend(tmpRoot);
    expect(['improving', 'stable', 'declining']).toContain(trend);
  });
});

// ── Debug counters ────────────────────────────────────────────────────────────

describe('computeMetrics — debug counters', () => {
  it('counts cycles, sprints, agents, items, and sessions correctly', () => {
    mkdirs(
      join(tmpRoot, '.agentforge/cycles'),
      join(tmpRoot, '.agentforge/sprints'),
      join(tmpRoot, '.agentforge/agents'),
    );
    writeCycle('c1');
    writeSprintFlat('v1.json', [{ status: 'completed' }, { status: 'planned' }]);
    writeAgent('TestAgent');
    writeSession('sess.json', { task_id: 't1', is_request_satisfied: true });

    const { debug } = computeMetrics(tmpRoot);
    expect(debug.cycleCount).toBe(1);
    expect(debug.completedCycleCount).toBe(1);
    expect(debug.sprintCount).toBe(1);
    expect(debug.agentCount).toBe(1);
    expect(debug.totalItems).toBe(2);
    expect(debug.completedItems).toBe(1);
    expect(debug.sessionCount).toBe(1);
    expect(debug.satisfiedSessionCount).toBe(1);
  });
});

// ── Cycle history ─────────────────────────────────────────────────────────────

describe('computeMetrics — cycleHistory', () => {
  it('contains correct fields per cycle', () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    writeCycle('hist-1', {
      sprintVersion: '7.1.0',
      startedAt: '2026-03-01T10:00:00.000Z',
      durationMs: 3_600_000,
      cost: { totalUsd: 12.50 },
      tests: { passed: 490, failed: 10, total: 500, passRate: 0.98 },
      pr: { number: 55 },
    });

    const history = computeMetrics(tmpRoot).cycleHistory;
    expect(history).toHaveLength(1);
    const pt = history[0];
    expect(pt.cycleId).toBe('hist-1');
    expect(pt.sprintVersion).toBe('7.1.0');
    expect(pt.stage).toBe('completed');
    expect(pt.testPassRate).toBeCloseTo(0.98, 5);
    expect(pt.costUsd).toBe(12.50);
    expect(pt.hasPr).toBe(true);
  });

  it('caps at 20 cycles', () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    for (let i = 0; i < 25; i++) {
      writeCycle(`c-${i}`, { startedAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z` });
    }
    expect(computeMetrics(tmpRoot).cycleHistory).toHaveLength(20);
  });

  it('is ordered oldest first', () => {
    mkdirs(join(tmpRoot, '.agentforge/cycles'));
    writeCycle('early', { startedAt: '2026-01-01T00:00:00Z' });
    writeCycle('later', { startedAt: '2026-06-01T00:00:00Z' });
    const history = computeMetrics(tmpRoot).cycleHistory;
    expect(new Date(history[0].startedAt).getTime())
      .toBeLessThan(new Date(history[1].startedAt).getTime());
  });
});

// ── Descriptions ─────────────────────────────────────────────────────────────

describe('computeMetrics — metric descriptions', () => {
  it('meta_learning description mentions sprint iterations', () => {
    writeSprintFlat('v1.json', [{ status: 'completed' }]);
    const m = computeMetrics(tmpRoot).metrics.find(m => m.key === 'meta_learning')!;
    expect(m.description).toContain('sprint');
  });

  it('autonomy description mentions sessions when session data is present', () => {
    writeSession('s1.json', { task_id: 's1', is_request_satisfied: true });
    const m = computeMetrics(tmpRoot).metrics.find(m => m.key === 'autonomy')!;
    expect(m.description).toContain('session');
  });
});
