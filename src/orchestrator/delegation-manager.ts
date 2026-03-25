/**
 * Delegation Manager for the AgentForge Orchestrator.
 *
 * Manages agent-to-agent delegation: validates delegation paths,
 * creates delegation requests, and tracks delegation results.
 */

import { randomUUID } from "node:crypto";
import type { MessageContext, MessagePriority } from "../types/message.js";
import type { DelegationGraph } from "../types/team.js";

/** A request from one agent to delegate work to another. */
export interface DelegationRequest {
  /** Unique identifier for this delegation. */
  id: string;
  /** Agent initiating the delegation. */
  from: string;
  /** Agent receiving the delegated task. */
  to: string;
  /** Description of the work to delegate. */
  task: string;
  /** Contextual information for the receiving agent. */
  context: MessageContext;
  /** Urgency of the delegation. */
  priority: MessagePriority;
  /** Whether task ownership transfers to the delegate. */
  ownership_transfer: boolean;
}

/** The outcome of a completed delegation. */
export interface DelegationResult {
  /** The original delegation request. */
  request: DelegationRequest;
  /** Whether the delegation completed, failed, or timed out. */
  status: "completed" | "failed" | "timeout";
  /** Result payload, or null if the delegation did not succeed. */
  result: string | null;
  /** Wall-clock duration in milliseconds. */
  duration_ms: number;
  /** Total tokens consumed by the delegated work. */
  tokens_used: number;
}

/**
 * Manages delegation between agents according to a directed delegation graph.
 */
export class DelegationManager {
  private readonly graph: DelegationGraph;

  constructor(delegationGraph: DelegationGraph) {
    this.graph = delegationGraph;
  }

  /**
   * Checks whether a direct delegation path exists from one agent to another.
   */
  canDelegate(from: string, to: string): boolean {
    const delegates = this.graph[from];
    if (!delegates) return false;
    return delegates.includes(to);
  }

  /**
   * Creates a new delegation request with a unique ID and default context.
   */
  createDelegation(
    from: string,
    to: string,
    task: string,
    priority: MessagePriority = "normal",
  ): DelegationRequest {
    return {
      id: randomUUID(),
      from,
      to,
      task,
      context: {
        parent_task: null,
        files_in_scope: [],
        deadline: null,
      },
      priority,
      ownership_transfer: false,
    };
  }

  /**
   * Delegates a complete task to a coworker, transferring ownership.
   *
   * The delegate owns the outcome. Inspired by CrewAI's `delegate_work`.
   */
  delegateWork(
    from: string,
    to: string,
    task: string,
    context?: string,
    responseFormat?: "summary" | "full" | "structured",
  ): DelegationRequest {
    return {
      id: randomUUID(),
      from,
      to,
      task,
      context: {
        parent_task: context ?? null,
        files_in_scope: [],
        deadline: null,
      },
      priority: "normal",
      ownership_transfer: true,
    };
  }

  /**
   * Asks a coworker a question without delegating the full task.
   *
   * The asker retains ownership. Inspired by CrewAI's `ask_coworker`.
   */
  askCoworker(
    from: string,
    to: string,
    question: string,
    context?: string,
  ): DelegationRequest {
    return {
      id: randomUUID(),
      from,
      to,
      task: question,
      context: {
        parent_task: context ?? null,
        files_in_scope: [],
        deadline: null,
      },
      priority: "normal",
      ownership_transfer: false,
    };
  }

  /**
   * Validates a delegation request against the delegation graph.
   *
   * Checks that:
   *   1. The source agent exists in the graph.
   *   2. The delegation path from source to target is permitted.
   *   3. An agent is not delegating to itself.
   */
  validateDelegation(
    request: DelegationRequest,
  ): { valid: boolean; reason?: string } {
    if (request.from === request.to) {
      return { valid: false, reason: "An agent cannot delegate to itself" };
    }

    if (!(request.from in this.graph)) {
      return {
        valid: false,
        reason: `Agent "${request.from}" is not present in the delegation graph`,
      };
    }

    if (!this.canDelegate(request.from, request.to)) {
      return {
        valid: false,
        reason: `Agent "${request.from}" is not permitted to delegate to "${request.to}"`,
      };
    }

    return { valid: true };
  }

  /**
   * Returns the list of agents that the given agent is allowed to delegate to.
   */
  getAvailableDelegates(agentName: string): string[] {
    return this.graph[agentName] ?? [];
  }
}
