import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { WorktreeHandle, WorktreePoolStats } from './worktree-pool-types.js';

const execFile = promisify(execFileCb);

/** Replace any character outside [a-zA-Z0-9_-] with an underscore. */
function sanitize(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function normalizeBranchPrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (!trimmed) return 'autonomous/';
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

/** Resolve a path to its real path, following symlinks.  Falls back to the
 *  original if the path does not (yet) exist on disk. */
function realPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, windowsHide: true });
  return stdout;
}

export interface WorktreePoolOptions {
  projectRoot: string;
  baseBranch?: string;
  branchPrefix?: string;
  rootDir?: string;
}

export class WorktreePool {
  private readonly projectRoot: string;
  private readonly baseBranch: string;
  private readonly branchPrefix: string;
  private readonly rootDir: string;

  private readonly handles = new Map<string, WorktreeHandle>();
  private stats: WorktreePoolStats = {
    active: 0,
    totalAllocations: 0,
    totalReleases: 0,
    totalGcd: 0,
  };

  /**
   * Serialise git worktree mutations to avoid `.git/config` and
   * `.git/worktrees` races on Windows. Even when add uses --no-track, git
   * still writes worktree metadata that can race under parallel allocation.
   */
  private gitMutex: Promise<unknown> = Promise.resolve();

  constructor(opts: WorktreePoolOptions) {
    this.projectRoot = resolve(opts.projectRoot);
    this.baseBranch = opts.baseBranch ?? 'main';
    this.branchPrefix = normalizeBranchPrefix(opts.branchPrefix ?? 'autonomous/');
    this.rootDir = opts.rootDir ?? '.agentforge/worktrees';
  }

  /** Enqueue a git-mutating task so `.git/config` writes never race. */
  private enqueueGitOp<T>(task: () => Promise<T>): Promise<T> {
    const next = this.gitMutex.then(() => task());
    // Suppress unhandled-rejection on the mutex chain itself.
    this.gitMutex = next.catch(() => undefined);
    return next;
  }

  /**
   * Allocate (or reuse) a worktree for the given agent/session pair.
   * Idempotent: if the worktree already exists, returns the existing handle.
   */
  async allocate(opts: { agentId: string; sessionId: string }): Promise<WorktreeHandle> {
    const safeAgent = sanitize(opts.agentId);
    const safeSession = sanitize(opts.sessionId);
    const id = `agent-${safeAgent}-${safeSession}`;

    // Idempotent: return cached handle if already allocated in this pool instance.
    const cached = this.handles.get(id);
    if (cached) {
      return cached;
    }

    const wtPath = join(this.projectRoot, this.rootDir, id);
    const branch = `${this.branchPrefix}agent-${safeAgent}-${safeSession}`;

    // If the directory already exists the worktree was previously created
    // (e.g. by another process or a prior run). Only reuse it when git still
    // knows about it; stale copied directories can contain node_modules
    // junctions and must not be treated as runnable worktrees.
    if (existsSync(wtPath)) {
      const registered = await this.isRegisteredWorktreePath(wtPath);
      if (!registered) {
        throw new Error(
          `Existing path ${wtPath} is not a registered git worktree; remove or archive it before allocating ${id}.`,
        );
      }

      const handle: WorktreeHandle = {
        id,
        path: wtPath,
        branch,
        allocatedAt: new Date().toISOString(),
        agentId: opts.agentId,
        sessionId: opts.sessionId,
      };
      this.handles.set(id, handle);
      this.stats.active += 1;
      this.stats.totalAllocations += 1;
      return handle;
    }

    // Ensure the parent directory exists.
    const parentDir = join(this.projectRoot, this.rootDir);
    mkdirSync(parentDir, { recursive: true });

    await this.enqueueGitOp(async () => {
      // Check if the branch already exists in the repository while holding the
      // git mutation lock so concurrent allocators don't race branch creation.
      let branchExists = false;
      try {
        const out = await git(this.projectRoot, ['branch', '--list', branch]);
        branchExists = out.trim().length > 0;
      } catch {
        branchExists = false;
      }

      if (branchExists) {
        // Branch exists but no worktree directory — just check it out into a
        // worktree. --no-track is only valid when git is creating a new branch.
        await git(this.projectRoot, ['worktree', 'add', wtPath, branch]);
      } else {
        // Create the branch and worktree together off origin/baseBranch.
        // --no-track avoids writing upstream metadata; agents push with
        // explicit refspecs so tracking is not needed.
        await git(this.projectRoot, [
          'worktree',
          'add',
          '--no-track',
          '-b',
          branch,
          wtPath,
          `origin/${this.baseBranch}`,
        ]);
      }
    });

    const handle: WorktreeHandle = {
      id,
      path: wtPath,
      branch,
      allocatedAt: new Date().toISOString(),
      agentId: opts.agentId,
      sessionId: opts.sessionId,
    };

    this.handles.set(id, handle);
    this.stats.active += 1;
    this.stats.totalAllocations += 1;
    return handle;
  }

  /**
   * Release a worktree by its id.
   * Removes the worktree directory; deletes the branch only if it has no
   * unmerged commits (warns and leaves the branch alone otherwise).
   */
  async release(id: string): Promise<void> {
    const handle = this.handles.get(id);
    if (!handle) {
      // Nothing to do — already released or never allocated.
      return;
    }

    // Serialise via mutex to avoid .git/config lock races during parallel releases.
    await this.enqueueGitOp(async () => {
      // Remove the worktree checkout.
      try {
        await git(this.projectRoot, ['worktree', 'remove', '--force', handle.path]);
      } catch (err) {
        // If the path doesn't exist anymore, git will error — that's fine.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('is not a working tree') && !msg.includes('No such file')) {
          throw err;
        }
      }

      // Prune stale worktree entries.
      try {
        await git(this.projectRoot, ['worktree', 'prune']);
      } catch {
        // Non-fatal.
      }

      // Attempt to delete the branch. If the branch has unmerged commits, warn
      // and leave it for forensics.
      try {
        // -d (lowercase) refuses to delete branches with unmerged commits.
        await git(this.projectRoot, ['branch', '-d', handle.branch]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Check for the canonical git error messages for unmerged branches.
        if (
          msg.includes('not fully merged') ||
          msg.includes('is not fully merged')
        ) {
          console.warn(
            `[WorktreePool] Branch ${handle.branch} has unmerged commits — leaving branch intact.`,
          );
        }
        // If the branch simply doesn't exist (already deleted), that is fine.
      }
    });

    this.handles.delete(id);
    this.stats.active = Math.max(0, this.stats.active - 1);
    this.stats.totalReleases += 1;
  }

  /**
   * Parse `git worktree list --porcelain` and return handles for all worktrees
   * that live under this pool's rootDir.
   */
  async listActive(): Promise<WorktreeHandle[]> {
    const out = await git(this.projectRoot, ['worktree', 'list', '--porcelain']);
    // Resolve symlinks so macOS /tmp → /private/tmp comparisons work correctly.
    const absoluteRootDir = realPath(join(this.projectRoot, this.rootDir));

    const worktrees: WorktreeHandle[] = [];

    // Parse porcelain blocks separated by blank lines.
    const blocks = out.trim().split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.trim().split('\n');
      const pathLine = lines.find((l) => l.startsWith('worktree '));
      const branchLine = lines.find((l) => l.startsWith('branch '));

      if (!pathLine) continue;
      // Resolve reported path so symlink comparison is reliable.
      const wtPath = realPath(pathLine.slice('worktree '.length).trim());

      // Only include worktrees under our rootDir.
      const relativePath = relative(absoluteRootDir, wtPath);
      if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
        continue;
      }

      const branch = branchLine
        ? branchLine.replace('branch refs/heads/', '').trim()
        : '';

      // Derive the id from the directory name.
      const dirName = basename(wtPath);

      // Try to find the cached handle for richer metadata.
      const cached = this.handles.get(dirName);
      if (cached) {
        worktrees.push(cached);
        continue;
      }

      // Reconstruct a minimal handle from what we can parse.
      // id format: agent-<agentId>-<sessionId>
      const idMatch = dirName.match(/^agent-(.+)-([^-]+)$/);
      worktrees.push({
        id: dirName,
        path: wtPath,
        branch,
        allocatedAt: new Date(0).toISOString(), // unknown
        agentId: idMatch ? idMatch[1] ?? dirName : dirName,
        sessionId: idMatch ? (idMatch[2] ?? '') : '',
      });
    }

    return worktrees;
  }

  /**
   * Garbage-collect old worktrees.
   * - Removes worktrees older than `olderThanMs` (default 24 h).
   * - If `keepLast` is set, only the most recent N are retained (by allocatedAt).
   * - Worktrees with unmerged/unpushed commits are skipped.
   */
  async gc(opts: { keepLast?: number; olderThanMs?: number } = {}): Promise<{ removed: string[] }> {
    const olderThanMs = opts.olderThanMs ?? 24 * 60 * 60 * 1000;
    const keepLast = opts.keepLast;

    const active = await this.listActive();
    const removed: string[] = [];

    // Combine cached handles (richer metadata) with live list.
    const candidates: WorktreeHandle[] = active.map((wt) => {
      const cached = this.handles.get(wt.id);
      return cached ?? wt;
    });

    // Sort by allocatedAt ascending (oldest first).
    candidates.sort(
      (a, b) => new Date(a.allocatedAt).getTime() - new Date(b.allocatedAt).getTime(),
    );

    // Determine which to remove.
    const now = Date.now();
    let toRemove: WorktreeHandle[];

    if (keepLast !== undefined) {
      // Remove all but the keepLast most recent.
      const excess = candidates.length - keepLast;
      toRemove = excess > 0 ? candidates.slice(0, excess) : [];
    } else {
      toRemove = candidates.filter(
        (wt) => now - new Date(wt.allocatedAt).getTime() > olderThanMs,
      );
    }

    for (const wt of toRemove) {
      // Safety check: skip if the branch has unmerged/unpushed commits.
      const hasWork = await this.branchHasUnpushedWork(wt);
      if (hasWork) {
        console.warn(
          `[WorktreePool] GC skipping ${wt.id} — branch ${wt.branch} has unpushed work.`,
        );
        continue;
      }

      await this.release(wt.id);
      removed.push(wt.id);
      this.stats.totalGcd += 1;
    }

    return { removed };
  }

  /** Returns current pool statistics. */
  getStats(): WorktreePoolStats {
    return { ...this.stats };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns true if the worktree's branch has commits not yet merged into
   * origin/baseBranch, or has uncommitted changes.
   */
  private async branchHasUnpushedWork(wt: WorktreeHandle): Promise<boolean> {
    // Check for uncommitted changes in the worktree directory.
    if (existsSync(wt.path)) {
      try {
        const status = await git(wt.path, ['status', '--porcelain']);
        if (status.trim().length > 0) return true;
      } catch {
        // If we can't read status, be conservative and say there is work.
        return true;
      }
    }

    // Check for commits not in origin/baseBranch.
    try {
      const log = await git(this.projectRoot, [
        'log',
        `origin/${this.baseBranch}..${wt.branch}`,
        '--oneline',
      ]);
      return log.trim().length > 0;
    } catch {
      // Branch might not exist remotely yet — treat as having unpushed work.
      return false;
    }
  }

  private async isRegisteredWorktreePath(path: string): Promise<boolean> {
    let out: string;
    try {
      out = await git(this.projectRoot, ['worktree', 'list', '--porcelain']);
    } catch {
      return false;
    }

    const expected = realPath(path);
    const blocks = out.trim().split(/\n\n+/);
    for (const block of blocks) {
      const pathLine = block
        .trim()
        .split('\n')
        .find((line) => line.startsWith('worktree '));
      if (!pathLine) continue;
      if (realPath(pathLine.slice('worktree '.length).trim()) === expected) {
        return true;
      }
    }

    return false;
  }

}
