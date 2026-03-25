/**
 * Knowledge store type definitions for the AgentForge v3 structured communication layer.
 *
 * KnowledgeStore provides multi-scope persistence for agent-produced knowledge
 * that outlives a single invocation. Session scope is ephemeral; project and
 * entity scopes are persisted to `.agentforge/knowledge/`.
 */

/** Scope that determines lifetime and storage location of a knowledge entry. */
export type KnowledgeScope = "session" | "project" | "entity";

/**
 * A single knowledge entry stored by an agent.
 *
 * Keys are namespaced strings (e.g. "cost-tracker-dev:budget-trends") to
 * avoid collisions across agents sharing the same scope.
 */
export interface KnowledgeEntry {
  /** Unique identifier for this entry. */
  id: string;
  /** Scope that governs this entry's lifetime. */
  scope: KnowledgeScope;
  /** Namespaced key for retrieval (e.g. "agent-name:topic"). */
  key: string;
  /** Arbitrary JSON-serializable data. */
  value: unknown;
  /** Name of the agent that created this entry. */
  createdBy: string;
  /** ISO 8601 timestamp of creation. */
  createdAt: string;
  /** ISO 8601 timestamp of last update. */
  updatedAt: string;
  /** Optional tags for filtered retrieval. */
  tags?: string[];
}
