import type { AgentProposal } from '@agentforge/core';

export type ExecutionStage = 'planning' | 'architecture' | 'coding' | 'linting' | 'testing' | 'complete' | 'failed';

export interface ExecutionPlan {
  proposalId: string;
  stages: ExecutionStage[];
  estimatedAgents: string[];
  estimatedComplexity: 'low' | 'medium' | 'high';
  sandboxed: boolean;
  createdAt: string;
}

export interface StageResult {
  stage: ExecutionStage;
  agentId: string;
  output: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface ExecutionResult {
  executionId: string;
  proposalId: string;
  proposal: AgentProposal;
  plan: ExecutionPlan;
  stages: StageResult[];
  status: 'pending' | 'running' | 'passed' | 'failed' | 'rejected';
  diff?: string;
  testSummary?: { passed: number; failed: number; total: number };
  totalCostUsd?: number;
  totalDurationMs: number;
  startedAt: string;
  completedAt?: string;
}

export interface StageExecutionRequest {
  executionId: string;
  proposal: AgentProposal;
  plan: ExecutionPlan;
  stage: ExecutionStage;
  agentId: string;
  stageIndex: number;
  timeoutMs: number;
  budgetRemainingUsd: number;
}

export interface StageExecutionResponse {
  output: string;
  success: boolean;
  durationMs?: number;
  error?: string;
  diff?: string;
  testSummary?: { passed: number; failed: number; total: number };
  costUsd?: number;
}

export interface ProposalRuntimeExecutor {
  executeStage(request: StageExecutionRequest): Promise<StageExecutionResponse>;
}

export interface ExecutorOptions {
  /** If true, run in dry-run mode — no actual agent invocations, produce simulated results. Default: true */
  dryRun?: boolean;
  /** Max time in ms for a single stage. Default: 30000 */
  stageTimeoutMs?: number;
  /** Budget cap in USD across the entire execution. Default: 1.00 */
  budgetUsd?: number;
  /** Required when dryRun is false. */
  runtime?: ProposalRuntimeExecutor;
}
