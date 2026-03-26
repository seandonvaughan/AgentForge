/**
 * Accountability Tracker — Sprint 1.2b
 *
 * Tracks task ownership and generates RACI matrices for multi-agent
 * deliverables. Every task has exactly one Accountable agent.
 *
 * RACI roles:
 *   R — Responsible: does the work
 *   A — Accountable: owns the outcome (exactly one per task)
 *   C — Consulted: provides input before/during
 *   I — Informed: notified of completion
 */

import { randomUUID } from "node:crypto";
import type { V4MessageBus } from "../communication/v4-message-bus.js";

export type RaciRole = "responsible" | "accountable" | "consulted" | "informed";

export interface RaciEntry {
  agentId: string;
  role: RaciRole;
}

export interface TaskOwnershipRecord {
  taskId: string;
  title: string;
  description: string;
  accountableAgentId: string;
  raciEntries: RaciEntry[];
  createdAt: string;
  updatedAt: string;
  status: "open" | "in_progress" | "completed" | "cancelled";
  completedAt?: string;
  completedByAgentId?: string;
}

export interface RaciMatrix {
  taskId: string;
  title: string;
  agents: string[];
  matrix: Record<string, Record<string, RaciRole | null>>;
  // matrix[agentId][taskId] = role | null
}

export class AccountabilityTracker {
  private tasks = new Map<string, TaskOwnershipRecord>();

  constructor(private readonly bus?: V4MessageBus) {}

  /**
   * Register a new task with its RACI assignments.
   * Exactly one entry must have role="accountable". Throws otherwise.
   */
  registerTask(
    title: string,
    description: string,
    raciEntries: RaciEntry[],
    taskId?: string
  ): TaskOwnershipRecord {
    const accountable = raciEntries.filter((e) => e.role === "accountable");
    if (accountable.length === 0) {
      throw new Error(`Task "${title}" must have exactly one accountable agent`);
    }
    if (accountable.length > 1) {
      throw new Error(
        `Task "${title}" has ${accountable.length} accountable agents — exactly one required`
      );
    }
    const id = taskId ?? randomUUID();
    if (this.tasks.has(id)) {
      throw new Error(`Task "${id}" already exists`);
    }
    const now = new Date().toISOString();
    const record: TaskOwnershipRecord = {
      taskId: id,
      title,
      description,
      accountableAgentId: accountable[0].agentId,
      raciEntries: raciEntries.map((e) => ({ ...e })),
      createdAt: now,
      updatedAt: now,
      status: "open",
    };
    this.tasks.set(id, record);
    if (this.bus) {
      this.bus.publish({
        from: "accountability-tracker",
        to: "broadcast",
        topic: "accountability.task.registered",
        category: "status",
        payload: this.cloneRecord(record),
        priority: "normal",
      });
    }
    return this.cloneRecord(record);
  }

  /** Transition task to in_progress. */
  startTask(taskId: string, agentId: string): TaskOwnershipRecord {
    const record = this.requireTask(taskId);
    if (record.status !== "open") {
      throw new Error(`Cannot start task "${taskId}" with status "${record.status}"`);
    }
    this.assertResponsible(record, agentId, "start");
    return this.updateRecord(taskId, { status: "in_progress" });
  }

  /** Mark task completed. Only the accountable or responsible agent may complete it. */
  completeTask(taskId: string, completedByAgentId: string): TaskOwnershipRecord {
    const record = this.requireTask(taskId);
    if (record.status !== "in_progress") {
      throw new Error(`Task "${taskId}" must be in_progress to complete (current: "${record.status}")`);
    }
    const isAccountable = record.accountableAgentId === completedByAgentId;
    const isResponsible = record.raciEntries.some(
      (e) => e.agentId === completedByAgentId && e.role === "responsible"
    );
    if (!isAccountable && !isResponsible) {
      throw new Error(
        `Agent "${completedByAgentId}" is not accountable or responsible for task "${taskId}"`
      );
    }
    const result = this.updateRecord(taskId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      completedByAgentId,
    });
    if (this.bus) {
      this.bus.publish({
        from: "accountability-tracker",
        to: "broadcast",
        topic: "accountability.task.completed",
        category: "status",
        payload: { taskId, completedByAgentId },
        priority: "normal",
      });
    }
    return result;
  }

  /** Cancel a task (accountable agent or supervisor only — caller enforces supervisor check). */
  cancelTask(taskId: string): TaskOwnershipRecord {
    const record = this.requireTask(taskId);
    if (record.status === "completed") {
      throw new Error(`Cannot cancel completed task "${taskId}"`);
    }
    return this.updateRecord(taskId, { status: "cancelled" });
  }

  /** Look up a task by ID. Returns null if not found. */
  getTask(taskId: string): TaskOwnershipRecord | null {
    const record = this.tasks.get(taskId);
    return record ? this.cloneRecord(record) : null;
  }

  /** All tasks where the given agent is accountable. */
  getAccountableFor(agentId: string): TaskOwnershipRecord[] {
    return Array.from(this.tasks.values())
      .filter((r) => r.accountableAgentId === agentId)
      .map((r) => this.cloneRecord(r));
  }

  /** All tasks where the given agent has any RACI role. */
  getInvolvedIn(agentId: string): TaskOwnershipRecord[] {
    return Array.from(this.tasks.values())
      .filter((r) => r.raciEntries.some((e) => e.agentId === agentId))
      .map((r) => this.cloneRecord(r));
  }

  /** Open and in-progress tasks for an agent. */
  getActiveTasks(agentId: string): TaskOwnershipRecord[] {
    return this.getInvolvedIn(agentId).filter(
      (r) => r.status === "open" || r.status === "in_progress"
    );
  }

  /**
   * Generate a RACI matrix for a set of task IDs.
   * Rows = agents, Columns = tasks, Cells = RACI role or null.
   */
  generateRaciMatrix(taskIds: string[]): RaciMatrix[] {
    return taskIds.map((taskId) => {
      const record = this.tasks.get(taskId);
      if (!record) {
        throw new Error(`Task "${taskId}" not found`);
      }
      const agents = [...new Set(record.raciEntries.map((e) => e.agentId))];
      const matrix: Record<string, Record<string, RaciRole | null>> = {};
      for (const agentId of agents) {
        matrix[agentId] = {};
        for (const tid of taskIds) {
          const taskRecord = this.tasks.get(tid);
          if (!taskRecord) {
            matrix[agentId][tid] = null;
          } else {
            const entry = taskRecord.raciEntries.find((e) => e.agentId === agentId);
            matrix[agentId][tid] = entry?.role ?? null;
          }
        }
      }
      return { taskId, title: record.title, agents, matrix };
    });
  }

  /** All tasks. */
  listTasks(): TaskOwnershipRecord[] {
    return Array.from(this.tasks.values()).map((r) => this.cloneRecord(r));
  }

  /** Total tasks registered. */
  size(): number {
    return this.tasks.size;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private requireTask(taskId: string): TaskOwnershipRecord {
    const record = this.tasks.get(taskId);
    if (!record) throw new Error(`Task "${taskId}" not found`);
    return record;
  }

  private assertResponsible(
    record: TaskOwnershipRecord,
    agentId: string,
    action: string
  ): void {
    const isResponsible = record.raciEntries.some(
      (e) => e.agentId === agentId && e.role === "responsible"
    );
    const isAccountable = record.accountableAgentId === agentId;
    if (!isResponsible && !isAccountable) {
      throw new Error(
        `Agent "${agentId}" cannot ${action} task "${record.taskId}" — not responsible or accountable`
      );
    }
  }

  private updateRecord(
    taskId: string,
    patch: Partial<TaskOwnershipRecord>
  ): TaskOwnershipRecord {
    const existing = this.tasks.get(taskId)!;
    const updated: TaskOwnershipRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(taskId, updated);
    return this.cloneRecord(updated);
  }

  private cloneRecord(record: TaskOwnershipRecord): TaskOwnershipRecord {
    return {
      ...record,
      raciEntries: record.raciEntries.map((e) => ({ ...e })),
    };
  }
}
