/**
 * MergeQueueConflictResolver — Cycle 4 / T4.4
 *
 * Classifies merge conflicts between an agent branch and a parent branch
 * WITHOUT modifying the parent tree. Strategy:
 *
 *   1. Add a temporary git worktree off parentBranch.
 *   2. Attempt `git merge --no-commit --no-ff <branch>` inside it.
 *   3. Inspect conflicting files to classify the conflict type.
 *   4. `git merge --abort` to clean up.
 *   5. Remove the temporary worktree.
 *
 * Classification rules (applied in order; first match wins):
 *   - No conflicting files → 'clean'
 *   - Any file ends in `.jsonl` → 'append-only'
 *   - Any file ends in `.db` or `.sqlite` → 'sqlite-binary'
 *   - File is `package-lock.json`, `pnpm-lock.yaml`, or `Cargo.lock` → 'lockfile'
 *   - Anything else → 'non-trivial'
 */

import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConflictType = 'clean' | 'append-only' | 'sqlite-binary' | 'lockfile' | 'non-trivial';

export interface ConflictReport {
  type: ConflictType;
  conflictingFiles: string[];
  suggestedResolution: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RESOLUTION_SUGGESTIONS: Record<ConflictType, string> = {
  clean: 'No conflicts — merge may proceed automatically.',
  'append-only':
    'Concat the JSONL files: sort by timestamp and deduplicate by entry id.',
  'sqlite-binary':
    'Accept incoming version and replay pending WAL entries from the base if required.',
  lockfile:
    'Regenerate the lock file by running the package manager install command (e.g. pnpm install).',
  'non-trivial':
    'Manual resolution required. Open a follow-up ticket and assign to the relevant coder agent.',
};

const LOCKFILE_NAMES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'Cargo.lock']);

function classifyFile(filename: string): ConflictType | null {
  const base = filename.split('/').pop() ?? filename;

  if (LOCKFILE_NAMES.has(base)) return 'lockfile';

  const ext = base.includes('.') ? '.' + base.split('.').pop()! : '';
  if (ext === '.jsonl') return 'append-only';
  if (ext === '.db' || ext === '.sqlite') return 'sqlite-binary';

  return null;
}

function classifyFiles(files: string[]): ConflictType {
  if (files.length === 0) return 'clean';

  // Rank: append-only < sqlite-binary < lockfile < non-trivial
  // Return the *most specific* deterministic category, but if any file is
  // non-trivial the whole conflict is non-trivial (escalate up).
  let result: ConflictType = 'non-trivial';

  for (const f of files) {
    const c = classifyFile(f);
    if (c === null) {
      // Unclassified file → non-trivial
      return 'non-trivial';
    }
    // Accept the first classified type but keep escalating if needed
    if (result === 'non-trivial') {
      result = c;
    } else if (result !== c) {
      // Mixed types → non-trivial
      return 'non-trivial';
    }
  }

  return result;
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFile('git', args, { cwd });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify the merge conflict (if any) between `branch` and `parentBranch`
 * without modifying the parent working tree.
 */
export async function classifyConflict(opts: {
  projectRoot: string;
  branch: string;
  parentBranch: string;
}): Promise<ConflictReport> {
  const { projectRoot, branch, parentBranch } = opts;

  // Create a unique temporary worktree so we never pollute projectRoot
  const wtDir = join(tmpdir(), `agentforge-conflict-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  mkdirSync(wtDir, { recursive: true });

  try {
    // Add a worktree checked out to parentBranch
    await git(projectRoot, ['worktree', 'add', '--detach', wtDir, parentBranch]);

    // Attempt the merge (no-commit, no-ff so we can inspect conflicts)
    let mergeClean = true;
    try {
      await git(wtDir, ['merge', '--no-commit', '--no-ff', branch]);
    } catch {
      // Non-zero exit from git merge means there are conflicts (or the branch
      // isn't reachable), but it may still have written conflict markers.
      mergeClean = false;
    }

    if (mergeClean) {
      // Merge succeeded without conflict — abort to leave state clean
      try {
        await git(wtDir, ['merge', '--abort']);
      } catch {
        // If there is nothing to abort (fast-forward result), that is fine.
        // Reset to HEAD to make the tree clean before we remove the worktree.
        try {
          await git(wtDir, ['reset', '--hard', 'HEAD']);
        } catch {
          // ignore
        }
      }

      return {
        type: 'clean',
        conflictingFiles: [],
        suggestedResolution: RESOLUTION_SUGGESTIONS.clean,
      };
    }

    // Collect conflicting files from `git status --porcelain`
    const { stdout: statusOut } = await git(wtDir, ['status', '--porcelain']);
    const conflictingFiles: string[] = [];

    for (const line of statusOut.split('\n')) {
      const xy = line.slice(0, 2);
      const filepath = line.slice(3).trim();
      // Status codes that indicate merge conflict: UU, AA, DD, AU, UA, DU, UD
      if (/^(UU|AA|DD|AU|UA|DU|UD)/.test(xy) && filepath) {
        conflictingFiles.push(filepath);
      }
    }

    // Classify conflict type
    const type = classifyFiles(conflictingFiles);

    // Always abort so the worktree is clean before removal
    try {
      await git(wtDir, ['merge', '--abort']);
    } catch {
      // If abort fails (e.g. not in merge state), reset hard
      try {
        await git(wtDir, ['reset', '--hard', 'HEAD']);
      } catch {
        // ignore
      }
    }

    return {
      type,
      conflictingFiles,
      suggestedResolution: RESOLUTION_SUGGESTIONS[type],
    };
  } finally {
    // Remove the temporary worktree
    try {
      await git(projectRoot, ['worktree', 'remove', '--force', wtDir]);
    } catch {
      // Fall back to manual deletion if git worktree remove fails
    }

    if (existsSync(wtDir)) {
      try {
        rmSync(wtDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    }

    // Prune stale worktree references
    try {
      await git(projectRoot, ['worktree', 'prune']);
    } catch {
      // non-fatal
    }
  }
}
