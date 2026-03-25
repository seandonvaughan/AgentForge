/**
 * Decision log type definitions for the AgentForge v3 structured communication layer.
 *
 * DecisionLog provides an append-only audit trail of decisions made during
 * agent execution. Entries link to external artifacts and persist to
 * `.agentforge/decisions/`.
 */

/** Classification of a decision for filtering and analysis. */
export type DecisionType =
  | "routing"
  | "delegation"
  | "reforge"
  | "escalation"
  | "budget"
  | "review";

/** A single recorded decision with full context for audit and learning. */
export interface DecisionEntry {
  /** Unique identifier for this decision. */
  id: string;
  /** What kind of decision was made. */
  type: DecisionType;
  /** ISO 8601 timestamp of when the decision was recorded. */
  timestamp: string;
  /** Agent that made the decision. */
  agent: string;
  /** What was decided. */
  description: string;
  /** Options that were considered but rejected. */
  alternatives: string[];
  /** Why this option was chosen over alternatives. */
  rationale: string;
  /** Links to files, overrides, or other artifacts related to this decision. */
  artifacts: { type: string; location: string }[];
  /** Confidence in the decision (0-1). */
  confidence: number;
  /** Session that produced this decision, if applicable. */
  sessionId?: string;
}
