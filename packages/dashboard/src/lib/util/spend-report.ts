/**
 * spend-report.ts
 *
 * Pure display helpers for the SpendReport artifact returned by
 * GET /api/v5/cycles/:id/spend-report.
 *
 * Consumed by the SpendTab component (cycles/[id] page) to render a
 * per-item table with planned-vs-actual variance and rolled-up totals.
 *
 * No browser/DOM access — safe for SSR and unit tests.
 */

import type { SpendReport, SpendReportItem } from '../api/epic.js';

// ── Output interfaces ─────────────────────────────────────────────────────────

export interface SpendRow {
  itemId: string;
  title: string;
  plannedUsd: number;
  actualUsd: number;
  /** actualUsd − plannedUsd. Positive = over-budget; negative = under-budget. */
  delta: number;
  /**
   * ((actualUsd − plannedUsd) / plannedUsd) × 100.
   * null when plannedUsd === 0 (division-by-zero guard).
   */
  deltaPct: number | null;
  /** "$20.00" */
  plannedFormatted: string;
  /** "$18.50" */
  actualFormatted: string;
  /** "+$1.20" | "-$1.50" | "$0.00" */
  deltaFormatted: string;
  /** "+8.0%" | "-7.5%" | "—" when deltaPct is null */
  deltaPctFormatted: string;
}

export interface SpendTotals {
  execution: number;
  overhead: number;
  /** Raw 0–1 ratio as produced by the server. */
  utilization: number;
  executionFormatted: string;
  overheadFormatted: string;
  /** "86.7%" */
  utilizationFormatted: string;
}

// ── Formatting primitives ─────────────────────────────────────────────────────

/**
 * Format a USD amount for display with 2 decimal places.
 * Returns "—" for non-finite inputs.
 */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return '—';
  return `$${amount.toFixed(2)}`;
}

/**
 * Format a signed USD delta: "+$1.20", "-$0.50", "$0.00".
 * Returns "—" for non-finite inputs.
 */
export function formatUsdDelta(delta: number): string {
  if (!Number.isFinite(delta)) return '—';
  const abs = `$${Math.abs(delta).toFixed(2)}`;
  if (delta > 0) return `+${abs}`;
  if (delta < 0) return `-${abs}`;
  return abs;
}

/**
 * Format a percentage with one decimal place and sign prefix.
 * Returns "—" for null or non-finite inputs (zero-planned guard).
 */
export function formatPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '—';
  const abs = `${Math.abs(pct).toFixed(1)}%`;
  if (pct > 0) return `+${abs}`;
  if (pct < 0) return `-${abs}`;
  return abs;
}

// ── Aggregation helpers ───────────────────────────────────────────────────────

/**
 * Build per-item rows with planned-vs-actual variance.
 *
 * Zero-planned guard: when plannedUsd === 0, deltaPct is null and
 * deltaPctFormatted is "—" to avoid meaningless infinity values.
 */
export function buildSpendRows(report: SpendReport): SpendRow[] {
  return report.items.map((item: SpendReportItem): SpendRow => {
    const { itemId, title, plannedUsd, actualUsd } = item;
    const delta = actualUsd - plannedUsd;
    const deltaPct = plannedUsd === 0 ? null : (delta / plannedUsd) * 100;

    return {
      itemId,
      title,
      plannedUsd,
      actualUsd,
      delta,
      deltaPct,
      plannedFormatted: formatUsd(plannedUsd),
      actualFormatted: formatUsd(actualUsd),
      deltaFormatted: formatUsdDelta(delta),
      deltaPctFormatted: formatPct(deltaPct),
    };
  });
}

/**
 * Build rolled-up totals from the SpendReport for the SpendTab footer.
 *
 * The server's `utilization` is a 0–1 ratio; `utilizationFormatted` converts
 * it to a human-readable percentage ("86.7%").
 */
export function buildSpendTotals(report: SpendReport): SpendTotals {
  const { execution, overhead, utilization } = report;
  const utilizationPct = Number.isFinite(utilization) ? utilization * 100 : 0;

  return {
    execution,
    overhead,
    utilization,
    executionFormatted: formatUsd(execution),
    overheadFormatted: formatUsd(overhead),
    utilizationFormatted: `${utilizationPct.toFixed(1)}%`,
  };
}
