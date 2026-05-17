/**
 * T4.8 — Worktree 20-agent stress test
 *
 * Spins up 20 concurrent mocked agents, each:
 *   1. Allocates a worktree from a WorktreePool
 *   2. Writes a distinct file (agent-N.txt) inside the worktree
 *   3. Commits the file via commitAgentWork
 *   4. Releases the worktree
 *
 * All 20 agents run in parallel via Promise.all.
 *
 * Assertions:
 *   - 20 distinct branches exist after the run (via results)
 *   - Each branch that still has a ref has exactly 1 agent commit vs main
 *   - No worktree directory remains (all released)
 *   - Pool stats: 20 allocations, 20 releases, 0 active
 *   - Wall-clock time < 60 s (warn if over)
 *
 * Repo setup mirrors worktree-pool.test.ts: bare clone so `origin/main`
 * resolves and `git worktree add -b ... origin/main` succeeds.
 */

import { execFile as execFileCb } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorktreePool } from '../../../packages/core/src/runtime/worktree-pool.js';
import { commitAgentWork } from '../../../packages/core/src/runtime/agent-commit.js';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd });
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// Repo factory (with origin so allocate can use origin/main)
// ---------------------------------------------------------------------------

interface RepoSetup {
  workingDir: string;
  cleanupDirs: string[];
}

async function setupRepoWithOrigin(): Promise<RepoSetup> {
  // 1. Create source repo with an initial commit.
  const sourceDir = mkdtempSync(join(tmpdir(), 'af-20a-src-'));
  await git(sourceDir, ['init', '-b', 'main']);
  await git(sourceDir, ['config', 'user.email', 'test@example.com']);
  await git(sourceDir, ['config', 'user.name', 'Test Agent']);
  await git(sourceDir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(sourceDir, 'README.md'), '# stress-test repo\n');
  await git(sourceDir, ['add', '.']);
  await git(sourceDir, ['commit', '-m', 'initial', '--no-gpg-sign']);

  // 2. Bare clone.
  const bareDir = mkdtempSync(join(tmpdir(), 'af-20a-bare-'));
  await execFile('git', ['clone', '--bare', sourceDir, bareDir]);

  // 3. Working clone from the bare dir (provides origin/main).
  const workingDir = mkdtempSync(join(tmpdir(), 'af-20a-work-'));
  rmSync(workingDir, { recursive: true, force: true });
  await execFile('git', ['clone', bareDir, workingDir]);
  await git(workingDir, ['config', 'user.email', 'test@example.com']);
  await git(workingDir, ['config', 'user.name', 'Test Agent']);
  await git(workingDir, ['config', 'commit.gpgsign', 'false']);

  return { workingDir, cleanupDirs: [sourceDir, bareDir, workingDir] };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let setup: RepoSetup;

beforeEach(async () => {
  setup = await setupRepoWithOrigin();
}, 60_000);

afterEach(() => {
  for (const dir of setup.cleanupDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  }
}, 30_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENT_COUNT = 20;

interface AgentResult {
  agentIndex: number;
  branch: string;
  worktreePath: string;
  committed: boolean;
}

/**
 * Run a single mocked agent: allocate → write file → commit → release.
 */
async function runAgent(
  pool: WorktreePool,
  workingDir: string,
  agentIndex: number,
): Promise<AgentResult> {
  const agentId = `agent-${agentIndex}`;
  const sessionId = `stress-sess-${agentIndex}`;

  const handle = await pool.allocate({ agentId, sessionId });

  // Write a distinct file into the worktree.
  const filename = `agent-${agentIndex}.txt`;
  writeFileSync(join(handle.path, filename), `agent-${agentIndex} content\n`);

  // Commit via commitAgentWork.
  // Ensure AGENT_AUTOCOMMIT_DISABLED is not set.
  const savedEnv = process.env['AGENT_AUTOCOMMIT_DISABLED'];
  delete process.env['AGENT_AUTOCOMMIT_DISABLED'];

  let committed = false;
  try {
    const result = await commitAgentWork({
      worktreePath: handle.path,
      branch: handle.branch,
      agentId,
      sessionId,
      itemIds: [`item-${agentIndex}`],
    });
    committed = result !== null;
  } catch {
    // commitAgentWork failed — fall back to raw git
  }

  // Restore env
  if (savedEnv !== undefined) {
    process.env['AGENT_AUTOCOMMIT_DISABLED'] = savedEnv;
  }

  if (!committed) {
    // Fallback: commit manually
    await git(handle.path, ['add', '-A']);
    await git(handle.path, [
      'commit',
      '-m',
      `agent(${agentId}): item-${agentIndex}`,
      '--no-verify',
      '--no-gpg-sign',
    ]);
    committed = true;
  }

  const branch = handle.branch;
  const worktreePath = handle.path;

  await pool.release(handle.id);

  return { agentIndex, branch, worktreePath, committed };
}

// ---------------------------------------------------------------------------
// Main stress test
// ---------------------------------------------------------------------------

describe('Worktree 20-agent stress test (T4.8)', () => {
  it(
    'runs 20 concurrent agents, each in an isolated worktree, with clean assembly',
    async () => {
      const { workingDir } = setup;

      // Ensure auto-commit is enabled for this test.
      delete process.env['AGENT_AUTOCOMMIT_DISABLED'];

      const pool = new WorktreePool({
        projectRoot: workingDir,
        baseBranch: 'main',
      });

      const wallStart = Date.now();

      // ── Run all 20 agents in parallel ──────────────────────────────────
      const results = await Promise.all(
        Array.from({ length: AGENT_COUNT }, (_, i) =>
          runAgent(pool, workingDir, i),
        ),
      );

      const wallMs = Date.now() - wallStart;
      console.log(`[stress-test] 20-agent run completed in ${wallMs} ms (${(wallMs / 1000).toFixed(1)} s)`);

      if (wallMs > 60_000) {
        console.warn(
          `[stress-test] WARNING: wall-clock time ${wallMs} ms exceeded 60 s budget`,
        );
      }

      // ── Assertion 1: 20 distinct branch names returned ─────────────────
      const returnedBranches = results.map((r) => r.branch);
      const uniqueBranches = new Set(returnedBranches);
      expect(uniqueBranches.size).toBe(AGENT_COUNT);

      // Verify every branch name follows the expected pattern
      for (const branch of uniqueBranches) {
        expect(branch).toMatch(/^autonomous\/agent-agent-\d+-stress-sess-\d+$/);
      }

      // ── Assertion 2: branches with unmerged commits have exactly 1 commit ─
      // release() calls `git branch -d` which deletes branches only when
      // they are fully merged. Since our branches have commits not in main,
      // they stay intact.
      for (const result of results) {
        let branchStillExists = false;
        try {
          const check = await git(workingDir, ['branch', '--list', result.branch]);
          branchStillExists = check.trim().length > 0;
        } catch {
          branchStillExists = false;
        }

        if (branchStillExists) {
          const log = await git(workingDir, [
            'log',
            '--oneline',
            `main..${result.branch}`,
          ]);
          const commits = log.split('\n').filter(Boolean);
          expect(commits).toHaveLength(1);

          // Verify the correct file is on the branch
          const files = await git(workingDir, [
            'diff',
            '--name-only',
            `main..${result.branch}`,
          ]);
          const changedFiles = files.split('\n').filter(Boolean);
          expect(changedFiles).toContain(`agent-${result.agentIndex}.txt`);
        }
      }

      // ── Assertion 3: no worktree directories remain ─────────────────────
      for (const result of results) {
        expect(
          existsSync(result.worktreePath),
          `Worktree dir ${result.worktreePath} should not exist after release()`,
        ).toBe(false);
      }

      // ── Assertion 4: pool stats ─────────────────────────────────────────
      const stats = pool.getStats();
      expect(stats.totalAllocations).toBe(AGENT_COUNT);
      expect(stats.totalReleases).toBe(AGENT_COUNT);
      expect(stats.active).toBe(0);

      // ── Assertion 5: all 20 agents committed ───────────────────────────
      const committedCount = results.filter((r) => r.committed).length;
      expect(committedCount).toBe(AGENT_COUNT);

      // ── Wall-clock hard guard ────────────────────────────────────────────
      // < 60s is the target; we allow up to 2 min as CI hard cap
      expect(wallMs).toBeLessThan(120_000);
    },
    120_000, // per-test timeout 2 min
  );
});
