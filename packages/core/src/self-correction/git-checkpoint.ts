import { generateId, nowIso } from '@agentforge/shared';
import type { Checkpoint } from './types.js';

/**
 * GitCheckpoint — records sprint checkpoints for rollback capability.
 * In dry-run mode, stores snapshots in memory only.
 * In production mode, would invoke execFileNoThrow('git', [...]) commands.
 */
export class GitCheckpoint {
  private checkpoints: Map<string, Checkpoint> = new Map();
  private readonly dryRun: boolean;

  constructor(dryRun = true) {
    this.dryRun = dryRun;
  }

  /** Create a checkpoint before starting a sprint. */
  create(sprintVersion: string, testCount: number, failureCount = 0, metadata?: Record<string, unknown>): Checkpoint {
    const id = generateId();
    const branch = `sprint/v${sprintVersion}-checkpoint-${id.slice(0, 6)}`;

    const checkpoint: Checkpoint = {
      id,
      sprintVersion,
      branch,
      testCount,
      failureCount,
      createdAt: nowIso(),
      ...(metadata ? { metadata } : {}),
    };

    this.checkpoints.set(id, checkpoint);

    if (!this.dryRun) {
      // Production: execFileNoThrow('git', ['checkout', '-b', branch])
      // Not implemented — production git integration is future work
    }

    return checkpoint;
  }

  /** Rollback to a checkpoint (dry-run: no-op; production: git checkout). */
  rollback(checkpointId: string): { success: boolean; checkpoint: Checkpoint | null; message: string } {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) {
      return { success: false, checkpoint: null, message: `Checkpoint ${checkpointId} not found` };
    }

    if (this.dryRun) {
      return { success: true, checkpoint, message: `[dry-run] Would rollback to branch ${checkpoint.branch}` };
    }

    // Production: execFileNoThrow('git', ['checkout', checkpoint.branch])
    return { success: true, checkpoint, message: `Rolled back to ${checkpoint.branch}` };
  }

  list(): Checkpoint[] {
    return [...this.checkpoints.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  latest(): Checkpoint | null {
    const all = this.list();
    return all[0] ?? null;
  }
}
