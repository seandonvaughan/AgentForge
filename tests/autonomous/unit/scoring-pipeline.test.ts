import { describe, it, expect, beforeEach } from 'vitest';
import { ScoringPipeline } from '../../../packages/core/src/autonomous/scoring-pipeline.js';
import { DEFAULT_CYCLE_CONFIG } from '../../../packages/core/src/autonomous/config-loader.js';
import type { BacklogItem } from '../../../packages/core/src/autonomous/proposal-to-backlog.js';

const fakeBacklog: BacklogItem[] = [
  { id: 'i1', title: 'Fix crash', description: 'crash in parser', priority: 'P0', tags: ['fix'], source: 'failed-session', confidence: 0.9 },
  { id: 'i2', title: 'Add feature X', description: 'new X', priority: 'P1', tags: ['feature'], source: 'todo-marker', confidence: 1.0 },
  { id: 'i3', title: 'Cleanup Y', description: 'cleanup', priority: 'P2', tags: ['chore'], source: 'todo-marker', confidence: 1.0 },
];

function makeMockRuntime(response: string) {
  return {
    run: async (_config: any, _task: string) => ({
      output: response,
      usage: { input_tokens: 1000, output_tokens: 500 },
      costUsd: 0.05,
      durationMs: 2500,
      model: 'claude-sonnet-4-6',
    }),
  };
}

function makeMockAdapter() {
  return {
    getSprintHistory: async (_limit: number) => [],
    getCostMedians: async () => ({}),
    getTeamState: async () => ({ utilization: {} }),
  };
}

function makeMockLogger() {
  const logs: any[] = [];
  return {
    logs,
    logger: {
      logScoring: (result: any, grounding: any) => logs.push({ type: 'scoring', result, grounding }),
      logScoringFallback: (strike: number, error: string) => logs.push({ type: 'fallback', strike, error }),
    } as any,
  };
}

describe('ScoringPipeline', () => {
  it('parses valid ScoringResult and returns withinBudget split', async () => {
    const runtime = makeMockRuntime(JSON.stringify({
      rankings: [
        { itemId: 'i1', title: 'Fix crash', rank: 1, score: 0.95, confidence: 0.9,
          estimatedCostUsd: 10, estimatedDurationMinutes: 20,
          rationale: 'High impact', dependencies: [], suggestedAssignee: 'coder',
          suggestedTags: ['fix'], withinBudget: true },
        { itemId: 'i2', title: 'Add feature X', rank: 2, score: 0.8, confidence: 0.85,
          estimatedCostUsd: 15, estimatedDurationMinutes: 30,
          rationale: 'Good value', dependencies: [], suggestedAssignee: 'coder',
          suggestedTags: ['feature'], withinBudget: true },
      ],
      totalEstimatedCostUsd: 25,
      budgetOverflowUsd: 0,
      summary: 'Selected 2 items within $50 budget',
      warnings: [],
    }));

    const { logger } = makeMockLogger();
    const pipeline = new ScoringPipeline(
      runtime as any,
      makeMockAdapter() as any,
      DEFAULT_CYCLE_CONFIG,
      logger,
    );
    const result = await pipeline.score(fakeBacklog);

    expect(result.withinBudget).toHaveLength(2);
    expect(result.requiresApproval).toHaveLength(0);
    expect(result.withinBudget[0]!.itemId).toBe('i1');
  });

  it('splits items into withinBudget vs requiresApproval', async () => {
    const runtime = makeMockRuntime(JSON.stringify({
      rankings: [
        { itemId: 'i1', title: 'a', rank: 1, score: 0.95, confidence: 0.9, estimatedCostUsd: 30, estimatedDurationMinutes: 30, rationale: 'r', dependencies: [], suggestedAssignee: 'coder', suggestedTags: ['fix'], withinBudget: true },
        { itemId: 'i2', title: 'b', rank: 2, score: 0.85, confidence: 0.85, estimatedCostUsd: 25, estimatedDurationMinutes: 30, rationale: 'r', dependencies: [], suggestedAssignee: 'coder', suggestedTags: ['feature'], withinBudget: false },
      ],
      totalEstimatedCostUsd: 55,
      budgetOverflowUsd: 5,
      summary: 'Top 2 items exceed budget by $5',
      warnings: [],
    }));

    const { logger } = makeMockLogger();
    const pipeline = new ScoringPipeline(runtime as any, makeMockAdapter() as any, DEFAULT_CYCLE_CONFIG, logger);
    const result = await pipeline.score(fakeBacklog);

    expect(result.withinBudget).toHaveLength(1);
    expect(result.requiresApproval).toHaveLength(1);
    expect(result.totalEstimatedCostUsd).toBe(55);
    expect(result.budgetOverflowUsd).toBe(5);
  });

  it('logs scoring result with grounding context', async () => {
    const runtime = makeMockRuntime(JSON.stringify({
      rankings: [], totalEstimatedCostUsd: 0, budgetOverflowUsd: 0, summary: 'empty', warnings: [],
    }));
    const { logs, logger } = makeMockLogger();
    const pipeline = new ScoringPipeline(runtime as any, makeMockAdapter() as any, DEFAULT_CYCLE_CONFIG, logger);
    await pipeline.score(fakeBacklog);

    const scoringLog = logs.find(l => l.type === 'scoring');
    expect(scoringLog).toBeDefined();
    expect(scoringLog.grounding).toBeDefined();
  });

  it('handles JSON wrapped in markdown code block', async () => {
    const runtime = makeMockRuntime('```json\n' + JSON.stringify({
      rankings: [{ itemId: 'i1', title: 'Fix', rank: 1, score: 0.9, confidence: 0.85, estimatedCostUsd: 10, estimatedDurationMinutes: 20, rationale: 'r', dependencies: [], suggestedAssignee: 'coder', suggestedTags: ['fix'], withinBudget: true }],
      totalEstimatedCostUsd: 10, budgetOverflowUsd: 0, summary: 's', warnings: [],
    }) + '\n```');
    const { logger } = makeMockLogger();
    const pipeline = new ScoringPipeline(runtime as any, makeMockAdapter() as any, DEFAULT_CYCLE_CONFIG, logger);
    const result = await pipeline.score(fakeBacklog);
    expect(result.withinBudget).toHaveLength(1);
  });
});

describe('ScoringPipeline fallback ladder', () => {
  function makeAlternatingRuntime(responses: string[]) {
    let idx = 0;
    return {
      run: async (_config: any, _task: string) => ({
        output: responses[idx++ % responses.length],
        usage: { input_tokens: 100, output_tokens: 50 },
        costUsd: 0.01,
        durationMs: 500,
        model: 'claude-sonnet-4-6',
      }),
    };
  }

  function makeAdapter() {
    return {
      getSprintHistory: async () => [],
      getCostMedians: async () => ({}),
      getTeamState: async () => ({ utilization: {} }),
    };
  }

  function makeLogger() {
    const logs: any[] = [];
    return {
      logs,
      logger: {
        logScoring: (r: any, g: any) => logs.push({ type: 'scoring', r, g }),
        logScoringFallback: (strike: number, error: string) => logs.push({ type: 'fallback', strike, error }),
      } as any,
    };
  }

  const fakeBacklog = [
    { id: 'i1', title: 'Fix crash', description: 'x', priority: 'P0' as const, tags: ['fix'], source: 'failed-session' as const, confidence: 0.9 },
    { id: 'i2', title: 'Add X', description: 'x', priority: 'P1' as const, tags: ['feature'], source: 'todo-marker' as const, confidence: 1.0 },
  ];

  it('strike 1: retries with clarified prompt on invalid JSON', async () => {
    const validResponse = JSON.stringify({
      rankings: [{ itemId: 'i1', title: 'Fix', rank: 1, score: 0.9, confidence: 0.9, estimatedCostUsd: 10, estimatedDurationMinutes: 15, rationale: 'r', dependencies: [], suggestedAssignee: 'coder', suggestedTags: ['fix'], withinBudget: true }],
      totalEstimatedCostUsd: 10, budgetOverflowUsd: 0, summary: 's', warnings: [],
    });
    const runtime = makeAlternatingRuntime([
      'this is not JSON at all',  // strike 1 fails
      validResponse,                // strike 2 succeeds
    ]);
    const { logs, logger } = makeLogger();
    const pipeline = new ScoringPipeline(
      runtime as any,
      makeAdapter() as any,
      DEFAULT_CYCLE_CONFIG,
      logger,
    );
    const result = await pipeline.scoreWithFallback(fakeBacklog);
    expect(result.withinBudget).toHaveLength(1);
    expect(logs.some(l => l.type === 'fallback' && l.strike === 1)).toBe(true);
  });

  it('strike 3: falls back to static priority ranking when all retries fail', async () => {
    const runtime = makeAlternatingRuntime([
      'garbage', 'more garbage', 'still garbage', // all 3 strikes fail
    ]);
    const { logs, logger } = makeLogger();
    const pipeline = new ScoringPipeline(
      runtime as any,
      makeAdapter() as any,
      DEFAULT_CYCLE_CONFIG,
      logger,
    );
    const result = await pipeline.scoreWithFallback(fakeBacklog);
    expect(result.fallback).toBe('static');
    expect(result.withinBudget.length).toBeGreaterThan(0);
    // P0 should rank higher than P1 in static fallback
    expect(result.withinBudget[0]!.itemId).toBe('i1');
  });

  it('static fallback respects budget', async () => {
    const runtime = makeAlternatingRuntime(['garbage', 'garbage', 'garbage']);
    const { logger } = makeLogger();
    const bigBacklog = Array.from({ length: 20 }, (_, i) => ({
      id: `item-${i}`,
      title: `Item ${i}`,
      description: 'x',
      priority: (i < 3 ? 'P0' : i < 10 ? 'P1' : 'P2') as 'P0' | 'P1' | 'P2',
      tags: ['fix'],
      source: 'failed-session' as const,
      confidence: 0.9,
    }));

    const config = {
      ...DEFAULT_CYCLE_CONFIG,
      budget: {
        ...DEFAULT_CYCLE_CONFIG.budget,
        perCycleUsd: 25,
        perItemUsd: 5,
      },
    };
    const pipeline = new ScoringPipeline(
      runtime as any,
      makeAdapter() as any,
      config,
      logger,
    );
    const result = await pipeline.scoreWithFallback(bigBacklog);
    expect(result.fallback).toBe('static');
    // Should prefer P0 items and fit within budget
    const totalCost = result.withinBudget.reduce((sum, i) => sum + i.estimatedCostUsd, 0);
    expect(totalCost).toBeLessThanOrEqual(25);
  });
});
