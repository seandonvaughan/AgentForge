import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CYCLE_LAUNCH_ENV_KEYS = [
  'AUTONOMOUS_MAX_ITEMS',
  'AUTONOMOUS_EFFORT_CAP',
  'AUTONOMOUS_FALLBACK_ENABLED',
  'AUTONOMOUS_MAX_AGENTS',
  'AUTONOMOUS_MODEL_CAP',
] as const;

const captures = vi.hoisted(() => ({
  runtimeAdapterOptions: [] as Array<Record<string, unknown>>,
  cycleRunnerOptions: [] as Array<Record<string, unknown>>,
  scoringPipelineOptions: [] as Array<Record<string, unknown>>,
  auditPhaseCallOptions: [] as Array<unknown>,
  configMaxItemsPerSprint: 5,
}));

vi.mock('@agentforge/core', () => {
  function RuntimeAdapterMock(this: object, opts: Record<string, unknown>) {
    captures.runtimeAdapterOptions.push(opts);
  }

  function CycleRunnerMock(this: object, opts: Record<string, unknown>) {
    captures.cycleRunnerOptions.push(opts);
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

  function ProposalToBacklogMock() {}
  ProposalToBacklogMock.prototype.build = function () {
    return Promise.resolve([
      {
        itemId: 'item-1',
        title: 'Previewable item',
        rank: 1,
        score: 1,
        confidence: 1,
        estimatedCostUsd: 1,
        estimatedDurationMinutes: 1,
        rationale: 'test',
        dependencies: [],
        suggestedAssignee: 'coder',
        suggestedTags: [],
        withinBudget: true,
      },
    ]);
  };

  function ScoringPipelineMock(
    this: object,
    runtime: unknown,
    scoringAdapter: unknown,
    config: Record<string, unknown>,
  ) {
    captures.scoringPipelineOptions.push({ runtime, scoringAdapter, config });
  }
  ScoringPipelineMock.prototype.scoreWithFallback = function () {
    return Promise.resolve({
      withinBudget: [
        {
          itemId: 'item-1',
          title: 'Previewable item',
          rank: 1,
          score: 1,
          confidence: 1,
          estimatedCostUsd: 1,
          estimatedDurationMinutes: 1,
          rationale: 'test',
          dependencies: [],
          suggestedAssignee: 'coder',
          suggestedTags: [],
          withinBudget: true,
        },
      ],
      requiresApproval: [],
      totalEstimatedCostUsd: 1,
      budgetOverflowUsd: 0,
      summary: 'ok',
      warnings: [],
      fallback: null,
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
  MessageBusV2Mock.prototype.subscribe = function () { return () => undefined; };

  return {
    loadCycleConfig: vi.fn().mockImplementation(() => ({
      budget: { perCycleUsd: 30, allowOverageApproval: false },
      limits: { maxItemsPerSprint: captures.configMaxItemsPerSprint, maxExecutePhaseParallelism: 4 },
      quality: { testPassRateFloor: 0.95, requireBuildSuccess: false, requireTypeCheckSuccess: false },
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
    ProposalToBacklog: ProposalToBacklogMock,
    ScoringPipeline: ScoringPipelineMock,
    createAutonomousTelemetryAdapters: vi.fn().mockReturnValue({
      proposalAdapter: {},
      scoringAdapter: {},
      close: vi.fn(),
    }),
    runExecutePhase: vi.fn().mockResolvedValue(undefined),
    runAuditPhase: vi.fn().mockImplementation((_ctx: unknown, options?: unknown) => {
      captures.auditPhaseCallOptions.push(options);
      return Promise.resolve(undefined);
    }),
    runPlanPhase: vi.fn().mockResolvedValue(undefined),
    runAssignPhase: vi.fn().mockResolvedValue(undefined),
    runGatePhase: vi.fn().mockResolvedValue(undefined),
    runLearnPhase: vi.fn().mockResolvedValue(undefined),
    runTestPhase: vi.fn().mockResolvedValue(undefined),
    runReviewPhase: vi.fn().mockResolvedValue(undefined),
    runReleasePhase: vi.fn().mockResolvedValue(undefined),
    previewCycle: vi.fn(),
    getWorkspace: vi.fn().mockReturnValue(null),
    getDefaultWorkspace: vi.fn().mockReturnValue(null),
    readCheckpoint: vi.fn().mockReturnValue(null),
  };
});

import { createCliProgram } from '../bin.js';

async function runCli(args: string[]): Promise<void> {
  const program = createCliProgram();
  program.exitOverride();
  try {
    await program.parseAsync(['node', 'agentforge', ...args]);
  } catch {
    // Tests assert on captured construction state and process.exitCode.
  }
}

describe('cycle launch options', () => {
  let projectRoot: string;
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;
  let savedLaunchEnv: Record<string, string | undefined>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-cycle-launch-options-'));
    savedLaunchEnv = {};
    for (const key of CYCLE_LAUNCH_ENV_KEYS) {
      savedLaunchEnv[key] = process.env[key];
      delete process.env[key];
    }
    captures.runtimeAdapterOptions.length = 0;
    captures.cycleRunnerOptions.length = 0;
    captures.scoringPipelineOptions.length = 0;
    captures.auditPhaseCallOptions.length = 0;
    captures.configMaxItemsPerSprint = 5;
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;
  });

  afterEach(() => {
    consoleLog.mockRestore();
    consoleError.mockRestore();
    rmSync(projectRoot, { recursive: true, force: true });
    for (const key of CYCLE_LAUNCH_ENV_KEYS) {
      const value = savedLaunchEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    process.exitCode = undefined;
  });

  it('passes Codex launch knobs from cycle run flags', async () => {
    await runCli([
      'cycle',
      'run',
      '--project-root',
      projectRoot,
      '--fast-mode',
      '--model-cap',
      'sonnet',
      '--max-agents',
      '2',
      '--no-fallback',
    ]);

    expect(captures.runtimeAdapterOptions[0]).toMatchObject({
      cwd: projectRoot,
      modelCap: 'sonnet',
      effortCap: 'high',
      enableFallback: false,
    });
    expect(captures.cycleRunnerOptions[0]?.['config']).toMatchObject({
      limits: { maxExecutePhaseParallelism: 2 },
      modelCap: 'sonnet',
      effortCap: 'high',
      fallbackEnabled: false,
    });
  });

  it('uses a 5-minute audit timeout when effective maxItemsPerSprint is 1', async () => {
    process.env['AUTONOMOUS_MAX_ITEMS'] = '1';
    await runCli([
      'cycle',
      'run',
      '--project-root',
      projectRoot,
    ]);

    const phaseHandlers = captures.cycleRunnerOptions[0]?.['phaseHandlers'] as Record<string, (ctx: unknown) => Promise<unknown>> | undefined;
    const auditHandler = phaseHandlers?.['audit'];
    expect(auditHandler).toBeDefined();
    await auditHandler?.({});
    expect(captures.auditPhaseCallOptions[0]).toMatchObject({ timeoutMs: 300000 });
  });

  it('keeps default audit runtime options when maxItemsPerSprint is greater than 1', async () => {
    captures.configMaxItemsPerSprint = 5;
    await runCli([
      'cycle',
      'run',
      '--project-root',
      projectRoot,
    ]);

    const phaseHandlers = captures.cycleRunnerOptions[0]?.['phaseHandlers'] as Record<string, (ctx: unknown) => Promise<unknown>> | undefined;
    const auditHandler = phaseHandlers?.['audit'];
    expect(auditHandler).toBeDefined();
    await auditHandler?.({});
    expect(captures.auditPhaseCallOptions[0]).toBeUndefined();
  });

  it('lets an explicit run effort cap override fast mode', async () => {
    await runCli([
      'cycle',
      'run',
      '--project-root',
      projectRoot,
      '--fast-mode',
      '--effort-cap',
      'low',
    ]);

    expect(captures.runtimeAdapterOptions[0]).toMatchObject({
      effortCap: 'low',
    });
  });

  it('passes Codex launch knobs from cycle preview flags', async () => {
    await runCli([
      'cycle',
      'preview',
      '--project-root',
      projectRoot,
      '--fast-mode',
      '--model-cap',
      'haiku',
      '--max-agents',
      '3',
      '--no-fallback',
    ]);

    expect(captures.runtimeAdapterOptions[0]).toMatchObject({
      cwd: projectRoot,
      modelCap: 'haiku',
      effortCap: 'high',
      enableFallback: false,
    });
    expect(captures.scoringPipelineOptions[0]?.['config']).toMatchObject({
      limits: { maxExecutePhaseParallelism: 3 },
      modelCap: 'haiku',
      effortCap: 'high',
      fallbackEnabled: false,
    });
  });
});
