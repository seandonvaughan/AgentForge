/**
 * Delegation Protocol — Sprint 1.2a
 *
 * Implements typed delegation context envelopes and the routing rules that
 * govern which agents can delegate to which roles/agents in the org-graph.
 *
 * Every task assignment in v4 is wrapped in a DelegationContext that carries
 * the business rationale, constraints, and acceptable trade-offs — so that
 * delegatees can make good decisions without re-escalating for context.
 */

import { randomUUID } from "node:crypto";
import type { DelegationContext, OrgNode } from "../types/v4-api.js";
import type { OrgGraph } from "./org-graph.js";

export interface DelegationResult {
  allowed: boolean;
  reason: string;
  context?: DelegationContext;
}

export interface DelegationRecord {
  context: DelegationContext;
  createdAt: string;
  status: "pending" | "accepted" | "completed" | "rejected" | "escalated";
  completedAt?: string;
  resultSummary?: string;
}

export class DelegationProtocol {
  private records = new Map<string, DelegationRecord>();

  constructor(private readonly graph: OrgGraph) {}

  /**
   * Create and record a delegation from one agent to another.
   *
   * Routing rules (enforced in order):
   *  1. Delegator must exist in the org-graph.
   *  2. Delegatee must exist in the org-graph.
   *  3. Delegator must be an ancestor of delegatee OR the target role must
   *     appear in delegator's `canDelegateTo` list.
   *  4. Delegatee must not be suspended/offline (callers check AgentStatusFile).
   *
   * Returns DelegationResult with allowed=false and reason if any rule fails.
   */
  delegate(
    delegatorAgentId: string,
    delegateeAgentId: string,
    taskDescription: string,
    businessRationale: string,
    constraints: string[],
    acceptableTradeoffs: string[],
    expectedOutput: string,
    options?: {
      budgetUsd?: number;
      deadlineIso?: string;
    }
  ): DelegationResult {
    const delegator = this.graph.getNode(delegatorAgentId);
    if (!delegator) {
      return { allowed: false, reason: `Delegator "${delegatorAgentId}" not found in org-graph` };
    }
    const delegatee = this.graph.getNode(delegateeAgentId);
    if (!delegatee) {
      return { allowed: false, reason: `Delegatee "${delegateeAgentId}" not found in org-graph` };
    }
    if (!this.isAuthorized(delegator, delegateeAgentId)) {
      return {
        allowed: false,
        reason: `"${delegatorAgentId}" is not authorized to delegate to "${delegateeAgentId}". Must be ancestor or list target in canDelegateTo.`,
      };
    }

    const taskId = randomUUID();
    const context: DelegationContext = {
      taskId,
      delegatorAgentId,
      delegateeAgentId,
      businessRationale,
      constraints,
      acceptableTradeoffs,
      expectedOutput,
      budgetUsd: options?.budgetUsd,
      deadlineIso: options?.deadlineIso,
    };
    const record: DelegationRecord = {
      context,
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    this.records.set(taskId, record);
    return { allowed: true, reason: "authorized", context };
  }

  /**
   * Mark a delegation as accepted (delegatee started working on it).
   */
  accept(taskId: string): void {
    this.transitionStatus(taskId, "pending", "accepted");
  }

  /**
   * Mark a delegation as completed with a result summary.
   */
  complete(taskId: string, resultSummary: string): void {
    const record = this.getRecord(taskId);
    this.transitionStatus(taskId, "accepted", "completed");
    const updated = this.records.get(taskId)!;
    this.records.set(taskId, {
      ...updated,
      completedAt: new Date().toISOString(),
      resultSummary,
    });
  }

  /**
   * Mark a delegation as rejected (delegatee cannot or will not do it).
   */
  reject(taskId: string, reason: string): void {
    const record = this.getRecord(taskId);
    this.transitionStatus(taskId, "pending", "rejected");
    const updated = this.records.get(taskId)!;
    this.records.set(taskId, { ...updated, resultSummary: reason });
  }

  /**
   * Escalate a delegation back to the delegator's supervisor.
   */
  escalate(taskId: string, reason: string): void {
    this.getRecord(taskId); // validate existence
    const record = this.records.get(taskId)!;
    if (record.status !== "pending" && record.status !== "accepted") {
      throw new Error(`Cannot escalate task "${taskId}" with status "${record.status}"`);
    }
    this.records.set(taskId, { ...record, status: "escalated", resultSummary: reason });
  }

  /** Look up a delegation record by task ID. */
  getRecord(taskId: string): DelegationRecord {
    const record = this.records.get(taskId);
    if (!record) throw new Error(`Delegation "${taskId}" not found`);
    return { ...record, context: { ...record.context } };
  }

  /** All pending delegations for a given delegatee. */
  getPendingFor(delegateeAgentId: string): DelegationRecord[] {
    return Array.from(this.records.values())
      .filter(
        (r) => r.context.delegateeAgentId === delegateeAgentId && r.status === "pending"
      )
      .map((r) => ({ ...r, context: { ...r.context } }));
  }

  /** All delegations issued by a given delegator (any status). */
  getIssuedBy(delegatorAgentId: string): DelegationRecord[] {
    return Array.from(this.records.values())
      .filter((r) => r.context.delegatorAgentId === delegatorAgentId)
      .map((r) => ({ ...r, context: { ...r.context } }));
  }

  /** Total delegation records. */
  size(): number {
    return this.records.size;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Returns true if delegator is authorized to delegate to delegateeAgentId.
   * Authorized when:
   *  - delegator is an ancestor of delegatee in the org-graph, OR
   *  - delegatee's role/agentId appears in delegator's canDelegateTo list.
   */
  private isAuthorized(delegator: OrgNode, delegateeAgentId: string): boolean {
    if (this.graph.isAncestor(delegator.agentId, delegateeAgentId)) return true;
    if (this.graph.canDelegate(delegator.agentId, delegateeAgentId)) return true;
    const delegateeNode = this.graph.getNode(delegateeAgentId);
    if (delegateeNode && this.graph.canDelegate(delegator.agentId, delegateeNode.roleId)) {
      return true;
    }
    return false;
  }

  private transitionStatus(
    taskId: string,
    expectedFrom: DelegationRecord["status"],
    to: DelegationRecord["status"]
  ): void {
    const record = this.records.get(taskId);
    if (!record) throw new Error(`Delegation "${taskId}" not found`);
    if (record.status !== expectedFrom) {
      throw new Error(
        `Cannot transition "${taskId}" from "${expectedFrom}" to "${to}" — current status is "${record.status}"`
      );
    }
    this.records.set(taskId, { ...record, status: to });
  }
}
