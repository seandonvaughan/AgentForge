// P0.6 deliverable (g) — integration-branch + worktree reuse on an epic
// gate-retry. On a retry, execute re-runs only the faulted items, but
// codex/epic-<id> AND its worktree may already exist from attempt 1 (the
// integration worktree is only removed in the release stage, which never ran on
// a rejected attempt). This test verifies that calling ensureIntegrationWorktree
// a second time (with the worktree still checked out) and re-merging an
// already-merged child are both safe no-ops — i.e. the existing primitives are
// idempotent and need no fix.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureIntegrationWorktree,
  mergeBranchesIntoIntegration,
} from '../wave-integration.js';

function g(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).toString();
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'af-waveint-retry-'));
  g(root, ['init', '-q', '-b', 'main']);
  g(root, ['config', 'user.email', 't@t.t']);
  g(root, ['config', 'user.name', 'T']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  g(root, ['add', '.']);
  g(root, ['commit', '-q', '-m', 'base']);
  return root;
}

function makeChildBranch(root: string, branch: string, file: string): void {
  g(root, ['branch', branch, 'main']);
  const wt = join(root, `.wt-${branch.replace(/\//g, '-')}`);
  g(root, ['worktree', 'add', '-q', wt, branch]);
  writeFileSync(join(wt, file), `content of ${file}\n`);
  g(wt, ['add', '.']);
  g(wt, ['commit', '-q', '-m', `add ${file}`]);
  g(root, ['worktree', 'remove', '--force', wt]);
}

describe('P0.6(g) — integration worktree reuse on epic gate-retry', () => {
  it('ensureIntegrationWorktree is idempotent when the worktree from attempt 1 still exists', async () => {
    const root = initRepo();
    const branch = 'codex/epic-retry1';

    // Attempt 1: create the integration worktree and merge one child.
    makeChildBranch(root, 'codex/c1', 'a.ts');
    const wt1 = await ensureIntegrationWorktree(root, branch, 'main');
    const m1 = await mergeBranchesIntoIntegration(wt1, ['codex/c1']);
    expect(m1.merged).toEqual(['codex/c1']);
    expect(existsSync(join(wt1, 'a.ts'))).toBe(true);

    // Gate REJECTS — release never runs, so the worktree is NOT removed.
    // Attempt 2 (the fix-up retry) re-enters execute and calls ensure again.
    const wt2 = await ensureIntegrationWorktree(root, branch, 'main');
    // Same path returned, no throw, branch still checked out, prior work intact.
    expect(wt2).toBe(wt1);
    expect(g(wt2, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(branch);
    expect(existsSync(join(wt2, 'a.ts'))).toBe(true);
  });

  it('re-merging an already-merged child is a clean no-op (Already up to date)', async () => {
    const root = initRepo();
    const branch = 'codex/epic-retry2';
    makeChildBranch(root, 'codex/c1', 'a.ts');

    const wt = await ensureIntegrationWorktree(root, branch, 'main');
    const first = await mergeBranchesIntoIntegration(wt, ['codex/c1']);
    expect(first.merged).toEqual(['codex/c1']);

    // Retry re-merges the same (unchanged) child branch — git reports
    // "Already up to date" and exits 0, so it is recorded as merged, not
    // conflicted, and the working tree stays clean.
    const second = await mergeBranchesIntoIntegration(wt, ['codex/c1']);
    expect(second.merged).toEqual(['codex/c1']);
    expect(second.conflicted).toEqual([]);
    expect(g(wt, ['status', '--porcelain']).trim()).toBe('');
  });

  it('a NEW faulted-item child branch merges cleanly into the reused integration branch on retry', async () => {
    const root = initRepo();
    const branch = 'codex/epic-retry3';

    // Attempt 1: child c1 lands.
    makeChildBranch(root, 'codex/c1', 'a.ts');
    const wt1 = await ensureIntegrationWorktree(root, branch, 'main');
    await mergeBranchesIntoIntegration(wt1, ['codex/c1']);

    // Attempt 2: the faulted item re-executes and produces a NEW branch c1b
    // (a fresh fix-up branch off main with a disjoint file). The reused
    // integration worktree merges it on top of attempt 1's work.
    makeChildBranch(root, 'codex/c1b', 'a-fix.ts');
    const wt2 = await ensureIntegrationWorktree(root, branch, 'main');
    const m = await mergeBranchesIntoIntegration(wt2, ['codex/c1b']);
    expect(m.merged).toEqual(['codex/c1b']);
    // Both attempt 1's file and attempt 2's fix-up are present on the branch.
    expect(existsSync(join(wt2, 'a.ts'))).toBe(true);
    expect(existsSync(join(wt2, 'a-fix.ts'))).toBe(true);
  });
});
