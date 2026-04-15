/**
 * Reforge type definitions for the AgentForge v3 intelligence wiring layer.
 *
 * ReforgeEngine uses these types to represent planned mutations to agent
 * configurations, execution results, and per-agent runtime overrides.
 */

import type { ModelTier, EffortLevel } from "../../team/engine/types/agent.js";

/**
 * Classification of a reforge plan.
 *
 * - `local`      — mutations applied immediately as AgentOverride files
 * - `structural` — topology-level changes written as proposal docs for human review
 */
export type ReforgeClass = "local" | "structural";

/**
 * A single mutation to be applied to an agent's configuration.
 */
export interface AgentMutation {
  /** The kind of mutation being applied. */
  type:
    | "system-prompt-preamble"
    | "model-tier-override"
    | "effort-override"
    | "add-skill"
    | "remove-skill";
  /** The agent being mutated. */
  agentName: string;
  /** The field being changed (e.g. "model", "effort", "system_prompt"). */
  field: string;
  /** Previous value for rollback support. */
  oldValue: unknown;
  /** New value to apply. */
  newValue: unknown;
  /** Human-readable explanation of why this mutation was proposed. */
  rationale: string;
}

/**
 * A complete plan for a single reforge operation.
 *
 * Produced by `ReforgeEngine.buildPlan` from a `FeedbackAnalysis`.
 * Not yet applied — call `ReforgeEngine.executePlan` to apply it.
 */
export interface ReforgePlan {
  /** UUID for this plan. */
  id: string;
  /** ISO 8601 timestamp of when the plan was built. */
  timestamp: string;
  /** Whether this plan applies local overrides or proposes structural change. */
  reforgeClass: ReforgeClass;
  /** What triggered this plan — a feedback theme label or "[REFORGE REQUESTED]". */
  triggeredBy: string;
  /** Ordered list of mutations to apply. */
  mutations: AgentMutation[];
  /** High-level rationale for the entire plan. */
  rationale: string;
  /** Narrative description of the expected outcome. */
  estimatedImpact: string;
}

/**
 * The result of executing a `ReforgePlan`.
 *
 * Returned by `ReforgeEngine.executePlan`.
 */
export interface ReforgeResult {
  /** The plan that was executed. */
  plan: ReforgePlan;
  /** Whether any mutations were successfully applied. */
  applied: boolean;
  /** Mutations that were successfully applied. */
  appliedMutations: AgentMutation[];
  /** Mutations that were skipped (e.g. structural mutations queued as proposals). */
  skippedMutations: AgentMutation[];
  /** Version number of the resulting override (starts at 1, capped at 5). */
  version: number;
  /** Whether a previous version exists to roll back to. */
  rollbackAvailable: boolean;
}

/**
 * A runtime override applied on top of an agent's base template.
 *
 * Stored as JSON in `.agentforge/agent-overrides/{agent-name}.json`.
 * Supports up to 5 versions (Iron Law 4) via linked `previousVersion`.
 */
export interface AgentOverride {
  /** The agent this override targets. */
  agentName: string;
  /** Monotonically increasing version number for this agent (1-based). */
  version: number;
  /** ISO 8601 timestamp when this override was applied. */
  appliedAt: string;
  /** Session or plan ID that produced this override. */
  sessionId: string;
  /** Mutations that are captured in this override. */
  mutations: AgentMutation[];
  /** Text to prepend to the agent's system_prompt. */
  systemPromptPreamble?: string;
  /** Model tier to use instead of the template's default. */
  modelTierOverride?: ModelTier;
  /** Effort level to use instead of the template's default. */
  effortOverride?: EffortLevel;
  /** The previous override version, enabling rollback. */
  previousVersion?: AgentOverride;
}
