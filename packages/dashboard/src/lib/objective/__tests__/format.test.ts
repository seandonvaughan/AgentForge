import { describe, expect, it } from 'vitest';
import {
  computeBudgetBand,
  deriveChildStatus,
  formatSpendReportTotals,
  groupChildrenIntoWaves,
} from '../format.js';

describe('objective format utilities', () => {
  it('groups children by explicit wave and totals planned cost per wave', () => {
    const waves = groupChildrenIntoWaves({
      children: [
        { id: 'child-3', title: 'Finalize', wave: 2, estimatedCostUsd: 4 },
        { id: 'child-1', title: 'Build base', wave: 0, estimatedCostUsd: 9.5 },
        { id: 'child-2', title: 'Wire UI', wave: 1, estimatedCostUsd: 6 },
        { id: 'child-4', title: 'Docs', wave: 1, estimatedCostUsd: 1.5 },
      ],
    });

    expect(waves).toEqual([
      {
        wave: 0,
        estimatedCostUsd: 9.5,
        children: [{ id: 'child-1', title: 'Build base', wave: 0, estimatedCostUsd: 9.5 }],
      },
      {
        wave: 1,
        estimatedCostUsd: 7.5,
        children: [
          { id: 'child-2', title: 'Wire UI', wave: 1, estimatedCostUsd: 6 },
          { id: 'child-4', title: 'Docs', wave: 1, estimatedCostUsd: 1.5 },
        ],
      },
      {
        wave: 2,
        estimatedCostUsd: 4,
        children: [{ id: 'child-3', title: 'Finalize', wave: 2, estimatedCostUsd: 4 }],
      },
    ]);
  });

  it('derives waves from predecessor depth when wave is absent', () => {
    const waves = groupChildrenIntoWaves([
      { id: 'api', predecessors: ['schema'], estimatedCostUsd: 3 },
      { id: 'schema', predecessors: [], estimatedCostUsd: 2 },
      { id: 'ui', predecessors: ['api'], estimatedCostUsd: 5 },
    ]);

    expect(waves.map((wave) => ({ wave: wave.wave, ids: wave.children.map((child) => child.id) }))).toEqual([
      { wave: 0, ids: ['schema'] },
      { wave: 1, ids: ['api'] },
      { wave: 2, ids: ['ui'] },
    ]);
  });

  it('derives child status from execute itemResults before falling back to child status', () => {
    const execute = {
      itemResults: [
        { itemId: 'child-1', status: 'completed' },
        { itemId: 'child-2', status: 'failed' },
        { itemId: 'child-3', status: 'in_progress' },
      ],
    };

    expect(deriveChildStatus({ id: 'child-1', status: 'planned' }, execute)).toBe('completed');
    expect(deriveChildStatus({ id: 'child-2' }, execute)).toBe('failed');
    expect(deriveChildStatus({ id: 'child-3' }, execute)).toBe('running');
    expect(deriveChildStatus({ id: 'child-4', status: 'skipped' }, execute)).toBe('skipped');
    expect(deriveChildStatus({ id: 'child-5' }, execute)).toBe('planned');
  });

  it('computes spendable budget and the 70 to 100 percent planning band', () => {
    expect(computeBudgetBand(50)).toEqual({
      budgetUsd: 50,
      spendableUsd: 36.66666666666667,
      lowerUsd: 25.666666666666668,
      upperUsd: 36.66666666666667,
    });
    expect(computeBudgetBand(5)).toEqual({
      budgetUsd: 5,
      spendableUsd: 0,
      lowerUsd: 0,
      upperUsd: 0,
    });
  });

  it('formats spend report totals for dashboard rendering', () => {
    expect(
      formatSpendReportTotals({
        totalUsd: 13.456,
        budgetUsd: 50,
        executionUsd: 9,
        overheadUsd: 4.456,
        utilization: 0.26912,
      }),
    ).toEqual({
      totalUsd: '$13.46',
      budgetUsd: '$50.00',
      executionUsd: '$9.00',
      overheadUsd: '$4.46',
      utilization: '27%',
    });
  });
});
