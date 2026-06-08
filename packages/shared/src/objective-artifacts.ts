/**
 * Shared objective-artifact response types for AgentForge.
 *
 * These types establish the contract between the server routes (child-2..7)
 * and the dashboard components (child-12..17) for the objective-mode pipeline.
 * Colocating them here prevents type drift across the two package boundaries.
 *
 * All optional fields use the `T | undefined` pattern required by
 * `exactOptionalPropertyTypes`.
 *
 * Zero runtime dependencies — pure type exports.
 */

// ── WorkItemStatus ─────────────────────────────────────────────────────────

/**
 * Lifecycle status of a single work item inside a decomposition wave.
 */
export type WorkItemStatus =
  | 'pending'
  | 'in-progress'
  | 'completed'
  | 'failed'
  | 'skipped';

// ── WorkItemChild ──────────────────────────────────────────────────────────

/**
 * A single work item (child) within a decomposition wave.
 */
export interface WorkItemChild {
  /** Stable identifier for the work item. */
  id: string;
  /** Human-readable title describing the work item. */
  title: string;
  /** Source files primarily affected by this work item. */
  files: string[];
  /** Budget estimate for this item in USD. */
  estimatedCostUsd: number;
  /** Current execution status. */
  status: WorkItemStatus;
}

// ── DecompositionArtifact ──────────────────────────────────────────────────

/**
 * One wave of a multi-wave epic decomposition.
 *
 * The full decomposition is represented as `DecompositionArtifact[]` where
 * each element corresponds to a sequential execution wave.  Consumers can
 * process waves in order, respecting inter-wave dependencies.
 *
 * @example
 * ```ts
 * const wave: DecompositionArtifact = {
 *   waveIndex: 0,
 *   children: [
 *     { id: 'w1-a', title: 'Bootstrap schema', files: ['db/schema.sql'], estimatedCostUsd: 2.5, status: 'pending' },
 *   ],
 * };
 * ```
 */
export interface DecompositionArtifact {
  /** Zero-based index of this wave in the full decomposition sequence. */
  waveIndex: number;
  /** Work items assigned to this wave. */
  children: WorkItemChild[];
}

// ── EpicReviewVerdict ──────────────────────────────────────────────────────

/**
 * High-level verdict produced by the epic review gate.
 *
 * - `pass` — all items met their acceptance criteria.
 * - `fail` — one or more items had blocking defects.
 * - `partial` — some items passed, but non-blocking issues were noted.
 */
export type EpicReviewVerdict = 'pass' | 'fail' | 'partial';

// ── EpicReviewArtifact ─────────────────────────────────────────────────────

/**
 * Review gate output for a completed objective run.
 *
 * Produced by the review phase and consumed by the gate phase to decide
 * whether to release the work or require a re-run.
 *
 * @example
 * ```ts
 * const review: EpicReviewArtifact = {
 *   verdict: 'partial',
 *   rationale: 'Two items merged successfully; one item missed edge-case test.',
 *   faultedItems: ['w2-c'],
 * };
 * ```
 */
export interface EpicReviewArtifact {
  /** Overall quality verdict for the run. */
  verdict: EpicReviewVerdict;
  /** Human-readable explanation of the verdict and any defects found. */
  rationale: string;
  /** IDs of work items that contributed to a `fail` or `partial` verdict. */
  faultedItems: string[];
}

// ── SpendReportItem ────────────────────────────────────────────────────────

/**
 * Per-item cost comparison between the pre-run budget estimate and the
 * actual spend observed during execution.
 */
export interface SpendReportItem {
  /** Work item identifier (matches `WorkItemChild.id`). */
  id: string;
  /** Budget estimate for this item before execution, in USD. */
  plannedUsd: number;
  /** Actual spend recorded for this item during execution, in USD. */
  actualUsd: number;
}

// ── SpendReportTotals ──────────────────────────────────────────────────────

/**
 * Aggregate cost breakdown for a completed objective run.
 */
export interface SpendReportTotals {
  /** Total USD spent on direct work-item execution (sum of `actualUsd` across all items). */
  executionUsd: number;
  /** Total USD spent on orchestration overhead (planning, review, gate phases). */
  overheadUsd: number;
  /**
   * Budget utilization as a percentage (0–100).
   * Computed as `(executionUsd + overheadUsd) / budgetUsd * 100`.
   */
  utilizationPct: number;
}

// ── SpendReportArtifact ────────────────────────────────────────────────────

/**
 * Cost accounting artifact produced at the end of an objective run.
 *
 * Exposes per-item planned-vs-actual deltas alongside rolled-up totals so
 * that operators can understand where budget was consumed.
 *
 * @example
 * ```ts
 * const report: SpendReportArtifact = {
 *   perItem: [
 *     { id: 'w1-a', plannedUsd: 2.5, actualUsd: 2.1 },
 *     { id: 'w2-b', plannedUsd: 1.0, actualUsd: 1.3 },
 *   ],
 *   totals: { executionUsd: 3.4, overheadUsd: 0.6, utilizationPct: 80 },
 * };
 * ```
 */
export interface SpendReportArtifact {
  /** Per-item breakdown comparing estimated vs actual spend. */
  perItem: SpendReportItem[];
  /** Rolled-up totals for the full run. */
  totals: SpendReportTotals;
}

// ── PostObjectiveBody ──────────────────────────────────────────────────────

/**
 * Request body for `POST /api/v5/objective` (and v6 shim).
 *
 * Both fields are optional so callers can supply only what they know —
 * missing values fall back to workspace defaults.
 *
 * @example
 * ```ts
 * const body: PostObjectiveBody = { objective: 'Improve test coverage to 90%', budgetUsd: 50 };
 * ```
 */
export interface PostObjectiveBody {
  /**
   * Natural-language description of the engineering objective.
   * When omitted the server falls back to the workspace's default objective.
   */
  objective?: string | undefined;
  /**
   * Budget cap for this run in USD.
   * When omitted the server uses the workspace-level `perCycleUsd` setting.
   */
  budgetUsd?: number | undefined;
}
