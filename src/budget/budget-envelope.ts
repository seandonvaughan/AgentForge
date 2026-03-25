/**
 * Budget envelope for cost-gating agent runs.
 *
 * Tracks accumulated spend against a maximum budget and provides
 * graduated action directives: proceed, warn, approve (soft block),
 * or block.
 */

import type { ModelTier } from "../types/agent.js";
import type { BudgetCheckResult } from "../types/budget.js";

/** Spend summary returned by getSpendReport. */
export interface SpendReport {
  /** Total dollars recorded via recordActual. */
  totalSpentUsd: number;
  /** Dollars remaining (clamped to 0). */
  remainingUsd: number;
  /** Percentage of budget consumed — can exceed 100. */
  percentUsed: number;
}

/**
 * Manages a fixed USD budget across an agent session or workflow.
 *
 * Before each run call `checkBefore` to gate execution.
 * After each run call `recordActual` to commit the real spend.
 */
export class BudgetEnvelope {
  private readonly maxBudgetUsd: number;
  private totalSpentUsd: number = 0;

  constructor(maxBudgetUsd: number) {
    this.maxBudgetUsd = maxBudgetUsd;
  }

  /**
   * Checks whether a prospective run should proceed.
   *
   * Graduated thresholds based on (spent + estimate) / budget:
   *   < 80%   → proceed
   *   80–95%  → warn (allowed, inject snippet)
   *   95–100% → approve (soft block, not allowed)
   *   > 100%  → block (hard block, not allowed)
   */
  checkBefore(estimatedCostUsd: number, _tier: ModelTier): BudgetCheckResult {
    const projectedSpend = this.totalSpentUsd + estimatedCostUsd;
    const projectedPercent = (projectedSpend / this.maxBudgetUsd) * 100;
    const remainingUsd = Math.max(0, this.maxBudgetUsd - this.totalSpentUsd);
    const percentUsed = (this.totalSpentUsd / this.maxBudgetUsd) * 100;

    if (projectedPercent > 100) {
      return {
        allowed: false,
        action: "block",
        remainingUsd,
        percentUsed,
      };
    }

    if (projectedPercent >= 95) {
      return {
        allowed: false,
        action: "approve",
        remainingUsd,
        percentUsed,
        budgetContextSnippet: this._buildSnippet(remainingUsd),
      };
    }

    if (projectedPercent >= 80) {
      return {
        allowed: true,
        action: "warn",
        remainingUsd,
        percentUsed,
        budgetContextSnippet: this._buildSnippet(remainingUsd),
      };
    }

    // < 80% — proceed cleanly
    return {
      allowed: true,
      action: "proceed",
      remainingUsd,
      percentUsed,
    };
  }

  /**
   * Records actual spend from a completed run.
   */
  recordActual(costUsd: number): void {
    this.totalSpentUsd += costUsd;
  }

  /**
   * Returns a summary of current spend against the budget.
   */
  getSpendReport(): SpendReport {
    return {
      totalSpentUsd: this.totalSpentUsd,
      remainingUsd: Math.max(0, this.maxBudgetUsd - this.totalSpentUsd),
      percentUsed: (this.totalSpentUsd / this.maxBudgetUsd) * 100,
    };
  }

  private _buildSnippet(remainingUsd: number): string {
    return (
      `Budget notice: $${remainingUsd.toFixed(4)} remaining. ` +
      "Be concise — avoid unnecessary token usage."
    );
  }
}
