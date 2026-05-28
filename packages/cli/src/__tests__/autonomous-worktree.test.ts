// packages/cli/src/__tests__/autonomous-worktree.test.ts
//
// Unit tests for WorktreePool wiring in runCycleAction.
// These tests verify the --no-worktrees flag, AUTONOMOUS_DISABLE_WORKTREES env,
// and the defensive fallback when WorktreePool construction throws.
//
// Strategy: mock @agentforge/core so we can intercept WorktreePool and
// CycleRunner construction without executing real git commands or cycle logic.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Hoisted state shared between the vi.mock factory and test bodies.
// vi.mock factories are hoisted before variable declarations — vi.hoisted()
// lets us declare state that is visible to both the factory and the tests.
// ---------------------------------------------------------------------------
const {
  worktreePoolCalls,
  cycleRunnerCalls,
  poolConfig,
} = vi.hoisted(() => {
  const worktreePoolCalls: Array<{
    projectRoot: string;
    baseBranch?: string;
    branchPrefix?: string;
    rootDir?: string;
  }> = [];
  const cycleRunnerCalls: Array<{
    worktreePool: unknown;
    disableWorktrees: unknown;
  }> = [];
  const poolConfig = {
    shouldThrow: false,
    throwMsg: 'not a git repository',
    prMode: 'multi' as 'single' | 'multi' | undefined,
  };
  return { worktreePoolCalls, cycleRunnerCalls, poolConfig };
});

// ---------------------------------------------------------------------------
// Mock @agentforge/core before the module-under-test is imported.
// ---------------------------------------------------------------------------
vi.mock('@agentforge/core', () => {
  function WorktreePoolMock(
    this: object,
    opts: { projectRoot: string; baseBranch?: string; branchPrefix?: string; rootDir?: string },
  ) {
    const entry: {
      projectRoot: string;
      baseBranch?: string;
      branchPrefix?: string;
      rootDir?: string;
    } = { projectRoot: opts.projectRoot };
    if (opts.baseBranch !== undefined) {
      entry.baseBranch = opts.baseBranch;
    }
    if (opts.branchPrefix !== undefined) {
      entry.branchPrefix = opts.branchPrefix;
    }
    if (opts.rootDir !== undefined) {
      entry.rootDir = opts.rootDir;
    }
    worktreePoolCalls.push(entry);
    if (poolConfig.shouldThrow) {
      throw new Error(poolConfig.throwMsg);
    }
  }

  function CycleRunnerMock(this: object, opts: Record<string, unknown>) {
    cycleRunnerCalls.push({
      worktreePool: opts['worktreePool'],
      disableWorktrees: opts['disableWorktrees'],
    });
  }
  CycleRunnerMock.prototype.start = function () {
    return Promise.resolve({
      stage: 'completed',
      sprintVersion: '1',
      pr: { url: null },
      cost: { totalUsd: 0, budgetUsd: 30 },
      tests: { passed: 0, total: 0, passRate: 1 },
    });
  };

  function WorkspaceManagerMock(this: object) {}
  WorkspaceManagerMock.prototype.getOrCreateDefaultWorkspace = function () {
    return Promise.resolve({ adapter: {} });
  };
  WorkspaceManagerMock.prototype.close = function () {};

  function RuntimeJobSupervisorMock(this: object) {}
  function RuntimeAdapterMock(this: object) {}
  function RealTestRunnerMock(this: object) {}
  function GitOpsMock(this: object) {}
  function PROpenerMock(this: object) {}
  function CycleLoggerMock(this: object) {}
  function MessageBusV2Mock(this: object) {}
  MessageBusV2Mock.prototype.publish = function () {};
  MessageBusV2Mock.prototype.subscribe = function () { return () => undefined; };

  return {
    WorktreePool: WorktreePoolMock,
    CycleRunner: CycleRunnerMock,
    CycleStage: { COMPLETED: 'completed', KILLED: 'killed' },
    loadCycleConfig: vi.fn().mockImplementation(() => ({
      budget: { perCycleUsd: 30, allowOverageApproval: false },
      limits: { maxItemsPerSprint: 5, maxExecutePhaseParallelism: 4 },
      quality: { testPassRateFloor: 0.95, requireBuildSuccess: false, requireTypeCheckSuccess: false },
      git: { branchPrefix: 'autonomous/', baseBranch: 'main' },
      pr: { draft: false },
      testing: {},
      fallbackEnabled: true,
      ...(poolConfig.prMode ? { prMode: poolConfig.prMode } : {}),
    })),
    createAutonomousTelemetryAdapters: vi.fn().mockReturnValue({
      proposalAdapter: {},
      scoringAdapter: {},
      close: vi.fn(),
    }),
    RealTestRunner: RealTestRunnerMock,
    GitOps: GitOpsMock,
    PROpener: PROpenerMock,
    RuntimeAdapter: RuntimeAdapterMock,
    RuntimeJobSupervisor: RuntimeJobSupervisorMock,
    WorkspaceManager: WorkspaceManagerMock,
    CycleLogger: CycleLoggerMock,
    MessageBusV2: MessageBusV2Mock,
    runExecutePhase: vi.fn().mockResolvedValue(undefined),
    runAuditPhase: vi.fn().mockResolvedValue(undefined),
    runPlanPhase: vi.fn().mockResolvedValue(undefined),
    runAssignPhase: vi.fn().mockResolvedValue(undefined),
    runGatePhase: vi.fn().mockResolvedValue(undefined),
    runLearnPhase: vi.fn().mockResolvedValue(undefined),
    runTestPhase: vi.fn().mockResolvedValue(undefined),
    runReviewPhase: vi.fn().mockResolvedValue(undefined),
    runReleasePhase: vi.fn().mockResolvedValue(undefined),
    previewCycle: vi.fn().mockResolvedValue({}),
    getWorkspace: vi.fn().mockReturnValue(null),
    getDefaultWorkspace: vi.fn().mockReturnValue(null),
  };
});

// Import after mock registration so the mock is in place.
import { createCliProgram } from '../bin.js';

const CYCLE_ENV_KEYS = [
  'AUTONOMOUS_BASE_BRANCH',
  'AUTONOMOUS_BRANCH_PREFIX',
  'AUTONOMOUS_BUDGET_USD',
  'AUTONOMOUS_DISABLE_WORKTREES',
  'AUTONOMOUS_DRY_RUN',
  'AUTONOMOUS_EFFORT_CAP',
  'AUTONOMOUS_FALLBACK_ENABLED',
  'AUTONOMOUS_MAX_AGENTS',
  'AUTONOMOUS_MAX_ITEMS',
  'AUTONOMOUS_MODEL_CAP',
] as const;

// ---------------------------------------------------------------------------
// Helper: run `cycle run` with given args against a tmpdir
// ---------------------------------------------------------------------------
async function runCycleRun(
  projectRoot: string,
  extraArgs: string[] = [],
  envOverrides: Record<string, string | undefined> = {},
): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  const keys = new Set<string>([...CYCLE_ENV_KEYS, ...Object.keys(envOverrides)]);
  for (const k of keys) {
    const v = Object.prototype.hasOwnProperty.call(envOverrides, k)
      ? envOverrides[k]
      : undefined;
    prev[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    const program = createCliProgram();
    program.exitOverride();
    await program.parseAsync(
      ['node', 'agentforge', 'cycle', 'run', '--project-root', projectRoot, ...extraArgs],
    );
  } catch {
    // exitOverride throws a CommanderError on --help/version, and runCycleAction
    // may set exitCode rather than throwing — either way just let the test assert.
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('autonomous-worktree: WorktreePool wiring at CLI launch', () => {
  let projectRoot: string;
  let stderrWrite: ReturnType<typeof vi.spyOn>;
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-worktree-cli-'));
    // Reset capture arrays.
    worktreePoolCalls.length = 0;
    cycleRunnerCalls.length = 0;
    poolConfig.shouldThrow = false;
    poolConfig.throwMsg = 'not a git repository';
    poolConfig.prMode = 'multi';
    // Silence output.
    stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;
  });

  afterEach(() => {
    stderrWrite.mockRestore();
    consoleLog.mockRestore();
    consoleError.mockRestore();
    rmSync(projectRoot, { recursive: true, force: true });
    process.exitCode = undefined;
    delete process.env['AUTONOMOUS_DISABLE_WORKTREES'];
  });

  it('constructs WorktreePool with correct options when worktrees are enabled', async () => {
    await runCycleRun(projectRoot);

    expect(worktreePoolCalls).toHaveLength(1);
    expect(worktreePoolCalls[0]?.projectRoot).toBe(projectRoot);
    // baseBranch comes from the mocked loadCycleConfig: 'main'
    expect(worktreePoolCalls[0]?.baseBranch).toBe('main');
    expect(worktreePoolCalls[0]?.branchPrefix).toBe('autonomous/');
    expect(worktreePoolCalls[0]?.rootDir).toContain(join('..', '.agentforge-worktrees'));
    const resolvedWorktreeRoot = resolve(projectRoot, worktreePoolCalls[0]!.rootDir!);
    expect(relative(projectRoot, resolvedWorktreeRoot).startsWith('..')).toBe(true);
  });

  it('normalizes relative project roots before constructing WorktreePool', async () => {
    const previousCwd = process.cwd();
    try {
      process.chdir(dirname(projectRoot));
      await runCycleRun(basename(projectRoot));
    } finally {
      process.chdir(previousCwd);
    }

    expect(worktreePoolCalls).toHaveLength(1);
    expect(worktreePoolCalls[0]?.projectRoot).toBe(projectRoot);
  });

  it('passes worktreePool to CycleRunner when pool construction succeeds', async () => {
    await runCycleRun(projectRoot);

    expect(cycleRunnerCalls).toHaveLength(1);
    // worktreePool should be truthy (the mock pool instance).
    expect(cycleRunnerCalls[0]?.worktreePool).toBeDefined();
    // disableWorktrees should not be set to true.
    expect(cycleRunnerCalls[0]?.disableWorktrees).toBeFalsy();
  });

  it('disables worktrees when --no-worktrees flag is passed', async () => {
    poolConfig.prMode = undefined;

    await runCycleRun(projectRoot, ['--no-worktrees']);

    // Pool should never have been constructed.
    expect(worktreePoolCalls).toHaveLength(0);
    expect(cycleRunnerCalls).toHaveLength(1);
    expect(cycleRunnerCalls[0]?.worktreePool).toBeUndefined();
    expect(cycleRunnerCalls[0]?.disableWorktrees).toBe(true);
  });

  it('disables worktrees when AUTONOMOUS_DISABLE_WORKTREES=1 env is set', async () => {
    poolConfig.prMode = undefined;

    await runCycleRun(projectRoot, [], { AUTONOMOUS_DISABLE_WORKTREES: '1' });

    expect(worktreePoolCalls).toHaveLength(0);
    expect(cycleRunnerCalls).toHaveLength(1);
    expect(cycleRunnerCalls[0]?.worktreePool).toBeUndefined();
    expect(cycleRunnerCalls[0]?.disableWorktrees).toBe(true);
  });

  it('does not construct WorktreePool for default single-PR mode', async () => {
    poolConfig.prMode = undefined;

    await runCycleRun(projectRoot);

    expect(worktreePoolCalls).toHaveLength(0);
    expect(cycleRunnerCalls).toHaveLength(1);
    expect(cycleRunnerCalls[0]?.worktreePool).toBeUndefined();
    expect(cycleRunnerCalls[0]?.disableWorktrees).toBe(true);
  });

  it('fails multi-PR mode when --no-worktrees is passed', async () => {
    await runCycleRun(projectRoot, ['--no-worktrees']);

    expect(worktreePoolCalls).toHaveLength(0);
    expect(cycleRunnerCalls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    const errorCalls = consoleError.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(errorCalls.some((s: string) => s.includes('prMode=multi requires isolated worktrees'))).toBe(true);
  });

  it('fails multi-PR mode when AUTONOMOUS_DISABLE_WORKTREES=1 is set', async () => {
    await runCycleRun(projectRoot, [], { AUTONOMOUS_DISABLE_WORKTREES: '1' });

    expect(worktreePoolCalls).toHaveLength(0);
    expect(cycleRunnerCalls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    const errorCalls = consoleError.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(errorCalls.some((s: string) => s.includes('prMode=multi requires isolated worktrees'))).toBe(true);
  });

  it('fails multi-PR mode when pool construction throws, emits warning to stderr', async () => {
    poolConfig.shouldThrow = true;
    poolConfig.throwMsg = 'fatal: not a git repository';

    await runCycleRun(projectRoot);

    // Pool construction was attempted.
    expect(worktreePoolCalls).toHaveLength(1);
    // Multi-PR mode must not silently fall back to single-tree execution.
    expect(cycleRunnerCalls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    // Warning was written to stderr with the required prefix.
    const stderrCalls = stderrWrite.mock.calls.map((c: unknown[]) => String(c[0]));
    const warning = stderrCalls.find((s: string) => s.includes('[autonomous:cycle] worktree-pool unavailable:'));
    expect(warning).toBeDefined();
    expect(warning).toContain('fatal: not a git repository');
    expect(warning).toContain('multi-PR mode requires isolated worktrees');
    expect(warning).not.toContain('falling back to single-tree execution');
    const errorCalls = consoleError.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(errorCalls.some((s: string) => s.includes('prMode=multi requires isolated worktrees'))).toBe(true);
  });

  it('does not disable worktrees when AUTONOMOUS_DISABLE_WORKTREES is not 1', async () => {
    await runCycleRun(projectRoot, [], { AUTONOMOUS_DISABLE_WORKTREES: '0' });

    // Pool should have been constructed normally.
    expect(worktreePoolCalls).toHaveLength(1);
    expect(cycleRunnerCalls[0]?.disableWorktrees).toBeFalsy();
  });

  it('does not construct WorktreePool for single-PR mode', async () => {
    poolConfig.prMode = 'single';

    await runCycleRun(projectRoot);

    expect(worktreePoolCalls).toHaveLength(0);
    expect(cycleRunnerCalls).toHaveLength(1);
    expect(cycleRunnerCalls[0]?.worktreePool).toBeUndefined();
    expect(cycleRunnerCalls[0]?.disableWorktrees).toBe(true);
  });

  it('uses AUTONOMOUS_BASE_BRANCH when constructing WorktreePool', async () => {
    await runCycleRun(projectRoot, [], { AUTONOMOUS_BASE_BRANCH: 'codex/codex-version' });

    expect(worktreePoolCalls).toHaveLength(1);
    expect(worktreePoolCalls[0]?.baseBranch).toBe('codex/codex-version');
  });

  it('uses AUTONOMOUS_BRANCH_PREFIX when constructing WorktreePool', async () => {
    await runCycleRun(projectRoot, [], { AUTONOMOUS_BRANCH_PREFIX: 'codex/' });

    expect(worktreePoolCalls).toHaveLength(1);
    expect(worktreePoolCalls[0]?.branchPrefix).toBe('codex/');
  });
});
