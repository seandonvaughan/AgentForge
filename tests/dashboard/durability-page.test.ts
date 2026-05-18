// tests/dashboard/durability-page.test.ts
//
// Contract tests for /durability page pure helper logic.
//
// Covers:
//  - fmtRel: relative time formatting
//  - isStale: >30 min idle detection
//  - phaseColor: returns CSS variable string per phase keyword
//  - sorting contract: most recently updated checkpoint first
//  - stale threshold edge cases (exactly 30 min, 31 min)

import { describe, it, expect } from 'vitest';

// ── Types (mirrored from the page) ─────────────────────────────────────────────

interface CheckpointRecord {
  cycleId: string;
  phase: string;
  completedItemIds: string[];
  lastUpdatedAt: string;
  idleSeconds: number;
}

// ── Helper mirrors ─────────────────────────────────────────────────────────────

function fmtRel(isoStr: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function isStale(record: CheckpointRecord): boolean {
  return record.idleSeconds > 30 * 60;
}

function phaseColor(phase: string): string {
  if (phase.includes('audit')) return 'var(--af-info)';
  if (phase.includes('plan')) return 'var(--af-accent)';
  if (phase.includes('execute')) return 'var(--af-success)';
  if (phase.includes('test')) return 'var(--af-warning)';
  if (phase.includes('gate') || phase.includes('review')) return 'var(--af-purple)';
  if (phase.includes('release') || phase.includes('learn')) return 'var(--af-success)';
  return 'var(--af-dim)';
}

function sortByLastUpdated(records: CheckpointRecord[]): CheckpointRecord[] {
  return [...records].sort(
    (a, b) =>
      new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime(),
  );
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW_ISO = new Date().toISOString();
const THIRTY_ONE_MIN_AGO = new Date(Date.now() - 31 * 60 * 1000).toISOString();
const THIRTY_MIN_AGO = new Date(Date.now() - 30 * 60 * 1000).toISOString();
const HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

const makeRecord = (
  cycleId: string,
  idleSeconds: number,
  lastUpdatedAt = NOW_ISO,
  phase = 'execute',
): CheckpointRecord => ({
  cycleId,
  phase,
  completedItemIds: [],
  lastUpdatedAt,
  idleSeconds,
});

// ── Tests: fmtRel ─────────────────────────────────────────────────────────────

describe('fmtRel', () => {
  it('shows seconds for <60s', () => {
    const ts = new Date(Date.now() - 30_000).toISOString();
    expect(fmtRel(ts)).toMatch(/^\d+s ago$/);
  });

  it('shows minutes for 60s – 3599s', () => {
    const ts = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(fmtRel(ts)).toMatch(/^\d+m ago$/);
  });

  it('shows hours for 3600s – 86399s', () => {
    const ts = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(fmtRel(ts)).toMatch(/^\d+h ago$/);
  });

  it('shows days for ≥86400s', () => {
    const ts = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(fmtRel(ts)).toMatch(/^\d+d ago$/);
  });

  it('does not return negative seconds for future timestamps', () => {
    const ts = new Date(Date.now() + 5000).toISOString();
    expect(fmtRel(ts)).toBe('0s ago');
  });
});

// ── Tests: isStale ────────────────────────────────────────────────────────────

describe('isStale', () => {
  it('returns false for idleSeconds = 0', () => {
    expect(isStale(makeRecord('c1', 0))).toBe(false);
  });

  it('returns false for idleSeconds exactly 1800 (30 min)', () => {
    expect(isStale(makeRecord('c2', 1800))).toBe(false);
  });

  it('returns true for idleSeconds = 1801 (just over 30 min)', () => {
    expect(isStale(makeRecord('c3', 1801))).toBe(true);
  });

  it('returns true for idleSeconds = 7200 (2 hours)', () => {
    expect(isStale(makeRecord('c4', 7200))).toBe(true);
  });

  it('uses idleSeconds field, not lastUpdatedAt directly', () => {
    // Stale by idleSeconds even though lastUpdatedAt says now
    const record = makeRecord('c5', 2000, NOW_ISO);
    expect(isStale(record)).toBe(true);
  });
});

// ── Tests: phaseColor ─────────────────────────────────────────────────────────

describe('phaseColor', () => {
  it('audit phase returns af-info', () => {
    expect(phaseColor('audit')).toBe('var(--af-info)');
  });

  it('plan phase returns af-accent', () => {
    expect(phaseColor('plan')).toBe('var(--af-accent)');
  });

  it('execute phase returns af-success', () => {
    expect(phaseColor('execute')).toBe('var(--af-success)');
  });

  it('test phase returns af-warning', () => {
    expect(phaseColor('test')).toBe('var(--af-warning)');
  });

  it('gate phase returns af-purple', () => {
    expect(phaseColor('gate')).toBe('var(--af-purple)');
  });

  it('review phase returns af-purple', () => {
    expect(phaseColor('review')).toBe('var(--af-purple)');
  });

  it('release phase returns af-success', () => {
    expect(phaseColor('release')).toBe('var(--af-success)');
  });

  it('learn phase returns af-success', () => {
    expect(phaseColor('learn')).toBe('var(--af-success)');
  });

  it('unknown phase returns af-dim', () => {
    expect(phaseColor('unknown')).toBe('var(--af-dim)');
    expect(phaseColor('')).toBe('var(--af-dim)');
  });
});

// ── Tests: sort order ─────────────────────────────────────────────────────────

describe('sortByLastUpdated', () => {
  const records: CheckpointRecord[] = [
    makeRecord('old', 7200, TWO_HOURS_AGO),
    makeRecord('mid', 3600, HOUR_AGO),
    makeRecord('new', 0, NOW_ISO),
  ];

  it('places most recently updated first', () => {
    const sorted = sortByLastUpdated(records);
    expect(sorted[0].cycleId).toBe('new');
    expect(sorted[1].cycleId).toBe('mid');
    expect(sorted[2].cycleId).toBe('old');
  });

  it('does not mutate the original array', () => {
    const original = [...records];
    sortByLastUpdated(records);
    expect(records[0].cycleId).toBe(original[0].cycleId);
  });

  it('handles single-element array', () => {
    const single = [makeRecord('solo', 10)];
    const sorted = sortByLastUpdated(single);
    expect(sorted.length).toBe(1);
    expect(sorted[0].cycleId).toBe('solo');
  });

  it('handles empty array', () => {
    expect(sortByLastUpdated([])).toEqual([]);
  });
});

// ── Tests: stale detection in realistic timestamps ────────────────────────────

describe('stale detection with realistic timestamps', () => {
  it('record updated 31 min ago is stale', () => {
    const record: CheckpointRecord = {
      cycleId: 'c',
      phase: 'execute',
      completedItemIds: [],
      lastUpdatedAt: THIRTY_ONE_MIN_AGO,
      idleSeconds: 31 * 60,
    };
    expect(isStale(record)).toBe(true);
  });

  it('record updated 30 min ago is not stale', () => {
    const record: CheckpointRecord = {
      cycleId: 'c',
      phase: 'execute',
      completedItemIds: [],
      lastUpdatedAt: THIRTY_MIN_AGO,
      idleSeconds: 1800,
    };
    expect(isStale(record)).toBe(false);
  });
});
