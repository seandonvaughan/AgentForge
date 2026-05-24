/**
 * Contract tests for packages/dashboard/src/routes/flywheel/+page.server.ts.
 *
 * These tests lock in regression guards for cycle-history shaping so critical
 * flywheel regressions fail in `verify:product` before dashboard e2e.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  _computeMetrics,
  type CycleHistoryPoint,
} from '../../packages/dashboard/src/routes/flywheel/+page.server.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'flywheel-page-server-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeCycle(
  cycleId: string,
  opts: { startedAt?: string; archived?: boolean } = {},
): void {
  const baseDir = opts.archived
    ? join(tmpRoot, '.agentforge', 'cycles-archived', cycleId)
    : join(tmpRoot, '.agentforge', 'cycles', cycleId);

  mkdirSync(baseDir, { recursive: true });
  writeFileSync(
    join(baseDir, 'cycle.json'),
    JSON.stringify(
      {
        cycleId,
        stage: 'completed',
        ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
        tests: { passed: 9, failed: 1, total: 10, passRate: 0.9 },
      },
      null,
      2,
    ),
    'utf-8',
  );
}

function writeMemoryEntry(source: string, createdAt: string): void {
  const memoryDir = join(tmpRoot, '.agentforge', 'memory');
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(
    join(memoryDir, 'events.jsonl'),
    `${JSON.stringify({ source, createdAt })}\n`,
    'utf-8',
  );
}

function tailCycleIds(points: CycleHistoryPoint[], count: number): string[] {
  return points.slice(-count).map((point) => point.cycleId);
}

describe('_computeMetrics cycle history guards', () => {
  it('caps cycleHistory to 20 and keeps the most recent sorted cycles', () => {
    for (let i = 1; i <= 25; i += 1) {
      writeCycle(
        `cycle-${String(i).padStart(2, '0')}`,
        { startedAt: `2026-01-${String(i).padStart(2, '0')}T10:00:00.000Z` },
      );
    }

    const payload = _computeMetrics(tmpRoot);
    const ids = payload.cycleHistory.map((point) => point.cycleId);

    expect(payload.cycleHistory).toHaveLength(20);
    expect(ids[0]).toBe('cycle-06');
    expect(ids[19]).toBe('cycle-25');
  });

  it('uses epoch fallback for cycles without startedAt in both history and memory trend', () => {
    writeCycle('cycle-no-start');
    writeCycle('cycle-with-start', { startedAt: '2026-03-01T08:00:00.000Z', archived: true });
    writeMemoryEntry('cycle-no-start', '2026-03-01T09:00:00.000Z');

    const payload = _computeMetrics(tmpRoot);
    const historyEntry = payload.cycleHistory.find((point) => point.cycleId === 'cycle-no-start');
    const trendEntry = payload.memoryStats.entriesPerCycleTrend.find(
      (point) => point.cycleId === 'cycle-no-start',
    );

    expect(historyEntry?.startedAt).toBe('1970-01-01T00:00:00.000Z');
    expect(trendEntry?.startedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('keeps memory trend cycle IDs aligned with the cycleHistory tail window', () => {
    for (let i = 1; i <= 40; i += 1) {
      writeCycle(
        `cycle-${String(i).padStart(2, '0')}`,
        { startedAt: `2026-02-${String((i % 28) + 1).padStart(2, '0')}T10:00:00.000Z` },
      );
    }

    const payload = _computeMetrics(tmpRoot);
    const historyTailIds = tailCycleIds(payload.cycleHistory, 12);
    const trendIds = payload.memoryStats.entriesPerCycleTrend.map((point) => point.cycleId);

    expect(payload.cycleHistory).toHaveLength(20);
    expect(payload.memoryStats.entriesPerCycleTrend).toHaveLength(12);
    expect(trendIds).toEqual(historyTailIds);
  });
});

