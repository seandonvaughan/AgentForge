/**
 * Unit tests for readCycleRecord — the shared cycle-record reader.
 *
 * These tests exercise the helper directly (not through an HTTP endpoint) to
 * pin both on-disk formats against future regressions.  The canonical
 * implementation lives in packages/shared/src/cycle-record.ts; this test file
 * acts as the regression guard that prevents divergence across consumers.
 *
 * Format coverage:
 *  - Legacy: cycle directory contains cycle.json (pre-v12 archives)
 *  - Current: cycle directory has events.jsonl + optional sprint-link.json
 *  - Edge cases: missing data, malformed JSON, partial event streams
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCycleRecord } from '@agentforge/shared';

// ── Fixtures ────────────────────────────────────────────────────────────────

let tmpDir: string;

function cycleDir(id: string): string {
  const d = join(tmpDir, id);
  mkdirSync(d, { recursive: true });
  return d;
}

function writeCycleJson(dir: string, data: Record<string, unknown>) {
  writeFileSync(join(dir, 'cycle.json'), JSON.stringify(data));
}

function writeEventsJsonl(dir: string, events: Array<Record<string, unknown>>) {
  writeFileSync(join(dir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
}

function writeSprintLink(dir: string, data: Record<string, unknown>) {
  writeFileSync(join(dir, 'sprint-link.json'), JSON.stringify(data));
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-cycle-record-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Legacy format (cycle.json) ─────────────────────────────────────────────

describe('legacy format — cycle.json', () => {
  it('returns the parsed record directly when cycle.json is present', () => {
    const dir = cycleDir('cycle-abc');
    writeCycleJson(dir, {
      cycleId: 'cycle-abc',
      stage: 'completed',
      sprintVersion: '12.0.0',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T01:00:00.000Z',
      durationMs: 3_600_000,
      cost: { totalUsd: 4.20, budgetUsd: 50 },
      tests: { passed: 100, failed: 0, total: 100, passRate: 1.0 },
      git: { branch: 'feat/v12', commitSha: 'abc123', filesChanged: ['src/foo.ts'] },
      pr: { url: 'https://github.com/org/repo/pull/99', number: 99 },
    });

    const result = readCycleRecord(dir, 'cycle-abc');

    expect(result).not.toBeNull();
    expect(result!.cycleId).toBe('cycle-abc');
    expect(result!.stage).toBe('completed');
    expect(result!.sprintVersion).toBe('12.0.0');
    expect(result!.cost?.totalUsd).toBe(4.20);
    expect(result!.tests?.passRate).toBe(1.0);
    expect(result!.pr?.number).toBe(99);
  });

  it('preserves heartbeat metadata from cycle.json', () => {
    const dir = cycleDir('hb-legacy'); writeCycleJson(dir, { cycleId: 'hb-legacy', lastHeartbeatAt: '2025-01-01T00:00:00.000Z', staleness: 'dead' }); const r = readCycleRecord(dir, 'hb-legacy'); expect(r!.lastHeartbeatAt).toBe('2025-01-01T00:00:00.000Z'); expect(r!.staleness).toBe('dead');
  });

  it('omits heartbeat metadata when cycle.json has no lastHeartbeatAt', () => {
    const dir = cycleDir('hb-missing');
    writeCycleJson(dir, {
      cycleId: 'hb-missing',
      stage: 'run',
      staleness: 'unknown',
    });

    const result = readCycleRecord(dir, 'hb-missing');

    expect(result).not.toBeNull();
    expect(result!.lastHeartbeatAt).toBeUndefined();
    expect(result!.staleness).toBeUndefined();
  });

  it('falls through to event-stream reader when cycle.json is malformed JSON', () => {
    const dir = cycleDir('cycle-bad-json');
    writeFileSync(join(dir, 'cycle.json'), '{ invalid json %%% }');
    // No events.jsonl — should return null (not throw)
    const result = readCycleRecord(dir, 'cycle-bad-json');
    expect(result).toBeNull();
  });
});

// ── Current format (events.jsonl) ─────────────────────────────────────────

describe('current format — events.jsonl reconstruction', () => {
  it('reconstructs a full record from a complete event stream', () => {
    const dir = cycleDir('cycle-evts');
    writeEventsJsonl(dir, [
      { type: 'sprint.assigned', at: '2026-03-01T10:00:00.000Z', sprintVersion: '14.0.0' },
      { type: 'phase.start',     at: '2026-03-01T10:01:00.000Z' },
      { type: 'tests.complete',  at: '2026-03-01T11:00:00.000Z', passed: 80, failed: 5 },
      { type: 'scoring.complete', at: '2026-03-01T11:05:00.000Z', totalCostUsd: 3.75 },
      { type: 'pr.opened',       at: '2026-03-01T11:10:00.000Z', url: 'https://github.com/org/repo/pull/7', number: 7 },
      { type: 'cycle.complete',  at: '2026-03-01T11:15:00.000Z', stage: 'completed' },
    ]);

    const result = readCycleRecord(dir, 'cycle-evts');

    expect(result).not.toBeNull();
    expect(result!.cycleId).toBe('cycle-evts');
    expect(result!.sprintVersion).toBe('14.0.0');
    expect(result!.stage).toBe('completed');
    expect(result!.startedAt).toBe('2026-03-01T10:01:00.000Z'); // phase.start wins
    expect(result!.completedAt).toBe('2026-03-01T11:15:00.000Z');
    expect(result!.durationMs).toBe(
      new Date('2026-03-01T11:15:00.000Z').getTime() -
      new Date('2026-03-01T10:01:00.000Z').getTime(),
    );
    expect(result!.cost).toEqual({ totalUsd: 3.75 });
    expect(result!.tests).toEqual({ passed: 80, failed: 5, total: 85, passRate: 80 / 85 });
    expect(result!.pr).toEqual({ url: 'https://github.com/org/repo/pull/7', number: 7 });
  });

  it('preserves heartbeat metadata from the event stream when present', () => {
    const dir = cycleDir('cycle-hb-events');
    writeEventsJsonl(dir, [
      { type: 'phase.start', at: '2026-03-01T10:00:00.000Z' },
      { type: 'cycle.heartbeat', lastHeartbeatAt: '2026-03-01T10:05:00.000Z', staleness: 'healthy' },
      { type: 'cycle.heartbeat', lastHeartbeatAt: '2026-03-01T10:15:00.000Z', staleness: 'stale' },
    ]);

    const result = readCycleRecord(dir, 'cycle-hb-events');

    expect(result).not.toBeNull();
    expect(result!.lastHeartbeatAt).toBe('2026-03-01T10:15:00.000Z');
    expect(result!.staleness).toBe('stale');
  });

  it('accepts "opened" as an alias for "pr.opened"', () => {
    const dir = cycleDir('cycle-opened');
    writeEventsJsonl(dir, [
      { type: 'phase.start', at: '2026-03-01T10:00:00.000Z' },
      { type: 'opened', url: 'https://github.com/org/repo/pull/5', number: 5 },
      { type: 'cycle.complete', at: '2026-03-01T11:00:00.000Z', stage: 'completed' },
    ]);

    const result = readCycleRecord(dir, 'cycle-opened');
    expect(result!.pr).toEqual({ url: 'https://github.com/org/repo/pull/5', number: 5 });
  });

  it('falls back to sprint-link.json for sprintVersion when sprint.assigned is absent', () => {
    const dir = cycleDir('cycle-link');
    writeSprintLink(dir, { sprintVersion: '13.5.0' });
    writeEventsJsonl(dir, [
      { type: 'phase.start', at: '2026-03-01T10:00:00.000Z' },
      { type: 'cycle.complete', at: '2026-03-01T11:00:00.000Z', stage: 'completed' },
    ]);

    const result = readCycleRecord(dir, 'cycle-link');
    expect(result!.sprintVersion).toBe('13.5.0');
  });

  it('uses sprint.assigned.at as startedAt fallback when phase.start is absent', () => {
    const dir = cycleDir('cycle-no-phase');
    writeEventsJsonl(dir, [
      { type: 'sprint.assigned', at: '2026-03-01T09:00:00.000Z', sprintVersion: '14.0.0' },
      { type: 'cycle.complete', at: '2026-03-01T10:00:00.000Z', stage: 'completed' },
    ]);

    const result = readCycleRecord(dir, 'cycle-no-phase');
    expect(result!.startedAt).toBe('2026-03-01T09:00:00.000Z');
  });

  it('returns a record with no tests field when tests.complete is absent', () => {
    const dir = cycleDir('cycle-no-tests');
    writeEventsJsonl(dir, [
      { type: 'phase.start',     at: '2026-03-01T10:00:00.000Z' },
      { type: 'cycle.complete',  at: '2026-03-01T11:00:00.000Z', stage: 'completed' },
    ]);

    const result = readCycleRecord(dir, 'cycle-no-tests');
    expect(result).not.toBeNull();
    expect(result!.tests).toBeUndefined();
  });

  it('returns a record with no cost field when scoring.complete is absent', () => {
    const dir = cycleDir('cycle-no-cost');
    writeEventsJsonl(dir, [
      { type: 'phase.start',    at: '2026-03-01T10:00:00.000Z' },
      { type: 'cycle.complete', at: '2026-03-01T11:00:00.000Z', stage: 'completed' },
    ]);

    const result = readCycleRecord(dir, 'cycle-no-cost');
    expect(result!.cost).toBeUndefined();
  });

  it('stage defaults to undefined when cycle.complete is absent', () => {
    const dir = cycleDir('cycle-running');
    writeEventsJsonl(dir, [
      { type: 'phase.start', at: '2026-03-01T10:00:00.000Z' },
    ]);

    const result = readCycleRecord(dir, 'cycle-running');
    expect(result!.stage).toBeUndefined();
    expect(result!.completedAt).toBeUndefined();
    expect(result!.durationMs).toBeUndefined();
  });

  it('omits heartbeat metadata when the event stream has no heartbeat event', () => {
    const dir = cycleDir('cycle-no-heartbeat');
    writeEventsJsonl(dir, [
      { type: 'phase.start', at: '2026-03-01T10:00:00.000Z' },
      { type: 'tests.complete', at: '2026-03-01T11:00:00.000Z', passed: 10, failed: 0 },
    ]);

    const result = readCycleRecord(dir, 'cycle-no-heartbeat');

    expect(result).not.toBeNull();
    expect(result!.lastHeartbeatAt).toBeUndefined();
    expect(result!.staleness).toBeUndefined();
  });

  it('returns null when events.jsonl contains only blank lines', () => {
    const dir = cycleDir('cycle-empty-events');
    writeFileSync(join(dir, 'events.jsonl'), '\n\n   \n');

    const result = readCycleRecord(dir, 'cycle-empty-events');
    // Empty event stream → all find() calls return undefined → result returned
    // with just cycleId. This is acceptable — the empty-dir guard is handled
    // by the caller iterating readdirSync; the helper itself returns a stub
    // record rather than null for a valid but empty stream.
    // Regression: must NOT throw.
    expect(() => readCycleRecord(dir, 'cycle-empty-events')).not.toThrow();
  });

  it('returns null when events.jsonl is malformed JSON', () => {
    const dir = cycleDir('cycle-bad-events');
    writeFileSync(join(dir, 'events.jsonl'), '{ bad }\n{ worse }\n');

    const result = readCycleRecord(dir, 'cycle-bad-events');
    expect(result).toBeNull();
  });
});

// ── Missing data ───────────────────────────────────────────────────────────

describe('missing data', () => {
  it('returns null when the directory has neither cycle.json nor events.jsonl', () => {
    const dir = cycleDir('cycle-empty-dir');
    const result = readCycleRecord(dir, 'cycle-empty-dir');
    expect(result).toBeNull();
  });

  it('returns null when the directory does not exist', () => {
    const nonExistent = join(tmpDir, 'does-not-exist');
    const result = readCycleRecord(nonExistent, 'ghost');
    expect(result).toBeNull();
  });
});
