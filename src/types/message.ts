/**
 * Agent collaboration message type definitions for the AgentForge system.
 *
 * Defines the protocol agents use to communicate: delegating tasks,
 * returning responses, broadcasting updates, and requesting reviews.
 */

/** The kind of inter-agent message being sent. */
export type MessageType = "delegate" | "response" | "broadcast" | "review";

/** Urgency level attached to a message. */
export type MessagePriority = "urgent" | "high" | "normal" | "low";

/** Ambient context carried alongside a message. */
export interface MessageContext {
  /** Identifier of the parent task this message relates to, if any. */
  parent_task: string | null;
  /** File paths that the receiving agent should consider in scope. */
  files_in_scope: string[];
  /** ISO-8601 deadline by which the task should be completed, if any. */
  deadline: string | null;
}

/** A single message exchanged between agents. */
export interface AgentMessage {
  /** Unique identifier for this message. */
  id: string;
  /** Name of the sending agent. */
  from: string;
  /** Name of the receiving agent. */
  to: string;
  /** Classification of this message. */
  type: MessageType;
  /** Description of the work to be performed or the result being returned. */
  task: string;
  /** How urgent this message is. */
  priority: MessagePriority;
  /** Additional context for the receiving agent. */
  context: MessageContext;
  /** How the response should be formatted. */
  response_format: "summary" | "full" | "structured";
}
