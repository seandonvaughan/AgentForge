/**
 * Tests for packages/dashboard/src/lib/util/spend-report.ts
 *
 * Covers:
 *   - buildSpendRows: delta math, deltaPct computation, zero-planned guard
 *   - buildSpendTotals: utilization ratio→percent, formatted totals
 *   - formatUsd / formatUsdDelta / formatPct: boundary and sign cases
 */

import { describe, expect, it } from 'vitest';
import {
  buildSpendRows,
  buildSpendTotals,
  formatUsd,
  formatUsdDelta,
  formatPct,
} from '../spend-report.js';
import type { SpendReport } from '../../api/epic.js';

// ── Shared fixture ────────────────────────────────────────────────────────────

const REPORT: SpendReport = {
  cycleId: 'cycle-abc',
  items: [
    { itemId: 'item-1', title: 'Login endpoint', plannedUsd: 20, actualUsd: 18.5 },
    { itemId: 'item-2', title: 'JWT middleware', plannedUsd: 15, actualUsd: 16.2 },
    { itemId: 'item-3', title: 'Zero-planned item', plannedUsd: 0, actualUsd: 5 },
  ],
  execution: 34.7,
  overhead: 5.3,
  utilization: 0.867,
};

// ── buildSpendRows ────────────────────────────────────────────────────────────

describe('buildSpendRows', () => {
  it('returns one row per item', () => {
    expect(buildSpendRows(REPORT)).toHaveLength(3);
  });

  it('returns empty array when report has no items', () => {
    const empty: SpendReport = { ...REPORT, items: [] };
    expect(buildSpendRows(empty)).toEqual([]);
  });

  it('passes through itemId and title', () => {
    const rows = buildSpendRows(REPORT);
    expect(rows[0]!.itemId).toBe('item-1');
    expect(rows[0]!.title).toBe('Login endpoint');
  });

  it('computes negative delta for under-budget item', () => {
    const row = buildSpendRows(REPORT)[0]!;
    expect(row.delta).toBeCloseTo(-1.5);
  });

  it('computes positive delta for over-budget item', () => {
    const row = buildSpendRows(REPORT)[1]!;
    expect(row.delta).toBeCloseTo(1.2);
  });

  it('computes deltaPct correctly for under-budget item', () => {
    // (18.5 - 20) / 20 * 100 = -7.5
    const row = buildSpendRows(REPORT)[0]!;
    expect(row.deltaPct).not.toBeNull();
    expect(row.deltaPct!).toBeCloseTo(-7.5);
  });

  it('computes deltaPct correctly for over-budget item', () => {
    // (16.2 - 15) / 15 * 100 = 8.0
    const row = buildSpendRows(REPORT)[1]!;
    expect(row.deltaPct!).toBeCloseTo(8.0);
  });

  it('sets deltaPct to null when plannedUsd is 0 (zero-planned guard)', () => {
    const row = buildSpendRows(REPORT)[2]!;
    expect(row.deltaPct).toBeNull();
  });

  it('sets deltaPctFormatted to "—" when plannedUsd is 0', () => {
    const row = buildSpendRows(REPORT)[2]!;
    expect(row.deltaPctFormatted).toBe('—');
  });

  it('formats null plannedUsd safely while preserving actual cost', () => {
    const report: SpendReport = {
      ...REPORT,
      items: [{ itemId: 'resumed', title: 'Resumed item', plannedUsd: null, actualUsd: 7.25 }],
    };
    const row = buildSpendRows(report)[0]!;
    expect(row.plannedFormatted).toBe('—');
    expect(row.actualFormatted).toBe('$7.25');
    expect(row.delta).toBe(7.25);
    expect(row.deltaPct).toBeNull();
    expect(row.deltaPctFormatted).toBe('—');
  });

  it('formats plannedUsd and actualUsd as USD strings', () => {
    const row = buildSpendRows(REPORT)[0]!;
    expect(row.plannedFormatted).toBe('$20.00');
    expect(row.actualFormatted).toBe('$18.50');
  });

  it('formats negative delta with leading minus', () => {
    const row = buildSpendRows(REPORT)[0]!;
    expect(row.deltaFormatted).toBe('-$1.50');
  });

  it('formats positive delta with leading plus', () => {
    const row = buildSpendRows(REPORT)[1]!;
    expect(row.deltaFormatted).toBe('+$1.20');
  });

  it('formats deltaPctFormatted with sign for non-zero planned', () => {
    const rows = buildSpendRows(REPORT);
    expect(rows[0]!.deltaPctFormatted).toBe('-7.5%');
    expect(rows[1]!.deltaPctFormatted).toBe('+8.0%');
  });

  it('handles exactly equal planned and actual (zero delta)', () => {
    const report: SpendReport = {
      ...REPORT,
      items: [{ itemId: 'x', title: 'Even', plannedUsd: 10, actualUsd: 10 }],
    };
    const row = buildSpendRows(report)[0]!;
    expect(row.delta).toBe(0);
    expect(row.deltaPct).toBeCloseTo(0);
    expect(row.deltaFormatted).toBe('$0.00');
    expect(row.deltaPctFormatted).toBe('0.0%');
  });
});

// ── buildSpendTotals ──────────────────────────────────────────────────────────

describe('buildSpendTotals', () => {
  it('copies raw execution and overhead values from report', () => {
    const totals = buildSpendTotals(REPORT);
    expect(totals.execution).toBe(34.7);
    expect(totals.overhead).toBe(5.3);
  });

  it('copies raw utilization from report', () => {
    const totals = buildSpendTotals(REPORT);
    expect(totals.utilization).toBe(0.867);
  });

  it('formats execution as USD string', () => {
    expect(buildSpendTotals(REPORT).executionFormatted).toBe('$34.70');
  });

  it('formats overhead as USD string', () => {
    expect(buildSpendTotals(REPORT).overheadFormatted).toBe('$5.30');
  });

  it('converts 0–1 utilization to percentage string', () => {
    // 0.867 × 100 = 86.7
    expect(buildSpendTotals(REPORT).utilizationFormatted).toBe('86.7%');
  });

  it('handles zero utilization', () => {
    const report: SpendReport = { ...REPORT, utilization: 0 };
    expect(buildSpendTotals(report).utilizationFormatted).toBe('0.0%');
  });

  it('handles 100% utilization', () => {
    const report: SpendReport = { ...REPORT, utilization: 1 };
    expect(buildSpendTotals(report).utilizationFormatted).toBe('100.0%');
  });

  it('handles non-finite utilization gracefully (defaults to 0.0%)', () => {
    const report: SpendReport = { ...REPORT, utilization: NaN };
    expect(buildSpendTotals(report).utilizationFormatted).toBe('0.0%');
  });
});

// ── formatUsd ─────────────────────────────────────────────────────────────────

describe('formatUsd', () => {
  it('formats a positive amount with two decimal places', () => {
    expect(formatUsd(12.5)).toBe('$12.50');
  });

  it('rounds to nearest cent', () => {
    expect(formatUsd(12.345)).toBe('$12.35');
  });

  it('formats zero as $0.00', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('returns — for null', () => {
    expect(formatUsd(null)).toBe('—');
  });

  it('returns — for Infinity', () => {
    expect(formatUsd(Infinity)).toBe('—');
  });

  it('returns — for NaN', () => {
    expect(formatUsd(NaN)).toBe('—');
  });
});

// ── formatUsdDelta ────────────────────────────────────────────────────────────

describe('formatUsdDelta', () => {
  it('prefixes positive delta with +', () => {
    expect(formatUsdDelta(1.5)).toBe('+$1.50');
  });

  it('prefixes negative delta with -', () => {
    expect(formatUsdDelta(-0.75)).toBe('-$0.75');
  });

  it('returns bare amount for exactly zero', () => {
    expect(formatUsdDelta(0)).toBe('$0.00');
  });

  it('returns — for non-finite input', () => {
    expect(formatUsdDelta(NaN)).toBe('—');
    expect(formatUsdDelta(-Infinity)).toBe('—');
  });
});

// ── formatPct ─────────────────────────────────────────────────────────────────

describe('formatPct', () => {
  it('returns — for null (zero-planned guard)', () => {
    expect(formatPct(null)).toBe('—');
  });

  it('returns — for NaN', () => {
    expect(formatPct(NaN)).toBe('—');
  });

  it('formats positive percentage with + prefix', () => {
    expect(formatPct(8.0)).toBe('+8.0%');
  });

  it('formats negative percentage with - prefix', () => {
    expect(formatPct(-7.5)).toBe('-7.5%');
  });

  it('formats zero without sign prefix', () => {
    expect(formatPct(0)).toBe('0.0%');
  });

  it('rounds to one decimal place', () => {
    expect(formatPct(8.05)).toBe('+8.1%');
  });
});
