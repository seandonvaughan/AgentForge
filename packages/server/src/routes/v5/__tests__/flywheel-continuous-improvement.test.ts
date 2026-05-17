/**
 * Tests for GET /api/v5/flywheel/continuous-improvement
 *
 * Tests:
 *   - Returns expected shape with data.length === 5 when 5 fixture files exist
 *   - `since` filter excludes older entries (mtime < since)
 *   - `limit` caps results to the requested maximum
 *   - rolling7dAvgRatio is computed correctly with 3+ entries in the window
 *   - trendVsPrior7d returns 'improving' when current 7d avg < prior 7d avg
 *   - Empty flywheel dir → empty data, null rolling7dAvgRatio, 'insufficient-data' trend
 *   - Missing flywheel dir → empty data, null meta fields
 *   - Invalid `since` param returns 400
 *   - Default window is 30 days when `since` is omitted
 *   - trendVsPrior7d returns 'regressing' when current 7d avg > prior 7d avg
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  registerFlywheelContinuousImprovementRoutes,
  computeRollingStats,
  type ContinuousImprovementEntry,
} from '../flywheel-continuous-improvement.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-ci-'));
  app = Fastify({ logger: false });
  registerFlywheelContinuousImprovementRoutes(app, { projectRoot: tmpRoot });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Write a continuous-improvement JSON file to the flywheel directory.
 * `mtimeDate` controls the file modification time, which the endpoint uses
 * as `recordedAt`.
 */
function writeMetricFile(opts: {
  cycleId: string;
  totalFailures?: number;
  failuresPreventableByPriorLearnings?: number;
  preventabilityRatio?: number;
  mtimeDate: Date;
}): void {
  const {
    cycleId,
    totalFailures = 4,
    failuresPreventableByPriorLearnings = 2,
    preventabilityRatio = 0.5,
    mtimeDate,
  } = opts;

  const flywheelDir = join(tmpRoot, '.agentforge', 'flywheel');
  mkdirSync(flywheelDir, { recursive: true });

  const filePath = join(
    flywheelDir,
    `continuous-improvement-${cycleId}.json`,
  );
  writeFileSync(
    filePath,
    JSON.stringify({
      cycleId,
      totalFailures,
      failuresPreventableByPriorLearnings,
      preventabilityRatio,
      perAgent: [],
      computedAt: mtimeDate.toISOString(),
    }),
  );
  // Set mtime to the requested date so the endpoint's mtime filter works.
  utimesSync(filePath, mtimeDate, mtimeDate);
}

/** Date N days before `now`. */
function daysAgo(n: number, now = new Date()): Date {
  const d = new Date(now);
  d.setDate(d.getDate() - n);
  return d;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v5/flywheel/continuous-improvement', () => {
  it('returns expected shape with data.length === 5 when 5 fixture files exist', async () => {
    for (let i = 1; i <= 5; i++) {
      writeMetricFile({
        cycleId: `cycle-${i}`,
        totalFailures: i * 2,
        failuresPreventableByPriorLearnings: i,
        preventabilityRatio: 0.5,
        mtimeDate: daysAgo(i),
      });
    }

    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/flywheel/continuous-improvement',
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{
      data: Array<{
        cycleId: string;
        totalFailures: number;
        failuresPreventableByPriorLearnings: number;
        preventabilityRatio: number;
        recordedAt: string;
      }>;
      meta: {
        total: number;
        since: string;
        rolling7dAvgRatio: number | null;
        trendVsPrior7d: string;
        timestamp: string;
      };
    }>();

    expect(body.data).toHaveLength(5);
    expect(body.meta.total).toBe(5);
    expect(typeof body.meta.since).toBe('string');
    expect(typeof body.meta.timestamp).toBe('string');
    expect(['improving', 'flat', 'regressing', 'insufficient-data']).toContain(
      body.meta.trendVsPrior7d,
    );

    // Each entry must have the required fields
    for (const entry of body.data) {
      expect(typeof entry.cycleId).toBe('string');
      expect(typeof entry.totalFailures).toBe('number');
      expect(typeof entry.failuresPreventableByPriorLearnings).toBe('number');
      expect(typeof entry.preventabilityRatio).toBe('number');
      expect(typeof entry.recordedAt).toBe('string');
      expect(() => new Date(entry.recordedAt)).not.toThrow();
    }
  });

  it('results are sorted newest-first by recordedAt', async () => {
    for (let i = 1; i <= 3; i++) {
      writeMetricFile({
        cycleId: `ord-${i}`,
        preventabilityRatio: 0.4,
        mtimeDate: daysAgo(i),
      });
    }

    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/flywheel/continuous-improvement',
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json<{ data: Array<{ recordedAt: string }> }>();
    expect(data).toHaveLength(3);
    // Newest first — each entry must be newer than or equal to the next
    for (let i = 0; i < data.length - 1; i++) {
      expect(new Date(data[i]!.recordedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(data[i + 1]!.recordedAt).getTime(),
      );
    }
  });

  it('`since` filter excludes entries with mtime before the cutoff', async () => {
    // Recent entries — within default 30d window
    writeMetricFile({ cycleId: 'recent-1', mtimeDate: daysAgo(5) });
    writeMetricFile({ cycleId: 'recent-2', mtimeDate: daysAgo(10) });
    // Old entry — 60 days ago; should be excluded
    writeMetricFile({ cycleId: 'old-1', mtimeDate: daysAgo(60) });

    const sinceDate = daysAgo(20);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/flywheel/continuous-improvement?since=${sinceDate.toISOString()}`,
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json<{ data: Array<{ cycleId: string }> }>();
    expect(data).toHaveLength(2);
    expect(data.map((e) => e.cycleId).sort()).toEqual(['recent-1', 'recent-2'].sort());
  });

  it('`limit` caps results to the requested count', async () => {
    for (let i = 1; i <= 10; i++) {
      writeMetricFile({ cycleId: `lim-${i}`, mtimeDate: daysAgo(i) });
    }

    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/flywheel/continuous-improvement?limit=3',
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json<{ data: unknown[] }>();
    expect(data).toHaveLength(3);
  });

  it('rolling7dAvgRatio is computed correctly with 3+ entries in 7d window', async () => {
    // Write 4 entries in the last 7 days with known ratios
    writeMetricFile({ cycleId: 'r1', preventabilityRatio: 0.2, mtimeDate: daysAgo(1) });
    writeMetricFile({ cycleId: 'r2', preventabilityRatio: 0.4, mtimeDate: daysAgo(2) });
    writeMetricFile({ cycleId: 'r3', preventabilityRatio: 0.6, mtimeDate: daysAgo(3) });
    writeMetricFile({ cycleId: 'r4', preventabilityRatio: 0.8, mtimeDate: daysAgo(4) });
    // Expected avg: (0.2 + 0.4 + 0.6 + 0.8) / 4 = 0.5

    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/flywheel/continuous-improvement',
    });
    expect(res.statusCode).toBe(200);
    const { meta } = res.json<{ meta: { rolling7dAvgRatio: number | null } }>();
    expect(meta.rolling7dAvgRatio).not.toBeNull();
    expect(meta.rolling7dAvgRatio!).toBeCloseTo(0.5, 5);
  });

  it('rolling7dAvgRatio is null when fewer than 3 entries in 7d window', async () => {
    // Only 2 entries in last 7 days — below the MIN_ENTRIES_FOR_ROLLING_AVG threshold
    writeMetricFile({ cycleId: 'few-1', preventabilityRatio: 0.3, mtimeDate: daysAgo(1) });
    writeMetricFile({ cycleId: 'few-2', preventabilityRatio: 0.5, mtimeDate: daysAgo(3) });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/flywheel/continuous-improvement',
    });
    expect(res.statusCode).toBe(200);
    const { meta } = res.json<{ meta: { rolling7dAvgRatio: null | number } }>();
    expect(meta.rolling7dAvgRatio).toBeNull();
  });

  it('trendVsPrior7d returns "improving" when current 7d avg < prior 7d avg', async () => {
    // Prior 7d (8-14 days ago): high ratio (0.8)
    writeMetricFile({ cycleId: 'p1', preventabilityRatio: 0.8, mtimeDate: daysAgo(8) });
    writeMetricFile({ cycleId: 'p2', preventabilityRatio: 0.8, mtimeDate: daysAgo(10) });
    writeMetricFile({ cycleId: 'p3', preventabilityRatio: 0.8, mtimeDate: daysAgo(12) });
    // Current 7d (1-6 days ago): low ratio (0.2) — improving!
    writeMetricFile({ cycleId: 'c1', preventabilityRatio: 0.2, mtimeDate: daysAgo(1) });
    writeMetricFile({ cycleId: 'c2', preventabilityRatio: 0.2, mtimeDate: daysAgo(3) });
    writeMetricFile({ cycleId: 'c3', preventabilityRatio: 0.2, mtimeDate: daysAgo(5) });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/flywheel/continuous-improvement',
    });
    expect(res.statusCode).toBe(200);
    const { meta } = res.json<{ meta: { trendVsPrior7d: string } }>();
    expect(meta.trendVsPrior7d).toBe('improving');
  });

  it('trendVsPrior7d returns "regressing" when current 7d avg > prior 7d avg', async () => {
    // Prior 7d: low ratio (0.2)
    writeMetricFile({ cycleId: 'rp1', preventabilityRatio: 0.2, mtimeDate: daysAgo(8) });
    writeMetricFile({ cycleId: 'rp2', preventabilityRatio: 0.2, mtimeDate: daysAgo(10) });
    writeMetricFile({ cycleId: 'rp3', preventabilityRatio: 0.2, mtimeDate: daysAgo(12) });
    // Current 7d: high ratio (0.8) — regressing
    writeMetricFile({ cycleId: 'rc1', preventabilityRatio: 0.8, mtimeDate: daysAgo(1) });
    writeMetricFile({ cycleId: 'rc2', preventabilityRatio: 0.8, mtimeDate: daysAgo(3) });
    writeMetricFile({ cycleId: 'rc3', preventabilityRatio: 0.8, mtimeDate: daysAgo(5) });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/flywheel/continuous-improvement',
    });
    expect(res.statusCode).toBe(200);
    const { meta } = res.json<{ meta: { trendVsPrior7d: string } }>();
    expect(meta.trendVsPrior7d).toBe('regressing');
  });

  it('empty flywheel dir → empty data, null rolling7dAvgRatio, insufficient-data trend', async () => {
    // Create the dir but leave it empty
    mkdirSync(join(tmpRoot, '.agentforge', 'flywheel'), { recursive: true });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/flywheel/continuous-improvement',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: unknown[];
      meta: { total: number; rolling7dAvgRatio: null; trendVsPrior7d: string };
    }>();
    expect(body.data).toHaveLength(0);
    expect(body.meta.total).toBe(0);
    expect(body.meta.rolling7dAvgRatio).toBeNull();
    expect(body.meta.trendVsPrior7d).toBe('insufficient-data');
  });

  it('missing flywheel dir → empty data, null meta fields', async () => {
    // Don't create the flywheel directory at all
    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/flywheel/continuous-improvement',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: unknown[];
      meta: { total: number; rolling7dAvgRatio: null; trendVsPrior7d: string };
    }>();
    expect(body.data).toHaveLength(0);
    expect(body.meta.total).toBe(0);
    expect(body.meta.rolling7dAvgRatio).toBeNull();
    expect(body.meta.trendVsPrior7d).toBe('insufficient-data');
  });

  it('invalid `since` param returns 400 with error message', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/flywheel/continuous-improvement?since=not-a-date',
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string; code: string }>();
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
    expect(body.code).toBe('INVALID_SINCE');
  });

  it('default window excludes entries older than 30 days when since is omitted', async () => {
    writeMetricFile({ cycleId: 'in-window', mtimeDate: daysAgo(25) });
    writeMetricFile({ cycleId: 'out-of-window', mtimeDate: daysAgo(35) });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/flywheel/continuous-improvement',
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json<{ data: Array<{ cycleId: string }> }>();
    const ids = data.map((e) => e.cycleId);
    expect(ids).toContain('in-window');
    expect(ids).not.toContain('out-of-window');
  });
});

// ---------------------------------------------------------------------------
// computeRollingStats unit tests (pure function)
// ---------------------------------------------------------------------------

describe('computeRollingStats()', () => {
  const nowMs = new Date('2026-05-17T12:00:00Z').getTime();

  function makeEntry(
    daysBack: number,
    ratio: number,
  ): ContinuousImprovementEntry {
    const d = new Date(nowMs);
    d.setDate(d.getDate() - daysBack);
    return {
      cycleId: `cyc-${daysBack}`,
      totalFailures: 4,
      failuresPreventableByPriorLearnings: Math.round(4 * ratio),
      preventabilityRatio: ratio,
      recordedAt: d.toISOString(),
    };
  }

  it('returns null ratio and insufficient-data when no entries', () => {
    const result = computeRollingStats([], nowMs);
    expect(result.rolling7dAvgRatio).toBeNull();
    expect(result.trendVsPrior7d).toBe('insufficient-data');
  });

  it('returns null ratio when fewer than 3 entries in current 7d window', () => {
    const entries = [makeEntry(1, 0.3), makeEntry(3, 0.5)];
    const result = computeRollingStats(entries, nowMs);
    expect(result.rolling7dAvgRatio).toBeNull();
  });

  it('computes correct rolling avg with exactly 3 entries', () => {
    const entries = [
      makeEntry(1, 0.3),
      makeEntry(3, 0.6),
      makeEntry(5, 0.9),
    ];
    // avg = (0.3 + 0.6 + 0.9) / 3 = 0.6
    const result = computeRollingStats(entries, nowMs);
    expect(result.rolling7dAvgRatio).toBeCloseTo(0.6, 5);
  });

  it('returns "flat" when current and prior averages differ by less than 2%', () => {
    const current = [makeEntry(1, 0.5), makeEntry(3, 0.51), makeEntry(5, 0.49)];
    const prior = [makeEntry(8, 0.5), makeEntry(10, 0.5), makeEntry(12, 0.5)];
    const result = computeRollingStats([...current, ...prior], nowMs);
    expect(result.trendVsPrior7d).toBe('flat');
  });

  it('returns "improving" when current avg is clearly lower than prior avg', () => {
    const current = [makeEntry(1, 0.1), makeEntry(3, 0.1), makeEntry(5, 0.1)];
    const prior = [makeEntry(8, 0.9), makeEntry(10, 0.9), makeEntry(12, 0.9)];
    const result = computeRollingStats([...current, ...prior], nowMs);
    expect(result.trendVsPrior7d).toBe('improving');
  });
});
