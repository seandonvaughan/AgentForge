import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProposalToBacklog, type BacklogItem, type ProposalAdapter } from '../proposal-to-backlog.js';
import { ScoringPipeline, type AdapterForScoring, type RuntimeForScoring, type ScoringPipelineResult } from '../scoring-pipeline.js';
import { SprintGenerator } from '../sprint-generator.js';
import type { CycleConfig, RankedItem } from '../types.js';
import type { CycleLogger } from '../cycle-logger.js';

const CYCLE_ID = 'sourcing-stability-cycle';

type PipelineWithPrivates = {
  staticFallback(backlog: BacklogItem[]): Promise<ScoringPipelineResult>;
};

function makeConfig(overrides: { perCycleUsd?: number; maxItems?: number } = {}): CycleConfig {
  return {
    budget: {
      perCycleUsd: overrides.perCycleUsd ?? 50,
      perItemUsd: 1.5,
      perAgentUsd: 10,
      allowOverageApproval: false,
    },
    limits: {
      maxItemsPerSprint: overrides.maxItems ?? 10,
      maxDurationMinutes: 60,
      maxConsecutiveFailures: 3,
      maxExecutePhaseFailureRate: 0.5,
      maxExecutePhaseParallelism: 3,
      maxItemRetries: 2,
    },
    quality: {
      testPassRateFloor: 0.9,
      allowRegression: false,
      requireBuildSuccess: true,
      requireTypeCheckSuccess: true,
    },
    git: {
      branchPrefix: 'auto',
      baseBranch: 'main',
      refuseCommitToBaseBranch: true,
      includeDiagnosticBranchOnFailure: false,
      maxFilesPerCommit: 50,
    },
    pr: {
      draft: true,
      assignReviewer: null,
      labelPrefix: 'auto',
      labels: [],
      titleTemplate: 'Auto Sprint',
    },
    sourcing: {
      lookbackDays: 7,
      minProposalConfidence: 0.6,
      includeTodoMarkers: false,
      todoMarkerPattern: 'TODO\\(autonomous\\)',
    },
    testing: {
      command: 'pnpm test',
      timeoutMinutes: 10,
      reporter: 'json',
      saveRawLog: false,
      buildCommand: 'pnpm build',
      typeCheckCommand: 'pnpm typecheck',
    },
    scoring: {
      agentId: 'backlog-scorer',
      maxRetries: 1,
      fallbackToStatic: true,
    },
    logging: { logDir: '/tmp/agentforge-test', retainCycles: 5 },
    safety: {
      stopFilePath: '/tmp/.stop',
      secretScanEnabled: false,
      verifyCleanWorkingTreeBeforeStart: false,
      workingTreeWhitelist: [],
    },
    retry: { maxAutoRetries: 2, requireApprovalAfter: 1, reExecuteOnRetry: false },
  } as unknown as CycleConfig;
}

function makeAdapter(): AdapterForScoring {
  return {
    getSprintHistory: vi.fn().mockResolvedValue([]),
    getCostMedians: vi.fn().mockResolvedValue({}),
    getP50CostByTag: vi.fn().mockResolvedValue({ fix: 1.1 }),
    getTeamState: vi.fn().mockResolvedValue({ utilization: {} }),
  };
}

function makeLogger(): CycleLogger {
  return {
    logScoring: vi.fn(),
    logScoringFallback: vi.fn(),
    logKillSwitch: vi.fn(),
    logCycleResult: vi.fn(),
    logGitEvent: vi.fn(),
    logTestRun: vi.fn(),
    logPREvent: vi.fn(),
  } as unknown as CycleLogger;
}

function makeBacklogItem(overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id: 'backlog-scoped-fix',
    title: 'Fix scoped ranking source',
    description: 'Keep declared file scope through ranking and sprint planning.',
    priority: 'P1',
    tags: ['fix'],
    source: 'backlog-file',
    confidence: 0.9,
    estimatedComplexity: 'low',
    files: ['packages/core/src/autonomous/scoring-pipeline.ts'],
    runtimeMode: 'codex-cli',
    preferredProvider: 'codex-cli',
    ...overrides,
  };
}

function makeScoringRuntime(): RuntimeForScoring {
  return {
    run: vi.fn().mockResolvedValue({
      output: JSON.stringify({
        rankings: [
          {
            itemId: 'backlog-scoped-fix',
            title: 'Fix scoped ranking source',
            rank: 1,
            score: 0.95,
            confidence: 0.9,
            estimatedCostUsd: 1.1,
            estimatedDurationMinutes: 20,
            rationale: 'Scored by test runtime',
            dependencies: [],
            suggestedAssignee: 'coder',
            suggestedTags: ['fix'],
            withinBudget: true,
          },
        ],
        totalEstimatedCostUsd: 1.1,
        budgetOverflowUsd: 0,
        summary: 'ok',
        warnings: [],
      }),
      usage: { input_tokens: 1, output_tokens: 1 },
      costUsd: 0.01,
      durationMs: 1,
      model: 'test',
    }),
  };
}

function makeFailingRuntime(): RuntimeForScoring {
  return {
    run: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
  };
}

describe('sourcing stability', () => {
  let tmpDir: string;
  let prevUnattended: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-sourcing-stability-'));
    mkdirSync(join(tmpDir, '.agentforge', 'backlog'), { recursive: true });
    mkdirSync(join(tmpDir, '.agentforge', 'cycles', CYCLE_ID), { recursive: true });
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ version: '10.5.1' }));
    prevUnattended = process.env['AGENTFORGE_UNATTENDED'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (prevUnattended === undefined) delete process.env['AGENTFORGE_UNATTENDED'];
    else process.env['AGENTFORGE_UNATTENDED'] = prevUnattended;
  });

  it('keeps unattended exclusions while preserving scoped backlog files', async () => {
    process.env['AGENTFORGE_UNATTENDED'] = '1';
    writeFileSync(
      join(tmpDir, '.agentforge', 'backlog', 'items.json'),
      JSON.stringify({
        items: [
          { id: 'big', title: 'Big unscoped feature', priority: 'P0', estimatedComplexity: 'high' },
          { id: 'vague', title: 'Vague low item', priority: 'P1', estimatedComplexity: 'low' },
          {
            id: 'scoped',
            title: 'Scoped low item',
            priority: 'P1',
            estimatedComplexity: 'low',
            files: ['packages/core/src/autonomous/types.ts'],
          },
        ],
      }),
    );
    const adapter: ProposalAdapter = {
      getRecentFailedSessions: async () => [],
      getCostAnomalies: async () => [
        { agent: 'backlog-scorer', anomaly: '3x median cost', confidence: 0.95 },
      ],
      getFailedTaskOutcomes: async () => [],
      getFlakingTests: async () => [],
    };

    const items = await new ProposalToBacklog(adapter, tmpDir, makeConfig()).build();

    expect(items.map((item) => item.title)).toEqual(['Scoped low item']);
    expect(items[0]?.files).toEqual(['packages/core/src/autonomous/types.ts']);
  });

  it('copies BacklogItem.files onto scorer-produced RankedItems', async () => {
    const pipeline = new ScoringPipeline(
      makeScoringRuntime(),
      makeAdapter(),
      makeConfig(),
      makeLogger(),
    );

    const result = await pipeline.score([makeBacklogItem()]);

    expect(result.withinBudget[0]?.files).toEqual([
      'packages/core/src/autonomous/scoring-pipeline.ts',
    ]);
    expect(result.withinBudget[0]?.description).toBe(
      'Keep declared file scope through ranking and sprint planning.',
    );
    expect(result.withinBudget[0]?.runtimeMode).toBe('codex-cli');
    expect(result.withinBudget[0]?.preferredProvider).toBe('codex-cli');
  });

  it('copies BacklogItem.files onto fallback RankedItems', async () => {
    const backlog = [makeBacklogItem()];
    const pipeline = new ScoringPipeline(
      makeFailingRuntime(),
      makeAdapter(),
      makeConfig(),
      makeLogger(),
    );

    const effortResult = await pipeline.scoreWithFallback(backlog);
    const staticResult = await (pipeline as unknown as PipelineWithPrivates).staticFallback(backlog);

    expect(effortResult.withinBudget[0]?.files).toEqual([
      'packages/core/src/autonomous/scoring-pipeline.ts',
    ]);
    expect(effortResult.withinBudget[0]?.description).toBe(
      'Keep declared file scope through ranking and sprint planning.',
    );
    expect(effortResult.withinBudget[0]?.runtimeMode).toBe('codex-cli');
    expect(effortResult.withinBudget[0]?.preferredProvider).toBe('codex-cli');
    expect(staticResult.withinBudget[0]?.files).toEqual([
      'packages/core/src/autonomous/scoring-pipeline.ts',
    ]);
    expect(staticResult.withinBudget[0]?.description).toBe(
      'Keep declared file scope through ranking and sprint planning.',
    );
    expect(staticResult.withinBudget[0]?.runtimeMode).toBe('codex-cli');
    expect(staticResult.withinBudget[0]?.preferredProvider).toBe('codex-cli');
  });

  it('writes RankedItem.files into sprint plan items', async () => {
    const rankedItem: RankedItem = {
      itemId: 'backlog-scoped-fix',
      title: 'Fix scoped ranking source',
      description: 'Original backlog acceptance: preserve text and JSON outputs.',
      rank: 1,
      score: 0.95,
      confidence: 0.9,
      estimatedCostUsd: 1.1,
      estimatedDurationMinutes: 20,
      rationale: 'Scored by test runtime',
      dependencies: [],
      suggestedAssignee: 'coder',
      suggestedTags: ['fix'],
      withinBudget: true,
      files: ['packages/core/src/autonomous/sprint-generator.ts'],
      runtimeMode: 'codex-cli',
      preferredProvider: 'codex-cli',
    };

    const plan = await new SprintGenerator(tmpDir, makeConfig()).generate([rankedItem], CYCLE_ID);
    const onDisk = JSON.parse(
      readFileSync(join(tmpDir, '.agentforge', 'cycles', CYCLE_ID, 'plan.json'), 'utf8'),
    );

    expect(plan.items[0]?.files).toEqual(['packages/core/src/autonomous/sprint-generator.ts']);
    expect(plan.items[0]?.description).toBe('Original backlog acceptance: preserve text and JSON outputs.');
    expect(plan.items[0]?.rationale).toBe('Scored by test runtime');
    expect(onDisk.items[0].files).toEqual(['packages/core/src/autonomous/sprint-generator.ts']);
    expect(onDisk.items[0].description).toBe('Original backlog acceptance: preserve text and JSON outputs.');
    expect(onDisk.items[0].rationale).toBe('Scored by test runtime');
    expect(plan.items[0]?.runtimeMode).toBe('codex-cli');
    expect(plan.items[0]?.preferredProvider).toBe('codex-cli');
    expect(onDisk.items[0].runtimeMode).toBe('codex-cli');
    expect(onDisk.items[0].preferredProvider).toBe('codex-cli');
  });

  it('reads runtime/provider hints from backlog files', async () => {
    writeFileSync(
      join(tmpDir, '.agentforge', 'backlog', 'items.json'),
      JSON.stringify({
        items: [
          {
            id: 'routed',
            title: 'Route item',
            priority: 'P1',
            estimatedComplexity: 'low',
            files: ['packages/core/src/runtime/provider-resolver.ts'],
            runtimeMode: 'codex-cli',
            preferredProvider: 'codex-cli',
          },
        ],
      }),
    );
    const adapter: ProposalAdapter = {
      getRecentFailedSessions: async () => [],
      getCostAnomalies: async () => [],
      getFailedTaskOutcomes: async () => [],
      getFlakingTests: async () => [],
    };

    const items = await new ProposalToBacklog(adapter, tmpDir, makeConfig()).build();
    expect(items[0]?.runtimeMode).toBe('codex-cli');
    expect(items[0]?.preferredProvider).toBe('codex-cli');
  });
});
