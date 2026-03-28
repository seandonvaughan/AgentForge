/**
 * ConcurrencyManager — Agent Identity Hub Phase 5
 *
 * Manages parallel execution slots for agents that can multitask.
 * Enforces per-agent concurrency caps derived from SENIORITY_CONFIG,
 * tracks working-file conflicts across slots, and merges completed
 * slot memories back into a unified result.
 */

import { randomUUID } from "node:crypto";
import type { AgentDatabase } from "../db/database.js";
import type {
  ExecutionSlot,
  TaskMemory,
  KnowledgeEntry,
  SeniorityLevel,
} from "../types/lifecycle.js";
import { SENIORITY_CONFIG } from "../types/lifecycle.js";

// ---------------------------------------------------------------------------
// Row types for SQLite result mapping
// ---------------------------------------------------------------------------

interface ExecutionSlotRow {
  slot_id: string;
  agent_id: string;
  task_id: string;
  status: string;
  working_files: string | null;
  started_at: string;
  completed_at: string | null;
}

// ---------------------------------------------------------------------------
// ConcurrencyManager
// ---------------------------------------------------------------------------

export class ConcurrencyManager {
  /** All tracked slots, keyed by slotId. */
  private slots: Map<string, ExecutionSlot> = new Map();
  /** agentId → set of active slotIds. */
  private agentSlots: Map<string, Set<string>> = new Map();
  private db: AgentDatabase | null;

  constructor({ db }: { db?: AgentDatabase } = {}) {
    this.db = db ?? null;
  }

  // ---------------------------------------------------------------------------
  // Factory
  // ---------------------------------------------------------------------------

  /**
   * Create a ConcurrencyManager pre-loaded with active slots from the DB.
   */
  static loadFromDb(db: AgentDatabase): ConcurrencyManager {
    const manager = new ConcurrencyManager({ db });

    const rows = db
      .getDb()
      .prepare<[], ExecutionSlotRow>(
        "SELECT * FROM execution_slots WHERE status = 'active'"
      )
      .all();

    for (const row of rows) {
      const slot: ExecutionSlot = {
        slotId: row.slot_id,
        agentId: row.agent_id,
        taskId: row.task_id,
        status: row.status as ExecutionSlot["status"],
        contextSnapshot: {
          taskMemories: [],
          teamKnowledge: [],
          workingFiles: row.working_files ? JSON.parse(row.working_files) : [],
        },
        startedAt: row.started_at,
        completedAt: row.completed_at ?? undefined,
      };

      manager.slots.set(slot.slotId, slot);
      manager._trackSlot(slot.agentId, slot.slotId);
    }

    return manager;
  }

  // ---------------------------------------------------------------------------
  // Slot allocation
  // ---------------------------------------------------------------------------

  /**
   * Allocate a new execution slot for an agent.
   *
   * Returns null if the agent is already at the concurrency cap for their
   * seniority level.
   */
  allocateSlot(
    agentId: string,
    taskId: string,
    seniority: SeniorityLevel,
    teamKnowledge?: KnowledgeEntry[]
  ): ExecutionSlot | null {
    const max = SENIORITY_CONFIG[seniority].maxConcurrentTasks;
    const activeCount = this._activeSlotIds(agentId).size;

    if (activeCount >= max) {
      return null;
    }

    const now = new Date().toISOString();
    const slot: ExecutionSlot = {
      slotId: randomUUID(),
      agentId,
      taskId,
      status: "active",
      contextSnapshot: {
        taskMemories: [],
        teamKnowledge: teamKnowledge ?? [],
        workingFiles: [],
      },
      startedAt: now,
    };

    this.slots.set(slot.slotId, slot);
    this._trackSlot(agentId, slot.slotId);

    if (this.db) {
      this.db
        .getDb()
        .prepare(
          `INSERT INTO execution_slots
           (slot_id, agent_id, task_id, status, working_files, started_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          slot.slotId,
          slot.agentId,
          slot.taskId,
          slot.status,
          JSON.stringify(slot.contextSnapshot.workingFiles),
          slot.startedAt
        );
    }

    return slot;
  }

  // ---------------------------------------------------------------------------
  // Slot release
  // ---------------------------------------------------------------------------

  /**
   * Mark a slot as completed or failed, removing it from the active tracking
   * set and persisting the update to the DB.
   *
   * Returns the updated slot, or null if slotId is unknown.
   */
  releaseSlot(
    slotId: string,
    outcome: "completed" | "failed"
  ): ExecutionSlot | null {
    const slot = this.slots.get(slotId);
    if (!slot) return null;

    const now = new Date().toISOString();
    const updated: ExecutionSlot = { ...slot, status: outcome, completedAt: now };
    this.slots.set(slotId, updated);

    // Remove from active tracking
    const agentActive = this.agentSlots.get(slot.agentId);
    if (agentActive) {
      agentActive.delete(slotId);
    }

    if (this.db) {
      this.db
        .getDb()
        .prepare(
          `UPDATE execution_slots
           SET status = ?, completed_at = ?
           WHERE slot_id = ?`
        )
        .run(outcome, now, slotId);
    }

    return updated;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * Return all currently active slots for an agent.
   */
  getActiveSlots(agentId: string): ExecutionSlot[] {
    const ids = this._activeSlotIds(agentId);
    const result: ExecutionSlot[] = [];
    for (const id of ids) {
      const slot = this.slots.get(id);
      if (slot) result.push(slot);
    }
    return result;
  }

  /**
   * Return a slot by ID, or null if not found.
   */
  getSlot(slotId: string): ExecutionSlot | null {
    return this.slots.get(slotId) ?? null;
  }

  /**
   * Return how many slots are currently used and how many remain available
   * for the given agent and seniority combination.
   */
  getCapacity(
    agentId: string,
    seniority: SeniorityLevel
  ): { used: number; max: number; available: number } {
    const max = SENIORITY_CONFIG[seniority].maxConcurrentTasks;
    const used = this._activeSlotIds(agentId).size;
    return { used, max, available: Math.max(0, max - used) };
  }

  // ---------------------------------------------------------------------------
  // Conflict detection
  // ---------------------------------------------------------------------------

  /**
   * Check whether any active slot for this agent is already working on
   * any of the supplied target files.
   */
  checkConflicts(
    agentId: string,
    targetFiles: string[]
  ): { hasConflict: boolean; conflictingSlots: string[] } {
    const targetSet = new Set(targetFiles);
    const conflictingSlots: string[] = [];

    for (const slotId of this._activeSlotIds(agentId)) {
      const slot = this.slots.get(slotId);
      if (!slot) continue;

      const overlaps = slot.contextSnapshot.workingFiles.some((f) =>
        targetSet.has(f)
      );
      if (overlaps) {
        conflictingSlots.push(slotId);
      }
    }

    return { hasConflict: conflictingSlots.length > 0, conflictingSlots };
  }

  // ---------------------------------------------------------------------------
  // Working-file management
  // ---------------------------------------------------------------------------

  /**
   * Update the workingFiles list for a slot and persist to the DB.
   * No-op if the slotId is unknown.
   */
  updateWorkingFiles(slotId: string, files: string[]): void {
    const slot = this.slots.get(slotId);
    if (!slot) return;

    slot.contextSnapshot.workingFiles = [...files];

    if (this.db) {
      this.db
        .getDb()
        .prepare(
          `UPDATE execution_slots SET working_files = ? WHERE slot_id = ?`
        )
        .run(JSON.stringify(files), slotId);
    }
  }

  // ---------------------------------------------------------------------------
  // Memory merging
  // ---------------------------------------------------------------------------

  /**
   * Collect all task memories from completed slots for this agent, detect
   * file conflicts across those slots, then remove the completed slots from
   * internal state.
   *
   * Returns the merged memories and a list of files that appeared in more
   * than one completed slot (potential merge conflicts).
   */
  mergeCompletedSlots(
    agentId: string
  ): { mergedMemories: TaskMemory[]; fileConflicts: string[] } {
    const mergedMemories: TaskMemory[] = [];
    const fileCounts: Map<string, number> = new Map();
    const completedSlotIds: string[] = [];

    for (const [slotId, slot] of this.slots) {
      if (
        slot.agentId === agentId &&
        (slot.status === "completed" || slot.status === "failed")
      ) {
        completedSlotIds.push(slotId);

        // Collect memories
        for (const mem of slot.contextSnapshot.taskMemories) {
          mergedMemories.push(mem);
        }

        // Track file-level overlaps
        for (const file of slot.contextSnapshot.workingFiles) {
          fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1);
        }
      }
    }

    // Files touched by more than one completed slot are conflicts
    const fileConflicts: string[] = [];
    for (const [file, count] of fileCounts) {
      if (count > 1) fileConflicts.push(file);
    }

    // Clean up completed slots from internal state
    for (const slotId of completedSlotIds) {
      this.slots.delete(slotId);
      // Also remove from agentSlots in case it was still referenced there
      const agentActive = this.agentSlots.get(agentId);
      if (agentActive) {
        agentActive.delete(slotId);
      }
    }

    return { mergedMemories, fileConflicts };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Ensure the agent has an active-slots set and return it. */
  private _activeSlotIds(agentId: string): Set<string> {
    let set = this.agentSlots.get(agentId);
    if (!set) {
      set = new Set();
      this.agentSlots.set(agentId, set);
    }
    return set;
  }

  /** Register a slot in the agent-keyed active-slots index. */
  private _trackSlot(agentId: string, slotId: string): void {
    this._activeSlotIds(agentId).add(slotId);
  }
}
