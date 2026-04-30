import { generateId, nowIso } from '@agentforge/shared';
import { execFileSync } from 'node:child_process';
import type { Checkpoint } from './types.js';

export interface GitCheckpointOptions {
  dryRun?: boolean;
  cwd?: string;
  gitBin?: string;
  requireCleanTree?: boolean;
  force?: boolean;
}

interface NormalizedGitCheckpointOptions {
  dryRun: boolean;
  cwd: string;
  gitBin: string;
  requireCleanTree: boolean;
  force: boolean;
}

export class GitCheckpoint {
  private checkpoints: Map<string, Checkpoint> = new Map();
  private readonly opts: NormalizedGitCheckpointOptions;

  constructor(options: GitCheckpointOptions | boolean = true) {
    if (typeof options === 'boolean') {
      this.opts = {
        dryRun: options,
        cwd: process.cwd(),
        gitBin: 'git',
        requireCleanTree: true,
        force: false,
      };
      return;
    }

    const force = options.force ?? false;
    this.opts = {
      dryRun: options.dryRun ?? true,
      cwd: options.cwd ?? process.cwd(),
      gitBin: options.gitBin ?? 'git',
      requireCleanTree: options.requireCleanTree ?? !force,
      force,
    };
  }

  /** Create a checkpoint before starting a sprint. */
  create(sprintVersion: string, testCount: number, failureCount = 0, metadata?: Record<string, unknown>): Checkpoint {
    const id = generateId();
    const branch = `sprint/v${sanitizeBranchSegment(sprintVersion)}-checkpoint-${id.slice(0, 6)}`;
    let checkpointMetadata = metadata;

    if (!this.opts.dryRun) {
      this.assertGitRepo();
      if (this.opts.requireCleanTree) {
        this.assertCleanWorkingTree('create checkpoint');
      }

      const commit = this.git(['rev-parse', 'HEAD']).trim();
      this.git(['branch', branch, commit]);
      checkpointMetadata = { ...(metadata ?? {}), commit };
    }

    const checkpoint: Checkpoint = {
      id,
      sprintVersion,
      branch,
      testCount,
      failureCount,
      createdAt: nowIso(),
      ...(checkpointMetadata ? { metadata: checkpointMetadata } : {}),
    };

    this.checkpoints.set(id, checkpoint);

    return checkpoint;
  }

  /** Rollback to a checkpoint (dry-run: no-op; production: git checkout). */
  rollback(checkpointId: string): { success: boolean; checkpoint: Checkpoint | null; message: string } {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) {
      return { success: false, checkpoint: null, message: `Checkpoint ${checkpointId} not found` };
    }

    if (this.opts.dryRun) {
      return { success: true, checkpoint, message: `[dry-run] Would rollback to branch ${checkpoint.branch}` };
    }

    try {
      this.assertGitRepo();
      if (this.opts.requireCleanTree) {
        this.assertCleanWorkingTree('rollback');
      }
      this.git(this.opts.force ? ['checkout', '-f', checkpoint.branch] : ['checkout', checkpoint.branch]);
      return { success: true, checkpoint, message: `Rolled back to ${checkpoint.branch}` };
    } catch (error) {
      return {
        success: false,
        checkpoint,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  list(): Checkpoint[] {
    return [...this.checkpoints.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  latest(): Checkpoint | null {
    const all = this.list();
    return all[0] ?? null;
  }

  private assertGitRepo(): void {
    const result = this.git(['rev-parse', '--is-inside-work-tree']).trim();
    if (result !== 'true') {
      throw new Error(`Not a git work tree: ${this.opts.cwd}`);
    }
  }

  private assertCleanWorkingTree(operation: string): void {
    const status = this.git(['status', '--porcelain']);
    if (status.trim().length > 0) {
      throw new Error(`Cannot ${operation}: working tree is not clean`);
    }
  }

  private git(args: string[]): string {
    try {
      return execFileSync(this.opts.gitBin, args, {
        cwd: this.opts.cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const stderr = readExecStderr(error);
      const command = `${this.opts.gitBin} ${args.join(' ')}`;
      throw new Error(stderr ? `${command}: ${stderr}` : `Git command failed: ${command}`);
    }
  }
}

function sanitizeBranchSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'unknown';
}

function readExecStderr(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'stderr' in error &&
    Buffer.isBuffer((error as { stderr?: unknown }).stderr)
  ) {
    return ((error as { stderr: Buffer }).stderr).toString('utf8').trim();
  }
  return error instanceof Error ? error.message : '';
}
