/**
 * ParallelSprintExecutor — P1-4: Parallel Execution with ConcurrencyManager
 *
 * Executes sprint items in parallel, grouped by agent, respecting each
 * agent's concurrency cap via ConcurrencyManager.allocateSlot() /
 * releaseSlot(), and flags file conflicts when they arise.
 */

import type { ConcurrencyManager } from "../lifecycle/concurrency-manager.js";
import type { SeniorityLevel } from "../types/lifecycle.js";

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

/** A single sprint item destined for a particular agent. */
export interface SprintItem {
  /** Unique task identifier. */
  taskId: string;
  /** Agent responsible for this task. */
  agentId: string;
  /** Agent's seniority (used for slot allocation cap). */
  seniority?: SeniorityLevel;
  /** Files expected to be touched by this task. */
  targetFiles?: string[];
  /** The work unit to execute. */
  task: string;
  /** Any extra data the executor fn needs. */
  metadata?: Record<string, unknown>;
}

/** Result for a single sprint item. */
export interface SprintItemResult {
  taskId: string;
  agentId: string;
  slotId: string | null;
  status: "completed" | "failed" | "skipped";
  /** Raw result from the executor. */
  output?: unknown;
  /** Error message if the item failed. */
  error?: string;
  /** Whether a file conflict was detected before execution. */
  hasConflict: boolean;
  /** Slot IDs that held the conflicting files. */
  conflictingSlots: string[];
}

/** Aggregate result returned by executeSprintItemsInParallel. */
export interface ParallelSprintResult {
  results: SprintItemResult[];
  /** Tasks with merge conflicts detected. */
  mergeConflicts: string[];
  totalCompleted: number;
  totalFailed: number;
  totalSkipped: number;
}

/** Signature for the executor function that performs one task. */
export type TaskExecutorFn = (item: SprintItem) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Core executor
// ---------------------------------------------------------------------------

/**
 * Execute sprint items in parallel, grouped by agent.
 *
 * For each agent:
 *  1. Check file conflicts for each pending task.
 *  2. Attempt to allocate a ConcurrencyManager slot.
 *  3. Run up to maxConcurrentTasks items simultaneously via Promise.allSettled.
 *  4. Release slots and merge memories after completion.
 *
 * @param items            - Sprint items, typically from one sprint batch.
 * @param concurrencyManager - Manages per-agent concurrency caps.
 * @param executor         - Function that runs one task; resolves with output.
 * @param onEvent          - Optional SSE/event callback for progress updates.
 */
export async function executeSprintItemsInParallel(
  items: SprintItem[],
  concurrencyManager: ConcurrencyManager,
  executor: TaskExecutorFn,
  onEvent?: (event: { type: string; data: unknown }) => void,
): Promise<ParallelSprintResult> {
  // Group items by agentId
  const byAgent = groupByAgent(items);

  // Accumulate results across all agents
  const allResults: SprintItemResult[] = [];

  // Process each agent's batch concurrently at the agent level,
  // but each batch respects the agent's slot cap.
  const agentPromises = Array.from(byAgent.entries()).map(([agentId, agentItems]) =>
    runAgentBatch(agentId, agentItems, concurrencyManager, executor, onEvent)
  );

  const agentBatchResults = await Promise.allSettled(agentPromises);

  for (const settled of agentBatchResults) {
    if (settled.status === "fulfilled") {
      allResults.push(...settled.value);
    }
    // A full batch failure is unexpected — individual item failures are
    // captured inside runAgentBatch; swallow here.
  }

  // Collect merge conflicts
  const mergeConflicts = allResults
    .filter((r) => r.hasConflict)
    .map((r) => r.taskId);

  const totalCompleted = allResults.filter((r) => r.status === "completed").length;
  const totalFailed    = allResults.filter((r) => r.status === "failed").length;
  const totalSkipped   = allResults.filter((r) => r.status === "skipped").length;

  return { results: allResults, mergeConflicts, totalCompleted, totalFailed, totalSkipped };
}

// ---------------------------------------------------------------------------
// Per-agent batch runner
// ---------------------------------------------------------------------------

async function runAgentBatch(
  agentId: string,
  items: SprintItem[],
  concurrencyManager: ConcurrencyManager,
  executor: TaskExecutorFn,
  onEvent?: (event: { type: string; data: unknown }) => void,
): Promise<SprintItemResult[]> {
  const results: SprintItemResult[] = [];
  const pending = [...items];

  while (pending.length > 0) {
    // Allocate as many slots as available (respects seniority cap)
    const wave: Array<{ item: SprintItem; slotId: string }> = [];

    for (const item of pending) {
      const seniority: SeniorityLevel = item.seniority ?? "mid";
      const targetFiles = item.targetFiles ?? [];

      // Check file conflicts against already-active slots
      const { hasConflict, conflictingSlots } = concurrencyManager.checkConflicts(agentId, targetFiles);
      if (hasConflict) {
        results.push({
          taskId: item.taskId,
          agentId,
          slotId: null,
          status: "skipped",
          hasConflict: true,
          conflictingSlots,
          error: `File conflict detected with slots: ${conflictingSlots.join(", ")}`,
        });
        continue;
      }

      const slot = concurrencyManager.allocateSlot(agentId, item.taskId, seniority);
      if (!slot) {
        // At concurrency cap — defer to next wave
        continue;
      }

      // Track working files in the slot
      if (targetFiles.length > 0) {
        concurrencyManager.updateWorkingFiles(slot.slotId, targetFiles);
      }

      wave.push({ item, slotId: slot.slotId });
    }

    if (wave.length === 0) {
      // No progress possible — mark remaining as skipped
      const waveTaskIds = new Set(wave.map((w) => w.item.taskId));
      const resultTaskIds = new Set(results.map((r) => r.taskId));
      for (const item of pending) {
        if (!waveTaskIds.has(item.taskId) && !resultTaskIds.has(item.taskId)) {
          results.push({
            taskId: item.taskId,
            agentId,
            slotId: null,
            status: "skipped",
            hasConflict: false,
            conflictingSlots: [],
            error: "No concurrency slot available",
          });
        }
      }
      break;
    }

    // Remove waved items from pending
    const waveTaskIds = new Set(wave.map((w) => w.item.taskId));
    const remainingPending = pending.filter((p) => !waveTaskIds.has(p.taskId));
    pending.length = 0;
    pending.push(...remainingPending);

    onEvent?.({ type: "wave_start", data: { agentId, taskIds: [...waveTaskIds] } });

    // Execute wave in parallel
    const settled = await Promise.allSettled(
      wave.map(async ({ item, slotId }) => {
        try {
          const output = await executor(item);
          concurrencyManager.releaseSlot(slotId, "completed");
          onEvent?.({ type: "task_complete", data: { taskId: item.taskId, agentId } });
          return { item, slotId, output, success: true };
        } catch (err: unknown) {
          const error = err instanceof Error ? err.message : String(err);
          concurrencyManager.releaseSlot(slotId, "failed");
          onEvent?.({ type: "task_failed", data: { taskId: item.taskId, agentId, error } });
          return { item, slotId, output: undefined, success: false, error };
        }
      })
    );

    for (const s of settled) {
      if (s.status === "fulfilled") {
        const { item, slotId, output, success, error } = s.value as {
          item: SprintItem; slotId: string; output: unknown;
          success: boolean; error?: string;
        };
        results.push({
          taskId: item.taskId,
          agentId,
          slotId,
          status: success ? "completed" : "failed",
          output,
          error,
          hasConflict: false,
          conflictingSlots: [],
        });
      } else {
        // Promise.allSettled inner rejection (should not happen — executor catches)
        results.push({
          taskId: "unknown",
          agentId,
          slotId: null,
          status: "failed",
          error: String(s.reason),
          hasConflict: false,
          conflictingSlots: [],
        });
      }
    }
  }

  // Merge completed slot memories for this agent
  concurrencyManager.mergeCompletedSlots(agentId);

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupByAgent(items: SprintItem[]): Map<string, SprintItem[]> {
  const map = new Map<string, SprintItem[]>();
  for (const item of items) {
    const bucket = map.get(item.agentId) ?? [];
    bucket.push(item);
    map.set(item.agentId, bucket);
  }
  return map;
}
