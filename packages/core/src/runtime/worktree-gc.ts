// packages/core/src/runtime/worktree-gc.ts
//
// T4.6 — Worktree garbage collection policy.
//
// WorktreeGc is a thin policy layer that decides WHICH worktrees to remove
// (by age, count, and disk budget) and delegates actual removal to the
// WorktreePool's release() method. It does NOT perform any git operations
// directly — that's WorktreePool's responsibility.

import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WorktreeHandle } from './worktree-pool-types.js';
import type { WorktreePool } from './worktree-pool.js';

const DEFAULT_KEEP_LAST = 20;
const DEFAULT_OLDER_THAN_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_MAX_DISK_MB = 5000; // 5 GB
const DISK_MEASURE_EXCLUDED_DIRS = new Set(['.git', '.pnpm', 'node_modules']);

export interface WorktreeGcOptions {
  /** The pool to query and release worktrees through. */
  pool: WorktreePool;
  /** Absolute path to the project root (parent of .agentforge/). */
  projectRoot: string;
  /**
   * Keep this many of the most-recent worktrees for forensics.
   * Defaults to 20 (matches T4.6 spec).
   */
  keepLast?: number;
  /**
   * Remove worktrees older than this many milliseconds.
   * Defaults to 24 hours.
   */
  olderThanMs?: number;
  /**
   * If the combined on-disk size of the worktrees directory exceeds this
   * many megabytes, aggressively remove oldest worktrees until under budget.
   * Defaults to 5000 MB (5 GB) to match the spec "--max-worktree-disk" flag.
   */
  maxDiskMb?: number;
  /**
   * Override for the worktrees sub-path relative to projectRoot.
   * Defaults to ".agentforge/worktrees".
   */
  rootDir?: string;
}

export interface WorktreeGcResult {
  removed: WorktreeHandle[];
  diskFreedMb: number;
}

export class WorktreeGc {
  private readonly pool: WorktreePool;
  private readonly projectRoot: string;
  private readonly keepLast: number;
  private readonly olderThanMs: number;
  private readonly maxDiskMb: number;
  private readonly worktreesDir: string;

  constructor(opts: WorktreeGcOptions) {
    this.pool = opts.pool;
    this.projectRoot = opts.projectRoot;
    this.keepLast = opts.keepLast ?? DEFAULT_KEEP_LAST;
    this.olderThanMs = opts.olderThanMs ?? DEFAULT_OLDER_THAN_MS;
    this.maxDiskMb = opts.maxDiskMb ?? DEFAULT_MAX_DISK_MB;
    this.worktreesDir = join(
      opts.projectRoot,
      opts.rootDir ?? '.agentforge/worktrees',
    );
  }

  /**
   * Run the garbage collection pass.
   *
   * Steps:
   *   a. List all active worktree handles via pool.listActive()
   *   b. Sort by allocatedAt (oldest first)
   *   c. Mark for removal: older than olderThanMs OR ranked beyond keepLast
   *   d. Compute current disk usage; if > maxDiskMb, mark more (oldest first)
   *   e. For each marked: call pool.release(handle.id)
   *   f. Return removed list + estimated disk freed
   *
   * Handles with unmerged commits are propagated correctly: pool.release()
   * already silently skips branch deletion for those (warns and leaves branch),
   * so they do count as removed from the pool's perspective (worktree checkout
   * is still removed). If pool.release() throws for any handle, the error
   * is collected and re-thrown after processing all other candidates.
   */
  async run(): Promise<WorktreeGcResult> {
    const handles = await this.pool.listActive();

    // Sort oldest-first so keep/remove decisions are deterministic.
    const sorted = [...handles].sort(
      (a, b) =>
        new Date(a.allocatedAt).getTime() - new Date(b.allocatedAt).getTime(),
    );

    const toRemoveSet = new Set<string>();
    const now = Date.now();

    // Mark by age.
    for (const h of sorted) {
      const ageMs = now - new Date(h.allocatedAt).getTime();
      if (ageMs > this.olderThanMs) {
        toRemoveSet.add(h.id);
      }
    }

    // Mark excess beyond keepLast (sorted oldest-first, so excess = head).
    const excess = sorted.length - this.keepLast;
    if (excess > 0) {
      for (let i = 0; i < excess; i++) {
        toRemoveSet.add(sorted[i]!.id);
      }
    }

    // Disk budget: compute current usage and aggressively prune oldest until
    // under budget. Handles already in toRemoveSet still count toward freeing.
    const diskUsageMb = this.measureDiskMb();
    if (diskUsageMb > this.maxDiskMb) {
      // Walk oldest-first; keep adding candidates until we're under budget.
      let projected = diskUsageMb;
      for (const h of sorted) {
        if (projected <= this.maxDiskMb) break;
        toRemoveSet.add(h.id);
        // Estimate per-worktree savings as average usage.
        const avgMb = sorted.length > 0 ? diskUsageMb / sorted.length : 0;
        projected -= avgMb;
      }
    }

    if (toRemoveSet.size === 0) {
      return { removed: [], diskFreedMb: 0 };
    }

    // Estimate disk freed (rough average per worktree).
    const diskPerWorktreeMb =
      sorted.length > 0 ? diskUsageMb / sorted.length : 0;

    const toRemoveHandles = sorted.filter((h) => toRemoveSet.has(h.id));

    const removed: WorktreeHandle[] = [];
    const errors: Array<{ id: string; error: unknown }> = [];

    for (const h of toRemoveHandles) {
      try {
        await this.pool.release(h.id);
        removed.push(h);
      } catch (err) {
        errors.push({ id: h.id, error: err });
      }
    }

    const diskFreedMb = removed.length * diskPerWorktreeMb;

    // Re-throw the first error after processing everything, so callers see it.
    if (errors.length > 0) {
      const first = errors[0]!;
      throw first.error instanceof Error
        ? first.error
        : new Error(`WorktreeGc: release(${first.id}) failed: ${String(first.error)}`);
    }

    return { removed, diskFreedMb };
  }

  // ---------------------------------------------------------------------------
  // Protected helpers (protected so test subclasses can inject mock values)
  // ---------------------------------------------------------------------------

  /**
   * Rough estimate of the total disk usage of the worktrees directory in MB.
   * Uses recursive directory traversal. Dependency stores and links are
   * skipped so copied or stale workspaces do not inflate worktree GC pressure
   * or force traversal through Windows junctions.
   * Protected so subclasses/tests can override for deterministic disk measurement.
   */
  protected measureDiskMb(): number {
    try {
      return this.dirSizeBytes(this.worktreesDir) / (1024 * 1024);
    } catch {
      return 0;
    }
  }

  protected dirSizeBytes(dir: string): number {
    let total = 0;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (DISK_MEASURE_EXCLUDED_DIRS.has(entry)) {
        continue;
      }

      const full = join(dir, entry);
      try {
        const st = lstatSync(full, { bigint: false });
        if (st.isSymbolicLink()) {
          continue;
        }

        if (st.isDirectory()) {
          total += this.dirSizeBytes(full);
        } else {
          total += st.size;
        }
      } catch {
        // Symlinks or race conditions — skip.
      }
    }
    return total;
  }
}
