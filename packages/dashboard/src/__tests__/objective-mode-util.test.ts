import { describe, expect, it } from 'vitest';
import {
  budgetBand,
  formatUtilization,
  formatUsd,
  groupChildrenByWave,
  spendTotals,
} from '../lib/util/objective-mode.js';

describe('objective-mode utilities', () => {
  it('groups children by ascending wave while preserving order inside each wave', () => {
    const groups = groupChildrenByWave({
      children: [
        { id: 'child-3', wave: 1, estimatedCostUsd: 2.25 },
        { id: 'child-1', wave: 0, estimatedCostUsd: 1 },
        { id: 'child-4', wave: 1, estimatedCostUsd: 3.75 },
        { id: 'child-2', estimatedCostUsd: 0.5 },
      ],
    });

    expect(groups.map((group) => group.wave)).toEqual([0, 1]);
    expect(groups[0]!.children.map((child) => child.id)).toEqual(['child-1', 'child-2']);
    expect(groups[1]!.children.map((child) => child.id)).toEqual(['child-3', 'child-4']);
    expect(groups[1]!.estimatedCostUsd).toBe(6);
  });

  it('collapses an unlayered child list into a single flat wave', () => {
    const groups = groupChildrenByWave([
      { id: 'child-1', estimatedCostUsd: 1 },
      { id: 'child-2', estimatedCostUsd: 2 },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe('Wave 1');
    expect(groups[0]!.children.map((child) => child.id)).toEqual(['child-1', 'child-2']);
    expect(groups[0]!.estimatedCostUsd).toBe(3);
  });

  it('calculates spend totals and utilization display strings', () => {
    const totals = spendTotals(
      {
        children: [
          { id: 'child-1', estimatedCostUsd: 2, costUsd: 1.25 },
          { id: 'child-2', estimatedCostUsd: 3.5, costUsd: 2.75 },
          { id: 'child-3', estimatedCostUsd: null, costUsd: undefined },
        ],
      },
      10,
    );

    expect(totals.estimatedUsd).toBe(5.5);
    expect(totals.actualUsd).toBe(4);
    expect(totals.remainingUsd).toBe(6);
    expect(totals.utilization).toBe(0.4);
    expect(totals.formatted).toEqual({
      estimated: '$5.50',
      actual: '$4.00',
      budget: '$10.00',
      remaining: '$6.00',
      utilization: '40%',
    });
  });

  it('formats standalone USD and utilization values consistently', () => {
    expect(formatUsd(3)).toBe('$3.00');
    expect(formatUsd(undefined)).toBe('$0.00');
    expect(formatUtilization(0.734)).toBe('73%');
    expect(formatUtilization(null)).toBe('-');
  });

  it('computes the budget spendable amount and 70-100 percent band', () => {
    const band = budgetBand(66);

    expect(band.spendableUsd).toBe(50);
    expect(band.lowerUsd).toBe(35);
    expect(band.upperUsd).toBe(50);
    expect(band.label).toBe('$35.00-$50.00');
  });

  it('keeps reserve-only budget math literal', () => {
    expect(budgetBand(3)).toMatchObject({
      spendableUsd: -2.5,
      lowerUsd: -1.75,
      upperUsd: -2.5,
    });
  });
});
