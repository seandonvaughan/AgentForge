/**
 * Execution status shown for an objective-mode child item.
 */
export type ObjectiveModeItemStatus =
  | 'planned'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'unknown'
  | (string & {});

/**
 * Child item summary used by objective-mode decomposition views.
 */
export interface EpicDecompositionChildView {
  /** Stable child item id, such as `child-5`. */
  id: string;
  /** Human-readable child work title. */
  title: string;
  /** Declared files the child is expected to touch. */
  files: string[];
  /** Planned child cost in USD, or null when the planner did not provide one. */
  estimatedCostUsd: number | null;
  /** Current execution status for the child. */
  status: ObjectiveModeItemStatus;
  /** Actual child execution cost in USD, or null before execution is known. */
  actualCostUsd: number | null;
}

/**
 * One wave of objective-mode child items that can run together.
 */
export interface EpicDecompositionWaveView {
  /** Zero-based wave index assigned by decomposition layering. */
  wave: number;
  /** Children scheduled in this wave. */
  children: EpicDecompositionChildView[];
}

/**
 * Wave-grouped decomposition view for one objective-mode epic.
 */
export interface EpicDecompositionView {
  /** Stable epic id for the decomposed objective. */
  epicId: string;
  /** Child work grouped by executable wave. */
  waves: EpicDecompositionWaveView[];
}

/**
 * Planned-vs-actual spend row for one objective-mode child item.
 */
export interface SpendReportItemView {
  /** Stable child item id. */
  itemId: string;
  /** Human-readable child work title. */
  title: string;
  /** Planned child spend in USD, or null when no estimate exists. */
  plannedUsd: number | null;
  /** Actual child spend in USD. */
  actualUsd: number;
  /** Current execution status for the child. */
  status: ObjectiveModeItemStatus;
}

/**
 * Objective-mode spend totals across execution and orchestration overhead.
 */
export interface SpendReportTotalsView {
  /** Cycle budget in USD. */
  budgetUsd: number;
  /** Total spend in USD across execution and overhead. */
  totalUsd: number;
  /** Execute-phase spend in USD. */
  executionUsd: number;
  /** Non-execute orchestration spend in USD. */
  overheadUsd: number;
  /** Total spend divided by budget, or 0 when no budget is available. */
  utilization: number;
}

/**
 * Planned-vs-actual objective-mode spend report view.
 */
export interface SpendReportView {
  /** Stable cycle id that produced the report. */
  cycleId: string;
  /** Stable epic id when the report belongs to an objective-mode epic. */
  epicId: string | null;
  /** Original operator objective text when available. */
  objective: string | null;
  /** Per-child planned-vs-actual spend rows. */
  perItem: SpendReportItemView[];
  /** Aggregate spend totals. */
  totals: SpendReportTotalsView;
  /** ISO timestamp for when the report was generated. */
  generatedAt: string;
}

/**
 * Verdict emitted by the objective-mode epic review.
 */
export type EpicReviewVerdict = 'APPROVE' | 'REQUEST_CHANGES' | 'TRIAGE';

/**
 * Specific child item fault identified by the epic review.
 */
export interface EpicReviewFaultedItemView {
  /** Stable child item id that needs follow-up. */
  itemId: string;
  /** Reviewer's rationale for why this child is faulted. */
  reason: string;
  /** Files involved in the fault. */
  files: string[];
}

/**
 * Objective-mode review view for the integrated epic branch.
 */
export interface EpicReviewView {
  /** Structured epic review verdict. */
  verdict: EpicReviewVerdict;
  /** Human-readable review rationale. */
  rationale: string;
  /** Child-level faults to route back into follow-up work. */
  faultedItems: EpicReviewFaultedItemView[];
}
