/**
 * tests/flywheel/memory-stats.test.ts
 *
 * Unit tests for computeMemoryStats() — the two-tier hit-rate logic and
 * sparkline trend computation. Uses real filesystem fixtures so path-joining,
 * file-parsing, and directory-traversal behaviour are all covered end-to-end.
 *
 * Addresses the MAJOR review finding from v10.1.0:
 *   "Flywheel two-tier hit-rate logic (audit.json tier) has no dedicated tests"
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeMemoryStats } from '../../src/flywheel/memory-stats.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Write a JSONL memory file under `<memoryDir>/<filename>`. */
function writeMemoryFile(
  memoryDir: string,
  filename: string,
  entries: object[],
): void {
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(memoryDir, filename), content, 'utf8');
}

/** Create a cycle directory and write its cycle.json. */
function writeCycle(
  cyclesDir: string,
  cycleId: string,
  data: { stage?: string; startedAt?: string },
): void {
  const cycleDir = join(cyclesDir, cycleId);
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(join(cycleDir, 'cycle.json'), JSON.stringify(data), 'utf8');
}

/** Create phases/audit.json for a cycle (tier-1 hit-rate signal). */
function writeAudit(
  cyclesDir: string,
  cycleId: string,
  data: { memoriesInjected?: number },
): void {
  const phasesDir = join(cyclesDir, cycleId, 'phases');
  mkdirSync(phasesDir, { recursive: true });
  writeFileSync(join(phasesDir, 'audit.json'), JSON.stringify(data), 'utf8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeMemoryStats', () => {
  let tempDir: string;
  let memoryDir: string;
  let cyclesDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'agentforge-mem-stats-'));
    memoryDir = join(tempDir, '.agentforge', 'memory');
    cyclesDir = join(tempDir, '.agentforge', 'cycles');
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(cyclesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── Empty / no-data states ──────────────────────────────────────────────────

  it('returns empty stats when memory dir does not exist', () => {
    rmSync(memoryDir, { recursive: true, force: true });
    const stats = computeMemoryStats(tempDir);
    expect(stats).toEqual({ totalEntries: 0, entriesPerCycleTrend: [], hitRate: 0 });
  });

  it('returns empty stats when memory dir has no JSONL files', () => {
    const stats = computeMemoryStats(tempDir);
    expect(stats).toEqual({ totalEntries: 0, entriesPerCycleTrend: [], hitRate: 0 });
  });

  it('returns empty stats when all JSONL entries are malformed', () => {
    writeFileSync(join(memoryDir, 'bad.jsonl'), 'not-json\n{broken\n', 'utf8');
    const stats = computeMemoryStats(tempDir);
    expect(stats).toEqual({ totalEntries: 0, entriesPerCycleTrend: [], hitRate: 0 });
  });

  it('skips entries missing id or type fields', () => {
    writeMemoryFile(memoryDir, 'partial.jsonl', [
      { type: 'insight' },              // missing id
      { id: '1' },                      // missing type
      { id: '2', type: 'note' },        // valid
    ]);
    const stats = computeMemoryStats(tempDir);
    expect(stats.totalEntries).toBe(1);
  });

  // ── Total entries ───────────────────────────────────────────────────────────

  it('counts total entries across multiple JSONL files', () => {
    writeMemoryFile(memoryDir, 'a.jsonl', [
      { id: '1', type: 'insight', createdAt: '2024-01-01T00:00:00Z' },
      { id: '2', type: 'note',    createdAt: '2024-01-02T00:00:00Z' },
    ]);
    writeMemoryFile(memoryDir, 'b.jsonl', [
      { id: '3', type: 'feedback', createdAt: '2024-01-03T00:00:00Z' },
    ]);
    const stats = computeMemoryStats(tempDir);
    expect(stats.totalEntries).toBe(3);
  });

  // ── Hit-rate: tier-1 (audit.json memoriesInjected) ─────────────────────────

  it('tier-1: hit when memoriesInjected > 0', () => {
    writeMemoryFile(memoryDir, 'mem.jsonl', [
      { id: '1', type: 'insight', createdAt: '2024-01-01T00:00:00Z', source: 'cycle-a' },
    ]);
    writeCycle(cyclesDir, 'cycle-a', { stage: 'completed', startedAt: '2024-01-02T00:00:00Z' });
    writeAudit(cyclesDir, 'cycle-a', { memoriesInjected: 3 });

    const stats = computeMemoryStats(tempDir);
    expect(stats.hitRate).toBe(1);
  });

  it('tier-1: miss when memoriesInjected === 0', () => {
    writeMemoryFile(memoryDir, 'mem.jsonl', [
      { id: '1', type: 'insight', createdAt: '2024-01-01T00:00:00Z', source: 'cycle-a' },
    ]);
    writeCycle(cyclesDir, 'cycle-a', { stage: 'completed', startedAt: '2024-01-02T00:00:00Z' });
    writeAudit(cyclesDir, 'cycle-a', { memoriesInjected: 0 });

    const stats = computeMemoryStats(tempDir);
    expect(stats.hitRate).toBe(0);
  });

  it('tier-1 takes precedence over tier-2 timestamp proxy', () => {
    // Cycle started after earliest memory (tier-2 would call this a hit),
    // but audit.json explicitly says memoriesInjected=0 (tier-1 says miss).
    const early = '2024-01-01T00:00:00Z';
    writeMemoryFile(memoryDir, 'mem.jsonl', [
      { id: '1', type: 'insight', createdAt: early, source: 'cycle-a' },
    ]);
    writeCycle(cyclesDir, 'cycle-a', { stage: 'completed', startedAt: '2024-01-03T00:00:00Z' });
    writeAudit(cyclesDir, 'cycle-a', { memoriesInjected: 0 }); // explicit miss

    const stats = computeMemoryStats(tempDir);
    expect(stats.hitRate).toBe(0);
  });

  it('tier-1: audit.json without memoriesInjected field falls through to tier-2', () => {
    const early = '2024-01-01T00:00:00Z';
    const later = '2024-01-05T00:00:00Z';
    writeMemoryFile(memoryDir, 'mem.jsonl', [
      { id: '1', type: 'insight', createdAt: early, source: 'cycle-a' },
    ]);
    writeCycle(cyclesDir, 'cycle-a', { stage: 'completed', startedAt: later });
    // audit.json exists but has no memoriesInjected field → falls to tier-2
    mkdirSync(join(cyclesDir, 'cycle-a', 'phases'), { recursive: true });
    writeFileSync(
      join(cyclesDir, 'cycle-a', 'phases', 'audit.json'),
      JSON.stringify({ otherField: true }),
      'utf8',
    );
    // tier-2: cycle started after earliest memory → hit
    const stats = computeMemoryStats(tempDir);
    expect(stats.hitRate).toBe(1);
  });

  // ── Hit-rate: tier-2 (timestamp proxy) ─────────────────────────────────────

  it('tier-2: hit when cycle started after earliest memory entry', () => {
    const early = '2024-01-01T00:00:00Z';
    writeMemoryFile(memoryDir, 'mem.jsonl', [
      { id: '1', type: 'insight', createdAt: early, source: 'cycle-b' },
    ]);
    // No audit.json → tier-2 fallback; cycle started later → hit
    writeCycle(cyclesDir, 'cycle-b', { stage: 'completed', startedAt: '2024-01-02T00:00:00Z' });

    const stats = computeMemoryStats(tempDir);
    expect(stats.hitRate).toBe(1);
  });

  it('tier-2: miss when cycle started before earliest memory entry', () => {
    const early = '2024-01-10T00:00:00Z';
    writeMemoryFile(memoryDir, 'mem.jsonl', [
      { id: '1', type: 'insight', createdAt: early, source: 'cycle-c' },
    ]);
    // Cycle started before any memory existed
    writeCycle(cyclesDir, 'cycle-c', { stage: 'completed', startedAt: '2024-01-05T00:00:00Z' });

    const stats = computeMemoryStats(tempDir);
    expect(stats.hitRate).toBe(0);
  });

  // ── Only completed cycles count ─────────────────────────────────────────────

  it('excludes non-completed cycles from hit-rate denominator', () => {
    const ts = '2024-01-01T00:00:00Z';
    writeMemoryFile(memoryDir, 'mem.jsonl', [
      { id: '1', type: 'insight', createdAt: ts, source: 'cycle-run' },
    ]);
    writeCycle(cyclesDir, 'cycle-run',    { stage: 'running', startedAt: ts });
    writeCycle(cyclesDir, 'cycle-failed', { stage: 'failed',  startedAt: ts });
    writeCycle(cyclesDir, 'cycle-none',   { startedAt: ts }); // no stage field

    // 0 evaluated completed cycles → hitRate = 0
    const stats = computeMemoryStats(tempDir);
    expect(stats.hitRate).toBe(0);
  });

  it('hitRate is 0.5 for one hit and one miss', () => {
    const ts = '2024-01-01T00:00:00Z';
    writeMemoryFile(memoryDir, 'mem.jsonl', [
      { id: '1', type: 'insight', createdAt: ts, source: 'cycle-hit' },
      { id: '2', type: 'insight', createdAt: ts, source: 'cycle-miss' },
    ]);
    writeCycle(cyclesDir, 'cycle-hit',  { stage: 'completed', startedAt: '2024-01-02T00:00:00Z' });
    writeAudit(cyclesDir, 'cycle-hit',  { memoriesInjected: 5 });
    writeCycle(cyclesDir, 'cycle-miss', { stage: 'completed', startedAt: '2024-01-02T00:00:00Z' });
    writeAudit(cyclesDir, 'cycle-miss', { memoriesInjected: 0 });

    const stats = computeMemoryStats(tempDir);
    expect(stats.hitRate).toBeCloseTo(0.5, 5);
  });

  it('cycles without startedAt are excluded from hit-rate calculation', () => {
    writeMemoryFile(memoryDir, 'mem.jsonl', [
      { id: '1', type: 'insight', createdAt: '2024-01-01T00:00:00Z', source: 'cycle-nostamp' },
    ]);
    // cycle.json has stage=completed but no startedAt
    mkdirSync(join(cyclesDir, 'cycle-nostamp'), { recursive: true });
    writeFileSync(
      join(cyclesDir, 'cycle-nostamp', 'cycle.json'),
      JSON.stringify({ stage: 'completed' }),
      'utf8',
    );

    // Missing startedAt → excluded → hitRate = 0
    const stats = computeMemoryStats(tempDir);
    expect(stats.hitRate).toBe(0);
  });

  // ── Entries-per-cycle trend (sparkline) ─────────────────────────────────────

  it('builds entriesPerCycleTrend with correct counts', () => {
    writeMemoryFile(memoryDir, 'mem.jsonl', [
      { id: '1', type: 'note', createdAt: '2024-01-01T00:00:00Z', source: 'cycle-a' },
      { id: '2', type: 'note', createdAt: '2024-01-02T00:00:00Z', source: 'cycle-a' },
      { id: '3', type: 'note', createdAt: '2024-02-01T00:00:00Z', source: 'cycle-b' },
    ]);
    writeCycle(cyclesDir, 'cycle-a', { stage: 'completed', startedAt: '2024-01-01T00:00:00Z' });
    writeCycle(cyclesDir, 'cycle-b', { stage: 'completed', startedAt: '2024-02-01T00:00:00Z' });

    const stats = computeMemoryStats(tempDir);
    expect(stats.entriesPerCycleTrend).toHaveLength(2);
    const a = stats.entriesPerCycleTrend.find(p => p.cycleId === 'cycle-a');
    const b = stats.entriesPerCycleTrend.find(p => p.cycleId === 'cycle-b');
    expect(a?.count).toBe(2);
    expect(b?.count).toBe(1);
  });

  it('trend is sorted oldest-first by cycle startedAt', () => {
    writeMemoryFile(memoryDir, 'mem.jsonl', [
      { id: '1', type: 'note', createdAt: '2024-03-01T00:00:00Z', source: 'cycle-c' },
      { id: '2', type: 'note', createdAt: '2024-01-01T00:00:00Z', source: 'cycle-a' },
      { id: '3', type: 'note', createdAt: '2024-02-01T00:00:00Z', source: 'cycle-b' },
    ]);
    writeCycle(cyclesDir, 'cycle-a', { stage: 'completed', startedAt: '2024-01-01T00:00:00Z' });
    writeCycle(cyclesDir, 'cycle-b', { stage: 'completed', startedAt: '2024-02-01T00:00:00Z' });
    writeCycle(cyclesDir, 'cycle-c', { stage: 'completed', startedAt: '2024-03-01T00:00:00Z' });

    const stats = computeMemoryStats(tempDir);
    const ids = stats.entriesPerCycleTrend.map(p => p.cycleId);
    expect(ids).toEqual(['cycle-a', 'cycle-b', 'cycle-c']);
  });

  it('limits trend to last 10 cycles', () => {
    const entries: object[] = [];
    for (let i = 0; i < 12; i++) {
      const month = String(i + 1).padStart(2, '0');
      const cycleId = `cycle-${month}`;
      entries.push({
        id: String(i),
        type: 'note',
        createdAt: `2024-${month}-01T00:00:00Z`,
        source: cycleId,
      });
      writeCycle(cyclesDir, cycleId, {
        stage: 'completed',
        startedAt: `2024-${month}-01T00:00:00Z`,
      });
    }
    writeMemoryFile(memoryDir, 'mem.jsonl', entries);

    const stats = computeMemoryStats(tempDir);
    expect(stats.entriesPerCycleTrend.length).toBeLessThanOrEqual(10);
  });

  it('entries without source are grouped under "unknown" cycle', () => {
    writeMemoryFile(memoryDir, 'mem.jsonl', [
      { id: '1', type: 'note', createdAt: '2024-01-01T00:00:00Z' }, // no source
      { id: '2', type: 'note', createdAt: '2024-01-02T00:00:00Z' }, // no source
    ]);

    const stats = computeMemoryStats(tempDir);
    expect(stats.totalEntries).toBe(2);
    const unknownPoint = stats.entriesPerCycleTrend.find(p => p.cycleId === 'unknown');
    expect(unknownPoint?.count).toBe(2);
  });

  it('hitRate is in [0, 1]', () => {
    writeMemoryFile(memoryDir, 'mem.jsonl', [
      { id: '1', type: 'insight', createdAt: '2024-01-01T00:00:00Z', source: 'cycle-x' },
    ]);
    writeCycle(cyclesDir, 'cycle-x', { stage: 'completed', startedAt: '2024-01-02T00:00:00Z' });
    writeAudit(cyclesDir, 'cycle-x', { memoriesInjected: 2 });

    const stats = computeMemoryStats(tempDir);
    expect(stats.hitRate).toBeGreaterThanOrEqual(0);
    expect(stats.hitRate).toBeLessThanOrEqual(1);
  });
});
