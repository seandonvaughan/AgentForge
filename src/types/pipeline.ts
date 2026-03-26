/**
 * Pipeline types — v4.5 P0-1
 *
 * Type definitions for the Task Pipeline Engine that enables
 * multi-agent, multi-stage task execution with DAG dependencies.
 */

/** Status of a pipeline stage. */
export type PipelineStageStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

/** Overall status of a pipeline. */
export type PipelineStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "partial";

/**
 * A single stage in a task pipeline.
 * Each stage is assigned to an agent and may depend on prior stages.
 */
export interface PipelineStage {
  /** Unique identifier for this stage within the pipeline. */
  id: string;
  /** Human-readable name of the stage. */
  name: string;
  /** Agent ID to execute this stage (must exist in team.yaml). */
  agentId: string;
  /** Task template — may contain `{{stageId}}` placeholders for upstream results. */
  task: string;
  /** IDs of stages that must complete before this one can start. */
  dependsOn: string[];
  /** Current execution status. */
  status: PipelineStageStatus;
  /** Result content from the agent, set after completion. */
  result?: string;
  /** Error message if the stage failed. */
  error?: string;
  /** Duration in milliseconds. */
  durationMs?: number;
  /** ISO-8601 start timestamp. */
  startedAt?: string;
  /** ISO-8601 completion timestamp. */
  completedAt?: string;
}

/**
 * A task pipeline definition — a DAG of stages to execute.
 */
export interface PipelineDefinition {
  /** Unique identifier for this pipeline. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Description of what this pipeline accomplishes. */
  description: string;
  /** Ordered list of stages (order is for display; execution follows dependsOn). */
  stages: PipelineStage[];
  /** Overall pipeline status. */
  status: PipelineStatus;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 completion timestamp. */
  completedAt?: string;
  /** Total duration in milliseconds. */
  totalDurationMs?: number;
}

/**
 * Result of executing a complete pipeline.
 */
export interface PipelineResult {
  /** Pipeline ID. */
  pipelineId: string;
  /** Final status. */
  status: PipelineStatus;
  /** Per-stage results. */
  stageResults: Array<{
    stageId: string;
    stageName: string;
    agentId: string;
    status: PipelineStageStatus;
    result?: string;
    error?: string;
    durationMs?: number;
  }>;
  /** Count of completed stages. */
  completedStages: number;
  /** Count of failed stages. */
  failedStages: number;
  /** Total stages. */
  totalStages: number;
  /** Total duration in milliseconds. */
  totalDurationMs: number;
}
