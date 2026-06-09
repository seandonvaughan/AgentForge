// packages/cli/src/__tests__/cycle-preview-objective.test.ts
//
// CLI wiring tests for `agentforge cycle preview --objective` (spec 2026-05-30
// §13 m3). Mirrors the vi.mock('@agentforge/core') factory pattern of
// autonomous-launch-options.test.ts: the core previewObjective is mocked, so
// no LLM and no decompose pipeline runs — these tests assert flag threading,
// budget defaulting, render output, exit codes, and the regression guard that
// plain `cycle preview` still runs the signal-backlog path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const captures = vi.hoisted(() => ({
  runtimeAdapterOptions: [] as Array<Record<string, unknown>>,
  previewObjectiveCalls: [] as Array<{ options: Record<string, unknown>; runtime: unknown }>,
  previewObjectiveResult: {} as Record<string, unknown>,
  backlogBuildCalls: 0,
}));

function okPreviewResult(): Record<string, unknown> {
  return {
    status: 'ok',
    objective: { id: 'epic-preview-x', title: 'Build the thing', description: 'Build the thing', createdAt: 'now' },
    plan: {
      epicId: 'epic-preview-x',
      rationale: 'r',
      children: [
        { id: 'c1', title: 'types', description: 'd', files: ['shared.ts'], capabilityTags: [],
          suggestedAssignee: 'eng', estimatedCostUsd: 2, estimatedComplexity: 'low', predecessors: [], wave: 0 },
        { id: 'c2', title: 'api', description: 'd', files: ['api.ts'], capabilityTags: [],
          suggestedAssignee: 'eng', estimatedCostUsd: 3, estimatedComplexity: 'medium', predecessors: ['c1'], wave: 1 },
      ],
    },
    report: {
      acyclic: true,
      missingPredecessors: [],
      syntheticFileEdges: [{ from: 'c1', to: 'c2', sharedFiles: ['shared.ts'] }],
      waveCount: 2,
      budget: { budgetUsd: 12, spendableUsd: 5, sumUsd: 5, lowerUsd: 3.5, upperUsd: 5, withinBand: true },
    },
    waves: [
      { wave: 0, childIds: ['c1'], estCostUsd: 2 },
      { wave: 1, childIds: ['c2'], estCostUsd: 3 },
    ],
    summary: { totalItems: 2, waveCount: 2, itemsPerWave: [1, 1], maxWaveWidth: 1 },
    criticalPathLength: 2,
    fileOverlaps: [{ from: 'c1', to: 'c2', sharedFiles: ['shared.ts'] }],
    warnings: ['file overlap: c2 forced after c1 (shared: shared.ts)'],
    plannerCostUsd: 0.5,
    repaired: false,
    durationMs: 10,
    artifactDir: '/tmp/previews/objective-x',
  };
}

vi.mock('@agentforge/core', () => {
  function RuntimeAdapterMock(this: object, opts: Record<string, unknown>) {
    captures.runtimeAdapterOptions.push(opts);
  }

  function ProposalToBacklogMock() {}
  ProposalToBacklogMock.prototype.build = function () {
    captures.backlogBuildCalls += 1;
    return Promise.resolve([]);
  };

  function ScoringPipelineMock(this: object) {}
  ScoringPipelineMock.prototype.scoreWithFallback = function () {
    return Promise.resolve({
      withinBudget: [], requiresApproval: [], totalEstimatedCostUsd: 0,
      budgetOverflowUsd: 0, summary: 'ok', warnings: [], fallback: null,
    });
  };

  function WorkspaceManagerMock(this: object) {}
  WorkspaceManagerMock.prototype.getOrCreateDefaultWorkspace = function () {
    return Promise.resolve({ adapter: {} });
  };
  WorkspaceManagerMock.prototype.close = function () {};

  function NoopCtor(this: object) {}
  function MessageBusV2Mock(this: object) {}
  MessageBusV2Mock.prototype.publish = function () {};
  MessageBusV2Mock.prototype.subscribe = function () { return () => undefined; };

  return {
    loadCycleConfig: vi.fn().mockImplementation(() => ({
      budget: { perCycleUsd: 30, allowOverageApproval: false },
      limits: { maxItemsPerSprint: 5, maxExecutePhaseParallelism: 4 },
      quality: { testPassRateFloor: 0.95, requireBuildSuccess: false, requireTypeCheckSuccess: false },
      git: { branchPrefix: 'autonomous/', baseBranch: 'main' },
      pr: { draft: false },
      testing: {},
      prMode: 'single',
      modelCap: 'fable',
      effortCap: 'xhigh',
    })),
    previewObjective: vi.fn().mockImplementation(
      (options: Record<string, unknown>, runtime: unknown) => {
        captures.previewObjectiveCalls.push({ options, runtime });
        return Promise.resolve(captures.previewObjectiveResult);
      },
    ),
    RuntimeAdapter: RuntimeAdapterMock,
    CycleRunner: NoopCtor,
    CycleStage: { COMPLETED: 'completed', KILLED: 'killed' },
    WorktreePool: NoopCtor,
    RuntimeJobSupervisor: NoopCtor,
    WorkspaceManager: WorkspaceManagerMock,
    RealTestRunner: NoopCtor,
    GitOps: NoopCtor,
    PROpener: NoopCtor,
    CycleLogger: NoopCtor,
    MessageBusV2: MessageBusV2Mock,
    ProposalToBacklog: ProposalToBacklogMock,
    ScoringPipeline: ScoringPipelineMock,
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

import { createCliProgram } from '../bin.js';

function collectConsoleOutput(calls: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return calls.map((call) => call.join(' ')).join('\n');
}

async function runCli(args: string[]): Promise<void> {
  const program = createCliProgram();
  program.exitOverride();
  try {
    await program.parseAsync(['node', 'agentforge', ...args]);
  } catch {
    // Tests assert on captured state and process.exitCode.
  }
}

describe('cycle preview --objective', () => {
  let projectRoot: string;
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-preview-objective-'));
    captures.runtimeAdapterOptions.length = 0;
    captures.previewObjectiveCalls.length = 0;
    captures.previewObjectiveResult = okPreviewResult();
    captures.backlogBuildCalls = 0;
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = savedExitCode;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('threads the objective, explicit budget, and config caps into the preview', async () => {
    await runCli([
      'cycle', 'preview',
      '--project-root', projectRoot,
      '--objective', '  Build the thing  ',
      '--budget-usd', '50',
    ]);

    expect(captures.previewObjectiveCalls).toHaveLength(1);
    const call = captures.previewObjectiveCalls[0]!;
    expect(call.options['objective']).toBe('Build the thing');
    expect(call.options['budgetUsd']).toBe(50);
    expect(call.options['projectRoot']).toBe(projectRoot);

    // The same RuntimeAdapter shape the run path uses, with config caps.
    expect(captures.runtimeAdapterOptions).toHaveLength(1);
    expect(captures.runtimeAdapterOptions[0]).toMatchObject({
      cwd: projectRoot,
      modelCap: 'fable',
      effortCap: 'xhigh',
      enableFallback: true,
    });
    expect(call.runtime).toBeInstanceOf(Object);
    expect(process.exitCode).toBeUndefined();
  });

  it('defaults the budget to config.budget.perCycleUsd when --budget-usd is absent', async () => {
    await runCli(['cycle', 'preview', '--project-root', projectRoot, '--objective', 'obj']);
    expect(captures.previewObjectiveCalls[0]!.options['budgetUsd']).toBe(30);
  });

  it('renders children, waves, overlaps, and planner cost in human output', async () => {
    await runCli(['cycle', 'preview', '--project-root', projectRoot, '--objective', 'obj']);
    const output = collectConsoleOutput(consoleLog.mock.calls);
    expect(output).toContain('Children:     2');
    expect(output).toContain('[w0] c1');
    expect(output).toContain('Wave 1 (1 items, $3.00): c2');
    expect(output).toContain('c1 -> c2');
    expect(output).toContain('Planner cost: $0.50');
    expect(output).toContain('band [$3.50, $5.00] OK');
  });

  it('emits round-trippable JSON with --json', async () => {
    await runCli(['cycle', 'preview', '--project-root', projectRoot, '--objective', 'obj', '--json']);
    const output = collectConsoleOutput(consoleLog.mock.calls);
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('ok');
    expect(parsed.waves).toHaveLength(2);
  });

  it('sets exit code 1 and prints the failure detail on an invalid decomposition', async () => {
    captures.previewObjectiveResult = {
      ...okPreviewResult(),
      status: 'invalid',
      plan: undefined,
      waves: [],
      error: { reason: 'budget', message: 'sum out of band' },
      report: {
        acyclic: true,
        missingPredecessors: [],
        syntheticFileEdges: [],
        waveCount: 0,
        budget: { budgetUsd: 50, spendableUsd: 36.67, sumUsd: 5, lowerUsd: 25.67, upperUsd: 36.67, withinBand: false },
      },
      plannerCostUsd: 1,
    };
    await runCli(['cycle', 'preview', '--project-root', projectRoot, '--objective', 'obj']);
    const output = collectConsoleOutput(consoleLog.mock.calls);
    expect(output).toContain('INVALID (budget): sum out of band');
    expect(process.exitCode).toBe(1);
  });

  it('without --objective the signal-backlog preview path still runs (regression guard)', async () => {
    await runCli(['cycle', 'preview', '--project-root', projectRoot]);
    expect(captures.previewObjectiveCalls).toHaveLength(0);
    expect(captures.backlogBuildCalls).toBe(1);
  });

  it('rejects an invalid --budget-usd before any planner spend', async () => {
    await runCli([
      'cycle', 'preview', '--project-root', projectRoot,
      '--objective', 'obj', '--budget-usd', 'not-a-number',
    ]);
    expect(captures.previewObjectiveCalls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    expect(collectConsoleOutput(consoleError.mock.calls)).toContain('--budget-usd');
  });
});
