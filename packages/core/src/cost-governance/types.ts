export interface BudgetConfig {
  dailyLimitUsd: number;         // Hard daily ceiling — KillSwitch fires if exceeded
  sprintLimitUsd: number;        // Per-sprint ceiling
  agentLimitUsd: number;         // Per individual agent call ceiling
  workflowLimitUsd: number;      // Per workflow run ceiling
  /** Alert when spend rate exceeds this multiplier of expected. Default: 3 */
  anomalyMultiplier: number;
}

export const DEFAULT_BUDGET: BudgetConfig = {
  dailyLimitUsd: 50.00,
  sprintLimitUsd: 10.00,
  agentLimitUsd: 1.00,
  workflowLimitUsd: 5.00,
  anomalyMultiplier: 3,
};

export type ModelTier = 'opus' | 'sonnet' | 'haiku';

export type TaskComplexity = 'trivial' | 'simple' | 'moderate' | 'complex' | 'strategic';

export interface BudgetStatus {
  dailySpend: number;
  dailyLimit: number;
  dailyRemaining: number;
  sprintSpend: number;
  sprintLimit: number;
  sprintRemaining: number;
  killed: boolean;
  alertFired: boolean;
}
