/**
 * Shared TypeScript contracts for objective-mode artifacts.
 *
 * These interfaces mirror the persisted JSON files written under
 * `.agentforge/cycles/<cycleId>/` so server routes and dashboard API clients can
 * consume objective-mode artifacts without importing from core.
 */

/**
 * Estimated implementation complexity for one decomposed objective child.
 */
export type DecompositionComplexity = 'low' | 'medium' | 'high';

/**
 * One child work item in `decomposition.json`.
 */
export interface DecompositionChild {
  /** Stable child item identifier within the parent epic. */
  id: string;
  /** Human-readable work item title. */
  title: string;
  /** Detailed implementation request and acceptance criteria. */
  description: string;
  /** Enforced file scope declared for the child item. */
  files: string[];
  /** Capability tags used for assignee selection and cost calibration. */
  capabilityTags: string[];
  /** Suggested AgentForge agent id for the child item. */
  suggestedAssignee: string;
  /** Planner-estimated execution cost for the child item, in USD. */
  estimatedCostUsd: number;
  /** Planner-estimated implementation complexity. */
  estimatedComplexity: DecompositionComplexity;
  /** Child item ids that must complete before this item may run. */
  predecessors: string[];
  /** Computed execution wave assigned by validation and layering. */
  wave?: number;
}

/**
 * Missing predecessor diagnostics in `decomposition.json.validationReport`.
 */
export interface DecompositionMissingPredecessor {
  /** Child item that referenced missing predecessors. */
  childId: string;
  /** Predecessor ids absent from the decomposition children list. */
  missing: string[];
}

/**
 * Synthetic dependency edge added because child file scopes overlap.
 */
export interface DecompositionSyntheticFileEdge {
  /** Source child item id for the synthetic edge. */
  from: string;
  /** Target child item id for the synthetic edge. */
  to: string;
  /** Files shared by both child items that required serialization. */
  sharedFiles: string[];
}

/**
 * Budget sizing audit in `decomposition.json.validationReport`.
 */
export interface DecompositionBudgetReport {
  /** Original objective budget, in USD. */
  budgetUsd: number;
  /** Budget available for child execution after overhead and reserve. */
  spendableUsd: number;
  /** Sum of all child `estimatedCostUsd` values. */
  sumUsd: number;
  /** Lower acceptable child-cost bound, in USD. */
  lowerUsd: number;
  /** Upper acceptable child-cost bound, in USD. */
  upperUsd: number;
  /** Whether `sumUsd` falls inside the accepted budget band. */
  withinBand: boolean;
}

/**
 * Validation diagnostics persisted with `decomposition.json`.
 */
export interface DecompositionValidationReport {
  /** Whether the child predecessor graph is acyclic. */
  acyclic: boolean;
  /** Cycle path when `acyclic` is false. */
  cycle?: string[];
  /** Missing predecessor references found during validation. */
  missingPredecessors: DecompositionMissingPredecessor[];
  /** Synthetic edges added to serialize overlapping file scopes. */
  syntheticFileEdges: DecompositionSyntheticFileEdge[];
  /** Number of computed execution waves. */
  waveCount: number;
  /** Budget audit, present only when the objective carried a budget. */
  budget?: DecompositionBudgetReport;
}

/**
 * Persisted shape of `.agentforge/cycles/<cycleId>/decomposition.json`.
 */
export interface DecompositionArtifact {
  /** Parent epic id for this decomposition. */
  epicId: string;
  /** Planner rationale for the decomposition. */
  rationale: string;
  /** Wave-layered child work items. */
  children: DecompositionChild[];
  /** Deterministic validation and layering diagnostics. */
  validationReport: DecompositionValidationReport;
}

/**
 * Structured verdict values written by `epic-review.json`.
 */
export type EpicReviewVerdict = 'APPROVE' | 'REQUEST_CHANGES' | 'TRIAGE';

/**
 * One actionable fault emitted by the objective-mode epic review.
 */
export interface EpicReviewFaultedItem {
  /** Plan item id that owns the fault. */
  itemId: string;
  /** Review rationale for why the item is faulted. */
  reason: string;
  /** Files involved in the fault. */
  files: string[];
}

/**
 * Persisted shape of `.agentforge/cycles/<cycleId>/phases/epic-review.json`.
 */
export interface EpicReviewArtifact {
  /** Phase that produced the artifact. */
  phase: 'gate';
  /** Gate mode used to produce the artifact. */
  mode: 'epic-review';
  /** Cycle id for the reviewed epic cycle. */
  cycleId: string;
  /** Review attempt number. */
  attempt: number;
  /** Structured epic review verdict. */
  verdict: EpicReviewVerdict;
  /** Human-readable review rationale. */
  rationale: string;
  /** Actionable item-specific review faults. */
  faultedItems: EpicReviewFaultedItem[];
  /** Whether the model output passed schema validation. */
  schemaValidationOk: boolean;
  /** Whether deterministic triage fallback was used. */
  triageUsed: boolean;
  /** Review phase cost, in USD. */
  costUsd: number;
  /** Review phase duration, in milliseconds. */
  durationMs: number;
  /** ISO timestamp when the review completed. */
  completedAt: string;
}

/**
 * Planned-vs-actual cost entry for one item in `spend-report.json`.
 */
export interface SpendReportPerItem {
  /** Plan item id. */
  itemId: string;
  /** Plan item title. */
  title: string;
  /** Planned item cost in USD, or `null` when the plan omitted an estimate. */
  plannedUsd: number | null;
  /** Actual item execution cost in USD. */
  actualUsd: number;
  /** Final observed item status. */
  status: string;
}

/**
 * Persisted shape of `.agentforge/cycles/<cycleId>/spend-report.json`.
 */
export interface SpendReport {
  /** Artifact schema version. */
  schemaVersion: 1;
  /** Cycle id for this spend report. */
  cycleId: string;
  /** Parent epic id when the cycle ran in objective mode. */
  epicId?: string;
  /** Objective text when available to the writer. */
  objective?: string;
  /** Configured cycle budget, in USD. */
  budgetUsd: number;
  /** Total observed cycle spend, in USD. */
  totalUsd: number;
  /** Execution phase spend, in USD. */
  executionUsd: number;
  /** Non-execution phase spend, in USD. */
  overheadUsd: number;
  /** `totalUsd / budgetUsd`, or 0 when `budgetUsd` is 0. */
  utilization: number;
  /** Per-item planned-vs-actual spend reconciliation. */
  perItem: SpendReportPerItem[];
  /** ISO timestamp when the report was generated. */
  generatedAt: string;
}
