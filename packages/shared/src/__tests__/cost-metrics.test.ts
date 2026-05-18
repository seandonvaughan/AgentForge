/**
 * Unit tests for cost metrics — rolling p50 computation and median calculation.
 *
 * Ensures that tag-specific cost medians are correctly computed from cycle data,
 * used by the scoring pipeline fallback to provide accurate per-tag cost estimates.
 */
import { describe, it, expect } from 'vitest';
import { computeRollingP50CostByTag, computeMedian } from '@agentforge/shared';

describe('computeMedian', () => {
  it('returns 0 for empty array', () => {
    expect(computeMedian([])).toBe(0);
  });

  it('returns the single value for a 1-element array', () => {
    expect(computeMedian([5])).toBe(5);
  });

  it('returns the middle value for odd-length array', () => {
    expect(computeMedian([1, 2, 3])).toBe(2);
    expect(computeMedian([1, 3, 5].sort((a, b) => a - b))).toBe(3); // sorted input
  });

  it('returns average of two middle values for even-length array', () => {
    expect(computeMedian([1, 2, 3, 4])).toBe(2.5);
    expect(computeMedian([10, 20])).toBe(15);
  });

  it('works with float values', () => {
    expect(computeMedian([1.5, 2.5, 3.5])).toBe(2.5);
    expect(computeMedian([0.1, 0.2, 0.3, 0.4])).toBeCloseTo(0.25);
  });

  it('works with negative values', () => {
    expect(computeMedian([-3, -2, -1, 0, 1].sort((a, b) => a - b))).toBe(-1);
  });

  it('handles duplicate values correctly', () => {
    expect(computeMedian([1, 1, 1, 2, 2, 3])).toBe(1.5);
  });
});

describe('computeRollingP50CostByTag', () => {
  it('returns empty object for empty cycles', () => {
    expect(computeRollingP50CostByTag([])).toEqual({});
  });

  it('returns empty object when no cycles have valid items', () => {
    expect(
      computeRollingP50CostByTag([
        { totalCostUsd: 10, items: [] },
        { totalCostUsd: 0, items: [{ tags: ['fix'] }] },
      ]),
    ).toEqual({});
  });

  it('computes p50 for a single cycle with one tag', () => {
    const result = computeRollingP50CostByTag([
      {
        totalCostUsd: 3,
        items: [{ tags: ['fix'] }, { tags: ['fix'] }, { tags: ['fix'] }],
      },
    ]);
    expect(result).toEqual({ fix: 1 }); // 3 / 3 items = $1 per item
  });

  it('handles cycles with multiple items and multiple tags', () => {
    const result = computeRollingP50CostByTag([
      {
        totalCostUsd: 10,
        items: [
          { tags: ['fix'] },
          { tags: ['fix'] },
          { tags: ['feature'] },
          { tags: ['feature'] },
          { tags: ['test'] },
        ],
      },
    ]);
    // Average cost per item = 10 / 5 = $2
    // Each item's tag records $2: fix [$2, $2], feature [$2, $2], test [$2]
    expect(result).toEqual({
      fix: 2,
      feature: 2,
      test: 2,
    });
  });

  it('computes median across multiple cycles', () => {
    const result = computeRollingP50CostByTag([
      { totalCostUsd: 6, items: [{ tags: ['fix'] }, { tags: ['fix'] }, { tags: ['fix'] }] }, // 2 per item
      { totalCostUsd: 12, items: [{ tags: ['fix'] }, { tags: ['fix'] }, { tags: ['fix'] }, { tags: ['fix'] }] }, // 3 per item
    ]);
    // fix observations: [2, 2, 2, 3, 3, 3, 3] (7 items total)
    // median of 7 items: values[3] = 3
    expect(result).toEqual({ fix: 3 });
  });

  it('handles items with empty tags array', () => {
    const result = computeRollingP50CostByTag([
      {
        totalCostUsd: 10,
        items: [
          { tags: ['fix'] },
          { tags: [] },
          { tags: ['feature'] },
        ],
      },
    ]);
    // Average cost per item = 10 / 3 ≈ 3.33
    // fix and feature each record 3.33; items with empty tags are skipped
    expect(result.fix).toBeCloseTo(3.33, 2);
    expect(result.feature).toBeCloseTo(3.33, 2);
    expect(Object.keys(result).length).toBe(2);
  });

  it('uses primary tag (first element) only', () => {
    const result = computeRollingP50CostByTag([
      {
        totalCostUsd: 10,
        items: [
          { tags: ['fix', 'critical', 'urgent'] },
          { tags: ['feature', 'dashboard'] },
        ],
      },
    ]);
    // Average cost per item = 10 / 2 = $5
    expect(result).toEqual({
      fix: 5,
      feature: 5,
    });
  });

  it('trims whitespace from tag names', () => {
    const result = computeRollingP50CostByTag([
      {
        totalCostUsd: 4,
        items: [
          { tags: ['  fix  '] },
          { tags: ['fix'] },
        ],
      },
    ]);
    // Both tags normalize to 'fix'
    expect(result).toEqual({ fix: 2 });
  });

  it('ignores cycles with zero or negative cost', () => {
    const result = computeRollingP50CostByTag([
      { totalCostUsd: 0, items: [{ tags: ['fix'] }] },
      { totalCostUsd: -5, items: [{ tags: ['fix'] }] },
      { totalCostUsd: 10, items: [{ tags: ['fix'] }, { tags: ['fix'] }] }, // 5 per item
    ]);
    expect(result).toEqual({ fix: 5 });
  });

  it('ignores cycles with missing or malformed items', () => {
    const result = computeRollingP50CostByTag([
      { totalCostUsd: 10, items: null as any },
      { totalCostUsd: 10, items: undefined as any },
      { totalCostUsd: 10, items: [{ tags: ['fix'] }, { tags: ['fix'] }] }, // 5 per item
    ]);
    expect(result).toEqual({ fix: 5 });
  });

  it('real-world scenario: mixed tags over multiple cycles', () => {
    const result = computeRollingP50CostByTag([
      {
        totalCostUsd: 30,
        items: [
          { tags: ['fix'] },
          { tags: ['fix'] },
          { tags: ['feature'] },
          { tags: ['feature'] },
          { tags: ['feature'] },
          { tags: ['test'] },
        ],
      }, // avg = 30/6 = 5
      {
        totalCostUsd: 20,
        items: [
          { tags: ['fix'] },
          { tags: ['fix'] },
          { tags: ['chore'] },
          { tags: ['chore'] },
        ],
      }, // avg = 20/4 = 5
      {
        totalCostUsd: 6,
        items: [{ tags: ['fix'] }, { tags: ['fix'] }, { tags: ['test'] }],
      }, // avg = 6/3 = 2
    ]);

    // fix: [5, 5, 5, 5, 2, 2] → sorted [2, 2, 5, 5, 5, 5] → p50 = (5+5)/2 = 5
    // feature: [5, 5, 5] → p50 = 5
    // test: [5, 2] → sorted [2, 5] → p50 = (2+5)/2 = 3.5
    // chore: [5, 5] → p50 = 5
    expect(result.fix).toBe(5);
    expect(result.feature).toBe(5);
    expect(result.test).toBe(3.5);
    expect(result.chore).toBe(5);
  });

  it('handles cycles with single-item backlog', () => {
    const result = computeRollingP50CostByTag([
      { totalCostUsd: 1.5, items: [{ tags: ['feature'] }] },
      { totalCostUsd: 2.0, items: [{ tags: ['feature'] }] },
      { totalCostUsd: 1.0, items: [{ tags: ['feature'] }] },
    ]);
    // feature: [1.5, 2.0, 1.0] → sorted [1.0, 1.5, 2.0] → p50 = 1.5
    expect(result.feature).toBe(1.5);
  });

  it('returns result with all observed tags', () => {
    const result = computeRollingP50CostByTag([
      { totalCostUsd: 10, items: [{ tags: ['a'] }, { tags: ['b'] }, { tags: ['c'] }] },
    ]);
    expect(Object.keys(result).sort()).toEqual(['a', 'b', 'c']);
  });
});
