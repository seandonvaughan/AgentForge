/**
 * Tests for `agentforge objective "<text>" --budget <usd> [--project-root <path>]`.
 *
 * Verifies that the command:
 *  1. Parses the positional <text> argument and --budget option correctly.
 *  2. Forwards both to the cycle-run objective path (CycleRunner receives
 *     `objective` and the budget is applied to `config.budget.perCycleUsd`).
 *  3. Rejects non-positive budget values with exit code 1 before delegating.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Hoisted captures — mutated inside mock factories so they survive vi.mock()
// hoisting to the top of the file.
// ---------------------------------------------------------------------------
const captures = vi.hoisted(() => ({
  cycleRunnerOptions: [] as Array<Record<string, unknown>>,
}));

// ---------------------------------------------------------------------------
// Mock @agentforge/core — mirrors the minimal surface used by autonomous.ts
// so that runCycleAction runs end-to-end with the captured CycleRunner state.
// ---------------------------------------------------------------------------
vi.mock('@agentforge/core', () => {
  function CycleRunnerMock(this: object, opts: Record<string, unknown>) {
    captures.cycleRunnerOptions.push(opts);
  }
  CycleRunnerMock.prototype.start = function () {
    return Promise.resolve({
      stage: 'completed',
      sprintVersion: '1',
      pr: { url: null },
      cost: { totalUsd: 0, budgetUsd: 5 },
      tests: { passed: 0, total: 0, passRate: 1 },
    });
  };

  function WorkspaceManagerMock(this: object) {}
  WorkspaceManagerMock.prototype.getOrCreateDefaultWorkspace = function () {
    return Promise.resolve({ adapter: {} });
  };
  WorkspaceManagerMock.prototype.close = function () {};

  function WorktreePoolMock() {}
  function RuntimeJobSupervisorMock(this: object) {}
  function RealTestRunnerMock(this: object) {}
  function GitOpsMock(this: object) {}
  function PROpenerMock(this: object) {}
  function CycleLoggerMock(this: object) {}
  function MessageBusV2Mock(this: object) {}
  MessageBusV2Mock.prototype.publish = function () {};
  MessageBusV2Mock.prototype.subscribe = function () {
    return () => undefined;
  };
  function RuntimeAdapterMock(this: object) {}

  return {
    loadCycleConfig: vi.fn().mockImplementation(() => ({
      budget: { perCycleUsd: 30, allowOverageApproval: false },
      limits: { maxItemsPerSprint: 5, maxExecutePhaseParallelism: 4 },
      quality: {
        testPassRateFloor: 0.95,
        requireBuildSuccess: false,
        requireTypeCheckSuccess: false,
      },
      git: { branchPrefix: 'autonomous/', baseBranch: 'main' },
      pr: { draft: false },
      testing: {},
      prMode: 'single',
    })),
    RuntimeAdapter: RuntimeAdapterMock,
    CycleRunner: CycleRunnerMock,
    CycleStage: { COMPLETED: 'completed', KILLED: 'killed' },
    WorktreePool: WorktreePoolMock,
    RuntimeJobSupervisor: RuntimeJobSupervisorMock,
    WorkspaceManager: WorkspaceManagerMock,
    RealTestRunner: RealTestRunnerMock,
    GitOps: GitOpsMock,
    PROpener: PROpenerMock,
    CycleLogger: CycleLoggerMock,
    MessageBusV2: MessageBusV2Mock,
    createAutonomousTelemetryAdapters: vi.fn().mockReturnValue({
      proposalAdapter: {},
      scoringAdapter: {},
      close: vi.fn(),
    }),
    runExecutePhase: vi.fn().mockResolvedValue(undefined),
    runAuditPhase: vi.fn().mockResolvedValue(undefined),
    runPlanPhase: vi.fn().mockResolvedValue(undefined),
    runAssignPhase: vi.fn().mockResolvedValue(undefined),
    runGatePhase: vi.fn().mockResolvedValue(undefined),
    runLearnPhase: vi.fn().mockResolvedValue(undefined),
    runTestPhase: vi.fn().mockResolvedValue(undefined),
    runReviewPhase: vi.fn().mockResolvedValue(undefined),
    runReleasePhase: vi.fn().mockResolvedValue(undefined),
    getWorkspace: vi.fn().mockReturnValue(null),
    getDefaultWorkspace: vi.fn().mockReturnValue(null),
    readCheckpoint: vi.fn().mockReturnValue(null),
  };
});

// ---------------------------------------------------------------------------
// Imports — AFTER vi.mock() so the mock is hoisted above them.
// ---------------------------------------------------------------------------
import { Command } from 'commander';
import { registerObjectiveCommand } from '../objective.js';

// ---------------------------------------------------------------------------
// Helper — spins up a fresh Commander program with only the objective command
// registered, then parses the given args.
// ---------------------------------------------------------------------------
async function runObjectiveCli(args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  registerObjectiveCommand(program);
  try {
    await program.parseAsync(['node', 'agentforge', ...args]);
  } catch {
    // exitOverride() converts Commander's internal process.exit() calls (e.g.
    // for --help or unknown options) into thrown CommanderErrors.  Tests assert
    // on captures and process.exitCode, not on thrown errors.
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('objective command', () => {
  let projectRoot: string;
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-objective-test-'));
    captures.cycleRunnerOptions.length = 0;
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;
  });

  afterEach(() => {
    consoleLog.mockRestore();
    consoleError.mockRestore();
    rmSync(projectRoot, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('forwards objective text and budget to the cycle-run path', async () => {
    await runObjectiveCli([
      'objective',
      'Fix the authentication bug',
      '--budget',
      '5',
      '--project-root',
      projectRoot,
    ]);

    // CycleRunner must have been constructed exactly once.
    expect(captures.cycleRunnerOptions).toHaveLength(1);

    // The objective text must be forwarded.
    expect(captures.cycleRunnerOptions[0]).toMatchObject({
      objective: 'Fix the authentication bug',
    });

    // The budget must be applied to config.budget.perCycleUsd (float).
    expect(captures.cycleRunnerOptions[0]?.['config']).toMatchObject({
      budget: { perCycleUsd: 5 },
    });

    // No error exit code for a successful cycle.
    expect(process.exitCode).toBeUndefined();
  });

  it('accepts a decimal budget value', async () => {
    await runObjectiveCli([
      'objective',
      'Refactor the database layer',
      '--budget',
      '12.5',
      '--project-root',
      projectRoot,
    ]);

    expect(captures.cycleRunnerOptions).toHaveLength(1);
    expect(captures.cycleRunnerOptions[0]?.['config']).toMatchObject({
      budget: { perCycleUsd: 12.5 },
    });
  });

  it('rejects a negative budget before delegating', async () => {
    await runObjectiveCli([
      'objective',
      'Some goal',
      '--budget',
      '-1',
      '--project-root',
      projectRoot,
    ]);

    expect(process.exitCode).toBe(1);
    // CycleRunner must NOT have been called.
    expect(captures.cycleRunnerOptions).toHaveLength(0);
  });

  it('rejects a zero budget before delegating', async () => {
    await runObjectiveCli([
      'objective',
      'Some goal',
      '--budget',
      '0',
      '--project-root',
      projectRoot,
    ]);

    expect(process.exitCode).toBe(1);
    expect(captures.cycleRunnerOptions).toHaveLength(0);
  });

  it('rejects a non-numeric budget before delegating', async () => {
    await runObjectiveCli([
      'objective',
      'Some goal',
      '--budget',
      'abc',
      '--project-root',
      projectRoot,
    ]);

    expect(process.exitCode).toBe(1);
    expect(captures.cycleRunnerOptions).toHaveLength(0);
  });

  it('uses process.cwd() as default project root when --project-root is omitted', async () => {
    await runObjectiveCli([
      'objective',
      'Some goal',
      '--budget',
      '10',
    ]);

    // CycleRunner should still be invoked (default project root accepted).
    expect(captures.cycleRunnerOptions).toHaveLength(1);
    expect(captures.cycleRunnerOptions[0]).toMatchObject({
      objective: 'Some goal',
    });
  });
});
