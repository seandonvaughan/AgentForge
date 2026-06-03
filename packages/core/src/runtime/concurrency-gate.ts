// packages/core/src/runtime/concurrency-gate.ts
//
// T4.5 — Concurrency cap + backpressure queue for execute-phase agent dispatch.
//
// Provides a simple async semaphore that:
//   - Limits concurrent agent dispatches to MAX_PARALLEL_AGENTS (default 8, max 40)
//   - Queues callers when saturated; higher-priority callers unblock first
//   - Force-releases stale slots after staleAcquireTimeoutMs (default 30 min)
//     to prevent deadlock when callers forget to call the release function
//
// Optional free-memory admission floor (default-DISABLED):
//   Set AGENTFORGE_MIN_FREE_MEM_GB (float, gigabytes) to enable. When unset,
//   acquire() is count-only (byte-identical to prior behaviour). When enabled,
//   admission additionally requires os.freemem() >= floor — but the floor is
//   never applied when active===0 to guarantee at least one slot is always
//   admitted (no deadlock).

import { freemem } from 'node:os';

const DEFAULT_MAX_PARALLEL = 8;
const HARD_MAX_PARALLEL = 40;
const DEFAULT_STALE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export interface ConcurrencyGateOptions {
  /**
   * Maximum number of concurrent acquisitions. Clamped to [1, 40].
   * Defaults to env var `envVar` (default `MAX_PARALLEL_AGENTS`), or 8.
   */
  maxParallel?: number;
  /**
   * Name of the env var to read the cap from.
   * Defaults to "MAX_PARALLEL_AGENTS".
   */
  envVar?: string;
  /**
   * How long (ms) a single acquire may hold a slot before being force-released.
   * Defaults to 30 minutes.
   */
  staleAcquireTimeoutMs?: number;
  /**
   * Opt-in free-memory floor in gigabytes. When set to a positive value,
   * acquire() will additionally require os.freemem() >= floor (unless
   * active===0, which always admits to prevent deadlock).
   *
   * Default: DISABLED (0). When unset or <=0, the floor is disabled and
   * acquire() behaves byte-identically to the count-only baseline.
   *
   * Can also be set via the AGENTFORGE_MIN_FREE_MEM_GB environment variable.
   * This explicit option takes precedence over the env var.
   */
  minFreeMemGb?: number;
  /**
   * Injectable free-memory reader (bytes). Defaults to os.freemem().
   * Provided for deterministic unit testing; do not set in production.
   */
  freeMemBytes?: () => number;
}

export interface ConcurrencyGateStats {
  active: number;
  queued: number;
  totalAcquires: number;
  totalReleases: number;
}

interface QueueEntry {
  priority: number;
  resolve: () => void;
  /** Monotonically-increasing serial so same-priority entries maintain FIFO order. */
  serial: number;
}

interface ActiveSlot {
  /** setTimeout handle for the stale-release watchdog. */
  timer: ReturnType<typeof setTimeout> | null;
  released: boolean;
}

/**
 * Async semaphore with priority-based backpressure.
 *
 * Usage:
 *   const release = await gate.acquire(priority);
 *   try {
 *     // ... do work ...
 *   } finally {
 *     release();
 *   }
 */
export class ConcurrencyGate {
  private readonly maxParallel: number;
  private readonly staleTimeoutMs: number;
  /** Floor in bytes; 0 means disabled. */
  private readonly minFreeMemBytes: number;
  /** Free-memory reader — injectable for tests. */
  private readonly freeMemBytes: () => number;

  private active = 0;
  private serialCounter = 0;

  /** Pending callers waiting for a slot. */
  private readonly queue: QueueEntry[] = [];

  /** Active slot watchdog timers keyed by a unique per-acquire slot id. */
  private readonly activeSlots = new Map<string, ActiveSlot>();

  private slotIdCounter = 0;
  private totalAcquires = 0;
  private totalReleases = 0;

  constructor(opts: ConcurrencyGateOptions = {}) {
    const envVarName = opts.envVar ?? 'MAX_PARALLEL_AGENTS';
    const fromEnv = process.env[envVarName];
    const envVal = fromEnv ? parseInt(fromEnv, 10) : NaN;

    // Resolution order: explicit option → env var → default
    const raw =
      opts.maxParallel !== undefined
        ? opts.maxParallel
        : !isNaN(envVal)
          ? envVal
          : DEFAULT_MAX_PARALLEL;

    this.maxParallel = Math.max(1, Math.min(HARD_MAX_PARALLEL, raw));
    this.staleTimeoutMs = opts.staleAcquireTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;

    // Free-memory floor (default-DISABLED).
    // Resolution order: explicit option → AGENTFORGE_MIN_FREE_MEM_GB env var → 0 (disabled).
    this.freeMemBytes = opts.freeMemBytes ?? freemem;

    let floorGb: number;
    if (opts.minFreeMemGb !== undefined) {
      floorGb = opts.minFreeMemGb;
    } else {
      const envFloor = process.env['AGENTFORGE_MIN_FREE_MEM_GB'];
      floorGb = envFloor ? parseFloat(envFloor) : 0;
    }
    // Treat NaN, negative, or zero as disabled (0).
    this.minFreeMemBytes = floorGb > 0 && isFinite(floorGb) ? floorGb * 1e9 : 0;
  }

  /**
   * Acquire a slot. Returns a release function.
   *
   * If the gate is at capacity, waits until a slot becomes available.
   * Callers with a higher `priority` number are unblocked before lower-priority
   * callers. Callers with equal priority are served FIFO.
   *
   * The returned release function is idempotent: calling it more than once
   * has no additional effect.
   */
  async acquire(priority = 0): Promise<() => void> {
    if (this.active < this.maxParallel && this.memFloorCleared()) {
      // Fast path: slot available immediately.
      this.active++;
      this.totalAcquires++;
      return this.makeReleaseFunction();
    }

    // Slow path: enqueue and wait.
    return new Promise<() => void>((resolve) => {
      const serial = this.serialCounter++;
      const entry: QueueEntry = {
        priority,
        serial,
        resolve: () => {
          // The slot count was already incremented in drainQueue before
          // this resolver fires, so we just hand back the release function.
          this.totalAcquires++;
          resolve(this.makeReleaseFunction());
        },
      };
      this.enqueue(entry);
    });
  }

  /** Return current stats snapshot. */
  getStats(): ConcurrencyGateStats {
    return {
      active: this.active,
      queued: this.queue.length,
      totalAcquires: this.totalAcquires,
      totalReleases: this.totalReleases,
    };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private makeReleaseFunction(): () => void {
    const slotId = `slot-${this.slotIdCounter++}`;
    const slot: ActiveSlot = { timer: null, released: false };
    this.activeSlots.set(slotId, slot);

    // Stale-release watchdog: if the slot is not released within the timeout,
    // force-release it so saturated callers are not permanently blocked.
    if (this.staleTimeoutMs > 0 && this.staleTimeoutMs !== Infinity) {
      slot.timer = setTimeout(() => {
        if (!slot.released) {
          console.error(
            `[ConcurrencyGate] Slot ${slotId} held for >${this.staleTimeoutMs}ms without release — force-releasing to prevent deadlock.`,
          );
          doRelease();
        }
      }, this.staleTimeoutMs);
      // Avoid keeping the Node process alive just for the watchdog.
      if (slot.timer && typeof slot.timer === 'object' && 'unref' in slot.timer) {
        (slot.timer as NodeJS.Timeout).unref();
      }
    }

    const doRelease = (): void => {
      if (slot.released) return; // idempotent
      slot.released = true;
      if (slot.timer !== null) {
        clearTimeout(slot.timer);
        slot.timer = null;
      }
      this.activeSlots.delete(slotId);
      this.totalReleases++;
      this.active--;
      this.drainQueue();
    };

    return doRelease;
  }

  /**
   * Insert the entry into the queue, sorted descending by priority, then
   * ascending by serial (FIFO within same priority).
   */
  private enqueue(entry: QueueEntry): void {
    // Binary insertion to keep the queue sorted.
    let lo = 0;
    let hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const m = this.queue[mid]!;
      if (
        m.priority > entry.priority ||
        (m.priority === entry.priority && m.serial < entry.serial)
      ) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    this.queue.splice(lo, 0, entry);
  }

  /**
   * Attempt to hand a free slot to the highest-priority queued caller.
   * Called after every release.
   */
  private drainQueue(): void {
    while (this.queue.length > 0 && this.active < this.maxParallel && this.memFloorCleared()) {
      const entry = this.queue.shift()!;
      this.active++;
      // Resolve the waiting caller (will call makeReleaseFunction).
      entry.resolve();
    }
  }

  /**
   * Returns true when the free-memory floor is either disabled (minFreeMemBytes===0)
   * or satisfied (free bytes >= floor), OR when active===0 (always admit at
   * least one slot to prevent deadlock).
   */
  private memFloorCleared(): boolean {
    if (this.minFreeMemBytes <= 0) return true;   // floor disabled
    if (this.active === 0) return true;            // never deadlock
    return this.freeMemBytes() >= this.minFreeMemBytes;
  }
}
