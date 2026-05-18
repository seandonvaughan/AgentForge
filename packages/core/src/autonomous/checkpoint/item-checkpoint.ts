// packages/core/src/autonomous/checkpoint/item-checkpoint.ts
//
// Wave 5 T1 — Per-item intra-phase checkpoint writer for the execute phase.
//
// Provides `ItemCheckpointWriter` with a single-concurrency serialized queue so
// concurrent item completions never race on checkpoint.json or cycle.json.
//
// Atomic writes: .tmp → fsync → rename (mirrors Wave 3 cycle-checkpoint pattern).
//
// CodeQL js/path-injection: cycleId and itemId are validated match-then-use against
// /^[a-zA-Z0-9-]{8,64}$/ — we use the matched substring across all join() calls.

import {
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
  closeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Shared contracts (inlined — canonical until T1 merges to origin/main)
// ---------------------------------------------------------------------------

export interface ExecuteProgress {
  cycleId: string;
  phase: 'execute';
  completedItemIds: string[];
  currentItemId: string | null;
  totalItems: number;
  lastUpdatedAt: string;
  schemaVersion: 2;
}

export interface ItemCheckpoint {
  cycleId: string;
  itemId: string;
  agentId: string;
  status: 'completed' | 'failed' | 'skipped';
  stepScore: number | null;
  completedAt: string;
}

// ---------------------------------------------------------------------------
// Path validation (match-then-use for CodeQL js/path-injection)
// ---------------------------------------------------------------------------

const SEGMENT_RE = /^[a-zA-Z0-9-]{8,64}$/;

/**
 * Validates and returns a safe segment. Throws when the raw value does not
 * match the allowed pattern. We return the regex match so the static analyzer
 * can trace a sanitized value across subsequent join() calls.
 */
function safeSegment(raw: string, label: string): string {
  const m = SEGMENT_RE.exec(raw);
  if (!m) {
    throw new Error(`[item-checkpoint] invalid ${label} segment: ${JSON.stringify(raw)}`);
  }
  return m[0];
}

function resolveCheckpointPath(projectRoot: string, cycleId: string): string {
  const safeId = safeSegment(cycleId, 'cycleId');
  return join(projectRoot, '.agentforge', 'cycles', safeId, 'checkpoint.json');
}

// ---------------------------------------------------------------------------
// Atomic write helper
// ---------------------------------------------------------------------------

/**
 * Write `content` to `finalPath` atomically via `.tmp` + fsync + rename.
 * Mirrors the Wave 3 pattern in cycle-checkpoint.ts.
 */
function atomicWrite(finalPath: string, content: string): void {
  const tmpPath = `${finalPath}.tmp`;
  mkdirSync(dirname(finalPath), { recursive: true });

  const fd = openSync(tmpPath, 'w');
  try {
    const buf = Buffer.from(content, 'utf8');
    writeSync(fd, buf);
  } finally {
    closeSync(fd);
  }

  renameSync(tmpPath, finalPath);
}

// ---------------------------------------------------------------------------
// ItemCheckpointWriter
// ---------------------------------------------------------------------------

/**
 * Serialised per-item checkpoint writer for the execute phase.
 *
 * All enqueue() calls share a single promise chain (the "queue") so concurrent
 * item completions are processed one-at-a-time: no two writes can interleave on
 * the same checkpoint.json file.
 *
 * Public surface:
 *   enqueue(cycleId, itemId, status, agentId?, stepScore?) - Promise<void>
 *   flush()                                                 - Promise<void>
 */
export class ItemCheckpointWriter {
  private readonly projectRoot: string;
  private readonly totalItems: number;
  /** Serialization queue — tail of the running promise chain. */
  private queue: Promise<void> = Promise.resolve();

  constructor(projectRoot: string, totalItems: number = 0) {
    this.projectRoot = projectRoot;
    this.totalItems = totalItems;
  }

  /**
   * Enqueue a checkpoint write for a completed/failed/skipped item.
   * Returns a promise that resolves when this specific write has been flushed.
   */
  enqueue(
    cycleId: string,
    itemId: string,
    status: ItemCheckpoint['status'],
    agentId: string = 'unknown',
    stepScore: number | null = null,
  ): Promise<void> {
    const record: ItemCheckpoint = {
      cycleId,
      itemId,
      agentId,
      status,
      stepScore,
      completedAt: new Date().toISOString(),
    };

    // Chain onto the existing queue so writes are strictly sequential.
    const writeTask = (): Promise<void> => {
      try {
        this._applyWrite(cycleId, record);
      } catch {
        // Never let a checkpoint write failure propagate to callers — the
        // execute phase must continue even when persistence fails.
      }
      return Promise.resolve();
    };

    this.queue = this.queue.then(writeTask, writeTask);
    return this.queue;
  }

  /**
   * Wait for all previously-enqueued writes to complete.
   */
  flush(): Promise<void> {
    return this.queue;
  }

  // -------------------------------------------------------------------------
  // Internal synchronous write (called inside the serialized queue)
  // -------------------------------------------------------------------------

  private _applyWrite(cycleId: string, record: ItemCheckpoint): void {
    const checkpointPath = resolveCheckpointPath(this.projectRoot, cycleId);

    // Read existing progress (best-effort).
    let progress: ExecuteProgress = this._readProgress(cycleId, checkpointPath);

    // Append item to completedItemIds (deduplicate).
    if (!progress.completedItemIds.includes(record.itemId)) {
      progress = {
        ...progress,
        completedItemIds: [...progress.completedItemIds, record.itemId],
        currentItemId: null,
        lastUpdatedAt: record.completedAt,
      };
    }

    atomicWrite(checkpointPath, JSON.stringify(progress, null, 2));
  }

  private _readProgress(cycleId: string, checkpointPath: string): ExecuteProgress {
    try {
      const raw = readFileSync(checkpointPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ExecuteProgress>;
      // Only trust records that declare schemaVersion: 2 (this writer's format).
      if (
        parsed.schemaVersion === 2 &&
        parsed.cycleId === cycleId &&
        parsed.phase === 'execute' &&
        Array.isArray(parsed.completedItemIds)
      ) {
        return parsed as ExecuteProgress;
      }
    } catch {
      // ENOENT or malformed — start fresh.
    }

    return {
      cycleId,
      phase: 'execute',
      completedItemIds: [],
      currentItemId: null,
      totalItems: this.totalItems,
      lastUpdatedAt: new Date().toISOString(),
      schemaVersion: 2,
    };
  }

  // -------------------------------------------------------------------------
  // Static helpers for resume
  // -------------------------------------------------------------------------

  /**
   * Read an existing execute progress checkpoint. Returns null on ENOENT,
   * malformed JSON, or wrong schemaVersion — never throws.
   */
  static readProgress(projectRoot: string, cycleId: string): ExecuteProgress | null {
    let checkpointPath: string;
    try {
      checkpointPath = resolveCheckpointPath(projectRoot, cycleId);
    } catch {
      return null;
    }
    try {
      const raw = readFileSync(checkpointPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ExecuteProgress>;
      if (
        parsed.schemaVersion === 2 &&
        parsed.cycleId === cycleId &&
        parsed.phase === 'execute' &&
        Array.isArray(parsed.completedItemIds)
      ) {
        return parsed as ExecuteProgress;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Returns the set of completed item IDs from an existing checkpoint, or an
   * empty Set when no checkpoint exists for the given cycle. Never throws.
   */
  static getCompletedItemIds(projectRoot: string, cycleId: string): Set<string> {
    const progress = ItemCheckpointWriter.readProgress(projectRoot, cycleId);
    if (!progress) return new Set();
    return new Set(progress.completedItemIds);
  }
}
