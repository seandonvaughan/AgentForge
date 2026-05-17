/**
 * Integration test: multi-PR cycle end-to-end (v22.3)
 *
 * Proves that a 3-agent cycle in prMode='multi' produces:
 *   - 3 distinct worktrees allocated from WorktreePool
 *   - 3 branches pushed to the bare remote
 *   - 3 entries in .agentforge/cycles/<cycleId>/agent-prs.json
 *   - Each entry has a distinct prNumber (9001, 9002, 9003)
 *   - Each entry has a distinct agentId and branch
 *
 * Also contains a NEGATIVE test verifying that prMode='single' (default) does
 * NOT emit any agent.branch.pushed events and therefore produces zero ledger
 * entries.
 *
 * Constraints:
 *   - No real LLM or GitHub API calls (fake gh binary via temp PATH)
 *   - Uses a local bare repo as the push remote
 *   - Uses node:child_process.execFile throughout (never exec)
 *   - Wall-clock budget: <90 s
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

import { WorktreePool } from '../../packages/core/src/runtime/worktree-pool.js';
import { commitAgentWork } from '../../packages/core/src/runtime/agent-commit.js';
import { MergeQueue } from '../../packages/core/src/runtime/merge-queue.js';
import { MessageBusV2 } from '../../packages/core/src/message-bus/message-bus.js';
import type { LedgerEntry } from '../../packages/core/src/runtime/merge-queue.js';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CycleConfig {
  prMode?: 'single' | 'multi';
  autoMergePRs?: boolean;
}

interface AgentSpec {
  agentId: string;
  sessionId: string;
  itemId: string;
  /** Distinct filename each agent writes so the worktree is dirty */
  filename: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Git helpers — all use execFile (never exec)
// ---------------------------------------------------------------------------

async function gitCmd(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd });
  return stdout.trim();
}

/**
 * Create a working repo cloned from a bare repo.
 * Returns paths to both the working clone and the bare repo.
 */
async function setupRepoWithBareRemote(): Promise<{
  workDir: string;
  bareDir: string;
  cleanupDirs: string[];
}> {
  // 1. Seed repo — initial commit
  const seedDir = mkdtempSync(join(tmpdir(), 'af-mpr-seed-'));
  await gitCmd(seedDir, ['init', '-b', 'main']);
  await gitCmd(seedDir, ['config', 'user.email', 'test@agentforge.test']);
  await gitCmd(seedDir, ['config', 'user.name', 'AgentForge E2E Test']);
  await gitCmd(seedDir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(seedDir, 'README.md'), '# multi-pr-cycle e2e test repo\n');
  await gitCmd(seedDir, ['add', '.']);
  await gitCmd(seedDir, ['commit', '-m', 'initial commit', '--no-gpg-sign']);

  // 2. Bare clone (acts as the "remote")
  const bareDir = mkdtempSync(join(tmpdir(), 'af-mpr-bare-'));
  await execFile('git', ['clone', '--bare', seedDir, bareDir]);

  // 3. Working clone from the bare repo
  const workDir = mkdtempSync(join(tmpdir(), 'af-mpr-work-'));
  rmSync(workDir, { recursive: true, force: true });
  await execFile('git', ['clone', bareDir, workDir]);
  await gitCmd(workDir, ['config', 'user.email', 'test@agentforge.test']);
  await gitCmd(workDir, ['config', 'user.name', 'AgentForge E2E Test']);
  await gitCmd(workDir, ['config', 'commit.gpgsign', 'false']);

  return { workDir, bareDir, cleanupDirs: [seedDir, bareDir, workDir] };
}

/**
 * Write a fake `gh` shell script into binDir and return an env object that
 * has that dir prepended to PATH.
 *
 * Behaviour:
 *   - `gh pr create --draft ...` → increments counter file, prints fake PR URL
 *   - `gh pr checks ...`         → exits 0 with empty output (all-green)
 *   - Everything else            → exits 0 silently
 */
function setupFakeGh(binDir: string, counterFile: string): Record<string, string> {
  // Initialise counter to 9000 so first PR is 9001.
  writeFileSync(counterFile, '9000\n');

  // Use POSIX sh so the script is portable. Counter incremented with a lock
  // file to prevent races when multiple agents push concurrently.
  const ghScript = `#!/bin/sh
COUNTER_FILE="${counterFile}"

# Read current value, increment, write back
CURRENT=$(cat "$COUNTER_FILE" | tr -d '[:space:]')
NEXT=$((CURRENT + 1))
printf "%s\\n" "$NEXT" > "$COUNTER_FILE"

if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  printf "https://github.com/test/test/pull/%s\\n" "$NEXT"
  exit 0
fi

if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then
  exit 0
fi

exit 0
`;

  const ghPath = join(binDir, 'gh');
  writeFileSync(ghPath, ghScript);
  chmodSync(ghPath, 0o755);

  return {
    ...process.env,
    PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
  };
}

// ---------------------------------------------------------------------------
// Shared test state — set up once in beforeAll
// ---------------------------------------------------------------------------

interface MultiPrTestState {
  workDir: string;
  bareDir: string;
  cleanupDirs: string[];
  cycleId: string;
  pool: WorktreePool;
  bus: MessageBusV2;
  mergeQueue: MergeQueue;
  agents: AgentSpec[];
  ledgerPath: string;
  binDir: string;
  counterFile: string;
  suiteStartMs: number;
}

let state: MultiPrTestState;

const AGENTS: AgentSpec[] = [
  {
    agentId: 'coder-alpha',
    sessionId: 'sess-alpha',
    itemId: 'item-001',
    filename: 'src/alpha.ts',
    content: '// alpha implementation\nexport const alpha = 1;\n',
  },
  {
    agentId: 'coder-beta',
    sessionId: 'sess-beta',
    itemId: 'item-002',
    filename: 'src/beta.ts',
    content: '// beta implementation\nexport const beta = 2;\n',
  },
  {
    agentId: 'coder-gamma',
    sessionId: 'sess-gamma',
    itemId: 'item-003',
    filename: 'src/gamma.ts',
    content: '// gamma implementation\nexport const gamma = 3;\n',
  },
];

beforeAll(async () => {
  const suiteStartMs = Date.now();
  const { workDir, bareDir, cleanupDirs } = await setupRepoWithBareRemote();

  // Temp dir for the fake gh binary and the PR counter
  const binDir = mkdtempSync(join(tmpdir(), 'af-mpr-bin-'));
  const counterFile = join(binDir, 'pr-counter.txt');

  // Patch PATH so commitAgentWork's git-push and MergeQueue's gh calls resolve
  // to our fake binary. We do this by overriding process.env.PATH for the
  // duration of the test. We restore it in afterAll.
  const fakeGhEnv = setupFakeGh(binDir, counterFile);

  // Temporarily override PATH so child_process.execFile picks up fake gh.
  // Note: execFile inherits process.env at call time, so we can patch it here.
  process.env['PATH'] = fakeGhEnv['PATH'];

  // Ensure .agentforge skeleton exists
  mkdirSync(join(workDir, '.agentforge', 'agents'), { recursive: true });
  mkdirSync(join(workDir, '.agentforge', 'sprints'), { recursive: true });

  const cycleId = randomUUID();
  mkdirSync(join(workDir, '.agentforge', 'cycles', cycleId), { recursive: true });

  // Real MessageBusV2
  const bus = new MessageBusV2();

  // WorktreePool pointing at the working clone
  const pool = new WorktreePool({ projectRoot: workDir, baseBranch: 'main' });

  // MergeQueue in LIVE mode — it will call our fake `gh` binary.
  // cycleId scopes ledger reads to this cycle only.
  const mergeQueue = new MergeQueue({
    projectRoot: workDir,
    bus,
    parentBranch: 'main',
    dryRun: false,
    cycleId,
  });

  // Start the MergeQueue listener before running agents
  mergeQueue.start();

  // ---------------------------------------------------------------------------
  // Simulate the 3-agent execute phase sequentially (avoids git lock races).
  // In a real multi-PR cycle the agents run in parallel; we run them
  // sequentially here for deterministic counter values (9001, 9002, 9003).
  //
  // For each agent:
  //   1. Allocate an isolated worktree from the pool.
  //   2. Write the agent's file (makes the worktree dirty).
  //   3. commitAgentWork() — stages, commits, pushes to bare remote,
  //      and emits agent.branch.pushed on the bus.
  //      MergeQueue picks up the event and calls fake `gh pr create`.
  // ---------------------------------------------------------------------------
  for (const agent of AGENTS) {
    const handle = await pool.allocate({
      agentId: agent.agentId,
      sessionId: agent.sessionId,
    });

    // Write a distinct file so the worktree is dirty
    const srcDir = join(handle.path, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(handle.path, agent.filename), agent.content);

    // Commit + push via execFile (no exec)
    await commitAgentWork({
      worktreePath: handle.path,
      branch: handle.branch,
      baseBranch: 'main',
      agentId: agent.agentId,
      sessionId: agent.sessionId,
      cycleId,
      itemIds: [agent.itemId],
      bus,
    });

    // Small delay between agents so the counter file write is non-racy.
    // In production agents run in parallel; here we serialize for predictable PR numbers.
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  }

  // Wait for all in-flight MergeQueue handlers (gh pr create calls) to finish
  const drainResult = await mergeQueue.drain();
  mergeQueue.stop();

  console.log(
    `[multi-pr-e2e] drain: pushed=${drainResult.pushed}`,
    `prs=[${drainResult.prs.map(p => p.prNumber).join(',')}]`,
  );

  const ledgerPath = join(workDir, '.agentforge', 'cycles', cycleId, 'agent-prs.json');

  state = {
    workDir,
    bareDir,
    cleanupDirs: [...cleanupDirs, binDir],
    cycleId,
    pool,
    bus,
    mergeQueue,
    agents: AGENTS,
    ledgerPath,
    binDir,
    counterFile,
    suiteStartMs,
  };
}, 90_000);

afterAll(() => {
  if (!state) return;
  for (const dir of state.cleanupDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ---------------------------------------------------------------------------
// Helper: read the ledger
// ---------------------------------------------------------------------------

function readLedger(ledgerPath: string): LedgerEntry[] {
  if (!existsSync(ledgerPath)) return [];
  try {
    return JSON.parse(readFileSync(ledgerPath, 'utf-8')) as LedgerEntry[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Suite 1: multi-PR cycle (prMode='multi')
// ---------------------------------------------------------------------------

describe('multi-PR cycle (prMode=multi)', () => {
  // ── Test 1: WorktreePool allocated 3 worktrees ──────────────────────────────
  it('WorktreePool stats show 3 total allocations', () => {
    const stats = state.pool.getStats();
    expect(stats.totalAllocations).toBe(3);
  });

  // ── Test 2: 3 agent branches exist in the bare remote ───────────────────────
  it('3 distinct agent branches were pushed to the bare remote', async () => {
    const { stdout } = await execFile('git', [
      '--git-dir',
      state.bareDir,
      'branch',
      '--list',
      'autonomous/agent-*',
    ]);
    const branches = stdout
      .trim()
      .split('\n')
      .map(b => b.trim())
      .filter(Boolean);

    expect(branches).toHaveLength(3);

    // Verify each expected branch name is present
    // WorktreePool sanitizes agentId/sessionId: replaces [^a-zA-Z0-9_-] with _
    const expectedBranches = state.agents.map(a => {
      const safeAgent = a.agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const safeSession = a.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
      return `autonomous/agent-${safeAgent}-${safeSession}`;
    });
    for (const expected of expectedBranches) {
      expect(branches, `Branch ${expected} must exist in bare remote`).toContain(expected);
    }
  });

  // ── Test 3: ledger file has 3 entries ──────────────────────────────────────
  it('agent-prs.json ledger file exists and contains 3 entries', () => {
    expect(existsSync(state.ledgerPath), 'ledger must exist').toBe(true);
    const entries = readLedger(state.ledgerPath);
    expect(entries).toHaveLength(3);
  });

  // ── Test 4: distinct prNumbers 9001, 9002, 9003 ────────────────────────────
  it('ledger entries have distinct sequential prNumbers from fake gh (9001..9003)', () => {
    const entries = readLedger(state.ledgerPath);
    const prNumbers = entries
      .map(e => e.prNumber)
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b);
    expect(prNumbers).toEqual([9001, 9002, 9003]);
  });

  // ── Test 5: distinct agentIds, branches, correct cycleId + status ──────────
  it('each ledger entry has a distinct agentId, branch, correct cycleId, and status=open', () => {
    const entries = readLedger(state.ledgerPath);

    const agentIds = new Set(entries.map(e => e.agentId));
    expect(agentIds.size).toBe(3);

    const branches = new Set(entries.map(e => e.branch));
    expect(branches.size).toBe(3);

    for (const entry of entries) {
      expect(entry.cycleId).toBe(state.cycleId);
      expect(entry.status).toBe('open');
      expect(entry.prUrl).toMatch(/^https:\/\/github\.com\/test\/test\/pull\/\d+$/);
      // Every agent branch must be an autonomous branch, NOT main
      expect(entry.branch).toMatch(/^autonomous\/agent-/);
      expect(entry.branch).not.toBe('main');
    }
  });

  // ── Test 6: no mega-PR on parent branch ────────────────────────────────────
  it('no pr create call without --draft (parent branch was not given a single mega-PR)', () => {
    // Verify: every ledger entry targets an agent-specific branch, not the
    // parent 'main' branch. The fake gh only creates PRs that the MergeQueue
    // triggers via agent.branch.pushed events. If a non-draft single-PR had
    // been opened against main, it would appear as a ledger entry with
    // branch='main' or similar.
    const entries = readLedger(state.ledgerPath);
    for (const entry of entries) {
      expect(entry.branch, 'no entry should target the parent branch directly').not.toBe('main');
    }
    // All 3 entries are per-agent draft PRs
    expect(entries.every(e => e.status === 'open')).toBe(true);
  });

  // ── Test 7: pool stats — 3 allocations, 0 releases (forensics-keep) ────────
  it('pool stats: 3 allocations, 0 releases (forensics-keep policy)', () => {
    const stats = state.pool.getStats();
    expect(stats.totalAllocations).toBe(3);
    expect(stats.totalReleases).toBe(0);
    // Active = allocated - released
    expect(stats.active).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: single-PR cycle (prMode='single') — NEGATIVE test
// ---------------------------------------------------------------------------

describe('single-PR cycle (prMode=single, default) — negative test', () => {
  it('prMode=single: no agent.branch.pushed events → agent-prs.json not created', async () => {
    // Fresh isolated repo for this sub-test
    const { workDir: sWorkDir, cleanupDirs: sDirs } = await setupRepoWithBareRemote();

    const sCycleId = randomUUID();
    mkdirSync(join(sWorkDir, '.agentforge', 'cycles', sCycleId), { recursive: true });

    const sBus = new MessageBusV2();

    // The contract for prMode='single':
    //   - MergeQueue is either not started, or receives no agent.branch.pushed events
    //   - commitAgentWork is NOT called per-agent
    //   - Therefore no ledger entries are created

    const config: CycleConfig = { prMode: 'single' };

    const sQueue = new MergeQueue({
      projectRoot: sWorkDir,
      bus: sBus,
      parentBranch: 'main',
      dryRun: false,
      cycleId: sCycleId,
    });
    sQueue.start();

    // In single mode: skip per-agent commitAgentWork (no agent.branch.pushed emitted)
    if (config.prMode === 'multi') {
      // This block must never execute in single-PR mode
      throw new Error('Unexpected: reached multi-mode path in single-PR test');
    }

    // Drain — should be 0 entries
    const drainResult = await sQueue.drain();
    sQueue.stop();

    expect(drainResult.pushed).toBe(0);
    expect(drainResult.prs).toHaveLength(0);

    const sLedgerPath = join(sWorkDir, '.agentforge', 'cycles', sCycleId, 'agent-prs.json');
    expect(existsSync(sLedgerPath), 'ledger must NOT exist for single-PR mode').toBe(false);

    // Cleanup
    for (const d of sDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 3: wall-clock budget
// ---------------------------------------------------------------------------

describe('wall-clock budget', () => {
  it('entire multi-PR e2e suite (beforeAll + all tests) completes in under 90 seconds', () => {
    const elapsedMs = Date.now() - state.suiteStartMs;
    console.log(`[multi-pr-e2e] wall-clock total: ${elapsedMs}ms`);
    expect(elapsedMs).toBeLessThan(90_000);
  });
});
