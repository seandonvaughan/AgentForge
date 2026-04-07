// tests/autonomous/integration/full-cycle.test.ts
//
// Task 24 of v6.4 autonomous loop: full-cycle E2E integration test.
//
// Proves the top-level `CycleRunner` drives all six stages end-to-end against
// a throwaway tmp workspace with:
//
//   - Mocked Anthropic runtime (no real API calls, no cost)
//   - Real git repo (git init + commit against tmp workspace)
//   - Dry-run PR opener (no real GitHub PR created)
//
// This is the integration-level counterpart to the unit test at
// tests/autonomous/unit/cycle-runner.test.ts. The unit test mocks every
// dependency; this test uses the real CycleLogger, ScoringPipeline,
// SprintGenerator, BudgetApproval, KillSwitch, PhaseScheduler, ProposalToBacklog,
// and PROpener — only the AgentRuntime, test runner, and git subprocess paths
// are substituted.
//
// ---------------------------------------------------------------------------
// DEVIATIONS FROM THE PLAN
// ---------------------------------------------------------------------------
//
// The plan in 2026-04-06-autonomous-loop-part2.md Task 24 prescribes the
// overall shape but its pseudocode made a few assumptions that don't survive
// contact with the real CycleRunner implementation. Documented here so future
// readers don't need to re-derive them:
//
//   1. The real `CycleRunner.collectChangedFiles()` is a TODO stub that
//      returns `[]`, so `gitOps.stage()` is NEVER called during the COMMIT
//      stage (the runner guards `if (filesToCommit.length > 0)`). The plan
//      pseudocode put the "write a real file" side effect inside `stage()`,
//      which would never run. We move that side effect into `createBranch()`
//      (which IS called) and `commit()` so the git subprocess has something
//      to commit.
//
//   2. The plan imports a real `GitOps` instance just to build a `CycleLogger`
//      pre-cycle and then throws away. The wrapped gitOps object is plain — so
//      we never need a real `GitOps`/`CycleLogger` in the test wiring.
//
//   3. The plan's wrapped gitOps used a stub `createBranch` that returned the
//      branch name as a string but did not actually move the git HEAD, while
//      the real `commit` call would then try to `git commit -m "..."` on the
//      main branch. The tmp git repo `refuseCommitToBaseBranch` safety in
//      real GitOps would not catch us because we aren't using real GitOps,
//      but the subsequent code would succeed and land the commit on main.
//      We fix this by doing the checkout -b in our wrapped `createBranch`.
//
//   4. The plan's `mockRuntime` typing did not extend to the optional
//      `options?: { responseFormat?: string }` param that the real
//      `RuntimeForScoring` expects. Our fixture at
//      tests/autonomous/fixtures/mock-anthropic.ts accepts the optional arg.
//
// If the CycleRunner's `collectChangedFiles` is ever implemented for real,
// some of these workarounds can be simplified.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { setupTmpAgentforgeWorkspace } from '../fixtures/tmp-workspace.js';
import { createMockRuntime } from '../fixtures/mock-anthropic.js';
import {
  CycleRunner,
  loadCycleConfig,
  CycleStage,
} from '../../../packages/core/src/autonomous/index.js';
import type { PhaseHandler, PhaseContext } from '../../../packages/core/src/autonomous/phase-scheduler.js';

const execFileAsync = promisify(execFile);

describe('Full autonomous cycle end-to-end', () => {
  let tmpWorkspace: string;

  beforeAll(async () => {
    tmpWorkspace = await setupTmpAgentforgeWorkspace();
  }, 120_000);

  afterAll(() => {
    if (tmpWorkspace) rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  it('runs end-to-end with mocked runtime and real git (dry-run PR)', async () => {
    // -----------------------------------------------------------------------
    // Config — merges DEFAULT_CYCLE_CONFIG with the tmp workspace's $5
    // budget override. The DEFAULT provides every other field (quality,
    // limits, git, etc.) including the critical `branchPrefix: "autonomous/"`
    // and `baseBranch: "main"` so branch creation matches the seeded git repo.
    // -----------------------------------------------------------------------
    const config = loadCycleConfig(tmpWorkspace);

    // -----------------------------------------------------------------------
    // Mock runtime — scoring agent returns a single chore item that fits
    // within the $5 cheap budget. `suggestedTags: ['chore']` is load-bearing:
    // SprintGenerator.bumpVersion(['chore']) = patch bump, so 6.3.5 → 6.3.6.
    // Any other tag would shift the version the test asserts against.
    // -----------------------------------------------------------------------
    const mockRuntime = createMockRuntime({
      responseBank: {
        'backlog-scorer': JSON.stringify({
          rankings: [
            {
              itemId: 'todo-src-sample-ts-0',
              title: 'add a meaningful comment to this file',
              rank: 1,
              score: 0.9,
              confidence: 1.0,
              estimatedCostUsd: 1.0,
              estimatedDurationMinutes: 5,
              rationale: 'TODO marker from src/sample.ts',
              dependencies: [],
              suggestedAssignee: 'coder',
              suggestedTags: ['chore'],
              withinBudget: true,
            },
          ],
          totalEstimatedCostUsd: 1.0,
          budgetOverflowUsd: 0,
          summary: 'Single chore item within budget',
          warnings: [],
        }),
      },
    });

    // -----------------------------------------------------------------------
    // Phase handlers — each handler just publishes `sprint.phase.completed`
    // with a small costUsd contribution. We do NOT want these to run real
    // AgentRuntime invocations because Task 24's contract is "prove the
    // orchestrator plumbing works" — the per-phase logic already has its own
    // integration tests at tests/autonomous/integration/phase-handlers-events.test.ts.
    //
    // Total cost across 9 phases: 0.5 + 0.5 + 0 + 1.0 + 0.5 + 0.5 + 0.5 + 0 + 0.5
    // = $4.00, just under the $5 kill-switch threshold.
    // -----------------------------------------------------------------------
    const makeHandler =
      (phase: string, costUsd = 0.5): PhaseHandler =>
      async (ctx: PhaseContext) => {
        ctx.bus.publish('sprint.phase.completed', {
          sprintId: ctx.sprintId,
          phase,
          cycleId: ctx.cycleId,
          result: {
            phase,
            status: 'completed',
            durationMs: 50,
            costUsd,
            agentRuns: [],
          },
          completedAt: new Date().toISOString(),
        });
      };
    const phaseHandlers: Record<string, PhaseHandler> = {
      audit: makeHandler('audit', 0.5),
      plan: makeHandler('plan', 0.5),
      assign: makeHandler('assign', 0),
      execute: makeHandler('execute', 1.0),
      test: makeHandler('test', 0.5),
      review: makeHandler('review', 0.5),
      gate: makeHandler('gate', 0.5),
      release: makeHandler('release', 0),
      learn: makeHandler('learn', 0.5),
    };

    // -----------------------------------------------------------------------
    // In-memory event bus — satisfies the minimal { publish, subscribe }
    // shape expected by PhaseScheduler. Keeps everything synchronous so
    // publish()→subscriber runs inline and the cycle does not hang.
    // -----------------------------------------------------------------------
    const subscribers: Record<string, Array<(e: unknown) => void>> = {};
    const bus = {
      publish: (topic: string, payload: unknown) =>
        (subscribers[topic] ?? []).forEach((cb) => cb(payload)),
      subscribe: (topic: string, cb: (e: unknown) => void) => {
        if (!subscribers[topic]) subscribers[topic] = [];
        subscribers[topic]!.push(cb);
        return () => {
          subscribers[topic] = subscribers[topic]!.filter((c) => c !== cb);
        };
      },
    };

    // -----------------------------------------------------------------------
    // Stub test runner — returns a perfect pass. This skips the kill
    // switch's test-floor check (0.95 default) because passRate=1.0.
    // -----------------------------------------------------------------------
    const testRunner = {
      run: async (cycleId: string) => ({
        passed: 1,
        failed: 0,
        skipped: 0,
        total: 1,
        passRate: 1.0,
        durationMs: 500,
        failedTests: [],
        newFailures: [],
        rawOutputPath: join(
          tmpWorkspace,
          '.agentforge/cycles',
          cycleId,
          'tests-raw.log',
        ),
        exitCode: 0,
      }),
    };

    // -----------------------------------------------------------------------
    // Wrapped gitOps — uses the real git binary against the tmp repo but
    // skips gh authentication (verifyPreconditions is a no-op) and bypasses
    // the secret-scan/safety-guard logic in real GitOps. We pay a price for
    // that: none of the safety tests cover this path. Those are covered in
    // tests/autonomous/unit/git-ops.test.ts.
    //
    // See "DEVIATIONS FROM THE PLAN" §1 at top of file for why createBranch
    // and commit both have to write a real file.
    // -----------------------------------------------------------------------
    let branchCreated = '';
    const wrappedGitOps = {
      verifyPreconditions: async () => {
        /* tmp workspace has no gh auth — intentional no-op */
      },
      createBranch: async (version: string) => {
        const branch = `autonomous/v${version}`;
        await execFileAsync('git', ['checkout', '-b', branch], {
          cwd: tmpWorkspace,
        });
        branchCreated = branch;
        return branch;
      },
      stage: async (_files: string[]) => {
        // Never called in this test because collectChangedFiles returns [].
        // Kept here to satisfy the GitOps interface shape.
      },
      commit: async (message: string) => {
        // Write a real file into the working tree so git actually has
        // something to commit. This simulates what a real execute phase
        // would have done during the RUN stage.
        writeFileSync(
          join(tmpWorkspace, 'cycle-output.txt'),
          'cycle ran\n',
        );
        await execFileAsync('git', ['add', 'cycle-output.txt'], {
          cwd: tmpWorkspace,
        });
        // Use -F - to feed the multi-line commit message via stdin, matching
        // the real GitOps behavior. Spawn via node -e would be overkill; we
        // use execFile with `input` instead.
        await execFileAsync('git', ['commit', '-m', message], {
          cwd: tmpWorkspace,
        });
        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
          cwd: tmpWorkspace,
        });
        return stdout.trim();
      },
      push: async (_branch: string) => {
        // Tmp repo has no remote; push is a no-op.
      },
      rollbackCommit: async () => {
        /* unused in the happy path */
      },
    };

    // -----------------------------------------------------------------------
    // PR opener — use the real PROpener but with dryRun: true so it returns
    // the synthetic https://github.com/dry-run/... URL instead of shelling
    // out to `gh pr create`. This exercises the real PROpenRequest shape
    // including title/body/labels/reviewers rendering.
    // -----------------------------------------------------------------------
    const { PROpener } = await import(
      '../../../packages/core/src/autonomous/exec/pr-opener.js'
    );
    const prOpener = new PROpener(tmpWorkspace);

    // -----------------------------------------------------------------------
    // Proposal + scoring adapters — empty stubs that satisfy the interface.
    // The PLAN stage's backlog comes entirely from the TODO(autonomous)
    // marker scan in src/sample.ts, not from these adapters.
    // -----------------------------------------------------------------------
    const proposalAdapter = {
      getRecentFailedSessions: async (_days: number) => [],
      getCostAnomalies: async (_days: number) => [],
      getFailedTaskOutcomes: async (_days: number) => [],
      getFlakingTests: async (_days: number) => [],
    };
    const scoringAdapter = {
      getSprintHistory: async (_limit: number) => [],
      getCostMedians: async () => ({}),
      getTeamState: async () => ({ utilization: {} }),
    };

    // -----------------------------------------------------------------------
    // Instantiate + run the cycle.
    // -----------------------------------------------------------------------
    const runner = new CycleRunner({
      cwd: tmpWorkspace,
      config,
      runtime: mockRuntime as never,
      proposalAdapter,
      scoringAdapter,
      phaseHandlers: phaseHandlers as never,
      testRunner: testRunner as never,
      gitOps: wrappedGitOps as never,
      prOpener,
      bus: bus as never,
      dryRun: { prOpener: true },
    });

    const result = await runner.start();

    // -----------------------------------------------------------------------
    // Assertions.
    // -----------------------------------------------------------------------

    // 1. Terminal stage is COMPLETED (not KILLED, not FAILED).
    expect(result.stage).toBe(CycleStage.COMPLETED);

    // 2. cycleId is a UUID-ish hex string (randomUUID output).
    expect(result.cycleId).toMatch(/^[0-9a-f-]+$/);

    // 3. Sprint version bumped from the seed 6.3.5 via the `chore` tag.
    expect(result.sprintVersion).toBe('6.3.6');

    // 4. SprintGenerator wrote the sprint file to disk.
    const sprintPath = join(tmpWorkspace, '.agentforge/sprints/v6.3.6.json');
    expect(existsSync(sprintPath)).toBe(true);

    // 5. CycleLogger populated the cycle log directory.
    const cycleDir = join(tmpWorkspace, '.agentforge/cycles', result.cycleId);
    expect(existsSync(cycleDir)).toBe(true);
    expect(existsSync(join(cycleDir, 'cycle.json'))).toBe(true);
    expect(existsSync(join(cycleDir, 'events.jsonl'))).toBe(true);

    // 6. Total cost stayed under the $5 cheap budget.
    expect(result.cost.totalUsd).toBeLessThan(config.budget.perCycleUsd);

    // 7. PROpener dry-run returned the synthetic github.com URL.
    expect(result.pr.url).toMatch(/^https:\/\/github\.com\//);

    // 8. Scoring agent was invoked exactly once (no fallback, no retry).
    expect(mockRuntime.callsFor('backlog-scorer')).toBe(1);

    // 9. Wrapped gitOps actually moved the branch (sanity check).
    expect(branchCreated).toBe('autonomous/v6.3.6');
    expect(result.git.commitSha).toBeTruthy();
  }, 120_000);
});
