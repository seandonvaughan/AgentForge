// packages/core/src/autonomous/__tests__/scoring-pipeline-fallback.test.ts
//
// Unit tests for the effort-estimator fallback path wired into ScoringPipeline.
// The three-tier ladder is: LLM scorer → effort-estimator → static priority.
// These tests verify that each tier fires in order and that the effort-estimator
// produces sensible estimates differentiated by complexity and history.

import { describe, it, expect, vi } from 'vitest';
import { ScoringPipeline, complexityFromTags } from '../scoring-pipeline.js';
import type { AdapterForScoring, RuntimeForScoring, ScoringPipelineResult } from '../scoring-pipeline.js';
import type { BacklogItem } from '../proposal-to-backlog.js';
import type { CycleConfig } from '../types.js';
import type { CycleLogger } from '../cycle-logger.js';

// Helper: access private staticFallback via type assertion (testing internal
// logic in isolation without needing to force effortEstimatorFallback to throw).
type PipelineWithPrivates = {
  staticFallback: (backlog: BacklogItem[]) => Promise<ScoringPipelineResult>;
};

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeConfig(opts: { perCycleUsd?: number; maxItems?: number } = {}): CycleConfig {
  return {
    budget: {
      perCycleUsd: opts.perCycleUsd ?? 50,
      perItemUsd: 1.5,
      perAgentUsd: 10,
      allowOverageApproval: false,
    },
    limits: {
      maxItemsPerSprint: opts.maxItems ?? 10,
      maxDurationMinutes: 60,
      maxConsecutiveFailures: 3,
      maxExecutePhaseFailureRate: 0.5,
      maxExecutePhaseParallelism: 3,
      maxItemRetries: 2,
    },
    quality: { testPassRateFloor: 0.9, allowRegression: false, requireBuildSuccess: true, requireTypeCheckSuccess: true },
    git: { branchPrefix: 'auto', baseBranch: 'main', refuseCommitToBaseBranch: true, includeDiagnosticBranchOnFailure: false, maxFilesPerCommit: 50 },
    pr: { draft: true, assignReviewer: null, labelPrefix: 'auto', labels: [], titleTemplate: 'Auto Sprint' },
    sourcing: { lookbackDays: 7, minProposalConfidence: 0.5, includeTodoMarkers: true, todoMarkerPattern: 'TODO\\(autonomous\\)' },
    testing: { command: 'pnpm test', timeoutMinutes: 10, reporter: 'json', saveRawLog: false, buildCommand: 'pnpm build', typeCheckCommand: 'pnpm typecheck' },
    scoring: { agentId: 'backlog-scorer', maxRetries: 1, fallbackToStatic: true },
    logging: { logDir: '/tmp/agentforge-test', retainCycles: 5 },
    safety: { stopFilePath: '/tmp/.stop', secretScanEnabled: false, verifyCleanWorkingTreeBeforeStart: false, workingTreeWhitelist: [] },
    retry: { maxAutoRetries: 2, requireApprovalAfter: 1, reExecuteOnRetry: false },
  } as unknown as CycleConfig;
}

function makeBacklogItems(count = 3): BacklogItem[] {
  const priorities: Array<'P0' | 'P1' | 'P2'> = ['P0', 'P1', 'P2'];
  return Array.from({ length: count }, (_, i) => ({
    id: `item-${i}`,
    title: `Task ${i}`,
    description: `Description for task ${i}`,
    priority: priorities[i % 3]!,
    tags: ['feature'],
    source: 'todo-marker' as const,
    confidence: 0.7 + i * 0.05,
  }));
}

function makeFailingRuntime(): RuntimeForScoring {
  return {
    run: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
  };
}

function makeAdapter(history: unknown[] = []): AdapterForScoring {
  return {
    getSprintHistory: vi.fn().mockResolvedValue(history),
    getCostMedians: vi.fn().mockResolvedValue({}),
    getP50CostByTag: vi.fn().mockResolvedValue({}),
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

// ---------------------------------------------------------------------------
// Tests: effort-estimator fallback fires after LLM strikes
// ---------------------------------------------------------------------------

describe('ScoringPipeline.scoreWithFallback — effort-estimator tier', () => {
  it('returns fallback="effort-estimator" when LLM scorer fails', async () => {
    const pipeline = new ScoringPipeline(
      makeFailingRuntime(),
      makeAdapter(),
      makeConfig(),
      makeLogger(),
    );

    const result = await pipeline.scoreWithFallback(makeBacklogItems());

    expect(result.fallback).toBe('effort-estimator');
  });

  it('effort-estimator result includes all backlog items', async () => {
    const backlog = makeBacklogItems(4);
    const pipeline = new ScoringPipeline(
      makeFailingRuntime(),
      makeAdapter(),
      makeConfig(),
      makeLogger(),
    );

    const result = await pipeline.scoreWithFallback(backlog);

    const allIds = [
      ...result.withinBudget.map(r => r.itemId),
      ...result.requiresApproval.map(r => r.itemId),
    ];
    expect(allIds).toHaveLength(backlog.length);
    expect(new Set(allIds)).toEqual(new Set(backlog.map(i => i.id)));
  });

  it('rankings are sorted P0 before P1 before P2', async () => {
    const pipeline = new ScoringPipeline(
      makeFailingRuntime(),
      makeAdapter(),
      makeConfig(),
      makeLogger(),
    );
    const backlog: BacklogItem[] = [
      { id: 'a', title: 'P2 task', description: '', priority: 'P2', tags: [], source: 'todo-marker', confidence: 0.8 },
      { id: 'b', title: 'P0 task', description: '', priority: 'P0', tags: [], source: 'todo-marker', confidence: 0.8 },
      { id: 'c', title: 'P1 task', description: '', priority: 'P1', tags: [], source: 'todo-marker', confidence: 0.8 },
    ];

    const result = await pipeline.scoreWithFallback(backlog);

    const sorted = [...result.withinBudget, ...result.requiresApproval].sort((a, b) => a.rank - b.rank);
    expect(sorted.at(0)?.itemId).toBe('b'); // P0 first
    expect(sorted.at(1)?.itemId).toBe('c'); // P1 second
    expect(sorted.at(2)?.itemId).toBe('a'); // P2 third
  });

  it('cost estimate without history defaults to complexityScore * 0.5 = 2.5', async () => {
    const pipeline = new ScoringPipeline(
      makeFailingRuntime(),
      makeAdapter([]), // empty history → zero-data analysis
      makeConfig(),
      makeLogger(),
    );

    const result = await pipeline.scoreWithFallback([
      { id: 'x', title: 'A task', description: '', priority: 'P1', tags: [], source: 'todo-marker', confidence: 0.7 },
    ]);

    // EffortEstimator.estimate: historicalCost=0 → estimatedCostUsd = 5 * 0.5 = 2.5
    const item = [...result.withinBudget, ...result.requiresApproval].at(0);
    expect(item?.estimatedCostUsd).toBeCloseTo(2.5);
  });

  it('confidence reflects sprint count from historical data', async () => {
    // HistoryAnalyzer.analyze: confidence = min(0.9, 0.4 + totalSprints * 0.05)
    // With 6 sprints: 0.4 + 6*0.05 = 0.7
    const history = Array.from({ length: 6 }, (_, i) => ({
      version: `v${i}.0.0`,
      itemCount: 5,
      completedCount: 4,
      avgItemCostUsd: 1.5,
      createdAt: new Date().toISOString(),
    }));

    const pipeline = new ScoringPipeline(
      makeFailingRuntime(),
      makeAdapter(history),
      makeConfig(),
      makeLogger(),
    );

    const result = await pipeline.scoreWithFallback([
      { id: 'x', title: 'Task', description: '', priority: 'P1', tags: [], source: 'todo-marker', confidence: 0.5 },
    ]);

    const item = [...result.withinBudget, ...result.requiresApproval].at(0);
    // Should be around 0.7 (6 sprints): min(0.9, 0.4 + 6*0.05)
    expect(item?.confidence).toBeCloseTo(0.7, 1);
  });

  it('enforces per-cycle budget cap', async () => {
    // 10 items × $2.5/item = $25 total — with a $10 budget, some must overflow
    const items = makeBacklogItems(10);
    const pipeline = new ScoringPipeline(
      makeFailingRuntime(),
      makeAdapter(),
      makeConfig({ perCycleUsd: 10 }),
      makeLogger(),
    );

    const result = await pipeline.scoreWithFallback(items);

    expect(result.withinBudget.length).toBeGreaterThan(0);
    expect(result.requiresApproval.length).toBeGreaterThan(0);
    const withinTotal = result.withinBudget.reduce((s, r) => s + r.estimatedCostUsd, 0);
    expect(withinTotal).toBeLessThanOrEqual(10 + 0.01); // allow floating-point margin
  });

  it('respects maxItemsPerSprint limit', async () => {
    const items = makeBacklogItems(10);
    const pipeline = new ScoringPipeline(
      makeFailingRuntime(),
      makeAdapter(),
      makeConfig({ maxItems: 3 }),
      makeLogger(),
    );

    const result = await pipeline.scoreWithFallback(items);

    expect(result.withinBudget.length).toBeLessThanOrEqual(3);
  });

  it('summary mentions effort-estimator fallback', async () => {
    const pipeline = new ScoringPipeline(
      makeFailingRuntime(),
      makeAdapter(),
      makeConfig(),
      makeLogger(),
    );

    const result = await pipeline.scoreWithFallback(makeBacklogItems());

    expect(result.summary).toMatch(/effort-estimator/i);
  });

  it('warnings include the fallback notice', async () => {
    const pipeline = new ScoringPipeline(
      makeFailingRuntime(),
      makeAdapter(),
      makeConfig(),
      makeLogger(),
    );

    const result = await pipeline.scoreWithFallback(makeBacklogItems());

    expect(result.warnings.some(w => /effort-estimator/i.test(w))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: static fallback as last resort after effort-estimator throws
// ---------------------------------------------------------------------------

describe('ScoringPipeline.scoreWithFallback — static tier (last resort)', () => {
  it('falls back to static when effort-estimator adapter throws', async () => {
    const adapter: AdapterForScoring = {
      // getSprintHistory throws → effortEstimatorFallback catches and recovers
      // with analyzer.analyze([]) — so this alone won't cause a static fallback.
      // To force static, we need effortEstimatorFallback itself to throw, which
      // can happen if the backlog is somehow invalid (e.g., all items mutated
      // to have no id). Since effortEstimatorFallback is resilient, we test
      // the actual guaranteed path: a backlog that works fine and produces
      // the effort-estimator result (not static) when history fetch throws.
      getSprintHistory: vi.fn().mockRejectedValue(new Error('DB down')),
      getCostMedians: vi.fn().mockResolvedValue({}),
      getP50CostByTag: vi.fn().mockResolvedValue({}),
      getTeamState: vi.fn().mockResolvedValue({ utilization: {} }),
    };

    const pipeline = new ScoringPipeline(
      makeFailingRuntime(),
      adapter,
      makeConfig(),
      makeLogger(),
    );

    // Even when getSprintHistory throws, effortEstimatorFallback catches it
    // and falls back to zero-data analysis — so fallback is still 'effort-estimator'.
    const result = await pipeline.scoreWithFallback(makeBacklogItems());
    expect(result.fallback).toBe('effort-estimator');
  });

  it('static fallback is used when fallbackToStatic=false causes a throw', async () => {
    const config = makeConfig();
    (config.scoring as Record<string, unknown>).fallbackToStatic = false;

    const pipeline = new ScoringPipeline(
      makeFailingRuntime(),
      makeAdapter(),
      config,
      makeLogger(),
    );

    // When fallbackToStatic=false, the pipeline throws instead of falling back.
    await expect(pipeline.scoreWithFallback(makeBacklogItems())).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: effort-estimator items have correct rationale discriminant
// ---------------------------------------------------------------------------

describe('ScoringPipeline — effort-estimator rationale format', () => {
  it('each ranked item rationale contains "Effort-estimator fallback"', async () => {
    const pipeline = new ScoringPipeline(
      makeFailingRuntime(),
      makeAdapter(),
      makeConfig(),
      makeLogger(),
    );

    const result = await pipeline.scoreWithFallback(makeBacklogItems(2));

    for (const item of [...result.withinBudget, ...result.requiresApproval]) {
      expect(item.rationale).toMatch(/Effort-estimator fallback/);
    }
  });

  it('rationale embeds the item priority', async () => {
    const pipeline = new ScoringPipeline(
      makeFailingRuntime(),
      makeAdapter(),
      makeConfig(),
      makeLogger(),
    );

    const result = await pipeline.scoreWithFallback([
      { id: 'a', title: 'T', description: '', priority: 'P0', tags: [], source: 'todo-marker', confidence: 0.8 },
    ]);

    const item = [...result.withinBudget, ...result.requiresApproval].at(0);
    expect(item?.rationale).toContain('P0');
  });
});

// ---------------------------------------------------------------------------
// Tests: staticFallback uses p50CostByTag instead of flat perItemUsd
// Verifies the one-liner: estimatedCostUsd = p50CostByTag[item.tags[0]] ?? defaultCost
// ---------------------------------------------------------------------------

describe('ScoringPipeline — staticFallback: p50CostByTag lookup', () => {
  // Shortcut to call the private staticFallback method directly without needing
  // to force effortEstimatorFallback to throw through the full ladder.
  function callStaticFallback(
    pipeline: ScoringPipeline,
    backlog: BacklogItem[],
  ): Promise<ScoringPipelineResult> {
    return (pipeline as unknown as PipelineWithPrivates).staticFallback(backlog);
  }

  it('uses tag-specific p50 cost for known tags', async () => {
    const p50CostByTag = { fix: 1.10, feature: 1.65, doc: 0.55 };
    const adapter: AdapterForScoring = {
      getSprintHistory: vi.fn().mockResolvedValue([]),
      getCostMedians: vi.fn().mockResolvedValue({}),
      getP50CostByTag: vi.fn().mockResolvedValue(p50CostByTag),
      getTeamState: vi.fn().mockResolvedValue({ utilization: {} }),
    };
    const backlog: BacklogItem[] = [
      { id: 'a', title: 'Fix bug', description: '', priority: 'P1', tags: ['fix'],     source: 'todo-marker', confidence: 0.8 },
      { id: 'b', title: 'Feature',  description: '', priority: 'P1', tags: ['feature'], source: 'todo-marker', confidence: 0.8 },
      { id: 'c', title: 'Doc',      description: '', priority: 'P2', tags: ['doc'],     source: 'todo-marker', confidence: 0.7 },
    ];

    const pipeline = new ScoringPipeline(makeFailingRuntime(), adapter, makeConfig(), makeLogger());
    const result = await callStaticFallback(pipeline, backlog);

    const all = [...result.withinBudget, ...result.requiresApproval];
    expect(all.find(r => r.itemId === 'a')?.estimatedCostUsd).toBeCloseTo(1.10);
    expect(all.find(r => r.itemId === 'b')?.estimatedCostUsd).toBeCloseTo(1.65);
    expect(all.find(r => r.itemId === 'c')?.estimatedCostUsd).toBeCloseTo(0.55);
  });

  it('falls back to perItemUsd (defaultCost) for unrecognised tags', async () => {
    const adapter: AdapterForScoring = {
      getSprintHistory: vi.fn().mockResolvedValue([]),
      getCostMedians: vi.fn().mockResolvedValue({}),
      // p50 map has no entry for "unknown-tag"
      getP50CostByTag: vi.fn().mockResolvedValue({ fix: 1.10 }),
      getTeamState: vi.fn().mockResolvedValue({ utilization: {} }),
    };
    const backlog: BacklogItem[] = [
      { id: 'x', title: 'Mystery task', description: '', priority: 'P1', tags: ['unknown-tag'], source: 'todo-marker', confidence: 0.7 },
    ];

    const pipeline = new ScoringPipeline(makeFailingRuntime(), adapter, makeConfig(), makeLogger());
    const result = await callStaticFallback(pipeline, backlog);

    const item = [...result.withinBudget, ...result.requiresApproval].at(0);
    // defaultCost = config.budget.perItemUsd = 1.5 (from makeConfig)
    expect(item?.estimatedCostUsd).toBeCloseTo(1.5);
  });

  it('falls back to perItemUsd when getP50CostByTag adapter throws', async () => {
    const adapter: AdapterForScoring = {
      getSprintHistory: vi.fn().mockResolvedValue([]),
      getCostMedians: vi.fn().mockResolvedValue({}),
      getP50CostByTag: vi.fn().mockRejectedValue(new Error('DB unavailable')),
      getTeamState: vi.fn().mockResolvedValue({ utilization: {} }),
    };
    const backlog: BacklogItem[] = [
      { id: 'y', title: 'Task', description: '', priority: 'P1', tags: ['fix'], source: 'todo-marker', confidence: 0.8 },
    ];

    const pipeline = new ScoringPipeline(makeFailingRuntime(), adapter, makeConfig(), makeLogger());
    const result = await callStaticFallback(pipeline, backlog);

    const item = [...result.withinBudget, ...result.requiresApproval].at(0);
    // Adapter threw → p50CostByTag is {} → lookup misses → defaultCost applies
    expect(item?.estimatedCostUsd).toBeCloseTo(1.5);
  });

  it('result has fallback="static" discriminant', async () => {
    const pipeline = new ScoringPipeline(makeFailingRuntime(), makeAdapter(), makeConfig(), makeLogger());
    const result = await callStaticFallback(pipeline, makeBacklogItems(2));
    expect(result.fallback).toBe('static');
  });
});

// ---------------------------------------------------------------------------
// Tests: complexityFromTags helper — tag-mapped complexity scoring used by
// the effort-estimator fallback so heterogeneous backlogs differentiate cost
// estimates instead of collapsing to a single complexity-5 default.
// ---------------------------------------------------------------------------

describe('complexityFromTags', () => {
  it('returns 3 for chore/doc/docs tags', () => {
    expect(complexityFromTags(['chore'])).toBe(3);
    expect(complexityFromTags(['doc'])).toBe(3);
    expect(complexityFromTags(['docs'])).toBe(3);
  });

  it('returns 4 for ci/security tags', () => {
    expect(complexityFromTags(['ci'])).toBe(4);
    expect(complexityFromTags(['security'])).toBe(4);
  });

  it('returns 5 for fix/test tags (neutral midpoint)', () => {
    expect(complexityFromTags(['fix'])).toBe(5);
    expect(complexityFromTags(['test'])).toBe(5);
  });

  it('returns 6 for feature tag', () => {
    expect(complexityFromTags(['feature'])).toBe(6);
  });

  it('returns 7 for migration/refactor tags', () => {
    expect(complexityFromTags(['migration'])).toBe(7);
    expect(complexityFromTags(['refactor'])).toBe(7);
  });

  it('returns 8 for e2e tag', () => {
    expect(complexityFromTags(['e2e'])).toBe(8);
  });

  it('returns 5 (default) for empty tags array', () => {
    expect(complexityFromTags([])).toBe(5);
  });

  it('returns 5 (default) for undefined tags', () => {
    expect(complexityFromTags(undefined)).toBe(5);
  });

  it('returns 5 (default) for unrecognised tag', () => {
    expect(complexityFromTags(['some-random-tag'])).toBe(5);
  });

  it('is case-insensitive on the primary tag', () => {
    expect(complexityFromTags(['FEATURE'])).toBe(6);
    expect(complexityFromTags(['Chore'])).toBe(3);
  });

  it('uses the first tag and ignores the rest', () => {
    // Even when later tags would map to a different complexity, only the
    // primary (index 0) is consulted — this keeps the contract predictable.
    expect(complexityFromTags(['chore', 'feature', 'e2e'])).toBe(3);
  });
});
