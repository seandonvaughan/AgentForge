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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

import { CycleRunner } from '../../../packages/core/src/autonomous/cycle-runner.js';
import { DEFAULT_CYCLE_CONFIG } from '../../../packages/core/src/autonomous/config-loader.js';
import { CycleStage } from '../../../packages/core/src/autonomous/types.js';

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
  });

  it('runs a full cycle end-to-end with mocked dependencies', async () => {
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
      dryRun: { prOpener: true },
    });

    const result = await runner.start();
    expect(result.stage).toBe(CycleStage.FAILED);
    expect(result.pr.url).toBeNull();

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
});
