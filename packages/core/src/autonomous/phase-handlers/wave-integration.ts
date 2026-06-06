// packages/core/src/autonomous/phase-handlers/wave-integration.ts
//
// Local integration-branch orchestration for epic wave execution (spec §8.2).
// A dedicated worktree holds codex/epic-<id> checked out; completed child
// branches are merged into it between waves so wave N+1 forks off wave N's
// code. Local-only (no remote required) — pushing happens at release (PR-2d).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout.toString();
}

/** Best-effort git that never throws (for cleanup / probe paths). */
async function gitSafe(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    return { ok: true, out: await git(cwd, args) };
  } catch (err) {
    return { ok: false, out: err instanceof Error ? err.message : String(err) };
  }
}

/** Derive the local integration branch name from an epic id. Slashes/dots stripped. */
export function epicIntegrationBranchName(parentEpicId: string): string {
  const safe = parentEpicId.replace(/[^a-zA-Z0-9-]/g, '');
  return `codex/${safe}`;
}

function integrationWorktreePath(projectRoot: string, branch: string): string {
  return join(projectRoot, '.agentforge', 'worktrees', `int-${branch.replace(/[\\/]/g, '-')}`);
}

/**
 * Ensure a local branch `branch` exists (created off `baseBranch` if absent) and
 * is checked out in a dedicated worktree. Idempotent — returns the worktree path.
 */
export async function ensureIntegrationWorktree(
  projectRoot: string,
  branch: string,
  baseBranch: string,
): Promise<string> {
  const wtPath = integrationWorktreePath(projectRoot, branch);
  if (existsSync(wtPath)) {
    // Reuse if it is the right branch; otherwise treat as fresh.
    const cur = await gitSafe(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (cur.ok && cur.out.trim() === branch) return wtPath;
  }
  mkdirSync(join(projectRoot, '.agentforge', 'worktrees'), { recursive: true });

  const branchExists = (await gitSafe(projectRoot, ['branch', '--list', branch])).out.trim().length > 0;
  if (!branchExists) {
    await git(projectRoot, ['branch', branch, baseBranch]);
  }
  await git(projectRoot, ['worktree', 'add', '--force', wtPath, branch]);
  return wtPath;
}

/**
 * Merge each branch in `childBranches` into the integration branch checked out
 * at `intWorktreePath`, in order. A conflicting merge is aborted (leaving the
 * working tree clean) and recorded in `conflicted`; remaining branches still
 * merge. Uses --no-ff so each child is a distinct merge commit.
 */
export async function mergeBranchesIntoIntegration(
  intWorktreePath: string,
  childBranches: string[],
): Promise<{ merged: string[]; conflicted: string[] }> {
  const merged: string[] = [];
  const conflicted: string[] = [];
  // Merge commits need an identity; set a local one in case the worktree lacks it.
  await gitSafe(intWorktreePath, ['config', 'user.email', 'autonomous@agentforge.local']);
  await gitSafe(intWorktreePath, ['config', 'user.name', 'AgentForge Epic Integrator']);

  for (const branch of childBranches) {
    const res = await gitSafe(intWorktreePath, ['merge', '--no-ff', '-m', `merge ${branch}`, branch]);
    if (res.ok) {
      merged.push(branch);
    } else {
      conflicted.push(branch);
      // Abort the in-progress merge so the worktree stays clean for the next branch.
      await gitSafe(intWorktreePath, ['merge', '--abort']);
    }
  }
  return { merged, conflicted };
}

/** Resolve the deterministic worktree path for an integration branch. Exported so
 *  the release path can read the integrated HEAD before the worktree is removed. */
export function integrationWorktreePathFor(projectRoot: string, branch: string): string {
  return integrationWorktreePath(projectRoot, branch);
}

/** True when an `origin` remote is configured for the repo at `cwd`. */
async function hasOriginRemote(cwd: string): Promise<boolean> {
  const res = await gitSafe(cwd, ['remote']);
  if (!res.ok) return false;
  return res.out.split('\n').map((s) => s.trim()).includes('origin');
}

/**
 * Result of pushing the integration branch at release time.
 *   - `pushed`   — true when the branch was force-pushed to origin.
 *   - `skipped`  — true when no `origin` remote exists (local-only repo / tests).
 *   - `headSha`  — the integration branch HEAD commit (best-effort, '' if unknown).
 *   - `error`    — populated only when the push attempt threw.
 */
export interface IntegrationPushResult {
  pushed: boolean;
  skipped: boolean;
  headSha: string;
  error?: string;
}

/**
 * Push the local integration branch `branch` to origin with an explicit refspec
 * (PR-2d / P0.4). Runs `git` via execFile from `projectRoot` — no shell, no
 * interpolation of the branch into a command string. Force-with-lease keeps the
 * push safe against a concurrently-advanced remote. Skips cleanly when no origin
 * remote is configured (mirrors agent-commit's local-repo behaviour) so unit
 * tests on bare local repos don't fail. Never throws — failures are reported in
 * the result so the caller can still open the PR / clean up deterministically.
 */
export async function pushIntegrationBranch(
  projectRoot: string,
  branch: string,
): Promise<IntegrationPushResult> {
  const headRes = await gitSafe(projectRoot, ['rev-parse', branch]);
  const headSha = headRes.ok ? headRes.out.trim() : '';

  if (!(await hasOriginRemote(projectRoot))) {
    return { pushed: false, skipped: true, headSha };
  }

  // Explicit refspec local-branch → remote-branch; no shell interpolation.
  const res = await gitSafe(projectRoot, [
    'push',
    '--force-with-lease',
    'origin',
    `${branch}:${branch}`,
  ]);
  if (res.ok) {
    return { pushed: true, skipped: false, headSha };
  }
  return { pushed: false, skipped: false, headSha, error: res.out };
}

/** Remove the integration worktree (best-effort). The branch is kept for release. */
export async function removeIntegrationWorktree(projectRoot: string, branch: string): Promise<void> {
  const wtPath = integrationWorktreePath(projectRoot, branch);
  await gitSafe(projectRoot, ['worktree', 'remove', '--force', wtPath]);
  await gitSafe(projectRoot, ['worktree', 'prune']);
}
