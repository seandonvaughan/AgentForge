/**
 * Agent type definitions for the AgentForge system.
 *
 * Defines the structure and capabilities of individual agents,
 * including their model tier, skills, triggers, and collaboration rules.
 */

import type { DomainId } from "./domain.js";

/** The Claude model tier an agent runs on. */
export type ModelTier = "opus" | "sonnet" | "haiku";

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
  /** Non-negotiable rules this agent must always follow. */
  iron_laws?: string[];
  /** Pre- and post-execution gate checks for this agent. */
  gates?: { pre: string[]; post: string[] };
  /** Event types this agent subscribes to for broadcast notifications. */
  subscriptions?: string[];
}
