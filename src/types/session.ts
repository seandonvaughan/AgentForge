/**
 * Session type definitions for the AgentForge v3 AgentForgeSession factory.
 *
 * AutoRule connects MessageBus events to automatic actions.
 * SessionSummary captures the outcome of a completed session.
 */

/**
 * An automatic dispatch rule that fires when a matching event is published
 * on the MessageBus.
 */
export interface AutoRule {
  /** Unique identifier for this rule. */
  id: string;
  /** Event type that triggers this rule (e.g. "security_alert"). */
  onEvent: string;
  /** Optional predicate — rule only fires when this returns true. */
  condition?: string;
  /** Action identifier to dispatch (e.g. "jira:create_issue"). */
  dispatchAction: string;
  /** Agent name attributed as the actor for this action. */
  attributedTo: string;
}

/** Summary produced when an AgentForgeSession ends. */
export interface SessionSummary {
  /** Unique session identifier. */
  sessionId: string;
  /** ISO 8601 timestamp of session start. */
  startedAt: string;
  /** ISO 8601 timestamp of session end. */
  endedAt: string;
  /** Total number of agent invocations in this session. */
  totalAgentRuns: number;
  /** Total USD spent across all invocations. */
  totalSpentUsd: number;
  /** Number of decisions recorded in the DecisionLog. */
  decisionsRecorded: number;
  /** Number of knowledge entries created during this session. */
  knowledgeEntriesCreated: number;
  /** Number of reforge actions applied (local mutations). */
  reforgeActionsApplied: number;
  /** Number of events processed through the MessageBus. */
  eventsProcessed: number;
}
