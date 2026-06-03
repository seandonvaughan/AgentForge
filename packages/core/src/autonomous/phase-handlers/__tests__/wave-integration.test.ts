import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  epicIntegrationBranchName,
  ensureIntegrationWorktree,
  mergeBranchesIntoIntegration,
} from '../wave-integration.js';

function g(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).toString();
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'af-waveint-'));
  g(root, ['init', '-q', '-b', 'main']);
  g(root, ['config', 'user.email', 't@t.t']);
  g(root, ['config', 'user.name', 'T']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  g(root, ['add', '.']); g(root, ['commit', '-q', '-m', 'base']);
  return root;
}

/** Create a child branch off main that adds one disjoint file, mimicking commitAgentWork. */
function makeChildBranch(root: string, branch: string, file: string): void {
  g(root, ['branch', branch, 'main']);
  const wt = join(root, `.wt-${branch.replace(/\//g, '-')}`);
  g(root, ['worktree', 'add', '-q', wt, branch]);
  writeFileSync(join(wt, file), `content of ${file}\n`);
  g(wt, ['add', '.']); g(wt, ['commit', '-q', '-m', `add ${file}`]);
  g(root, ['worktree', 'remove', '--force', wt]);
}

describe('epicIntegrationBranchName', () => {
  it('derives a safe local branch name', () => {
    expect(epicIntegrationBranchName('epic-abc12345')).toBe('codex/epic-abc12345');
  });
  it('strips unsafe chars', () => {
    expect(epicIntegrationBranchName('epic-../x')).toBe('codex/epic-x');
  });
});

describe('ensureIntegrationWorktree', () => {
  it('creates the local branch off baseBranch + a worktree checked out on it', async () => {
    const root = initRepo();
    const branch = 'codex/epic-test1';
    const wt = await ensureIntegrationWorktree(root, branch, 'main');
    expect(existsSync(wt)).toBe(true);
    expect(g(wt, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(branch);
    // idempotent: a second call returns the same path without error
    const wt2 = await ensureIntegrationWorktree(root, branch, 'main');
    expect(wt2).toBe(wt);
  });
});

describe('mergeBranchesIntoIntegration', () => {
  it('merges disjoint child branches into the integration branch', async () => {
    const root = initRepo();
    makeChildBranch(root, 'codex/c1', 'a.ts');
    makeChildBranch(root, 'codex/c2', 'b.ts');
    const branch = 'codex/epic-test2';
    const wt = await ensureIntegrationWorktree(root, branch, 'main');
    const result = await mergeBranchesIntoIntegration(wt, ['codex/c1', 'codex/c2']);
    expect(result.merged.sort()).toEqual(['codex/c1', 'codex/c2']);
    expect(result.conflicted).toEqual([]);
    expect(existsSync(join(wt, 'a.ts'))).toBe(true);
    expect(existsSync(join(wt, 'b.ts'))).toBe(true);
  });

  it('reports a conflicted branch without aborting the others', async () => {
    const root = initRepo();
    // Two branches that both modify base.txt → conflict on the second merge.
    g(root, ['branch', 'codex/x1', 'main']);
    g(root, ['branch', 'codex/x2', 'main']);
    for (const [b, txt] of [['codex/x1', 'x1\n'], ['codex/x2', 'x2\n']] as const) {
      const wt = join(root, `.wt-${b.replace(/\//g, '-')}`);
      g(root, ['worktree', 'add', '-q', wt, b]);
      writeFileSync(join(wt, 'base.txt'), txt);
      g(wt, ['add', '.']); g(wt, ['commit', '-q', '-m', b]);
      g(root, ['worktree', 'remove', '--force', wt]);
    }
    const wt = await ensureIntegrationWorktree(root, 'codex/epic-test3', 'main');
    const result = await mergeBranchesIntoIntegration(wt, ['codex/x1', 'codex/x2']);
    expect(result.merged).toEqual(['codex/x1']);
    expect(result.conflicted).toEqual(['codex/x2']);
    // working tree is clean after the aborted conflicting merge
    expect(g(wt, ['status', '--porcelain']).trim()).toBe('');
  });
});
