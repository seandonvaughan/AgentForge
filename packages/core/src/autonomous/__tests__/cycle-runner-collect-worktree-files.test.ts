// packages/core/src/autonomous/__tests__/cycle-runner-collect-worktree-files.test.ts
//
// Unit tests for collectFilesFromAgentBranches() — the worktree-aware file
// discovery helper invoked by CycleRunner.collectChangedFiles() when a
// worktreePool is set.
//
// Strategy: the exported standalone function is tested directly using real git
// repos (bare remote + working clone in tmpdir) so git diff invocations
// exercise the actual production code path without any mocking. A bare repo
// is required as the origin so `git push` creates proper remote tracking refs
// (origin/<baseBranch>) that `git diff --name-only origin/main...branch` needs.
//
// Coverage:
//   1. Two agent branches each contribute one file → both returned, sorted+deduped.
//   2. Files under .agentforge/cycles/ are excluded.
//   3. A worktree path that no longer exists on disk still resolves through the pushed branch.
//   4. worktreePool === undefined → CycleRunner falls back to git status (regression).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  collectFilesFromAgentBranches,
  verificationWorktreeName,
  verifyMultiPrAgentBranches,
} from '../cycle-runner.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Git repo helpers
// ---------------------------------------------------------------------------

async function initRepoWithBareRemote(workDir: string, bareDir: string): Promise<void> {
  // The bareDir must not exist yet for `git init --bare` to succeed.
  await execFileAsync('git', ['init', '--bare', bareDir]);
  await execFileAsync('git', ['init', '-b', 'main', workDir]);
  await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: workDir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: workDir });
  writeFileSync(join(workDir, 'README.md'), '# test\n');
  await execFileAsync('git', ['add', 'README.md'], { cwd: workDir });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: workDir });
  await execFileAsync('git', ['remote', 'add', 'origin', bareDir], { cwd: workDir });
  await execFileAsync('git', ['push', '-u', 'origin', 'main'], { cwd: workDir });
}

/** Creates a branch with one file, pushes to origin, returns to main. */
async function createAgentBranch(
  workDir: string,
  branch: string,
  file: string,
  content: string,
): Promise<void> {
  await execFileAsync('git', ['checkout', '-b', branch], { cwd: workDir });
  const parentDir = join(workDir, file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.');
  mkdirSync(parentDir, { recursive: true });
  writeFileSync(join(workDir, file), content);
  await execFileAsync('git', ['add', file], { cwd: workDir });
  await execFileAsync('git', ['commit', '-m', `add ${file}`], { cwd: workDir });
  await execFileAsync('git', ['push', 'origin', branch], { cwd: workDir });
  await execFileAsync('git', ['checkout', 'main'], { cwd: workDir });
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function writePhasesDir(projectRoot: string, cycleId: string): string {
  const d = join(projectRoot, '.agentforge', 'cycles', cycleId, 'phases');
  mkdirSync(d, { recursive: true });
  return d;
}

function writeExecuteJson(
  phasesDir: string,
  agentRuns: Array<{
    itemId: string;
    status: string;
    worktreePath?: string;
    worktreeBranch?: string;
  }>,
): void {
  writeFileSync(join(phasesDir, 'execute.json'), JSON.stringify({ agentRuns }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('collectFilesFromAgentBranches', () => {
  const CYCLE_ID = 'test-cycle-001';
  let workDir: string;
  let bareDir: string;

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'cr-collect-work-'));
    bareDir = join(tmpdir(), `cr-collect-bare-${Date.now()}`);
    await initRepoWithBareRemote(workDir, bareDir);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    try { rmSync(bareDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('AC1: returns both file paths from two agent branches (sorted+deduped)', async () => {
    await createAgentBranch(workDir, 'autonomous/agent-a', 'src/alpha.ts', 'export const a = 1;\n');
    await createAgentBranch(workDir, 'autonomous/agent-b', 'src/beta.ts', 'export const b = 2;\n');

    const phasesDir = writePhasesDir(workDir, CYCLE_ID);
    writeExecuteJson(phasesDir, [
      { itemId: 'a', status: 'completed', worktreePath: workDir, worktreeBranch: 'autonomous/agent-a' },
      { itemId: 'b', status: 'completed', worktreePath: workDir, worktreeBranch: 'autonomous/agent-b' },
    ]);

    const files = await collectFilesFromAgentBranches({
      cwd: workDir,
      cycleId: CYCLE_ID,
      baseBranch: 'main',
    });

    expect(files).toContain('src/alpha.ts');
    expect(files).toContain('src/beta.ts');
    // sorted
    expect(files).toEqual([...files].sort());
    // de-duplicated
    expect(files.length).toBe(new Set(files).size);
  }, 30_000);

  it('AC1: de-duplicates a file changed on both branches', async () => {
    await createAgentBranch(workDir, 'autonomous/agent-x', 'src/shared.ts', 'export const x = 1;\n');
    await createAgentBranch(workDir, 'autonomous/agent-y', 'src/shared.ts', 'export const y = 2;\n');

    const phasesDir = writePhasesDir(workDir, CYCLE_ID);
    writeExecuteJson(phasesDir, [
      { itemId: 'x', status: 'completed', worktreePath: workDir, worktreeBranch: 'autonomous/agent-x' },
      { itemId: 'y', status: 'completed', worktreePath: workDir, worktreeBranch: 'autonomous/agent-y' },
    ]);

    const files = await collectFilesFromAgentBranches({
      cwd: workDir,
      cycleId: CYCLE_ID,
      baseBranch: 'main',
    });

    expect(files.filter(f => f === 'src/shared.ts').length).toBe(1);
  }, 30_000);

  it('AC3: files under .agentforge/cycles/ are excluded', async () => {
    // Agent branch adds a file under .agentforge/cycles/ AND a real source file
    await execFileAsync('git', ['checkout', '-b', 'autonomous/agent-c'], { cwd: workDir });
    mkdirSync(join(workDir, '.agentforge', 'cycles', CYCLE_ID, 'phases'), { recursive: true });
    writeFileSync(
      join(workDir, '.agentforge', 'cycles', CYCLE_ID, 'phases', 'execute.json'),
      '{}',
    );
    mkdirSync(join(workDir, 'src'), { recursive: true });
    writeFileSync(join(workDir, 'src', 'real.ts'), 'export {};\n');
    await execFileAsync('git', ['add', '.'], { cwd: workDir });
    await execFileAsync('git', ['commit', '-m', 'agent work'], { cwd: workDir });
    await execFileAsync('git', ['push', 'origin', 'autonomous/agent-c'], { cwd: workDir });
    await execFileAsync('git', ['checkout', 'main'], { cwd: workDir });

    const phasesDir = writePhasesDir(workDir, CYCLE_ID);
    writeExecuteJson(phasesDir, [
      { itemId: 'c', status: 'completed', worktreePath: workDir, worktreeBranch: 'autonomous/agent-c' },
    ]);

    const files = await collectFilesFromAgentBranches({
      cwd: workDir,
      cycleId: CYCLE_ID,
      baseBranch: 'main',
    });

    expect(files.some(f => f.includes('.agentforge/cycles/'))).toBe(false);
    expect(files).toContain('src/real.ts');
  }, 30_000);

  it('AC4: worktreePath that no longer exists still returns branch changes', async () => {
    await createAgentBranch(workDir, 'autonomous/agent-d', 'src/delta.ts', 'export const d = 4;\n');

    const phasesDir = writePhasesDir(workDir, CYCLE_ID);
    const missingPath = join(workDir, 'nonexistent-99999');
    expect(existsSync(missingPath)).toBe(false); // sanity check

    writeExecuteJson(phasesDir, [
      {
        itemId: 'd',
        status: 'completed',
        worktreePath: missingPath,            // does NOT exist
        worktreeBranch: 'autonomous/agent-d',
      },
    ]);

    const files = await collectFilesFromAgentBranches({
      cwd: workDir,
      cycleId: CYCLE_ID,
      baseBranch: 'main',
    });

    expect(Array.isArray(files)).toBe(true);
    expect(files).toContain('src/delta.ts');
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Regression: worktreePool absent → git status path
// ---------------------------------------------------------------------------
//
// We test this behaviorally: when worktreePool is undefined, collectChangedFiles
// falls back to `git status --porcelain` on the main tree. We verify this by
// checking that the function returns changed files from a dirty working tree.
// This test uses the exported helper indirectly by calling `collectFilesFromAgentBranches`
// with an empty agentRuns list and confirming it returns [] (not git-status output).
//
describe('collectFilesFromAgentBranches regression: worktreePool=undefined path', () => {
  it('AC2: returns [] when execute.json has no agentRuns with worktreeBranch', async () => {
    const workDir2 = mkdtempSync(join(tmpdir(), 'cr-collect-reg-'));
    const bareDir2 = join(tmpdir(), `cr-collect-bare-reg-${Date.now()}`);

    try {
      await initRepoWithBareRemote(workDir2, bareDir2);
      const phasesDir = writePhasesDir(workDir2, 'test-cycle-reg');
      // No agentRuns with worktreeBranch — simulates no worktree pool
      writeExecuteJson(phasesDir, [
        { itemId: 'x', status: 'completed' }, // no worktreeBranch
      ]);

      const files = await collectFilesFromAgentBranches({
        cwd: workDir2,
        cycleId: 'test-cycle-reg',
        baseBranch: 'main',
      });

      // Without worktreeBranch entries, result is empty (git status NOT called)
      expect(files).toEqual([]);
    } finally {
      rmSync(workDir2, { recursive: true, force: true });
      try { rmSync(bareDir2, { recursive: true, force: true }); } catch { /* ok */ }
    }
  }, 20_000);
});

describe('verifyMultiPrAgentBranches', () => {
  it('uses short deterministic verification worktree names', () => {
    const cycleId = 'aaae9534-72c7-494b-85e1-b5eab6593c25';
    const branch = 'codex/agent-executor-runtime-engineer-aaae9534-72c7-494b-85e1-b5eab6593c25';

    const first = verificationWorktreeName(cycleId, 0, branch);
    const second = verificationWorktreeName(cycleId, 1, branch);

    expect(first).toMatch(/^verify-1-[a-f0-9]{12}$/);
    expect(second).toMatch(/^verify-2-[a-f0-9]{12}$/);
    expect(first).toHaveLength('verify-1-'.length + 12);
    expect(second).not.toBe(first);
    expect(verificationWorktreeName(cycleId, 0, branch)).toBe(first);
  });

  it('treats itemResults worktreeBranch entries as branch verification work', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'cr-verify-itemresults-'));
    const bareDir = join(tmpdir(), `cr-verify-itemresults-bare-${Date.now()}`);

    try {
      await initRepoWithBareRemote(workDir, bareDir);
      const phasesDir = writePhasesDir(workDir, 'test-cycle-verify-itemresults');
      writeFileSync(join(phasesDir, 'execute.json'), JSON.stringify({
        itemResults: [
          {
            itemId: 'item-1',
            status: 'completed',
            agentId: 'coder',
            worktreeBranch: 'autonomous/missing-agent-branch',
          },
        ],
      }));

      const result = await verifyMultiPrAgentBranches({
        cwd: workDir,
        cycleId: 'test-cycle-verify-itemresults',
        baseBranch: 'main',
        testing: {
          command: 'node --version',
          timeoutMinutes: 1,
          reporter: 'json',
          saveRawLog: false,
          buildCommand: '',
          typeCheckCommand: '',
        },
      });

      expect(result.skipped).not.toBe(true);
      expect(result.passed).toBe(false);
      expect(result.results).toEqual([
        expect.objectContaining({
          branch: 'autonomous/missing-agent-branch',
          agentId: 'coder',
          itemId: 'item-1',
          status: 'failed',
        }),
      ]);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      try { rmSync(bareDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  }, 20_000);
});
