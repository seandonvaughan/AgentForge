export interface BacklogItem {
  id: string;
  title: string;
  description: string;
  priority: 'P0' | 'P1' | 'P2';
  estimatedComplexity: 'low' | 'medium' | 'high';
  tags: string[];
  source?: string; // which sprint/proposal generated this
}

export interface SprintPlan {
  version: string;        // e.g. "5.5"
  name: string;
  items: SprintPlanItem[];
  plannedAt: string;
  budgetUsd: number;
  source: 'autonomous' | 'human';
}

export interface SprintPlanItem {
  id: string;
  priority: 'P0' | 'P1' | 'P2';
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

export interface SprintRunResult {
  sprintVersion: string;
  itemsAttempted: number;
  itemsCompleted: number;
  itemsFailed: number;
  totalCostUsd: number;
  durationMs: number;
  completedAt: string;
}

export interface SprintEvaluation {
  sprintVersion: string;
  passed: boolean;
  testCountBefore: number;
  testCountAfter: number;
  testCountDelta: number;
  failuresBefore: number;
  failuresAfter: number;
  regression: boolean;
  costUsd: number;
  verdict: 'ship' | 'revert' | 'retry';
  notes: string;
}

export interface SprintItemExecutionRequest {
  plan: SprintPlan;
  item: SprintPlanItem;
  budgetRemainingUsd: number;
}

export interface SprintItemExecutionResult {
  success: boolean;
  costUsd: number;
  output?: string;
  error?: string;
}

export interface SprintItemExecutor {
  executeSprintItem(request: SprintItemExecutionRequest): Promise<SprintItemExecutionResult>;
}

export interface SprintLoopOptions {
  /** If true, no real agent calls or test runs — simulate everything. Default: true */
  dryRun?: boolean;
  /** Per-sprint budget ceiling in USD. Default: 5.00 */
  sprintBudgetUsd?: number;
  /** If true, approve all proposals that pass evaluation without human input. Default: false */
  autoApprove?: boolean;
  /** Minimum confidence score to auto-approve a proposal. Default: 0.7 */
  autoApproveThreshold?: number;
  /** Minimum test pass rate to ship. Default: 1.0 (zero failures) */
  testPassRateFloor?: number;
  /** Required when dryRun is false. */
  executor?: SprintItemExecutor;
}
