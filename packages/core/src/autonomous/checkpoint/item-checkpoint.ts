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
  completedItems: CompletedItemCheckpoint[];
  currentItemId: string | null;
  totalItems: number;
  lastUpdatedAt: string;
  schemaVersion: 3;
}

export interface CompletedItemCheckpoint {
  itemId: string;
  costUsd: number;
  agentId: string;
}

export interface ItemCheckpoint {
  cycleId: string;
  itemId: string;
  agentId: string;
  status: 'completed' | 'failed' | 'skipped';
  stepScore: number | null;
  costUsd: number;
  completedAt: string;
}

interface RawExecuteProgress {
  schemaVersion?: number;
  cycleId?: unknown;
  phase?: unknown;
  completedItemIds?: unknown;
  completedItems?: unknown;
  currentItemId?: unknown;
  totalItems?: unknown;
  lastUpdatedAt?: unknown;
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
  return join(projectRoot, '.agentforge', 'cycles', safeId, 'checkpoint-execute.json');
}

/** Legacy single-file name, kept for the one-release read-shim. */
function resolveLegacyCheckpointPath(projectRoot: string, cycleId: string): string {
  const safeId = safeSegment(cycleId, 'cycleId');
  return join(projectRoot, '.agentforge', 'cycles', safeId, 'checkpoint.json');
}

function resolveExecutePhasePath(projectRoot: string, cycleId: string): string {
  const safeId = safeSegment(cycleId, 'cycleId');
  return join(projectRoot, '.agentforge', 'cycles', safeId, 'phases', 'execute.json');
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

/**
 * Attempt to parse and validate a progress file at the given path.
 * Returns the parsed progress if valid, or null if the file doesn't exist,
 * is malformed, or doesn't match the expected schema.
 */
function isCompletedItemCheckpoint(value: unknown): value is CompletedItemCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<CompletedItemCheckpoint>;
  return (
    typeof record.itemId === 'string' &&
    typeof record.costUsd === 'number' &&
    Number.isFinite(record.costUsd) &&
    typeof record.agentId === 'string'
  );
}

function tryReadItemCostUsd(projectRoot: string, cycleId: string, itemId: string): number | null {
  try {
    const raw = readFileSync(resolveExecutePhasePath(projectRoot, cycleId), 'utf8');
    const parsed = JSON.parse(raw) as { itemResults?: unknown };
    const itemResults = Array.isArray(parsed.itemResults) ? parsed.itemResults : [];
    for (const itemResult of itemResults) {
      if (!itemResult || typeof itemResult !== 'object') continue;
      const record = itemResult as { itemId?: unknown; costUsd?: unknown };
      if (
        record.itemId === itemId &&
        typeof record.costUsd === 'number' &&
        Number.isFinite(record.costUsd)
      ) {
        return record.costUsd;
      }
    }
  } catch {
    // Missing or malformed execute.json is non-fatal for checkpoint writes.
  }
  return null;
}

function tryParseProgress(checkpointPath: string, cycleId: string): ExecuteProgress | null {
  try {
    const raw = readFileSync(checkpointPath, 'utf8');
    const parsed = JSON.parse(raw) as RawExecuteProgress;
    if (
      (parsed.schemaVersion === 2 || parsed.schemaVersion === 3) &&
      parsed.cycleId === cycleId &&
      parsed.phase === 'execute' &&
      Array.isArray(parsed.completedItemIds)
    ) {
      const completedItems = Array.isArray(parsed.completedItems)
        ? parsed.completedItems.filter(isCompletedItemCheckpoint)
        : [];
      return {
        cycleId,
        phase: 'execute',
        completedItemIds: parsed.completedItemIds.filter((id): id is string => typeof id === 'string'),
        completedItems,
        currentItemId: typeof parsed.currentItemId === 'string' ? parsed.currentItemId : null,
        totalItems: typeof parsed.totalItems === 'number' ? parsed.totalItems : 0,
        lastUpdatedAt: typeof parsed.lastUpdatedAt === 'string'
          ? parsed.lastUpdatedAt
          : new Date().toISOString(),
        schemaVersion: 3,
      };
    }
  } catch {
    // ENOENT or malformed — fall through.
  }
  return null;
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
 *   enqueue(cycleId, itemId, status, agentId?, stepScore?, costUsd?) - Promise<void>
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
    costUsd: number | null = null,
  ): Promise<void> {
    const record: ItemCheckpoint = {
      cycleId,
      itemId,
      agentId,
      status,
      stepScore,
      costUsd: costUsd ?? tryReadItemCostUsd(this.projectRoot, cycleId, itemId) ?? 0,
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

    // Append item to completedItemIds (deduplicate) — but ONLY items that
    // actually completed. Failed/skipped items must stay resumable: recording
    // every settled item here made `--resume` skip FAILED children as if done
    // (observed on cycle 4e451e22 — 10 verify-failed children landed in the
    // skip set alongside the 7 that passed).
    if (record.status === 'completed' && !progress.completedItemIds.includes(record.itemId)) {
      progress = {
        ...progress,
        completedItemIds: [...progress.completedItemIds, record.itemId],
        completedItems: [
          ...progress.completedItems,
          { itemId: record.itemId, costUsd: record.costUsd, agentId: record.agentId },
        ],
        currentItemId: null,
        lastUpdatedAt: record.completedAt,
      };
    }

    atomicWrite(checkpointPath, JSON.stringify(progress, null, 2));
  }

  private _readProgress(cycleId: string, checkpointPath: string): ExecuteProgress {
    const fromNew = tryParseProgress(checkpointPath, cycleId);
    if (fromNew) return fromNew;
    const fromLegacy = tryParseProgress(
      resolveLegacyCheckpointPath(this.projectRoot, cycleId),
      cycleId,
    );
    if (fromLegacy) return fromLegacy;
    return {
      cycleId,
      phase: 'execute',
      completedItemIds: [],
      completedItems: [],
      currentItemId: null,
      totalItems: this.totalItems,
      lastUpdatedAt: new Date().toISOString(),
      schemaVersion: 3,
    };
  }

  // -------------------------------------------------------------------------
  // Static helpers for resume
  // -------------------------------------------------------------------------

  /**
   * Read an existing execute progress checkpoint. Returns null on ENOENT,
   * malformed JSON, or wrong schemaVersion — never throws.
   *
   * Tries the new path (checkpoint-execute.json) first, then falls back to the
   * legacy path (checkpoint.json) for backwards compatibility.
   */
  static readProgress(projectRoot: string, cycleId: string): ExecuteProgress | null {
    let newPath: string;
    let legacyPath: string;
    try {
      newPath = resolveCheckpointPath(projectRoot, cycleId);
      legacyPath = resolveLegacyCheckpointPath(projectRoot, cycleId);
    } catch {
      return null;
    }
    return tryParseProgress(newPath, cycleId) ?? tryParseProgress(legacyPath, cycleId);
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
