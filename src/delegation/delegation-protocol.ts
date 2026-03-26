/**
 * DelegationProtocol — v4.5 P0-2
 *
 * Runtime delegation protocol that validates agent-to-agent task delegation
 * against the delegation graph in team.yaml. Tracks all delegation events
 * and emits bus messages for observability.
 *
 * Zero new npm dependencies (Iron Law 5).
 */

import { randomUUID } from "node:crypto";
import type {
  DelegationRequest,
  DelegationResult,
  DelegationLogEntry,
  DelegationGraph,
  DelegationStatus,
} from "../types/delegation.js";
import type { V4MessageBus } from "../communication/v4-message-bus.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Executor function for delegated tasks. Implementations should dispatch
 * to the target agent and return the result.
 */
export type DelegationExecutor = (
  request: DelegationRequest,
) => Promise<{ response: string; tokensUsed: number; durationMs: number }>;

export interface DelegationProtocolOptions {
  /** The delegation authority graph from team.yaml. */
  delegationGraph: DelegationGraph;
  /** Set of all known agent IDs. */
  knownAgents: Set<string>;
  /** Message bus for event emission. */
  bus?: V4MessageBus;
  /** Custom executor. Defaults to a stub for testing. */
  executor?: DelegationExecutor;
}

// ---------------------------------------------------------------------------
// Default executor (for testing)
// ---------------------------------------------------------------------------

const defaultExecutor: DelegationExecutor = async (request) => {
  return {
    response: `[${request.to}] completed delegation from ${request.from}: ${request.task}`,
    tokensUsed: 0,
    durationMs: 0,
  };
};

// ---------------------------------------------------------------------------
// DelegationProtocol
// ---------------------------------------------------------------------------

export class DelegationProtocol {
  private readonly graph: DelegationGraph;
  private readonly knownAgents: Set<string>;
  private readonly bus?: V4MessageBus;
  private readonly executor: DelegationExecutor;
  private readonly log: DelegationLogEntry[] = [];

  constructor(options: DelegationProtocolOptions) {
    this.graph = options.delegationGraph;
    this.knownAgents = options.knownAgents;
    this.bus = options.bus;
    this.executor = options.executor ?? defaultExecutor;
  }

  // =========================================================================
  // Delegation
  // =========================================================================

  /**
   * Request a delegation from one agent to another.
   *
   * Validates:
   * 1. Both agents exist in the known agent set
   * 2. The delegator has authority to delegate to the delegatee
   * 3. An agent cannot delegate to itself
   *
   * If validation passes, executes the delegation and records the result.
   */
  async delegate(
    from: string,
    to: string,
    task: string,
    options?: {
      context?: string;
      constraints?: string[];
      budgetUsd?: number;
    },
  ): Promise<DelegationResult> {
    const request: DelegationRequest = {
      id: randomUUID(),
      from,
      to,
      task,
      context: options?.context ?? "",
      constraints: options?.constraints ?? [],
      budgetUsd: options?.budgetUsd ?? 0,
      requestedAt: new Date().toISOString(),
    };

    // Validate agents exist
    if (!this.knownAgents.has(from)) {
      return this.rejectDelegation(
        request,
        `Delegator agent "${from}" not found in team`,
      );
    }
    if (!this.knownAgents.has(to)) {
      return this.rejectDelegation(
        request,
        `Delegatee agent "${to}" not found in team`,
      );
    }

    // Validate no self-delegation
    if (from === to) {
      return this.rejectDelegation(
        request,
        `Agent "${from}" cannot delegate to itself`,
      );
    }

    // Validate delegation authority
    if (!this.isAuthorized(from, to)) {
      return this.rejectDelegation(
        request,
        `Agent "${from}" is not authorized to delegate to "${to}" — not in delegation graph`,
      );
    }

    // Emit delegation requested event
    this.emitEvent("delegation.requested", {
      delegationId: request.id,
      from,
      to,
      task: task.slice(0, 120),
    });

    // Execute the delegation
    const startTime = Date.now();
    try {
      const outcome = await this.executor(request);

      const result: DelegationResult = {
        delegationId: request.id,
        success: true,
        response: outcome.response,
        tokensUsed: outcome.tokensUsed,
        durationMs: outcome.durationMs,
        completedAt: new Date().toISOString(),
      };

      this.recordLog(request, "completed", true);

      this.emitEvent("delegation.completed", {
        delegationId: request.id,
        from,
        to,
        success: true,
        durationMs: outcome.durationMs,
      });

      return result;
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startTime;

      const result: DelegationResult = {
        delegationId: request.id,
        success: false,
        response: "",
        tokensUsed: 0,
        durationMs,
        error: errorMessage,
        completedAt: new Date().toISOString(),
      };

      this.recordLog(request, "failed", true);

      this.emitEvent("delegation.completed", {
        delegationId: request.id,
        from,
        to,
        success: false,
        error: errorMessage,
      });

      return result;
    }
  }

  // =========================================================================
  // Authorization
  // =========================================================================

  /**
   * Check whether `from` is authorized to delegate to `to`.
   * Checks direct authorization only (no transitive delegation).
   */
  isAuthorized(from: string, to: string): boolean {
    const authorized = this.graph[from];
    if (!authorized) return false;
    return authorized.includes(to);
  }

  /**
   * Check whether `from` can reach `to` through a chain of delegations.
   * Useful for validating transitive delegation paths.
   */
  canReachTransitively(from: string, to: string): boolean {
    const visited = new Set<string>();
    const queue = [from];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === to) return true;
      if (visited.has(current)) continue;
      visited.add(current);

      const delegates = this.graph[current] ?? [];
      for (const d of delegates) {
        if (!visited.has(d)) {
          queue.push(d);
        }
      }
    }

    return false;
  }

  // =========================================================================
  // Query
  // =========================================================================

  /** Get the delegation log. */
  getLog(): DelegationLogEntry[] {
    return this.log.map((e) => ({ ...e }));
  }

  /** Get delegations from a specific agent. */
  getDelegationsFrom(agentId: string): DelegationLogEntry[] {
    return this.log
      .filter((e) => e.from === agentId)
      .map((e) => ({ ...e }));
  }

  /** Get delegations to a specific agent. */
  getDelegationsTo(agentId: string): DelegationLogEntry[] {
    return this.log
      .filter((e) => e.to === agentId)
      .map((e) => ({ ...e }));
  }

  /** Get the delegation graph. */
  getGraph(): DelegationGraph {
    const copy: DelegationGraph = {};
    for (const [key, val] of Object.entries(this.graph)) {
      copy[key] = [...val];
    }
    return copy;
  }

  // =========================================================================
  // Private
  // =========================================================================

  private rejectDelegation(
    request: DelegationRequest,
    reason: string,
  ): DelegationResult {
    this.recordLog(request, "rejected", false, reason);

    this.emitEvent("delegation.rejected", {
      delegationId: request.id,
      from: request.from,
      to: request.to,
      reason,
    });

    return {
      delegationId: request.id,
      success: false,
      response: "",
      tokensUsed: 0,
      durationMs: 0,
      error: reason,
      completedAt: new Date().toISOString(),
    };
  }

  private recordLog(
    request: DelegationRequest,
    status: DelegationStatus,
    authorized: boolean,
    rejectionReason?: string,
  ): void {
    this.log.push({
      delegationId: request.id,
      from: request.from,
      to: request.to,
      taskSummary: request.task.slice(0, 120),
      status,
      authorized,
      rejectionReason,
      timestamp: new Date().toISOString(),
    });
  }

  private emitEvent(topic: string, payload: Record<string, unknown>): void {
    if (!this.bus) return;
    this.bus.publish({
      from: "delegation-protocol",
      to: "broadcast",
      topic,
      category: "task",
      payload,
      priority: "normal",
    });
  }
}
