/**
 * A single planned-versus-actual spend row in `spend-report.json`.
 */
export interface SpendReportPerItem {
  /**
   * Stable sprint item identifier from the cycle plan.
   */
  itemId: string;

  /**
   * Human-readable sprint item title.
   */
  title: string;

  /**
   * Planned cost estimate in USD, or null when no estimate was available.
   */
  plannedUsd: number | null;

  /**
   * Actual execution cost attributed to this item in USD.
   */
  actualUsd: number;

  /**
   * Terminal item status reported by the cycle executor.
   */
  status: string;
}

/**
 * JSON artifact written as `spend-report.json` for an autonomous cycle.
 */
export interface SpendReport {
  /**
   * Schema version for the spend report artifact.
   */
  schemaVersion: 1;

  /**
   * Cycle identifier that produced the report.
   */
  cycleId: string;

  /**
   * Optional epic identifier associated with the cycle.
   */
  epicId?: string;

  /**
   * Optional cycle objective associated with the report.
   */
  objective?: string;

  /**
   * Cycle budget in USD.
   */
  budgetUsd: number;

  /**
   * Total cycle spend in USD, including execution and overhead.
   */
  totalUsd: number;

  /**
   * Spend attributed to execution work in USD.
   */
  executionUsd: number;

  /**
   * Spend attributed to non-execution cycle overhead in USD.
   */
  overheadUsd: number;

  /**
   * Total spend divided by budget, or 0 when the budget is 0.
   */
  utilization: number;

  /**
   * Planned-versus-actual spend rows for each cycle item.
   */
  perItem: SpendReportPerItem[];

  /**
   * ISO 8601 timestamp for when the report was generated.
   */
  generatedAt: string;
}
