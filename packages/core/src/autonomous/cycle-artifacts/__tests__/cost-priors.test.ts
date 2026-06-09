// W3 — estimator self-calibration from spend-report actuals.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeCostPriors,
  writeCostPriors,
  loadCostPriors,
  COST_PRIORS_MIN_SAMPLES,
} from '../cost-priors.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'af-cost-priors-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeCycle(
  id: string,
  perItem: Array<Record<string, unknown>>,
  planItems?: Array<Record<string, unknown>>,
): void {
  const dir = join(root, '.agentforge', 'cycles', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spend-report.json'), JSON.stringify({ perItem }));
  if (planItems) {
    writeFileSync(join(dir, 'plan.json'), JSON.stringify({ items: planItems }));
  }
}

describe('computeCostPriors', () => {
  it('buckets completed actuals by complexity and computes medians', () => {
    writeCycle('c1', [
      { itemId: 'a', status: 'completed', actualUsd: 2.0, estimatedComplexity: 'low' },
      { itemId: 'b', status: 'completed', actualUsd: 4.0, estimatedComplexity: 'medium' },
      { itemId: 'c', status: 'completed', actualUsd: 6.0, estimatedComplexity: 'medium' },
      { itemId: 'x', status: 'failed', actualUsd: 9.0, estimatedComplexity: 'high' }, // excluded
      { itemId: 'y', status: 'completed', actualUsd: 0, estimatedComplexity: 'high' }, // excluded
    ]);
    const priors = computeCostPriors(root);
    expect(priors).not.toBeNull();
    expect(priors!.low).toEqual({ medianUsd: 2.0, count: 1 });
    expect(priors!.medium).toEqual({ medianUsd: 5.0, count: 2 });
    expect(priors!.high).toBeUndefined();
    expect(priors!.totalSamples).toBe(3);
  });

  it('joins complexity from plan.json for older spend-reports lacking the field', () => {
    writeCycle(
      'c1',
      [
        { itemId: 'a', status: 'completed', actualUsd: 3.0 },
        { itemId: 'b', status: 'completed', actualUsd: 5.0 },
        { itemId: 'c', status: 'completed', actualUsd: 7.0 },
      ],
      [
        { id: 'a', estimatedComplexity: 'low' },
        { id: 'b', estimatedComplexity: 'medium' },
        { id: 'c', estimatedComplexity: 'medium' },
      ],
    );
    const priors = computeCostPriors(root);
    expect(priors!.low!.medianUsd).toBe(3.0);
    expect(priors!.medium).toEqual({ medianUsd: 6.0, count: 2 });
  });

  it(`returns null below the ${COST_PRIORS_MIN_SAMPLES}-sample floor and for fresh repos`, () => {
    expect(computeCostPriors(root)).toBeNull();
    writeCycle('c1', [
      { itemId: 'a', status: 'completed', actualUsd: 2.0, estimatedComplexity: 'low' },
    ]);
    expect(computeCostPriors(root)).toBeNull();
  });
});

describe('writeCostPriors / loadCostPriors', () => {
  it('persists priors to .agentforge/config/cost-priors.json and round-trips', () => {
    writeCycle('c1', [
      { itemId: 'a', status: 'completed', actualUsd: 2.0, estimatedComplexity: 'low' },
      { itemId: 'b', status: 'completed', actualUsd: 4.0, estimatedComplexity: 'medium' },
      { itemId: 'c', status: 'completed', actualUsd: 6.0, estimatedComplexity: 'high' },
    ]);
    const written = writeCostPriors(root);
    expect(written).not.toBeNull();
    expect(existsSync(join(root, '.agentforge', 'config', 'cost-priors.json'))).toBe(true);

    const loaded = loadCostPriors(root);
    expect(loaded).toEqual(written);
  });

  it('leaves an existing priors file untouched when the floor is not met', () => {
    writeCycle('c1', [
      { itemId: 'a', status: 'completed', actualUsd: 2.0, estimatedComplexity: 'low' },
      { itemId: 'b', status: 'completed', actualUsd: 4.0, estimatedComplexity: 'medium' },
      { itemId: 'c', status: 'completed', actualUsd: 6.0, estimatedComplexity: 'high' },
    ]);
    const first = writeCostPriors(root);
    expect(first).not.toBeNull();

    // Wipe the cycle data — recompute is below floor, file must survive.
    rmSync(join(root, '.agentforge', 'cycles'), { recursive: true, force: true });
    expect(writeCostPriors(root)).toBeNull();
    expect(loadCostPriors(root)).toEqual(first);
  });

  it('loadCostPriors returns null for absent or corrupt files', () => {
    expect(loadCostPriors(root)).toBeNull();
    mkdirSync(join(root, '.agentforge', 'config'), { recursive: true });
    writeFileSync(join(root, '.agentforge', 'config', 'cost-priors.json'), 'not-json');
    expect(loadCostPriors(root)).toBeNull();
  });
});
