/**
 * Workflow types — v4.5 P0-4
 *
 * Type definitions for predefined multi-agent workflow templates.
 */

import type { PipelineStage } from "./pipeline.js";

/**
 * A stage template within a workflow. Unlike a PipelineStage, the task
 * field may contain `{{parameter}}` placeholders that are resolved
 * at instantiation time.
 */
export interface WorkflowStageTemplate {
  /** Stage name. */
  name: string;
  /** Agent role to execute this stage. */
  agentId: string;
  /** Task template with optional `{{parameter}}` placeholders. */
  taskTemplate: string;
  /** Stage IDs (by name) that must complete first. */
  dependsOn: string[];
}

/**
 * A workflow template — a reusable pattern of multi-agent collaboration.
 */
export interface WorkflowTemplate {
  /** Unique workflow name (e.g., "code-review", "bug-investigation"). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Stage templates in this workflow. */
  stages: WorkflowStageTemplate[];
  /** Agent IDs required to run this workflow. */
  requiredAgents: string[];
  /** Parameter names that must be provided at instantiation. */
  parameters: string[];
}

/**
 * Parameters passed when instantiating a workflow template.
 */
export type WorkflowParameters = Record<string, string>;
