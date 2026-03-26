/**
 * Org-Graph — Sprint 1.1a
 *
 * Directed acyclic graph of agent organizational relationships.
 * Every agent has exactly one supervisor (or is root), zero or more direct
 * reports, and a defined peer set derived from sharing the same supervisor.
 *
 * Guarantees:
 *   - Acyclicity enforced on addNode; cycle detection via DFS
 *   - All queries are O(1) or O(depth) — supports ≥30 nodes sub-100ms
 *   - Immutable node snapshots returned (no accidental mutation)
 */

import type { OrgNode } from "../types/v4-api.js";
import type { V4MessageBus } from "../communication/v4-message-bus.js";

export interface OrgGraphValidationResult {
  valid: boolean;
  errors: string[];
}

export class OrgGraph {
  private nodes = new Map<string, OrgNode>();

  constructor(private readonly bus?: V4MessageBus) {}

  /** Add a node. Throws if it would create a cycle or violate DAG constraints. */
  addNode(node: OrgNode): void {
    const existing = this.nodes.get(node.agentId);
    if (existing) {
      throw new Error(`Agent "${node.agentId}" is already in the org-graph`);
    }
    if (node.supervisorAgentId !== null) {
      if (!this.nodes.has(node.supervisorAgentId)) {
        throw new Error(
          `Supervisor "${node.supervisorAgentId}" does not exist — add supervisor before subordinate`
        );
      }
      if (this.wouldCreateCycle(node.agentId, node.supervisorAgentId)) {
        throw new Error(
          `Adding "${node.agentId}" under "${node.supervisorAgentId}" would create a cycle`
        );
      }
    }
    this.nodes.set(node.agentId, { ...node });
    if (this.bus) {
      this.bus.publish({
        from: "org-graph",
        to: "broadcast",
        topic: "org.node.added",
        category: "status",
        payload: { ...node },
        priority: "normal",
      });
    }
    // Register as direct report on supervisor
    if (node.supervisorAgentId !== null) {
      const supervisor = this.nodes.get(node.supervisorAgentId)!;
      if (!supervisor.directReportIds.includes(node.agentId)) {
        this.nodes.set(supervisor.agentId, {
          ...supervisor,
          directReportIds: [...supervisor.directReportIds, node.agentId],
        });
      }
    }
  }

  /** Remove a node and clean up references. Throws if it has direct reports. */
  removeNode(agentId: string): void {
    const node = this.nodes.get(agentId);
    if (!node) {
      throw new Error(`Agent "${agentId}" not found in org-graph`);
    }
    if (node.directReportIds.length > 0) {
      throw new Error(
        `Cannot remove "${agentId}" — it has ${node.directReportIds.length} direct report(s). Reassign them first.`
      );
    }
    // Remove from supervisor's direct reports
    if (node.supervisorAgentId !== null) {
      const supervisor = this.nodes.get(node.supervisorAgentId);
      if (supervisor) {
        this.nodes.set(supervisor.agentId, {
          ...supervisor,
          directReportIds: supervisor.directReportIds.filter((id) => id !== agentId),
        });
      }
    }
    this.nodes.delete(agentId);
    if (this.bus) {
      this.bus.publish({
        from: "org-graph",
        to: "broadcast",
        topic: "org.node.removed",
        category: "status",
        payload: { nodeId: agentId },
        priority: "normal",
      });
    }
  }

  /** Look up a node by agent ID. Returns null if not found. */
  getNode(agentId: string): OrgNode | null {
    const node = this.nodes.get(agentId);
    return node ? this.cloneNode(node) : null;
  }

  /** Returns the supervisor of the given agent, or null if it is the root. */
  getSupervisor(agentId: string): OrgNode | null {
    const node = this.nodes.get(agentId);
    if (!node || node.supervisorAgentId === null) return null;
    const supervisor = this.nodes.get(node.supervisorAgentId);
    return supervisor ? this.cloneNode(supervisor) : null;
  }

  /** Returns the direct reports of the given agent (snapshot copies). */
  getDirectReports(agentId: string): OrgNode[] {
    const node = this.nodes.get(agentId);
    if (!node) return [];
    return node.directReportIds
      .map((id) => this.nodes.get(id))
      .filter((n): n is OrgNode => n !== undefined)
      .map((n) => this.cloneNode(n));
  }

  /**
   * Returns peers — agents that share the same supervisor.
   * Does not include the queried agent itself.
   */
  getPeers(agentId: string): OrgNode[] {
    const node = this.nodes.get(agentId);
    if (!node || node.supervisorAgentId === null) return [];
    const supervisor = this.nodes.get(node.supervisorAgentId);
    if (!supervisor) return [];
    return supervisor.directReportIds
      .filter((id) => id !== agentId)
      .map((id) => this.nodes.get(id))
      .filter((n): n is OrgNode => n !== undefined)
      .map((n) => this.cloneNode(n));
  }

  /**
   * Returns the chain of supervisors from the given agent up to the root.
   * First element is the immediate supervisor; last is the root.
   */
  getAncestors(agentId: string): OrgNode[] {
    const ancestors: OrgNode[] = [];
    let current = this.nodes.get(agentId);
    const visited = new Set<string>();
    while (current && current.supervisorAgentId !== null) {
      if (visited.has(current.agentId)) break;
      visited.add(current.agentId);
      const supervisor = this.nodes.get(current.supervisorAgentId);
      if (!supervisor) break;
      ancestors.push(this.cloneNode(supervisor));
      current = supervisor;
    }
    return ancestors;
  }

  /**
   * Returns all descendants of the given agent (DFS, not including the agent itself).
   */
  getDescendants(agentId: string): OrgNode[] {
    const result: OrgNode[] = [];
    const stack = [agentId];
    const visited = new Set<string>();
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const node = this.nodes.get(id);
      if (!node) continue;
      if (id !== agentId) result.push(this.cloneNode(node));
      for (const reportId of node.directReportIds) {
        stack.push(reportId);
      }
    }
    return result;
  }

  /**
   * Find the root node (no supervisor). Returns null if graph is empty.
   * In a valid org-graph there is exactly one root.
   */
  getRoot(): OrgNode | null {
    for (const node of this.nodes.values()) {
      if (node.supervisorAgentId === null) return this.cloneNode(node);
    }
    return null;
  }

  /** Returns all nodes matching the predicate (snapshot copies). */
  query(predicate: (node: OrgNode) => boolean): OrgNode[] {
    const result: OrgNode[] = [];
    for (const node of this.nodes.values()) {
      if (predicate(node)) result.push(this.cloneNode(node));
    }
    return result;
  }

  /** Total number of nodes in the graph. */
  size(): number {
    return this.nodes.size;
  }

  /** All agent IDs in the graph. */
  agentIds(): string[] {
    return Array.from(this.nodes.keys());
  }

  /**
   * Returns true if `targetId` is an ancestor of `agentId`.
   * Used to check delegation authority (can only delegate to subordinates).
   */
  isAncestor(potentialAncestorId: string, agentId: string): boolean {
    let current = this.nodes.get(agentId);
    const visited = new Set<string>();
    while (current && current.supervisorAgentId !== null) {
      if (visited.has(current.agentId)) break;
      visited.add(current.agentId);
      if (current.supervisorAgentId === potentialAncestorId) return true;
      current = this.nodes.get(current.supervisorAgentId);
    }
    return false;
  }

  /**
   * Returns true if `agentId` can delegate to `targetId` per their
   * `canDelegateTo` list.
   */
  canDelegate(agentId: string, targetRoleOrId: string): boolean {
    const node = this.nodes.get(agentId);
    if (!node) return false;
    return node.canDelegateTo.includes(targetRoleOrId);
  }

  /** Validates the graph. Returns all structural errors. */
  validate(): OrgGraphValidationResult {
    const errors: string[] = [];
    // Check exactly one root
    const roots = Array.from(this.nodes.values()).filter(
      (n) => n.supervisorAgentId === null
    );
    if (roots.length === 0 && this.nodes.size > 0) {
      errors.push("No root node found — graph has no agent with null supervisorAgentId");
    }
    if (roots.length > 1) {
      errors.push(
        `Multiple root nodes found: ${roots.map((r) => r.agentId).join(", ")}`
      );
    }
    // Check all referenced supervisors exist
    for (const node of this.nodes.values()) {
      if (node.supervisorAgentId !== null && !this.nodes.has(node.supervisorAgentId)) {
        errors.push(
          `Agent "${node.agentId}" references non-existent supervisor "${node.supervisorAgentId}"`
        );
      }
      for (const reportId of node.directReportIds) {
        if (!this.nodes.has(reportId)) {
          errors.push(
            `Agent "${node.agentId}" lists non-existent direct report "${reportId}"`
          );
        }
      }
    }
    // Check acyclicity via DFS from root
    if (roots.length === 1) {
      const visited = new Set<string>();
      const inStack = new Set<string>();
      const detectCycle = (id: string): boolean => {
        visited.add(id);
        inStack.add(id);
        const node = this.nodes.get(id);
        if (node) {
          for (const reportId of node.directReportIds) {
            if (!visited.has(reportId)) {
              if (detectCycle(reportId)) return true;
            } else if (inStack.has(reportId)) {
              errors.push(`Cycle detected involving agent "${reportId}"`);
              return true;
            }
          }
        }
        inStack.delete(id);
        return false;
      };
      detectCycle(roots[0].agentId);
    }
    return { valid: errors.length === 0, errors };
  }

  // ---------------------------------------------------------------------------
  // Visualization exports
  // ---------------------------------------------------------------------------

  /** Export the org graph as a Mermaid diagram string. */
  toMermaid(): string {
    const lines: string[] = ["graph TD"];
    for (const node of this.nodes.values()) {
      for (const reportId of node.directReportIds) {
        lines.push(`  ${node.agentId} --> ${reportId}`);
      }
    }
    return lines.join("\n");
  }

  /** Export the org graph as a Graphviz DOT format string. */
  toDOT(): string {
    const lines: string[] = ["digraph OrgGraph {"];
    for (const node of this.nodes.values()) {
      for (const reportId of node.directReportIds) {
        lines.push(`  "${node.agentId}" -> "${reportId}";`);
      }
    }
    lines.push("}");
    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Deep-clones a node so callers cannot mutate internal state. */
  private cloneNode(node: OrgNode): OrgNode {
    return {
      ...node,
      directReportIds: [...node.directReportIds],
      peerAgentIds: [...node.peerAgentIds],
      canDelegateTo: [...node.canDelegateTo],
    };
  }

  /**
   * Returns true if adding `newId` as a child of `supervisorId` would
   * create a cycle (i.e., `supervisorId` is already a descendant of `newId`).
   */
  private wouldCreateCycle(newId: string, supervisorId: string): boolean {
    // Walk up from supervisorId — if we find newId, it's a cycle
    let current = this.nodes.get(supervisorId);
    const visited = new Set<string>();
    while (current) {
      if (visited.has(current.agentId)) return false; // already checked
      visited.add(current.agentId);
      if (current.agentId === newId) return true;
      if (current.supervisorAgentId === null) break;
      current = this.nodes.get(current.supervisorAgentId);
    }
    return false;
  }
}
