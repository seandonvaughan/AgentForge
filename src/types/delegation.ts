/**
 * Delegation types — v4.5 P0-2
 *
 * Type definitions for the Agent-to-Agent Delegation Protocol.
 * Agents delegate work to subordinates according to the delegation
 * graph defined in team.yaml.
 */

/**
 * A request from one agent to delegate a task to another.
 */
export interface DelegationRequest {
  /** Unique ID for this delegation. */
  id: string;
  /** Agent initiating the delegation. */
  from: string;
  /** Agent receiving the delegation. */
  to: string;
  /** Task description to be executed by the delegatee. */
  task: string;
  /** Additional context passed from the delegator. */
  context: string;
  /** Constraints the delegatee must respect. */
  constraints: string[];
  /** Budget cap in USD for this delegation (0 = no limit). */
  budgetUsd: number;
  /** ISO-8601 timestamp of the request. */
  requestedAt: string;
}

/**
 * Result of a delegation execution.
 */
export interface DelegationResult {
  /** Delegation request ID. */
  delegationId: string;
  /** Whether the delegation succeeded. */
  success: boolean;
  /** Response content from the delegatee. */
  response: string;
  /** Tokens used by the delegatee. */
  tokensUsed: number;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Error message if delegation failed. */
  error?: string;
  /** ISO-8601 completion timestamp. */
  completedAt: string;
}

/**
 * Status of a delegation.
 */
export type DelegationStatus =
  | "requested"
  | "authorized"
  | "rejected"
  | "executing"
  | "completed"
  | "failed";

/**
 * A log entry recording a delegation event.
 */
export interface DelegationLogEntry {
  /** Delegation request ID. */
  delegationId: string;
  /** Delegator agent ID. */
  from: string;
  /** Delegatee agent ID. */
  to: string;
  /** Task summary (first 120 chars). */
  taskSummary: string;
  /** Final status. */
  status: DelegationStatus;
  /** Whether the delegation was authorized by the graph. */
  authorized: boolean;
  /** Reason for rejection, if applicable. */
  rejectionReason?: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Duration in milliseconds (if executed). */
  durationMs?: number;
}

/**
 * The delegation graph from team.yaml — maps agent names to their
 * authorized delegatees.
 */
export type DelegationGraph = Record<string, string[]>;
