/**
 * Team type definitions for the AgentForge system.
 *
 * Describes how agents are organized into a team, how work is
 * routed across model tiers, and the delegation relationships
 * between agents.
 */

import type { DomainId } from "./domain.js";
import type { CollaborationTemplate } from "./collaboration.js";
import type { ProjectBrief } from "./analysis.js";
import type {
  TeamUnit,
  TechnicalLayer,
  AgentIdentity,
  SeniorityLevel,
  AgentRole,
} from "./lifecycle.js";

// Re-export lifecycle team types for convenience
export type {
  TeamUnit,
  TechnicalLayer,
  AgentIdentity,
  SeniorityLevel,
  AgentRole,
};

/** Agent names grouped by their functional category within a team. */
export interface TeamAgents {
  /** Agents responsible for high-level planning and decision-making. */
  strategic: string[];
  /** Agents that carry out code changes and feature work. */
  implementation: string[];
  /** Agents focused on testing, review, and correctness. */
  quality: string[];
  /** Agents providing support services (docs, CI, refactoring, etc.). */
  utility: string[];
  /** Custom agent categories added by domain packs. */
  [category: string]: string[];
}

/** Maps each model tier to the agent names that run on it. */
export interface ModelRouting {
  /** Agents routed to the Opus (highest capability) tier. */
  opus: string[];
  /** Agents routed to the Sonnet (balanced) tier. */
  sonnet: string[];
  /** Agents routed to the Haiku (fastest / cheapest) tier. */
  haiku: string[];
}

/**
 * A directed graph of delegation relationships.
 *
 * Each key is an agent name; its value is the list of agents it may delegate to.
 */
export type DelegationGraph = Record<string, string[]>;

/** Snapshot manifest produced when a team is forged for a project. */
export interface TeamManifest {
  /** Display name of the team. */
  name: string;
  /** ISO-8601 timestamp of when the team was created. */
  forged_at: string;
  /** Identifier of the user or process that created the team. */
  forged_by: string;
  /** Hash of the project state at forge time, used for cache invalidation. */
  project_hash: string;
  /** Agents organized by category. */
  agents: TeamAgents;
  /** Agent-to-model-tier routing table. */
  model_routing: ModelRouting;
  /** Directed graph describing which agents can delegate to which. */
  delegation_graph: DelegationGraph;
  /** Universal project brief used to compose this team. */
  project_brief?: ProjectBrief;
  /** Domain packs that were activated for this team. */
  domains?: DomainId[];
  /** Collaboration template governing team topology and delegation. */
  collaboration?: CollaborationTemplate;
  /** Team units organized by technical layer (v6.1 Agent Identity Hub). */
  team_units?: TeamUnit[];
}
