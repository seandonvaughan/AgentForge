// packages/core/src/autonomous/cycle-artifacts/cost-priors.ts
//
// Estimator self-calibration (W3). The epic planner's static cost table was
// hand-fitted once (2026-06-06) and never updates. This module computes
// per-complexity (low/medium/high) cost medians from completed cycles'
// spend-report actuals and persists them to `.agentforge/config/
// cost-priors.json`. The learn phase refreshes the file after every cycle;
// the decomposer's budget prompt block prefers these repo-local priors over
// the static table (per-repo observed medians still rank above both).

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface CostPriorBucket {
  medianUsd: number;
  count: number;
}

export interface CostPriors {
  schemaVersion: 1;
  low?: CostPriorBucket;
  medium?: CostPriorBucket;
  high?: CostPriorBucket;
  totalSamples: number;
  updatedAt: string;
}

/** Minimum completed-item samples before priors are considered meaningful. */
export const COST_PRIORS_MIN_SAMPLES = 3;

type Complexity = 'low' | 'medium' | 'high';

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function tryReadJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function priorsPath(projectRoot: string): string {
  return join(projectRoot, '.agentforge', 'config', 'cost-priors.json');
}

/**
 * Scan every cycle's spend-report.json for completed items with a positive
 * actual cost, bucket them by estimatedComplexity, and compute medians.
 * Rows written before spend-reports carried complexity are joined against
 * that cycle's plan.json by itemId. Returns null when fewer than
 * COST_PRIORS_MIN_SAMPLES samples exist in total.
 */
export function computeCostPriors(projectRoot: string): CostPriors | null {
  const cyclesDir = join(projectRoot, '.agentforge', 'cycles');
  if (!existsSync(cyclesDir)) return null;

  const buckets: Record<Complexity, number[]> = { low: [], medium: [], high: [] };

  let cycleIds: string[];
  try {
    cycleIds = readdirSync(cyclesDir);
  } catch {
    return null;
  }

  for (const id of cycleIds) {
    const report = tryReadJson(join(cyclesDir, id, 'spend-report.json'));
    const perItem = Array.isArray(report?.['perItem']) ? (report!['perItem'] as Array<Record<string, unknown>>) : [];
    if (perItem.length === 0) continue;

    // Lazy complexity join for older spend-reports that predate the field.
    let planComplexity: Map<string, Complexity> | null = null;
    const lookupComplexity = (itemId: string): Complexity | null => {
      if (planComplexity === null) {
        planComplexity = new Map();
        const plan = tryReadJson(join(cyclesDir, id, 'plan.json'));
        const items = Array.isArray(plan?.['items']) ? (plan!['items'] as Array<Record<string, unknown>>) : [];
        for (const item of items) {
          const c = item['estimatedComplexity'];
          if (typeof item['id'] === 'string' && (c === 'low' || c === 'medium' || c === 'high')) {
            planComplexity.set(item['id'], c);
          }
        }
      }
      return planComplexity.get(itemId) ?? null;
    };

    for (const row of perItem) {
      if (row['status'] !== 'completed') continue;
      const actual = row['actualUsd'];
      if (typeof actual !== 'number' || actual <= 0) continue;
      let complexity = row['estimatedComplexity'];
      if (complexity !== 'low' && complexity !== 'medium' && complexity !== 'high') {
        complexity = typeof row['itemId'] === 'string' ? lookupComplexity(row['itemId'] as string) : null;
      }
      if (complexity !== 'low' && complexity !== 'medium' && complexity !== 'high') continue;
      buckets[complexity].push(actual);
    }
  }

  const totalSamples = buckets.low.length + buckets.medium.length + buckets.high.length;
  if (totalSamples < COST_PRIORS_MIN_SAMPLES) return null;

  const bucket = (values: number[]): CostPriorBucket | undefined =>
    values.length > 0 ? { medianUsd: Number(median(values).toFixed(2)), count: values.length } : undefined;

  return {
    schemaVersion: 1,
    ...(bucket(buckets.low) ? { low: bucket(buckets.low)! } : {}),
    ...(bucket(buckets.medium) ? { medium: bucket(buckets.medium)! } : {}),
    ...(bucket(buckets.high) ? { high: bucket(buckets.high)! } : {}),
    totalSamples,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Recompute and persist priors. Returns the written priors, or null when the
 * sample floor isn't met (the file is left untouched in that case so existing
 * priors never regress to nothing). Never throws.
 */
export function writeCostPriors(projectRoot: string): CostPriors | null {
  try {
    const priors = computeCostPriors(projectRoot);
    if (!priors) return null;
    const path = priorsPath(projectRoot);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(priors, null, 2), 'utf8');
    renameSync(tmp, path);
    return priors;
  } catch {
    return null;
  }
}

/** Load persisted priors; null when absent/corrupt. */
export function loadCostPriors(projectRoot: string): CostPriors | null {
  const parsed = tryReadJson(priorsPath(projectRoot));
  if (!parsed || parsed['schemaVersion'] !== 1 || typeof parsed['totalSamples'] !== 'number') {
    return null;
  }
  return parsed as unknown as CostPriors;
}
