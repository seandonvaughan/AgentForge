/**
 * Execution Engine for the AgentForge Orchestrator.
 *
 * Creates task executions, plans parallel execution groups,
 * and tracks overall execution state.
 */

import { randomUUID } from "node:crypto";
import type { DelegationResult } from "./delegation-manager.js";
import type { TeamManifest } from "../types/team.js";

/** Represents a single task assigned to an agent. */
export interface TaskExecution {
  /** Unique execution identifier. */
  id: string;
  /** Name of the agent assigned to this task. */
  agent: string;
  /** Description of the task to execute. */
  task: string;
  /** Current execution status. */
  status: "pending" | "running" | "completed" | "failed";
  /** ISO-8601 timestamp when execution started, or null if not yet started. */
  started_at: string | null;
  /** ISO-8601 timestamp when execution ended, or null if still running. */
  completed_at: string | null;
  /** Result payload, or null if not yet available. */
  result: string | null;
  /** Delegation results produced during this execution. */
  delegations: DelegationResult[];
}

/**
 * A plan that organises task executions into parallel groups
 * and tracks inter-task dependencies.
 */
export interface ExecutionPlan {
  /** All tasks included in this plan. */
  tasks: TaskExecution[];
  /** Groups of task IDs that can safely run in parallel. */
  parallel_groups: string[][];
  /** Map from task ID to the IDs of tasks it depends on. */
  dependencies: Record<string, string[]>;
}

/**
 * Manages task creation, parallel-execution planning, and status tracking.
 */
export class ExecutionEngine {
  private readonly manifest: TeamManifest;
  private readonly executions: Map<string, TaskExecution> = new Map();

  constructor(teamManifest: TeamManifest) {
    this.manifest = teamManifest;
  }

  /**
   * Creates a new pending task execution and registers it for tracking.
   */
  createExecution(agent: string, task: string): TaskExecution {
    const execution: TaskExecution = {
      id: randomUUID(),
      agent,
      task,
      status: "pending",
      started_at: null,
      completed_at: null,
      result: null,
      delegations: [],
    };

    this.executions.set(execution.id, execution);
    return execution;
  }

  /**
   * Analyses a set of tasks and groups independent ones for parallel execution.
   *
   * Tasks assigned to agents that share a delegation relationship are treated
   * as dependent (the delegator must finish before the delegate starts).
   * All other tasks are considered independent and placed in the same
   * parallel group.
   */
  planExecution(tasks: TaskExecution[]): ExecutionPlan {
    const dependencies: Record<string, string[]> = {};
    const graph = this.manifest.delegation_graph;

    // Build dependency map: if agent A can delegate to agent B,
    // treat B's task as dependent on A's task.
    for (const task of tasks) {
      dependencies[task.id] = [];
    }

    for (const taskA of tasks) {
      for (const taskB of tasks) {
        if (taskA.id === taskB.id) continue;
        const delegates = graph[taskA.agent] ?? [];
        if (delegates.includes(taskB.agent)) {
          // taskB depends on taskA
          if (!dependencies[taskB.id].includes(taskA.id)) {
            dependencies[taskB.id].push(taskA.id);
          }
        }
      }
    }

    // Build parallel groups using a topological-layer approach.
    const parallelGroups: string[][] = [];
    const scheduled = new Set<string>();

    while (scheduled.size < tasks.length) {
      const group: string[] = [];

      for (const task of tasks) {
        if (scheduled.has(task.id)) continue;

        const deps = dependencies[task.id];
        const allDepsScheduled = deps.every((d) => scheduled.has(d));
        if (allDepsScheduled) {
          group.push(task.id);
        }
      }

      // Safety: if no progress is made (circular dependency), break.
      if (group.length === 0) break;

      parallelGroups.push(group);
      for (const id of group) {
        scheduled.add(id);
      }
    }

    // Register any tasks not yet tracked.
    for (const task of tasks) {
      if (!this.executions.has(task.id)) {
        this.executions.set(task.id, task);
      }
    }

    return { tasks, parallel_groups: parallelGroups, dependencies };
  }

  /**
   * Returns an aggregate status snapshot of all tracked executions.
   */
  getStatus(): {
    running: number;
    completed: number;
    failed: number;
    pending: number;
  } {
    let running = 0;
    let completed = 0;
    let failed = 0;
    let pending = 0;

    for (const exec of Array.from(this.executions.values())) {
      switch (exec.status) {
        case "running":
          running++;
          break;
        case "completed":
          completed++;
          break;
        case "failed":
          failed++;
          break;
        case "pending":
          pending++;
          break;
      }
    }

    return { running, completed, failed, pending };
  }
}
