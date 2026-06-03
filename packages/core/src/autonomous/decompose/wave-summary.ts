// packages/core/src/autonomous/decompose/wave-summary.ts
//
// Pure helper: summarise the SHAPE of a layered EpicPlan — wave count,
// items-per-wave distribution, and peak parallelism. No I/O; safe for
// use in logging, preview, and operator dashboards.

import type { EpicPlan } from './types.js';

export interface WavePlanSummary {
  /** Total number of children in the plan. */
  totalItems: number;
  /** Number of distinct wave numbers present (0 when plan is empty). */
  waveCount: number;
  /**
   * Count of children in each wave, indexed by wave number.
   * Contiguous from wave 0 to the maximum wave; gaps are filled with 0.
   * Empty array when the plan has no children.
   */
  itemsPerWave: number[];
  /**
   * The largest single-wave count — the peak parallelism achievable.
   * 0 when the plan is empty.
   */
  maxWaveWidth: number;
}

/**
 * Compute a concise shape-summary for a layered EpicPlan.
 *
 * Children that have no `wave` field are treated as wave 0. Returns
 * all-zero results with `itemsPerWave: []` when `plan.children` is empty;
 * never throws and never produces NaN.
 */
export function summarizeWavePlan(plan: EpicPlan): WavePlanSummary {
  const children = plan.children;

  if (children.length === 0) {
    return { totalItems: 0, waveCount: 0, itemsPerWave: [], maxWaveWidth: 0 };
  }

  const totalItems = children.length;

  // Collect wave → count
  const counts = new Map<number, number>();
  for (const child of children) {
    const w = typeof child.wave === 'number' ? child.wave : 0;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }

  const waveCount = counts.size;
  const maxWave = Math.max(...counts.keys());

  // Build contiguous array from 0..maxWave (gaps are 0)
  const itemsPerWave: number[] = [];
  for (let w = 0; w <= maxWave; w++) {
    itemsPerWave.push(counts.get(w) ?? 0);
  }

  const maxWaveWidth = Math.max(...itemsPerWave);

  return { totalItems, waveCount, itemsPerWave, maxWaveWidth };
}
