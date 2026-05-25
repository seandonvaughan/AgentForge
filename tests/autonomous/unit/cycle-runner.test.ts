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

import { CycleRunner, DEFAULT_CYCLE_CONFIG, CycleStage, MessageBusV2 } from '@agentforge/core';
import * as autoReforgeModule from '../../../packages/core/src/autonomous/auto-reforge.js';
import { GateRejectedError } from '../../../packages/core/src/autonomous/phase-handlers/gate-phase.js';

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

  it('fails when a worktree pool is provided outside prMode=multi', async () => {
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
      worktreePool: {} as any,
    });

    const result = await runner.start();

    expect(result.stage).toBe(CycleStage.FAILED);
    expect(result.error).toContain('options.worktreePool currently requires prMode=multi');
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

  it('marks multi-PR cycles failed when an agent branch verifier fails', async () => {
    await initGitRepo(tmpDir);
    const deps = makeMockDeps();
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
    const branchVerifier = vi.fn(async () => ({
      passed: false,
      results: [
        {
          branch: 'codex/agent-failing',
          agentId: 'coder',
          itemId: 'i1',
          status: 'failed' as const,
          command: 'corepack pnpm test',
          durationMs: 100,
          stdout: '',
          stderr: 'branch tests failed',
          error: 'branch tests failed',
        },
      ],
    }));
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
      messageBus: new MessageBusV2({ workspaceId: 'test' }),
      preVerifyTypeCheck: deps.preVerifyTypeCheck,
      dryRun: { prOpener: true },
      worktreePool: { listActive: async () => [] } as any,
      multiPrBranchVerifier: branchVerifier as any,
    } as any);

    const result = await runner.start();

    expect(branchVerifier).toHaveBeenCalledOnce();
    expect(result.stage).toBe(CycleStage.FAILED);
    expect(result.error).toContain('multi-pr branch verification failed');
    expect(result.error).toContain('codex/agent-failing');
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
});
