/**
 * Agent type definitions for the AgentForge system.
 *
 * Defines the structure and capabilities of individual agents,
 * including their model tier, skills, triggers, and collaboration rules.
 */

import type { DomainId } from "./domain.js";

/** The Claude model tier an agent runs on. */
export type ModelTier = "opus" | "sonnet" | "haiku";

/**
 * Reasoning effort level for an agent's model invocation.
 *
 * Controls how much computation the model spends per request.
 * Higher effort = deeper reasoning but more tokens/cost.
 * Lower effort = faster, cheaper responses for mechanical tasks.
 */
export type EffortLevel = "low" | "medium" | "high" | "max";

/** Broad functional category that an agent belongs to. */
export type AgentCategory = "strategic" | "implementation" | "quality" | "utility";

/** A discrete skill that an agent can perform. */
export interface AgentSkill {
  /** Human-readable skill name. */
  name: string;
  /** Brief explanation of what the skill does. */
  description: string;
  /** Free-form category label used for grouping or filtering. */
  category: string;
}

/** Conditions that automatically activate an agent. */
export interface AgentTriggers {
  /** Glob patterns for files that should invoke this agent. */
  file_patterns: string[];
  /** Keywords in tasks or commits that should invoke this agent. */
  keywords: string[];
}

/** Rules governing how an agent interacts with other agents. */
export interface AgentCollaboration {
  /** The agent this agent reports results to, or null if top-level. */
  reports_to: string | null;
  /** Agents whose review this agent accepts before finalizing work. */
  reviews_from: string[];
  /** Agents this agent is allowed to delegate sub-tasks to. */
  can_delegate_to: string[];
  /** Whether this agent can run in parallel with its siblings. */
  parallel: boolean;
}

/** Defines the file context window available to an agent. */
export interface AgentContext {
  /** Maximum number of files the agent may hold in context at once. */
  max_files: number;
  /** Glob patterns for files that are always loaded into context. */
  auto_include: string[];
  /** Paths or patterns specific to the current project. */
  project_specific: string[];
}

/** Full template definition used to instantiate an agent. */
export interface AgentTemplate {
  /** Unique agent name used as an identifier across the system. */
  name: string;
  /** Claude model tier this agent should run on. */
  model: ModelTier;
  /** Reasoning effort level — controls cost/quality trade-off per invocation. */
  effort?: EffortLevel;
  /** Semantic version of the agent template. */
  version: string;
  /** Human-readable summary of the agent's purpose. */
  description: string;
  /** System prompt injected at the start of every conversation. */
  system_prompt: string;
  /** List of skill identifiers this agent can exercise. */
  skills: string[];
  /** Conditions that automatically activate this agent. */
  triggers: AgentTriggers;
  /** Rules for inter-agent collaboration. */
  collaboration: AgentCollaboration;
  /** File-context configuration. */
  context: AgentContext;
  /** Domain this agent belongs to. Defaults to 'software' when omitted. */
  domain?: DomainId;
  /** Functional category for routing and escalation decisions. */
  category?: AgentCategory;
  /** Non-negotiable rules this agent must always follow. */
  iron_laws?: string[];
  /** Pre- and post-execution gate checks for this agent. */
  gates?: { pre: string[]; post: string[] };
  /** Event types this agent subscribes to for broadcast notifications. */
  subscriptions?: string[];
  /** Per-invocation and per-session cost limits for this agent. */
  budget?: {
    /** Maximum cost in USD for a single invocation. */
    maxCostPerInvocationUsd: number;
    /** Maximum total cost in USD for an entire session. */
    maxCostPerSessionUsd: number;
  };
  /**
   * Confidence score (0–1) below which the agent should escalate to a
   * higher-tier model. Populated by CostAwareRunner escalation logic.
   */
  confidenceEscalationThreshold?: number;
}
