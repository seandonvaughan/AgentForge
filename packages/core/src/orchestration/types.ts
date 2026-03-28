export type StepType = 'agent' | 'parallel' | 'sequential' | 'conditional';

export interface AgentStep {
  type: 'agent';
  id: string;
  agentId: string;
  task: string;
  model?: 'opus' | 'sonnet' | 'haiku';
  /** If true, failure does not halt the workflow. Default false. */
  optional?: boolean;
}

export interface ParallelStep {
  type: 'parallel';
  id: string;
  steps: WorkflowStep[];
  /** Max concurrent executions. Default: all at once. */
  concurrency?: number;
}

export interface SequentialStep {
  type: 'sequential';
  id: string;
  steps: WorkflowStep[];
}

export interface ConditionalStep {
  type: 'conditional';
  id: string;
  condition: string; // e.g. "context.errorRate < 0.2"
  ifTrue: WorkflowStep;
  ifFalse?: WorkflowStep;
}

export type WorkflowStep = AgentStep | ParallelStep | SequentialStep | ConditionalStep;

export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  budgetUsd?: number;
  steps: WorkflowStep[];
}

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface StepResult {
  stepId: string;
  agentId?: string;
  status: StepStatus;
  output?: string;
  costUsd: number;
  durationMs: number;
  error?: string;
  children?: StepResult[];
}

export interface WorkflowResult {
  workflowId: string;
  definitionId: string;
  status: 'completed' | 'failed' | 'budget_exceeded';
  steps: StepResult[];
  totalCostUsd: number;
  totalDurationMs: number;
  startedAt: string;
  completedAt: string;
}

export interface WorkflowContext {
  workflowId: string;
  variables: Record<string, unknown>;
  totalCostUsd: number;
  budgetUsd: number;
}
