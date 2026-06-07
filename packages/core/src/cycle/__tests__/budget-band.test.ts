import { describe, expect, it } from 'vitest';
import { computeBudgetBand } from '../budget-band.js';

describe('computeBudgetBand', () => {
  it('computes spendable budget after fixed reserve and overhead', () => {
    expect(computeBudgetBand(18).spendableUsd).toBeCloseTo(10);
  });

  it('computes the 0.7 to 1.0 spendable band boundaries', () => {
    expect(computeBudgetBand(18)).toEqual({
      budgetUsd: 18,
      spendableUsd: 10,
      lowerUsd: 7,
      upperUsd: 10,
    });
  });
});
