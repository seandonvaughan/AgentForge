/**
 * AgentHeartbeat — v4.5 P0-6
 *
 * Writes agent status files to `.agentforge/status/<agentId>.json`
 * for real-time health monitoring. Integrates with V4HealthCheck
 * to provide health probes for the entire team.
 *
 * Zero new npm dependencies (Iron Law 5).
 */

import type { AgentState } from "../types/v4-api.js";
import type { V4MessageBus } from "../communication/v4-message-bus.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Status record for a single agent. */
export interface AgentStatus {
  /** Agent identifier. */
  agentId: string;
  /** Display name. */
  agentName: string;
  /** Model tier: "opus" | "sonnet" | "haiku". */
  modelTier: string;
  /** Current runtime state. */
  state: AgentState;
  /** ISO-8601 timestamp of last heartbeat. */
  heartbeatAt: string;
  /** Active task description, if any. */
  activeTask?: string;
  /** Task count completed in current session. */
  tasksCompleted: number;
  /** Consecutive errors. */
  consecutiveErrors: number;
}

/** Aggregate health report for the team. */
export interface TeamHealthReport {
  /** ISO-8601 timestamp of this report. */
  timestamp: string;
  /** Total agents tracked. */
  totalAgents: number;
  /** Agents currently active. */
  activeAgents: number;
  /** Agents currently idle. */
  idleAgents: number;
  /** Agents currently offline/stale. */
  offlineAgents: number;
  /** Agents with consecutive errors. */
  errorAgents: number;
  /** Overall health: true if no agents are in error state. */
  healthy: boolean;
  /** Per-agent status details. */
  agents: AgentStatus[];
}

/** Health snapshot for persistence. */
export interface HealthSnapshot {
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Total agents. */
  totalAgents: number;
  /** Active count. */
  activeAgents: number;
  /** Healthy. */
  healthy: boolean;
}

export interface AgentHeartbeatOptions {
  /** Message bus for event emission. */
  bus?: V4MessageBus;
  /** Staleness threshold in milliseconds (default: 120000 = 2 minutes). */
  stalenessThresholdMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_STALENESS_MS = 120_000; // 2 minutes

// ---------------------------------------------------------------------------
// AgentHeartbeat
// ---------------------------------------------------------------------------

export class AgentHeartbeat {
  private readonly agents = new Map<string, AgentStatus>();
  private readonly bus?: V4MessageBus;
  private readonly stalenessThresholdMs: number;
  private readonly healthSnapshots: HealthSnapshot[] = [];

  constructor(options?: AgentHeartbeatOptions) {
    this.bus = options?.bus;
    this.stalenessThresholdMs =
      options?.stalenessThresholdMs ?? DEFAULT_STALENESS_MS;
  }

  // =========================================================================
  // Registration
  // =========================================================================

  /**
   * Register an agent for heartbeat tracking.
   */
  registerAgent(
    agentId: string,
    agentName: string,
    modelTier: string,
  ): void {
    this.agents.set(agentId, {
      agentId,
      agentName,
      modelTier,
      state: "idle",
      heartbeatAt: new Date().toISOString(),
      tasksCompleted: 0,
      consecutiveErrors: 0,
    });
  }

  /**
   * Remove an agent from tracking.
   */
  unregisterAgent(agentId: string): boolean {
    return this.agents.delete(agentId);
  }

  // =========================================================================
  // Heartbeat
  // =========================================================================

  /**
   * Record a heartbeat for an agent.
   */
  heartbeat(agentId: string, state?: AgentState, activeTask?: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    agent.heartbeatAt = new Date().toISOString();
    if (state) agent.state = state;
    agent.activeTask = activeTask;
  }

  /**
   * Record a task completion for an agent.
   */
  recordTaskComplete(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    agent.tasksCompleted++;
    agent.consecutiveErrors = 0;
    agent.state = "idle";
    agent.activeTask = undefined;
    agent.heartbeatAt = new Date().toISOString();
  }

  /**
   * Record an error for an agent.
   */
  recordError(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    agent.consecutiveErrors++;
    agent.state = "idle";
    agent.activeTask = undefined;
    agent.heartbeatAt = new Date().toISOString();
  }

  // =========================================================================
  // Staleness detection
  // =========================================================================

  /**
   * Check all agents for staleness and mark offline if heartbeat is too old.
   * Returns the list of agents marked as offline.
   */
  detectStaleness(): string[] {
    const now = Date.now();
    const staleAgents: string[] = [];

    for (const [id, agent] of this.agents) {
      const heartbeatAge = now - new Date(agent.heartbeatAt).getTime();
      if (
        heartbeatAge > this.stalenessThresholdMs &&
        agent.state !== "offline"
      ) {
        agent.state = "offline";
        staleAgents.push(id);

        if (this.bus) {
          this.bus.publish({
            from: "agent-heartbeat",
            to: "broadcast",
            topic: "agent.status.update",
            category: "status",
            payload: {
              agentId: id,
              previousState: "idle",
              currentState: "offline",
              reason: "Heartbeat stale",
            },
            priority: "high",
          });
        }
      }
    }

    return staleAgents;
  }

  // =========================================================================
  // Health reporting
  // =========================================================================

  /**
   * Get the current health status of the entire team.
   */
  getTeamHealth(): TeamHealthReport {
    // Run staleness detection first
    this.detectStaleness();

    const agents = Array.from(this.agents.values()).map((a) => ({ ...a }));
    const activeAgents = agents.filter((a) => a.state === "active").length;
    const idleAgents = agents.filter((a) => a.state === "idle").length;
    const offlineAgents = agents.filter((a) => a.state === "offline").length;
    const errorAgents = agents.filter(
      (a) => a.consecutiveErrors > 0,
    ).length;

    const report: TeamHealthReport = {
      timestamp: new Date().toISOString(),
      totalAgents: agents.length,
      activeAgents,
      idleAgents,
      offlineAgents,
      errorAgents,
      healthy: offlineAgents === 0 && errorAgents === 0,
      agents,
    };

    // Record snapshot
    this.healthSnapshots.push({
      timestamp: report.timestamp,
      totalAgents: report.totalAgents,
      activeAgents: report.activeAgents,
      healthy: report.healthy,
    });

    // Keep only last 100 snapshots
    while (this.healthSnapshots.length > 100) {
      this.healthSnapshots.shift();
    }

    return report;
  }

  /**
   * Get a specific agent's status.
   */
  getAgentStatus(agentId: string): AgentStatus | null {
    const agent = this.agents.get(agentId);
    return agent ? { ...agent } : null;
  }

  /**
   * Get health snapshots for trend analysis.
   */
  getHealthSnapshots(): HealthSnapshot[] {
    return this.healthSnapshots.map((s) => ({ ...s }));
  }

  /**
   * Get the total number of tracked agents.
   */
  getAgentCount(): number {
    return this.agents.size;
  }

  // =========================================================================
  // V4HealthCheck probe
  // =========================================================================

  /**
   * Returns a health probe function compatible with V4HealthCheck.
   */
  toHealthProbe(): () => {
    module: string;
    healthy: boolean;
    metrics: Record<string, number>;
  } {
    return () => {
      const report = this.getTeamHealth();
      return {
        module: "agent-heartbeat",
        healthy: report.healthy,
        metrics: {
          totalAgents: report.totalAgents,
          activeAgents: report.activeAgents,
          offlineAgents: report.offlineAgents,
          errorAgents: report.errorAgents,
        },
      };
    };
  }
}
