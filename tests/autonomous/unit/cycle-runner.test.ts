// tests/autonomous/unit/cycle-runner.test.ts
//
// Unit tests for the CycleRunner top-level orchestrator (Task 21).
// Drives all 6 stages with mocked dependencies and asserts:
//   1. happy path produces a CycleResult with stage=COMPLETED
//   2. cycle.json is always written on completion
//   3. test-floor violation is caught by the kill switch and produces stage=KILLED
//   4. cycle.json is also written when KILLED
//
// See packages/core/src/autonomous/cycle-runner.ts and
// docs/superpowers/specs/2026-04-06-autonomous-loop-design.md §6.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import {
  CycleRunner,
  DEFAULT_CYCLE_CONFIG,
  CycleStage,
  MessageBusV2,
  ScoringPipeline,
  BudgetApproval,
} from '@agentforge/core';
import * as autoReforgeModule from '../../../packages/core/src/autonomous/auto-reforge.js';
import { GateRejectedError } from '../../../packages/core/src/autonomous/phase-handlers/gate-phase.js';
import { runExecutePhase } from '../../../packages/core/src/autonomous/phase-handlers/execute-phase.js';

/**
 * Build the full set of mocked dependencies the CycleRunner needs.
 *
 * Each phase handler publishes a single `sprint.phase.completed` event so the
 * PhaseScheduler can advance through the entire phase sequence in one tick.
 * The proposalAdapter returns one failed session so the PLAN stage produces a
 * non-empty backlog. The runtime returns a hard-coded ScoringResult JSON
 * that the ScoringPipeline accepts on the first try (no fallback).
 */
function makeMockDeps() {
  return {
    runtime: {
      run: async (_agent: string, _task: string) => ({
        output: JSON.stringify({
          rankings: [
            {
              itemId: 'i1',
              title: 'Fix bug',
              rank: 1,
              score: 0.9,
              confidence: 0.9,
              estimatedCostUsd: 5,
              estimatedDurationMinutes: 15,
              rationale: 'r',
              dependencies: [],
              suggestedAssignee: 'coder',
              suggestedTags: ['fix'],
              withinBudget: true,
            },
          ],
          totalEstimatedCostUsd: 5,
          budgetOverflowUsd: 0,
          summary: 'one fix',
          warnings: [],
        }),
        usage: { input_tokens: 100, output_tokens: 50 },
        costUsd: 0.01,
        durationMs: 500,
        model: 'sonnet',
      }),
    },
    proposalAdapter: {
      getRecentFailedSessions: async () => [
        { id: 's1', agent: 'coder', error: 'crash', confidence: 0.9 },
      ],
      getCostAnomalies: async () => [],
      getFailedTaskOutcomes: async () => [],
      getFlakingTests: async () => [],
    },
    scoringAdapter: {
      getSprintHistory: async () => [],
      getCostMedians: async () => ({}),
      getTeamState: async () => ({ utilization: {} }),
      getP50CostByTag: async () => ({}),
    },
    mockPhaseHandlers: {
      audit: async (ctx: any) => {
        ctx.bus.publish('sprint.phase.completed', {
          sprintId: ctx.sprintId,
          phase: 'audit',
          cycleId: ctx.cycleId,
          result: {
            phase: 'audit',
            status: 'completed',
            durationMs: 100,
            costUsd: 0.5,
            agentRuns: [],
          },
          completedAt: new Date().toISOString(),
        });
      },
      plan: async (ctx: any) => {
        ctx.bus.publish('sprint.phase.completed', {
          sprintId: ctx.sprintId,
          phase: 'plan',
          cycleId: ctx.cycleId,
          result: {
            phase: 'plan',
            status: 'completed',
            durationMs: 100,
            costUsd: 0.5,
            agentRuns: [],
          },
          completedAt: new Date().toISOString(),
        });
      },
      assign: async (ctx: any) => {
        ctx.bus.publish('sprint.phase.completed', {
          sprintId: ctx.sprintId,
          phase: 'assign',
          cycleId: ctx.cycleId,
          result: {
            phase: 'assign',
            status: 'completed',
            durationMs: 50,
            costUsd: 0,
            agentRuns: [],
          },
          completedAt: new Date().toISOString(),
        });
      },
      execute: async (ctx: any) => {
        ctx.bus.publish('sprint.phase.completed', {
          sprintId: ctx.sprintId,
          phase: 'execute',
          cycleId: ctx.cycleId,
          result: {
            phase: 'execute',
            status: 'completed',
            durationMs: 500,
            costUsd: 1.0,
            agentRuns: [],
            itemResults: [],
          },
          completedAt: new Date().toISOString(),
        });
      },
      test: async (ctx: any) => {
        ctx.bus.publish('sprint.phase.completed', {
          sprintId: ctx.sprintId,
          phase: 'test',
          cycleId: ctx.cycleId,
          result: {
            phase: 'test',
            status: 'completed',
            durationMs: 100,
            costUsd: 0.2,
            agentRuns: [],
          },
          completedAt: new Date().toISOString(),
        });
      },
      review: async (ctx: any) => {
        ctx.bus.publish('sprint.phase.completed', {
          sprintId: ctx.sprintId,
          phase: 'review',
          cycleId: ctx.cycleId,
          result: {
            phase: 'review',
            status: 'completed',
            durationMs: 100,
            costUsd: 0.2,
            agentRuns: [],
          },
          completedAt: new Date().toISOString(),
        });
      },
      gate: async (ctx: any) => {
        ctx.bus.publish('sprint.phase.completed', {
          sprintId: ctx.sprintId,
          phase: 'gate',
          cycleId: ctx.cycleId,
          result: {
            phase: 'gate',
            status: 'completed',
            durationMs: 100,
            costUsd: 0.3,
            agentRuns: [],
          },
          completedAt: new Date().toISOString(),
        });
      },
      release: async (ctx: any) => {
        ctx.bus.publish('sprint.phase.completed', {
          sprintId: ctx.sprintId,
          phase: 'release',
          cycleId: ctx.cycleId,
          result: {
            phase: 'release',
            status: 'completed',
            durationMs: 50,
            costUsd: 0,
            agentRuns: [],
          },
          completedAt: new Date().toISOString(),
        });
      },
      learn: async (ctx: any) => {
        ctx.bus.publish('sprint.phase.completed', {
          sprintId: ctx.sprintId,
          phase: 'learn',
          cycleId: ctx.cycleId,
          result: {
            phase: 'learn',
            status: 'completed',
            durationMs: 100,
            costUsd: 0.2,
            agentRuns: [],
          },
          completedAt: new Date().toISOString(),
        });
      },
    },
    testRunner: {
      run: async (cycleId: string) => ({
        passed: 100,
        failed: 0,
        skipped: 0,
        total: 100,
        passRate: 1.0,
        durationMs: 5000,
        failedTests: [],
        newFailures: [],
        rawOutputPath: `.agentforge/cycles/${cycleId}/tests-raw.log`,
        exitCode: 0,
      }),
    },
    gitOps: {
      verifyPreconditions: async () => {},
      createBranch: async (version: string) => `autonomous/v${version}`,
      stage: async (_files: string[]) => {},
      commit: async (_msg: string) =>
        '0123456789abcdef0123456789abcdef01234567',
      push: async (_branch: string) => {},
      rollbackCommit: async () => {},
    },
    prOpener: {
      open: async () => ({
        url: 'https://github.com/dry-run/autonomous-test/pull/1',
        number: 1,
        draft: false,
      }),
    },
    // Default pre-verify typecheck: always passes. Prevents real build commands
    // from running in the tmpdir workspace where no package.json exists.
    preVerifyTypeCheck: async () => ({ buildOk: true, typeCheckOk: true }),
    bus: (() => {
      const subs: Record<string, Array<(e: any) => void>> = {};
      return {
        publish: (topic: string, payload: any) =>
          (subs[topic] ?? []).forEach((cb) => cb(payload)),
        subscribe: (topic: string, cb: (e: any) => void) => {
          if (!subs[topic]) subs[topic] = [];
          subs[topic]!.push(cb);
          return () => {
            subs[topic] = subs[topic]!.filter((c) => c !== cb);
          };
        },
      };
    })(),
  };
}

async function initGitRepo(dir: string): Promise<void> {
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  await execFileAsync('git', ['add', 'README.md'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });
}

function readCycleOutcomeMemoryStage(dir: string): string | undefined {
  const memoryPath = join(dir, '.agentforge', 'memory', 'cycle-outcome.jsonl');
  if (!existsSync(memoryPath)) return undefined;
  const lines = readFileSync(memoryPath, 'utf8').trim().split(/\r?\n/);
  const last = lines.at(-1);
  if (!last) return undefined;
  const entry = JSON.parse(last) as { value: string };
  return (JSON.parse(entry.value) as { stage?: string }).stage;
}

describe('CycleRunner', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-cr-'));
    mkdirSync(join(tmpDir, '.agentforge/sprints'), { recursive: true });
    // Seed a prior sprint so SprintGenerator bumps from a known version.
    writeFileSync(
      join(tmpDir, '.agentforge/sprints/v6.3.5.json'),
      '{"sprints":[{"version":"6.3.5"}]}',
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('runs a full cycle end-to-end with mocked dependencies', async () => {
    await initGitRepo(tmpDir);
    const deps = makeMockDeps();
    const baseExecute = deps.mockPhaseHandlers.execute;
    deps.mockPhaseHandlers.execute = async (ctx: any) => {
      writeFileSync(join(tmpDir, 'feature.txt'), 'implemented\n');
      await baseExecute(ctx);
    };
    const runner = new CycleRunner({
      cwd: tmpDir,
      config: DEFAULT_CYCLE_CONFIG,
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
    });

    const result = await runner.start();

    expect(result.stage).toBe(CycleStage.COMPLETED);
    // 6.3.5 → 6.3.6 (patch bump because the only item has tag "fix")
    expect(result.sprintVersion).toBe('6.3.6');
    expect(result.pr.url).toBeDefined();
    expect(result.pr.url).not.toBeNull();
    expect(result.cost.totalUsd).toBeGreaterThan(0);
  });

  it('writes an audit resume checkpoint before the first scheduled phase starts', async () => {
    await initGitRepo(tmpDir);
    const deps = makeMockDeps();
    let checkpointAtAuditStart: any;

    const baseAudit = deps.mockPhaseHandlers.audit;
    deps.mockPhaseHandlers.audit = async (ctx: any) => {
      checkpointAtAuditStart = JSON.parse(
        readFileSync(
          join(tmpDir, '.agentforge', 'cycles', ctx.cycleId, 'checkpoint-cycle.json'),
          'utf8',
        ),
      );
      await baseAudit(ctx);
    };

    const baseExecute = deps.mockPhaseHandlers.execute;
    deps.mockPhaseHandlers.execute = async (ctx: any) => {
      writeFileSync(join(tmpDir, 'feature.txt'), 'implemented\n');
      await baseExecute(ctx);
    };

    const runner = new CycleRunner({
      cwd: tmpDir,
      config: DEFAULT_CYCLE_CONFIG,
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
    });

    const result = await runner.start();

    expect(result.stage).toBe(CycleStage.COMPLETED);
    expect(checkpointAtAuditStart).toMatchObject({
      v: 1,
      resumeFromPhase: 'audit',
      completedPhases: [],
      budgetUsd: DEFAULT_CYCLE_CONFIG.budget.perCycleUsd,
      spentUsd: 0,
    });
    expect(checkpointAtAuditStart.cycleId).toBe(result.cycleId);
  });

  it('fails prMode=multi before planning when no worktree pool is available', async () => {
    const deps = makeMockDeps();
    const runner = new CycleRunner({
      cwd: tmpDir,
      config: {
        ...DEFAULT_CYCLE_CONFIG,
        prMode: 'multi',
      },
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
    });

    const result = await runner.start();

    expect(result.stage).toBe(CycleStage.FAILED);
    expect(result.error).toContain('prMode=multi requires options.worktreePool');
  });

  // P0.4 — KEYSTONE: a worktree pool with prMode!=multi is now VALID (single-PR
  // epic cycles run children in worktrees and release ONE PR from the integration
  // branch). This replaces the prior "throws outside prMode=multi" behaviour.
  it('accepts a worktree pool in single-PR mode (no longer throws)', async () => {
    await initGitRepo(tmpDir);
    const deps = makeMockDeps();
    const baseExecute = deps.mockPhaseHandlers.execute;
    deps.mockPhaseHandlers.execute = async (ctx: any) => {
      writeFileSync(join(tmpDir, 'feature.txt'), 'implemented\n');
      await baseExecute(ctx);
    };
    const runner = new CycleRunner({
      cwd: tmpDir,
      config: DEFAULT_CYCLE_CONFIG,
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
      // Minimal pool stub — GC calls listActive(); no allocation happens because
      // the mock execute handler does not request worktrees.
      worktreePool: { listActive: async () => [] } as any,
    });

    const result = await runner.start();

    expect(result.stage).toBe(CycleStage.COMPLETED);
    // Non-epic single-PR path is unchanged: it still commits via the main-tree
    // gitOps path (the mock execute wrote feature.txt) and opens one PR.
    expect(result.pr.url).toBeDefined();
    expect(result.epicIntegration).toBeUndefined();
  });

  // P0.4 — KEYSTONE: epic single-PR release.
  // When the execute phase surfaces an epicIntegration signal, the release stage
  // must (1) NOT run the main-tree gitOps createBranch/stage/commit path, (2) open
  // exactly ONE PR from the integration branch, and (3) record the integration
  // branch on the cycle result. The operator's main tree is never committed.
  it('epic mode: opens ONE PR from the integration branch and skips the main-tree commit path', async () => {
    await initGitRepo(tmpDir);
    // Create a real local integration branch so pushIntegrationBranch finds a HEAD.
    // No `origin` remote exists → the push step is skipped cleanly (local-only).
    await execFileAsync('git', ['branch', 'codex/epic-test', 'main'], { cwd: tmpDir });

    const deps = makeMockDeps();

    // Spy on the main-tree git path — it MUST NOT be touched in epic mode.
    const createBranch = vi.fn(async (v: string) => `autonomous/v${v}`);
    const commit = vi.fn(async () => '0123456789abcdef0123456789abcdef01234567');
    const stage = vi.fn(async (_files: string[]) => {});
    const push = vi.fn(async (_branch: string) => {});
    deps.gitOps.createBranch = createBranch;
    deps.gitOps.commit = commit;
    deps.gitOps.stage = stage;
    deps.gitOps.push = push;

    // Capture PR open calls.
    const prCalls: any[] = [];
    deps.prOpener.open = async (req: any) => {
      prCalls.push(req);
      return { url: 'https://github.com/x/y/pull/42', number: 42, draft: false };
    };

    // Execute handler emits the epicIntegration signal on its phase result.
    const baseExecute = deps.mockPhaseHandlers.execute;
    deps.mockPhaseHandlers.execute = async (ctx: any) => {
      ctx.bus.publish('sprint.phase.completed', {
        sprintId: ctx.sprintId,
        phase: 'execute',
        cycleId: ctx.cycleId,
        result: {
          phase: 'execute',
          status: 'completed',
          durationMs: 500,
          costUsd: 1.0,
          agentRuns: [],
          itemResults: [],
          epicIntegration: {
            branch: 'codex/epic-test',
            epicId: 'epic-test',
            mergedBranches: ['codex/c1', 'codex/c2'],
            hadConflicts: false,
          },
        },
        completedAt: new Date().toISOString(),
      });
      void baseExecute;
    };

    const runner = new CycleRunner({
      cwd: tmpDir,
      config: DEFAULT_CYCLE_CONFIG,
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      objective: 'ship the epic',
      worktreePool: { listActive: async () => [] } as any,
    });

    const result = await runner.start();

    expect(result.stage).toBe(CycleStage.COMPLETED);
    // (1) main-tree commit path was NOT touched.
    expect(createBranch).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    // (2) exactly ONE PR, opened FROM the integration branch.
    expect(prCalls).toHaveLength(1);
    expect(prCalls[0].branch).toBe('codex/epic-test');
    expect(result.pr.number).toBe(42);
    // (3) the integration branch is recorded on the cycle result.
    expect(result.epicIntegration).toMatchObject({
      branch: 'codex/epic-test',
      epicId: 'epic-test',
      mergedBranches: ['codex/c1', 'codex/c2'],
    });
  });

  it('ignores a provided worktree pool when worktrees are disabled', async () => {
    await initGitRepo(tmpDir);
    const deps = makeMockDeps();
    const baseExecute = deps.mockPhaseHandlers.execute;
    deps.mockPhaseHandlers.execute = async (ctx: any) => {
      writeFileSync(join(tmpDir, 'feature.txt'), 'implemented\n');
      await baseExecute(ctx);
    };
    const listActive = vi.fn(async () => []);
    const stage = vi.fn(async (_files: string[]) => {});
    deps.gitOps.stage = stage;
    const runner = new CycleRunner({
      cwd: tmpDir,
      config: DEFAULT_CYCLE_CONFIG,
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
      disableWorktrees: true,
      worktreePool: { listActive } as any,
    });

    const result = await runner.start();

    expect(result.stage).toBe(CycleStage.COMPLETED);
    expect(listActive).not.toHaveBeenCalled();
    expect(stage).toHaveBeenCalledWith(expect.arrayContaining(['feature.txt']));
  });

  it('passes gate rejection details into the retry execute phase', async () => {
    await initGitRepo(tmpDir);
    const deps = makeMockDeps();
    const observedExecuteContexts: Array<{
      retryAttempt?: number;
      gateRetry?: unknown;
    }> = [];
    const baseExecute = deps.mockPhaseHandlers.execute;
    deps.mockPhaseHandlers.execute = async (ctx: any) => {
      observedExecuteContexts.push({
        retryAttempt: ctx.retryAttempt,
        gateRetry: ctx.gateRetry,
      });
      writeFileSync(join(tmpDir, 'feature.txt'), `implemented attempt ${observedExecuteContexts.length}\n`);
      await baseExecute(ctx);
    };

    let gateCalls = 0;
    const baseGate = deps.mockPhaseHandlers.gate;
    deps.mockPhaseHandlers.gate = async (ctx: any) => {
      gateCalls++;
      if (gateCalls === 1) {
        const cycleDir = join(tmpDir, '.agentforge/cycles', ctx.cycleId);
        mkdirSync(cycleDir, { recursive: true });
        writeFileSync(
          join(cycleDir, 'agent-prs.json'),
          JSON.stringify([
            {
              prNumber: 153,
              prUrl: 'https://github.com/example/repo/pull/153',
              branch: 'codex/agent-executor-runtime-engineer-06e26f07b342',
              itemIds: ['i1'],
              status: 'open',
              openedAt: '2026-05-25T08:32:58.533Z',
            },
          ]),
        );
        throw new GateRejectedError(
          'MAJOR: packages/core/src/autonomous/phase-handlers/execute-phase.ts can pass undefined to truncateMemoryValue on branch codex/agent-executor-runtime-engineer-06e26f07b342.',
        );
      }
      await baseGate(ctx);
    };

    const runner = new CycleRunner({
      cwd: tmpDir,
      config: {
        ...DEFAULT_CYCLE_CONFIG,
        retry: {
          ...DEFAULT_CYCLE_CONFIG.retry,
          maxAutoRetries: 1,
          requireApprovalAfter: 99,
        },
      },
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
    });

    const result = await runner.start();

    expect(result.stage).toBe(CycleStage.COMPLETED);
    expect(observedExecuteContexts).toHaveLength(2);
    expect(observedExecuteContexts[0]!.gateRetry).toBeUndefined();
    expect(observedExecuteContexts[1]).toMatchObject({
      retryAttempt: 1,
      gateRetry: {
        attempt: 1,
        rejectedBranch: 'codex/agent-executor-runtime-engineer-06e26f07b342',
        prNumber: 153,
        prUrl: 'https://github.com/example/repo/pull/153',
        itemIds: ['i1'],
      },
    });
    expect((observedExecuteContexts[1]!.gateRetry as any).rationale).toContain('truncateMemoryValue');
    expect((observedExecuteContexts[1]!.gateRetry as any).files).toContain(
      'packages/core/src/autonomous/phase-handlers/execute-phase.ts',
    );
  });

  it('routes gate rejection context into the real retry execute prompt', async () => {
    await initGitRepo(tmpDir);
    const deps = makeMockDeps();
    const coderPrompts: string[] = [];
    deps.runtime.run = vi.fn(async (agent: string, task: string) => {
      if (agent === 'coder') {
        coderPrompts.push(task);
        writeFileSync(join(tmpDir, 'feature.txt'), `implemented attempt ${coderPrompts.length}\n`);
        return {
          output: 'ok',
          costUsd: 0.01,
          durationMs: 1,
          model: 'sonnet',
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      }
      return {
        output: JSON.stringify({
          rankings: [
            {
              itemId: 'i1',
              title: 'Fix bug',
              rank: 1,
              score: 0.9,
              confidence: 0.9,
              estimatedCostUsd: 5,
              estimatedDurationMinutes: 15,
              rationale: 'r',
              dependencies: [],
              suggestedAssignee: 'coder',
              suggestedTags: ['fix'],
              withinBudget: true,
            },
          ],
          totalEstimatedCostUsd: 5,
          budgetOverflowUsd: 0,
          summary: 'one fix',
          warnings: [],
        }),
        usage: { input_tokens: 100, output_tokens: 50 },
        costUsd: 0.01,
        durationMs: 500,
        model: 'sonnet',
      };
    });
    deps.mockPhaseHandlers.execute = async (ctx: any) => {
      await runExecutePhase(ctx, {
        maxParallelism: 1,
        maxItemRetries: 0,
        disableWorktrees: true,
        selfEvalDisabled: true,
      });
    };

    let gateCalls = 0;
    const baseGate = deps.mockPhaseHandlers.gate;
    deps.mockPhaseHandlers.gate = async (ctx: any) => {
      gateCalls++;
      if (gateCalls === 1) {
        const cycleDir = join(tmpDir, '.agentforge/cycles', ctx.cycleId);
        mkdirSync(cycleDir, { recursive: true });
        writeFileSync(
          join(cycleDir, 'agent-prs.json'),
          JSON.stringify([
            {
              prNumber: 153,
              prUrl: 'https://github.com/example/repo/pull/153',
              branch: 'codex/agent-executor-runtime-engineer-06e26f07b342',
              status: 'open',
              openedAt: '2026-05-25T08:32:58.533Z',
            },
          ]),
        );
        throw new GateRejectedError(
          'MAJOR: packages/core/src/autonomous/phase-handlers/execute-phase.ts can pass undefined to truncateMemoryValue.',
        );
      }
      await baseGate(ctx);
    };

    const runner = new CycleRunner({
      cwd: tmpDir,
      config: {
        ...DEFAULT_CYCLE_CONFIG,
        retry: {
          ...DEFAULT_CYCLE_CONFIG.retry,
          maxAutoRetries: 1,
          requireApprovalAfter: 99,
        },
      },
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
      disableWorktrees: true,
    });

    const result = await runner.start();

    expect(result.stage).toBe(CycleStage.COMPLETED);
    expect(coderPrompts).toHaveLength(2);
    expect(coderPrompts[0]).not.toContain('Gate Rejection Retry');
    expect(coderPrompts[1]!.startsWith('## Gate Rejection Retry')).toBe(true);
    expect(coderPrompts[1]).toContain('Rejected PR: #153');
    expect(coderPrompts[1]).toContain('Rejected branch: codex/agent-executor-runtime-engineer-06e26f07b342');
    expect(coderPrompts[1]).toContain('truncateMemoryValue');
  });

  it('retries multi-PR cycles on agent branch verification failures', async () => {
    await initGitRepo(tmpDir);
    const deps = makeMockDeps();
    const observedExecuteContexts: Array<{
      retryAttempt?: number;
      gateRetry?: unknown;
    }> = [];
    deps.mockPhaseHandlers.execute = async (ctx: any) => {
      observedExecuteContexts.push({
        retryAttempt: ctx.retryAttempt,
        gateRetry: ctx.gateRetry,
      });
      const cycleDir = join(tmpDir, '.agentforge/cycles', ctx.cycleId);
      mkdirSync(cycleDir, { recursive: true });
      writeFileSync(
        join(cycleDir, 'agent-prs.json'),
        JSON.stringify([
          {
            prNumber: 413,
            prUrl: 'https://github.com/example/repo/pull/413',
            branch: 'codex/agent-failing',
            itemIds: ['i1'],
            status: 'open',
            openedAt: '2026-05-28T12:00:00.000Z',
          },
        ]),
      );
      ctx.bus.publish('sprint.phase.completed', {
        sprintId: ctx.sprintId,
        phase: 'execute',
        cycleId: ctx.cycleId,
        result: {
          phase: 'execute',
          status: 'completed',
          durationMs: 500,
          costUsd: 1.0,
          agentRuns: [
            {
              itemId: 'i1',
              status: 'completed',
              costUsd: 1.0,
              durationMs: 500,
              response: 'implemented',
              attempts: 1,
              agentId: 'coder',
              worktreeBranch: 'codex/agent-failing',
            },
          ],
          itemResults: [],
        },
        completedAt: new Date().toISOString(),
      });
    };
    let verifierCalls = 0;
    const branchVerifier = vi.fn(async () => {
      verifierCalls++;
      if (verifierCalls === 1) {
        return {
          passed: false,
          results: [
            {
              branch: 'codex/agent-failing',
              agentId: 'coder',
              itemId: 'i1',
              status: 'failed' as const,
              command: 'corepack pnpm build',
              durationMs: 100,
              stdout: 'packages/cli/src/commands/autonomous.ts(1133,19): error TS18047',
              stderr: '',
              error: 'packages/cli/src/commands/autonomous.ts(1133,19): error TS18047',
            },
          ],
        };
      }
      return {
        passed: true,
        results: [
          {
            branch: 'codex/agent-failing',
            agentId: 'coder',
            itemId: 'i1',
            status: 'passed' as const,
            command: 'corepack pnpm build',
            durationMs: 100,
            commandsCompleted: 4,
          },
        ],
      };
    });
    const verifyEvents: any[] = [];
    deps.bus.subscribe('sprint.phase.verify.step', (event: any) => {
      verifyEvents.push(event);
    });
    const runner = new CycleRunner({
      cwd: tmpDir,
      config: {
        ...DEFAULT_CYCLE_CONFIG,
        prMode: 'multi',
        retry: {
          ...DEFAULT_CYCLE_CONFIG.retry,
          maxAutoRetries: 1,
          requireApprovalAfter: 99,
        },
      },
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      messageBus: new MessageBusV2({ workspaceId: 'test' }),
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
      worktreePool: { listActive: async () => [] } as any,
      multiPrBranchVerifier: branchVerifier as any,
    } as any);

    const result = await runner.start();

    expect(branchVerifier).toHaveBeenCalledTimes(2);
    expect(result.stage).toBe(CycleStage.COMPLETED);
    expect(observedExecuteContexts).toHaveLength(2);
    expect(observedExecuteContexts[0]!.gateRetry).toBeUndefined();
    expect(observedExecuteContexts[1]).toMatchObject({
      retryAttempt: 1,
      gateRetry: {
        attempt: 1,
        rejectedBranch: 'codex/agent-failing',
        prNumber: 413,
        prUrl: 'https://github.com/example/repo/pull/413',
        itemIds: ['i1'],
      },
    });
    expect((observedExecuteContexts[1]!.gateRetry as any).rationale).toContain('corepack pnpm build');
    expect((observedExecuteContexts[1]!.gateRetry as any).rationale).toContain('TS18047');
    expect(verifyEvents.map((event) => event.step)).toEqual([
      'branch-verify-complete',
      'branch-verify-complete',
      'tests-started',
      'tests-complete',
    ]);
    expect(verifyEvents[0]).toEqual(expect.objectContaining({
      passed: false,
      branches: 1,
      skipped: false,
    }));
    expect(verifyEvents[1]).toEqual(expect.objectContaining({
      passed: true,
      branches: 1,
      skipped: false,
    }));
  });

  it('records terminal FAILED result before auto-reforge on a final gate rejection', async () => {
    await initGitRepo(tmpDir);
    const deps = makeMockDeps();
    deps.mockPhaseHandlers.gate = async () => {
      throw new GateRejectedError('final gate rejection');
    };
    const observed: { cycleStage?: string; memoryStage?: string; gateVerdict?: string | null } = {};
    const reforgeSpy = vi.spyOn(autoReforgeModule, 'runAutoReforge').mockImplementation(async (opts) => {
      const cycleJsonPath = join(tmpDir, '.agentforge/cycles', opts.cycleId, 'cycle.json');
      const cycleJson = JSON.parse(readFileSync(cycleJsonPath, 'utf8')) as {
        stage?: string;
        gateVerdict?: string | null;
      };
      observed.cycleStage = cycleJson.stage;
      observed.gateVerdict = cycleJson.gateVerdict ?? null;
      observed.memoryStage = readCycleOutcomeMemoryStage(tmpDir);
      return {
        cycleId: opts.cycleId,
        skipped: true,
        durationMs: 0,
      };
    });
    vi.spyOn(autoReforgeModule, 'extractInvolvedAgentIds').mockReturnValue([]);

    const runner = new CycleRunner({
      cwd: tmpDir,
      config: {
        ...DEFAULT_CYCLE_CONFIG,
        // FIX 2 — auto-reforge is opt-in; this test asserts it runs after the
        // terminal FAILED result is recorded, so it must explicitly enable it.
        autoReforge: true,
        retry: { ...DEFAULT_CYCLE_CONFIG.retry, maxAutoRetries: 0 },
      },
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
    });

    const result = await runner.start();

    expect(reforgeSpy).toHaveBeenCalledOnce();
    expect(observed).toEqual({
      cycleStage: 'failed',
      memoryStage: 'failed',
      gateVerdict: 'REJECT',
    });
    expect(result.stage).toBe(CycleStage.FAILED);
    expect(result.error).toContain('gate: final gate rejection');
  });

  it('runs auto-reforge after terminal FAILED memory when execute phase fails', async () => {
    await initGitRepo(tmpDir);
    const deps = makeMockDeps();
    deps.mockPhaseHandlers.execute = async (ctx: any) => {
      ctx.bus.publish('sprint.phase.completed', {
        sprintId: ctx.sprintId,
        phase: 'execute',
        cycleId: ctx.cycleId,
        result: {
          phase: 'execute',
          status: 'failed',
          error: 'agent implementation failed',
          durationMs: 100,
          costUsd: 0.4,
          agentRuns: [
            {
              itemId: 'i1',
              status: 'failed',
              costUsd: 0.4,
              durationMs: 100,
              response: '',
              attempts: 1,
              agentId: 'coder',
              error: 'agent implementation failed',
            },
          ],
        },
        completedAt: new Date().toISOString(),
      });
    };

    const observed: { cycleStage?: string; memoryStage?: string; involvedAgentIds?: string[] } = {};
    const reforgeSpy = vi.spyOn(autoReforgeModule, 'runAutoReforge').mockImplementation(async (opts) => {
      const cycleJsonPath = join(tmpDir, '.agentforge/cycles', opts.cycleId, 'cycle.json');
      observed.cycleStage = JSON.parse(readFileSync(cycleJsonPath, 'utf8')).stage;
      observed.memoryStage = readCycleOutcomeMemoryStage(tmpDir);
      observed.involvedAgentIds = [...opts.involvedAgentIds];
      return {
        cycleId: opts.cycleId,
        skipped: true,
        durationMs: 0,
      };
    });

    const runner = new CycleRunner({
      cwd: tmpDir,
      // FIX 2 — auto-reforge is opt-in; enable it so this terminal-FAILED
      // reforge path is exercised.
      config: { ...DEFAULT_CYCLE_CONFIG, autoReforge: true },
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
    });

    const result = await runner.start();

    expect(reforgeSpy).toHaveBeenCalledOnce();
    expect(observed).toEqual({
      cycleStage: 'failed',
      memoryStage: 'failed',
      involvedAgentIds: ['coder'],
    });
    expect(result.stage).toBe(CycleStage.FAILED);
    expect(result.error).toBe('execute: agent implementation failed');
  });

  it('runs auto-reforge after terminal FAILED memory when a post-execute generic error fails the cycle', async () => {
    await initGitRepo(tmpDir);
    const deps = makeMockDeps();
    deps.preVerifyTypeCheck = async () => {
      throw new Error('preverify crashed');
    };
    const observed: { cycleStage?: string; memoryStage?: string } = {};
    const reforgeSpy = vi.spyOn(autoReforgeModule, 'runAutoReforge').mockImplementation(async (opts) => {
      const cycleJsonPath = join(tmpDir, '.agentforge/cycles', opts.cycleId, 'cycle.json');
      observed.cycleStage = JSON.parse(readFileSync(cycleJsonPath, 'utf8')).stage;
      observed.memoryStage = readCycleOutcomeMemoryStage(tmpDir);
      return {
        cycleId: opts.cycleId,
        skipped: true,
        durationMs: 0,
      };
    });

    const runner = new CycleRunner({
      cwd: tmpDir,
      // FIX 2 — auto-reforge is opt-in; enable it so both the in-cycle (3.25)
      // and terminal-FAILED reforge calls are exercised (asserted as 2 below).
      config: { ...DEFAULT_CYCLE_CONFIG, autoReforge: true },
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
    });

    const result = await runner.start();

    expect(reforgeSpy).toHaveBeenCalledTimes(2);
    expect(observed).toEqual({
      cycleStage: 'failed',
      memoryStage: 'failed',
    });
    expect(result.stage).toBe(CycleStage.FAILED);
    expect(result.error).toBe('preverify crashed');
  });

  it('writes cycle.json on completion (happy path)', async () => {
    const deps = makeMockDeps();
    const runner = new CycleRunner({
      cwd: tmpDir,
      config: DEFAULT_CYCLE_CONFIG,
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
    });
    const result = await runner.start();

    const cycleJsonPath = join(
      tmpDir,
      '.agentforge/cycles',
      result.cycleId,
      'cycle.json',
    );
    expect(existsSync(cycleJsonPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(cycleJsonPath, 'utf8'));
    expect(parsed.stage).toBe('completed');
    expect(parsed.cycleId).toBe(result.cycleId);
  });

  it('kills cycle on test floor violation', async () => {
    const deps = makeMockDeps();
    // Override testRunner to return a 50% pass rate (below the 95% floor).
    deps.testRunner.run = async (cycleId: string) => ({
      passed: 50,
      failed: 50,
      skipped: 0,
      total: 100,
      passRate: 0.5,
      durationMs: 5000,
      failedTests: [],
      newFailures: [],
      rawOutputPath: `.agentforge/cycles/${cycleId}/tests-raw.log`,
      exitCode: 1,
    });

    const runner = new CycleRunner({
      cwd: tmpDir,
      config: DEFAULT_CYCLE_CONFIG,
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
    });

    const result = await runner.start();

    expect(result.stage).toBe(CycleStage.KILLED);
    expect(result.killSwitch?.reason).toBe('testFloor');
    expect(result.pr.url).toBeNull();
  });

  it('writes cycle.json on kill-switch trip', async () => {
    const deps = makeMockDeps();
    deps.testRunner.run = async (cycleId: string) => ({
      passed: 50,
      failed: 50,
      skipped: 0,
      total: 100,
      passRate: 0.5,
      durationMs: 5000,
      failedTests: [],
      newFailures: [],
      rawOutputPath: `.agentforge/cycles/${cycleId}/tests-raw.log`,
      exitCode: 1,
    });

    const runner = new CycleRunner({
      cwd: tmpDir,
      config: DEFAULT_CYCLE_CONFIG,
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
    });

    const result = await runner.start();
    const cycleJsonPath = join(
      tmpDir,
      '.agentforge/cycles',
      result.cycleId,
      'cycle.json',
    );
    expect(existsSync(cycleJsonPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(cycleJsonPath, 'utf8'));
    expect(parsed.stage).toBe('killed');
    expect(parsed.killSwitch?.reason).toBe('testFloor');
  });

  it('marks cycle FAILED on non-kill-switch errors', async () => {
    const deps = makeMockDeps();
    // proposalAdapter throws → fails the PLAN stage with a generic error.
    deps.proposalAdapter.getRecentFailedSessions = async () => {
      throw new Error('database connection refused');
    };
    const reforgeSpy = vi.spyOn(autoReforgeModule, 'runAutoReforge').mockResolvedValue({
      cycleId: 'test-cycle',
      skipped: true,
      durationMs: 0,
    });

    const runner = new CycleRunner({
      cwd: tmpDir,
      config: DEFAULT_CYCLE_CONFIG,
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
    });

    const result = await runner.start();
    expect(result.stage).toBe(CycleStage.FAILED);
    expect(result.pr.url).toBeNull();
    expect(reforgeSpy).not.toHaveBeenCalled();

    const cycleJsonPath = join(
      tmpDir,
      '.agentforge/cycles',
      result.cycleId,
      'cycle.json',
    );
    expect(existsSync(cycleJsonPath)).toBe(true);
  });

  // v6.4.4 bug #2
  it('propagates error message to CycleResult on FAILED stage', async () => {
    const deps = makeMockDeps();
    deps.proposalAdapter.getRecentFailedSessions = async () => {
      throw new Error('database connection refused');
    };

    const runner = new CycleRunner({
      cwd: tmpDir,
      config: DEFAULT_CYCLE_CONFIG,
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
    });

    const result = await runner.start();
    expect(result.stage).toBe(CycleStage.FAILED);
    expect(result.error).toBe('database connection refused');

    const cycleJsonPath = join(
      tmpDir,
      '.agentforge/cycles',
      result.cycleId,
      'cycle.json',
    );
    const parsed = JSON.parse(readFileSync(cycleJsonPath, 'utf8'));
    expect(parsed.error).toBe('database connection refused');
  });

  // v6.5.1: the v6.4.4 TEST_POLLUTION_PATTERNS workaround was removed because
  // tests no longer mutate the real repo's .agentforge/. The filter that this
  // test used to assert is gone — see tests/e2e/cli.test.ts for the cleanup.

  // ── STAGE 3.5 — TYPECHECK ──────────────────────────────────────────────────

  it('kills cycle on build failure when requireBuildSuccess is true', async () => {
    const deps = makeMockDeps();
    deps.preVerifyTypeCheck = async () => ({
      buildOk: false,
      buildError: 'error TS2345: Argument of type string is not assignable',
      typeCheckOk: true,
    });

    const runner = new CycleRunner({
      cwd: tmpDir,
      config: {
        ...DEFAULT_CYCLE_CONFIG,
        quality: { ...DEFAULT_CYCLE_CONFIG.quality, requireBuildSuccess: true },
      },
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
    });

    const result = await runner.start();
    expect(result.stage).toBe(CycleStage.KILLED);
    expect(result.killSwitch?.reason).toBe('buildFailure');
    expect(result.pr.url).toBeNull();
  });

  it('kills cycle on typecheck failure when requireTypeCheckSuccess is true', async () => {
    const deps = makeMockDeps();
    deps.preVerifyTypeCheck = async () => ({
      buildOk: true,
      typeCheckOk: false,
      typeCheckError: 'error TS2305: Module has no exported member X',
    });

    const runner = new CycleRunner({
      cwd: tmpDir,
      config: {
        ...DEFAULT_CYCLE_CONFIG,
        quality: { ...DEFAULT_CYCLE_CONFIG.quality, requireTypeCheckSuccess: true },
      },
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
    });

    const result = await runner.start();
    expect(result.stage).toBe(CycleStage.KILLED);
    expect(result.killSwitch?.reason).toBe('typeCheckFailure');
    expect(result.pr.url).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // augmentLessonAttributionsWithVerifyResult
  // ---------------------------------------------------------------------------

  describe('augmentLessonAttributionsWithVerifyResult — post-VERIFY fill', () => {
    // Import helpers inline at test scope so the describe block is self-contained.
    // We import from the dist (built) path via the package alias or source path.
    let appendLessonAttributions: typeof import('../../../packages/core/src/memory/lesson-attribution.js').appendLessonAttributions;
    let readLessonAttributions: typeof import('../../../packages/core/src/memory/lesson-attribution.js').readLessonAttributions;
    let aggregateLessonOutcomes: typeof import('../../../packages/core/src/memory/lesson-attribution.js').aggregateLessonOutcomes;

    beforeEach(async () => {
      const mod = await import('../../../packages/core/src/memory/lesson-attribution.js');
      appendLessonAttributions = mod.appendLessonAttributions;
      readLessonAttributions = mod.readLessonAttributions;
      aggregateLessonOutcomes = mod.aggregateLessonOutcomes;
    });

    /**
     * Seed the lesson-attribution file with rows that have gateVerdict filled
     * but verifyPassed absent (the state test-phase produces before VERIFY).
     */
    function seedRows(
      root: string,
      cycleId: string,
      append: typeof appendLessonAttributions,
    ): void {
      append(root, [
        {
          cycleId,
          itemId: 'item-1',
          agentId: 'coder',
          lessonId: 'lesson-a',
          lessonText: 'Use execFile not exec.',
          scope: 'cycle',
          gateVerdict: 'approved',
          // verifyPassed intentionally absent
        },
        {
          cycleId,
          itemId: 'item-2',
          agentId: 'coder',
          lessonId: 'lesson-b',
          lessonText: 'Always use js-yaml dump.',
          scope: 'cycle',
          gateVerdict: 'approved',
          // verifyPassed intentionally absent
        },
      ]);
    }

    it('appends verifyPassed=true rows for the cycle when all tests pass', async () => {
      await initGitRepo(tmpDir);
      const deps = makeMockDeps();
      // Must be a valid UUID so CycleRunner accepts it (UUID_RE validation in constructor).
      const knownCycleId = '00000000-1111-2222-3333-444444444444';

      // Pre-seed attribution rows with gateVerdict but no verifyPassed
      // (simulating what test-phase writes before VERIFY runs).
      seedRows(tmpDir, knownCycleId, appendLessonAttributions);

      // Confirm seed: 2 rows, none have verifyPassed set
      const rowsBefore = readLessonAttributions(tmpDir).filter((r) => r.cycleId === knownCycleId);
      expect(rowsBefore).toHaveLength(2);
      expect(rowsBefore.every((r) => r.verifyPassed === undefined)).toBe(true);

      // failed=0 → augmentLessonAttributionsWithVerifyResult should set verifyPassed=true
      deps.testRunner.run = async (cycleId: string) => ({
        passed: 50,
        failed: 0,
        skipped: 0,
        total: 50,
        passRate: 1.0,
        durationMs: 1000,
        failedTests: [],
        newFailures: [],
        rawOutputPath: `.agentforge/cycles/${cycleId}/tests-raw.log`,
        exitCode: 0,
      });

      // Pass the known cycleId so the runner writes to the same cycle directory
      // and augmentLessonAttributionsWithVerifyResult can find our seeded rows.
      const runner = new CycleRunner({
        cwd: tmpDir,
        cycleId: knownCycleId,
        config: DEFAULT_CYCLE_CONFIG,
        runtime: deps.runtime as any,
        proposalAdapter: deps.proposalAdapter as any,
        scoringAdapter: deps.scoringAdapter as any,
        phaseHandlers: deps.mockPhaseHandlers as any,
        testRunner: deps.testRunner as any,
        gitOps: deps.gitOps as any,
        prOpener: deps.prOpener as any,
        bus: deps.bus as any,
        preVerifyTypeCheck: deps.preVerifyTypeCheck,
        dryRun: { prOpener: true },
      });

      const result = await runner.start();
      expect(result.stage).toBe(CycleStage.COMPLETED);

      // After the cycle, the attribution file should have the original 2 rows +
      // 2 new rows with verifyPassed=true appended by augmentLessonAttributionsWithVerifyResult.
      const allRows = readLessonAttributions(tmpDir).filter((r) => r.cycleId === knownCycleId);
      expect(allRows.length).toBeGreaterThanOrEqual(4);

      // The augmented rows have verifyPassed=true
      const augmentedRows = allRows.filter((r) => r.verifyPassed !== undefined);
      expect(augmentedRows.length).toBeGreaterThanOrEqual(2);
      expect(augmentedRows.every((r) => r.verifyPassed === true)).toBe(true);

      // aggregateLessonOutcomes selects the latest row per (cycleId,itemId,lessonId).
      // The augmented rows carry gateVerdict='approved' + verifyPassed=true → passes.
      const outcomes = aggregateLessonOutcomes(allRows);
      expect(outcomes.get('lesson-a')?.appearances).toBe(1);
      expect(outcomes.get('lesson-a')?.passes).toBe(1);
      expect(outcomes.get('lesson-b')?.appearances).toBe(1);
      expect(outcomes.get('lesson-b')?.passes).toBe(1);
    });

    it('fills verifyPassed=false when tests fail and dedup marks the lesson as not passed', async () => {
      await initGitRepo(tmpDir);

      const cycleId = 'test-cycle-verify-fail';

      // Seed rows with gateVerdict='approved' but no verifyPassed
      seedRows(tmpDir, cycleId, appendLessonAttributions);

      // Append augmented rows with verifyPassed=false (failed>0).
      // Must include gateVerdict so aggregateLessonOutcomes indexes this row
      // (it skips rows without gateVerdict). Also ensure a later ts so dedup
      // selects the VERIFY row over the seed row.
      await new Promise((r) => setTimeout(r, 5));
      const rows = readLessonAttributions(tmpDir).filter((r) => r.cycleId === cycleId);
      expect(rows).toHaveLength(2);
      appendLessonAttributions(tmpDir, rows.map((r) => ({
        cycleId: r.cycleId,
        itemId: r.itemId,
        agentId: r.agentId,
        lessonId: r.lessonId,
        lessonText: r.lessonText,
        scope: 'cycle' as const,
        gateVerdict: r.gateVerdict,
        verifyPassed: false as const,
      })));

      const allRows = readLessonAttributions(tmpDir).filter((r) => r.cycleId === cycleId);
      // The latest row for each lesson has verifyPassed=false
      const outcomes = aggregateLessonOutcomes(allRows);
      // gateVerdict='approved' but verifyPassed=false → NOT a pass
      expect(outcomes.get('lesson-a')?.appearances).toBe(1);
      expect(outcomes.get('lesson-a')?.passes).toBe(0);
      expect(outcomes.get('lesson-b')?.appearances).toBe(1);
      expect(outcomes.get('lesson-b')?.passes).toBe(0);
    });

    it('VERIFY-time row supersedes the test-phase row when verifyPassed is present', async () => {
      await initGitRepo(tmpDir);

      const cycleId = 'test-cycle-dedup-verify-wins';

      // Seed: test-phase row has gateVerdict='approved', no verifyPassed
      // → counts as pass (verifyPassed!==false) until VERIFY augments it.
      seedRows(tmpDir, cycleId, appendLessonAttributions);

      // Guarantee a strictly later ts for the VERIFY-time rows.
      await new Promise((r) => setTimeout(r, 5));

      // VERIFY-time rows: same cycleId+itemId+lessonId but verifyPassed=false.
      // Must carry gateVerdict so aggregateLessonOutcomes can pick them up.
      const rows = readLessonAttributions(tmpDir).filter((r) => r.cycleId === cycleId);
      appendLessonAttributions(tmpDir, rows.map((r) => ({
        cycleId: r.cycleId,
        itemId: r.itemId,
        agentId: r.agentId,
        lessonId: r.lessonId,
        lessonText: r.lessonText,
        scope: 'cycle' as const,
        gateVerdict: r.gateVerdict,
        verifyPassed: false as const,
      })));

      const allRows = readLessonAttributions(tmpDir).filter((r) => r.cycleId === cycleId);
      const outcomes = aggregateLessonOutcomes(allRows);
      // VERIFY row (verifyPassed=false, later ts) wins over test-phase row.
      // gateVerdict='approved' + verifyPassed=false → NOT a pass.
      expect(outcomes.get('lesson-a')?.passes).toBe(0);
      expect(outcomes.get('lesson-b')?.passes).toBe(0);
    });

    it('does not augment rows from a different cycleId', () => {
      const cycleId = 'target-cycle';
      const otherCycleId = 'other-cycle';

      // Seed rows for a different cycleId
      appendLessonAttributions(tmpDir, [{
        cycleId: otherCycleId,
        itemId: 'item-1',
        agentId: 'coder',
        lessonId: 'lesson-a',
        lessonText: 'Use execFile not exec.',
        scope: 'cycle',
        gateVerdict: 'approved',
      }]);

      // The augmentation only reads rows where r.cycleId === cycleId
      const rowsForTarget = readLessonAttributions(tmpDir).filter((r) => r.cycleId === cycleId);
      // No rows for target cycleId → nothing to augment → early return
      expect(rowsForTarget).toHaveLength(0);

      // The other cycleId's rows should be unaffected
      const allRows = readLessonAttributions(tmpDir);
      expect(allRows).toHaveLength(1);
      expect(allRows[0]?.verifyPassed).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// P0.2 — Objective-mode bypass (empty backlog OK; scoring + approval skipped).
//
// When the CycleRunner is constructed with `objective`, STAGE 1 must:
//   (a) NOT throw "No backlog items to work on — nothing to do" on an empty
//       backlog (the epic decomposer in the plan phase is the planner);
//   (b) bypass the ScoringPipeline ladder and the BudgetApproval gate.
// The legacy (no-objective) path must behave exactly as before: it throws on
// an empty backlog, and it runs scoring + approval on a non-empty backlog.
// ---------------------------------------------------------------------------

const NO_BACKLOG_MESSAGE = 'No backlog items to work on — nothing to do';

/** A proposalAdapter that yields zero signals → an empty backlog. */
function emptyProposalAdapter() {
  return {
    getRecentFailedSessions: async () => [],
    getCostAnomalies: async () => [],
    getFailedTaskOutcomes: async () => [],
    getFlakingTests: async () => [],
  };
}

describe('CycleRunner objective mode (P0.2)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-cr-obj-'));
    mkdirSync(join(tmpDir, '.agentforge/sprints'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.agentforge/sprints/v6.3.5.json'),
      '{"sprints":[{"version":"6.3.5"}]}',
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('does NOT throw "No backlog items" when an objective is set and the backlog is empty', async () => {
    await initGitRepo(tmpDir);
    const deps = makeMockDeps();
    deps.proposalAdapter = emptyProposalAdapter();

    const runner = new CycleRunner({
      cwd: tmpDir,
      config: DEFAULT_CYCLE_CONFIG,
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
      objective: 'Add a dark-mode toggle to the settings page',
    });

    const result = await runner.start();

    // The defining regression guard: the empty-backlog throw must be skipped.
    expect(result.error ?? '').not.toContain(NO_BACKLOG_MESSAGE);
    // It must reach STAGE 2+ (planning); it must not be the FAILED-on-empty path.
    expect(result.stage).not.toBe(CycleStage.FAILED);
  });

  it('STILL throws "No backlog items" when NO objective is set and the backlog is empty (legacy regression guard)', async () => {
    await initGitRepo(tmpDir);
    const deps = makeMockDeps();
    deps.proposalAdapter = emptyProposalAdapter();

    const runner = new CycleRunner({
      cwd: tmpDir,
      config: DEFAULT_CYCLE_CONFIG,
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
      // no objective
    });

    const result = await runner.start();

    // start() catches the thrown Error and surfaces it as a FAILED result.
    expect(result.stage).toBe(CycleStage.FAILED);
    expect(result.error).toBe(NO_BACKLOG_MESSAGE);
  });

  it('skips the scoring ladder and BudgetApproval gate in objective mode', async () => {
    await initGitRepo(tmpDir);
    const deps = makeMockDeps();
    deps.proposalAdapter = emptyProposalAdapter();

    const scoreSpy = vi.spyOn(ScoringPipeline.prototype, 'scoreWithFallback');
    const approveSpy = vi.spyOn(BudgetApproval.prototype, 'collect');

    const runner = new CycleRunner({
      cwd: tmpDir,
      config: DEFAULT_CYCLE_CONFIG,
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
      objective: 'Add a dark-mode toggle to the settings page',
    });

    await runner.start();

    expect(scoreSpy).not.toHaveBeenCalled();
    expect(approveSpy).not.toHaveBeenCalled();
  });

  it('STILL runs the scoring ladder and BudgetApproval gate in legacy mode (non-empty backlog)', async () => {
    await initGitRepo(tmpDir);
    const deps = makeMockDeps();
    // Default makeMockDeps proposalAdapter yields one failed session → non-empty.

    const scoreSpy = vi.spyOn(ScoringPipeline.prototype, 'scoreWithFallback');
    const approveSpy = vi.spyOn(BudgetApproval.prototype, 'collect');

    const runner = new CycleRunner({
      cwd: tmpDir,
      config: DEFAULT_CYCLE_CONFIG,
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
      // no objective → legacy path
    });

    await runner.start();

    expect(scoreSpy).toHaveBeenCalledTimes(1);
    expect(approveSpy).toHaveBeenCalledTimes(1);
  });

  // ── FIX 1 — finally-restore the operator's branch ──────────────────────────
  //
  // Incident: every width-1 (legacy) cycle left the main working tree checked
  // out on the autonomous branch (codex/vX.Y.Z). The runner now captures the
  // operator's branch at run start and restores it on EVERY exit, unless the
  // tree is too dirty to switch safely (in which case it warns instead).

  async function currentBranch(dir: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
    return stdout.toString().trim();
  }

  it('restores the operator branch after a successful cycle that switched branches', async () => {
    await initGitRepo(tmpDir);
    // Mirror production: .agentforge/ is gitignored so the cycle's own JSON
    // artifacts do not count as a dirty tree.
    writeFileSync(join(tmpDir, '.gitignore'), '.agentforge/\n');
    await execFileAsync('git', ['add', '.gitignore'], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-m', 'ignore agentforge'], { cwd: tmpDir });
    // The operator starts on a non-default branch (mimics codex/vX.Y.Z).
    await execFileAsync('git', ['checkout', '-b', 'codex/v99.0.0'], { cwd: tmpDir });

    const deps = makeMockDeps();
    const baseExecute = deps.mockPhaseHandlers.execute;
    // Simulate the legacy GitOps path: switch to the autonomous branch and
    // commit the work, leaving HEAD on the autonomous branch with a CLEAN tree.
    deps.mockPhaseHandlers.execute = async (ctx: any) => {
      await execFileAsync('git', ['checkout', '-b', 'autonomous/v6.3.6'], { cwd: tmpDir });
      writeFileSync(join(tmpDir, 'feature.txt'), 'implemented\n');
      await execFileAsync('git', ['add', 'feature.txt'], { cwd: tmpDir });
      await execFileAsync('git', ['commit', '-m', 'work'], { cwd: tmpDir });
      await baseExecute(ctx);
    };

    const runner = new CycleRunner({
      cwd: tmpDir,
      config: DEFAULT_CYCLE_CONFIG,
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
    });

    const result = await runner.start();
    expect(result.stage).toBe(CycleStage.COMPLETED);
    // The operator's branch is restored even though the cycle switched it.
    expect(await currentBranch(tmpDir)).toBe('codex/v99.0.0');
  });

  it('restores the operator branch after a thrown stage error', async () => {
    await initGitRepo(tmpDir);
    writeFileSync(join(tmpDir, '.gitignore'), '.agentforge/\n');
    await execFileAsync('git', ['add', '.gitignore'], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-m', 'ignore agentforge'], { cwd: tmpDir });
    await execFileAsync('git', ['checkout', '-b', 'codex/v99.0.0'], { cwd: tmpDir });

    const deps = makeMockDeps();
    // Switch + commit (clean tree), then fail a LATER phase so the cycle ends
    // FAILED while HEAD sits on the autonomous branch.
    deps.mockPhaseHandlers.execute = async (ctx: any) => {
      await execFileAsync('git', ['checkout', '-b', 'autonomous/v6.3.6'], { cwd: tmpDir });
      writeFileSync(join(tmpDir, 'feature.txt'), 'implemented\n');
      await execFileAsync('git', ['add', 'feature.txt'], { cwd: tmpDir });
      await execFileAsync('git', ['commit', '-m', 'work'], { cwd: tmpDir });
      const baseExecute = makeMockDeps().mockPhaseHandlers.execute;
      await baseExecute(ctx);
    };
    deps.mockPhaseHandlers.gate = async () => {
      throw new GateRejectedError('forced gate rejection');
    };

    const runner = new CycleRunner({
      cwd: tmpDir,
      config: { ...DEFAULT_CYCLE_CONFIG, retry: { ...DEFAULT_CYCLE_CONFIG.retry, maxAutoRetries: 0 } },
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
    });

    const result = await runner.start();
    expect(result.stage).toBe(CycleStage.FAILED);
    // Restoration runs in the finally even on the failure exit.
    expect(await currentBranch(tmpDir)).toBe('codex/v99.0.0');
  });

  it('does NOT switch when the tree is dirty; warns and leaves the autonomous branch checked out', async () => {
    await initGitRepo(tmpDir);
    await execFileAsync('git', ['checkout', '-b', 'codex/v99.0.0'], { cwd: tmpDir });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const deps = makeMockDeps();
    // Switch branch but leave the tree DIRTY (uncommitted file). Restoration
    // must refuse to switch and warn instead.
    deps.mockPhaseHandlers.execute = async (ctx: any) => {
      await execFileAsync('git', ['checkout', '-b', 'autonomous/v6.3.6'], { cwd: tmpDir });
      writeFileSync(join(tmpDir, 'feature.txt'), 'uncommitted\n');
      const baseExecute = makeMockDeps().mockPhaseHandlers.execute;
      await baseExecute(ctx);
    };

    const runner = new CycleRunner({
      cwd: tmpDir,
      config: DEFAULT_CYCLE_CONFIG,
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
    });

    await runner.start();

    // Tree is dirty → restoration must NOT switch back.
    expect(await currentBranch(tmpDir)).toBe('autonomous/v6.3.6');
    // A one-line warning naming the original branch was emitted.
    const warned = warnSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === 'string' && a.includes('codex/v99.0.0')),
    );
    expect(warned).toBe(true);
  });

  // ── FIX 2 — auto-reforge is OPT-IN (default OFF) ───────────────────────────
  //
  // Incident: stage 3.25 auto-reforge mutated .agentforge/agents/*.yaml
  // mid-cycle and leaked unrelated changes into PRs. It now runs only when
  // explicitly opted in.

  function makeSuccessfulExecuteDeps() {
    const deps = makeMockDeps();
    const baseExecute = deps.mockPhaseHandlers.execute;
    deps.mockPhaseHandlers.execute = async (ctx: any) => {
      writeFileSync(join(tmpDir, 'feature.txt'), 'implemented\n');
      await baseExecute(ctx);
    };
    return deps;
  }

  it('does NOT invoke auto-reforge by default (opt-in gate)', async () => {
    await initGitRepo(tmpDir);
    const deps = makeSuccessfulExecuteDeps();
    const reforgeSpy = vi.spyOn(autoReforgeModule, 'runAutoReforge').mockResolvedValue({
      cycleId: 'x',
      skipped: true,
      durationMs: 0,
    });

    const runner = new CycleRunner({
      cwd: tmpDir,
      config: DEFAULT_CYCLE_CONFIG, // autoReforge unset → default OFF
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
    });

    const result = await runner.start();
    expect(result.stage).toBe(CycleStage.COMPLETED);
    expect(reforgeSpy).not.toHaveBeenCalled();
  });

  it('invokes auto-reforge when config.autoReforge=true', async () => {
    await initGitRepo(tmpDir);
    const deps = makeSuccessfulExecuteDeps();
    const reforgeSpy = vi.spyOn(autoReforgeModule, 'runAutoReforge').mockResolvedValue({
      cycleId: 'x',
      skipped: true,
      durationMs: 0,
    });

    const runner = new CycleRunner({
      cwd: tmpDir,
      config: { ...DEFAULT_CYCLE_CONFIG, autoReforge: true },
      runtime: deps.runtime as any,
      proposalAdapter: deps.proposalAdapter as any,
      scoringAdapter: deps.scoringAdapter as any,
      phaseHandlers: deps.mockPhaseHandlers as any,
      testRunner: deps.testRunner as any,
      gitOps: deps.gitOps as any,
      prOpener: deps.prOpener as any,
      bus: deps.bus as any,
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
    });

    const result = await runner.start();
    expect(result.stage).toBe(CycleStage.COMPLETED);
    expect(reforgeSpy).toHaveBeenCalled();
  });

  it('invokes auto-reforge when AGENTFORGE_AUTO_REFORGE=1 even if config flag is unset', async () => {
    await initGitRepo(tmpDir);
    const prev = process.env['AGENTFORGE_AUTO_REFORGE'];
    process.env['AGENTFORGE_AUTO_REFORGE'] = '1';
    try {
      const deps = makeSuccessfulExecuteDeps();
      const reforgeSpy = vi.spyOn(autoReforgeModule, 'runAutoReforge').mockResolvedValue({
        cycleId: 'x',
        skipped: true,
        durationMs: 0,
      });

      const runner = new CycleRunner({
        cwd: tmpDir,
        config: DEFAULT_CYCLE_CONFIG, // flag unset; env opts in
        runtime: deps.runtime as any,
        proposalAdapter: deps.proposalAdapter as any,
        scoringAdapter: deps.scoringAdapter as any,
        phaseHandlers: deps.mockPhaseHandlers as any,
        testRunner: deps.testRunner as any,
        gitOps: deps.gitOps as any,
        prOpener: deps.prOpener as any,
        bus: deps.bus as any,
        preVerifyTypeCheck: deps.preVerifyTypeCheck,
        dryRun: { prOpener: true },
      });

      const result = await runner.start();
      expect(result.stage).toBe(CycleStage.COMPLETED);
      expect(reforgeSpy).toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env['AGENTFORGE_AUTO_REFORGE'];
      else process.env['AGENTFORGE_AUTO_REFORGE'] = prev;
    }
  });
});
