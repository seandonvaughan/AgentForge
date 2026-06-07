export interface BudgetBand {
  budgetUsd: number;
  spendableUsd: number;
  lowerUsd: number;
  upperUsd: number;
}

export const BUDGET_BAND_RESERVE_USD = 6;
export const BUDGET_BAND_OVERHEAD_MULTIPLIER = 1.2;
export const BUDGET_BAND_LOWER_MULTIPLIER = 0.7;
export const BUDGET_BAND_UPPER_MULTIPLIER = 1;

export function computeBudgetBand(budgetUsd: number): BudgetBand {
  const spendableUsd = (budgetUsd - BUDGET_BAND_RESERVE_USD) / BUDGET_BAND_OVERHEAD_MULTIPLIER;

  return {
    budgetUsd,
    spendableUsd,
    lowerUsd: spendableUsd * BUDGET_BAND_LOWER_MULTIPLIER,
    upperUsd: spendableUsd * BUDGET_BAND_UPPER_MULTIPLIER,
  };
}
