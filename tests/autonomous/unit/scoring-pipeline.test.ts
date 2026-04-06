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
