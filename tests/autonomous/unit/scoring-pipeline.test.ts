import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScoringPipeline, DEFAULT_CYCLE_CONFIG, type AutonomousBacklogItem } from '@agentforge/core';

const fakeBacklog: AutonomousBacklogItem[] = [
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

/** Captures the task prompt passed to runtime.run for assertion in tests. */
function makeCapturingRuntime(response: string) {
  let capturedTask = '';
  const runtime = {
    run: async (_config: any, task: string) => {
      capturedTask = task;
      return {
        output: response,
        usage: { input_tokens: 1000, output_tokens: 500 },
        costUsd: 0.05,
        durationMs: 2500,
        model: 'claude-sonnet-4-6',
      };
    },
    getTask: () => capturedTask,
  };
  return runtime;
}

function makeMockAdapter(p50CostByTag: Record<string, number> = {}) {
  return {
    getSprintHistory: async (_limit: number) => [],
    getCostMedians: async () => ({}),
    getP50CostByTag: async () => p50CostByTag,
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

  it('replaces invented PascalCase assignees with "coder" and adds a warning', async () => {
    const runtime = makeMockRuntime(JSON.stringify({
      rankings: [
        { itemId: 'i1', title: 'Fix crash', rank: 1, score: 0.95, confidence: 0.9,
          estimatedCostUsd: 10, estimatedDurationMinutes: 20,
          rationale: 'r', dependencies: [], suggestedAssignee: 'BackendEngineer',
          suggestedTags: ['fix'], withinBudget: true },
        { itemId: 'i2', title: 'Add feature X', rank: 2, score: 0.8, confidence: 0.85,
          estimatedCostUsd: 15, estimatedDurationMinutes: 30,
          rationale: 'r', dependencies: [], suggestedAssignee: 'coder',
          suggestedTags: ['feature'], withinBudget: true },
      ],
      totalEstimatedCostUsd: 25, budgetOverflowUsd: 0, summary: 's', warnings: [],
    }));

    const { logger } = makeMockLogger();
    const pipeline = new ScoringPipeline(runtime as any, makeMockAdapter() as any, DEFAULT_CYCLE_CONFIG, logger);
    const result = await pipeline.score(fakeBacklog);

    expect(result.withinBudget[0]!.suggestedAssignee).toBe('coder');
    expect(result.withinBudget[1]!.suggestedAssignee).toBe('coder');
    expect(result.warnings.some(w => w.includes('BackendEngineer'))).toBe(true);
    expect(result.warnings.some(w => w.includes('replaced with "coder"'))).toBe(true);
    // Only one replacement warning — the valid 'coder' should not be touched
    expect(result.warnings.filter(w => w.includes('replaced with "coder"'))).toHaveLength(1);
  });

  it('scorer prompt includes explicit penalty language for off-roster assignees', async () => {
    const emptyResult = JSON.stringify({
      rankings: [], totalEstimatedCostUsd: 0, budgetOverflowUsd: 0, summary: 's', warnings: [],
    });
    const runtime = makeCapturingRuntime(emptyResult);
    const { logger } = makeMockLogger();
    const pipeline = new ScoringPipeline(runtime as any, makeMockAdapter() as any, DEFAULT_CYCLE_CONFIG, logger);
    await pipeline.score(fakeBacklog);

    const prompt = runtime.getTask();
    // Penalty language must be present so the LLM treats off-roster names as costly
    expect(prompt.toLowerCase()).toContain('scoring penalty');
    expect(prompt).toContain('gate-rejection');
    expect(prompt).toContain('BackendEngineer');
    expect(prompt).toContain('FrontendEngineer');
    // Substitution hints must guide the LLM toward real IDs
    expect(prompt).toContain('frontend-dev');
    expect(prompt).toContain('api-specialist');
    // Re-read-the-roster guidance must appear (numbered steps in the prompt)
    expect(prompt).toMatch(/re-read the roster/i);
  });

  it('sanitizes invented assignees in requiresApproval items too', async () => {
    const runtime = makeMockRuntime(JSON.stringify({
      rankings: [
        { itemId: 'i1', title: 'Fix', rank: 1, score: 0.9, confidence: 0.9,
          estimatedCostUsd: 5, estimatedDurationMinutes: 20,
          rationale: 'r', dependencies: [], suggestedAssignee: 'FrontendEngineer',
          suggestedTags: ['fix'], withinBudget: false },
      ],
      totalEstimatedCostUsd: 5, budgetOverflowUsd: 0, summary: 's', warnings: [],
    }));

    const { logger } = makeMockLogger();
    const pipeline = new ScoringPipeline(runtime as any, makeMockAdapter() as any, DEFAULT_CYCLE_CONFIG, logger);
    const result = await pipeline.score(fakeBacklog);

    expect(result.requiresApproval[0]!.suggestedAssignee).toBe('coder');
    expect(result.warnings.some(w => w.includes('FrontendEngineer'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: getAgentRoster() — nested team.yaml format and cwd-based injection
// These tests verify that the scorer prompt includes LIVE roster IDs from the
// real .agentforge/team.yaml (nested group format) rather than silently
// falling back to the 23-agent hardcoded list when team.yaml is present.
// ---------------------------------------------------------------------------

/** Create a temp directory with a mock .agentforge/team.yaml using nested groups. */
function makeNestedTeamYamlDir(agents: Record<string, string[]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentforge-test-'));
  mkdirSync(join(dir, '.agentforge'));
  const lines = ['agents:'];
  for (const [group, ids] of Object.entries(agents)) {
    lines.push(`  ${group}:`);
    for (const id of ids) lines.push(`    - ${id}`);
  }
  writeFileSync(join(dir, '.agentforge', 'team.yaml'), lines.join('\n'));
  return dir;
}

describe('ScoringPipeline — roster from nested team.yaml', () => {
  it('reads agent IDs from nested grouped team.yaml when cwd is provided', async () => {
    const cwd = makeNestedTeamYamlDir({
      strategic: ['ceo', 'architect'],
      implementation: ['coder', 'frontend-dev', 'api-specialist', 'devops-engineer'],
      quality: ['backend-qa', 'test-runner'],
    });

    const emptyResult = JSON.stringify({
      rankings: [], totalEstimatedCostUsd: 0, budgetOverflowUsd: 0, summary: 's', warnings: [],
    });
    const runtime = makeCapturingRuntime(emptyResult);
    const { logger } = makeMockLogger();
    const pipeline = new ScoringPipeline(
      runtime as any, makeMockAdapter() as any, DEFAULT_CYCLE_CONFIG, logger, cwd,
    );
    await pipeline.score(fakeBacklog);

    const prompt = runtime.getTask();
    // All agents from the nested YAML must appear in the roster section
    expect(prompt).toContain('ceo');
    expect(prompt).toContain('frontend-dev');
    expect(prompt).toContain('backend-qa');
    expect(prompt).toContain('devops-engineer');
  });

  it('prompt lists only live roster IDs, not hardcoded fallback extras, when cwd resolves', async () => {
    // The hardcoded fallback includes 'linter' but NOT 'ceo'. If we write a team.yaml
    // with only a single agent, the prompt roster should contain only that agent.
    const cwd = makeNestedTeamYamlDir({
      utility: ['my-custom-agent'],
    });

    const emptyResult = JSON.stringify({
      rankings: [], totalEstimatedCostUsd: 0, budgetOverflowUsd: 0, summary: 's', warnings: [],
    });
    const runtime = makeCapturingRuntime(emptyResult);
    const { logger } = makeMockLogger();
    const pipeline = new ScoringPipeline(
      runtime as any, makeMockAdapter() as any, DEFAULT_CYCLE_CONFIG, logger, cwd,
    );
    await pipeline.score(fakeBacklog);

    const prompt = runtime.getTask();
    // The live roster section (between "Valid agent IDs" and the ⚠️ line) must
    // include our custom agent ID, proving the live yaml was parsed.
    // We locate the roster line by searching for the section header pattern.
    const rosterStart = prompt.indexOf('Valid agent IDs — use one verbatim');
    const rosterEnd = prompt.indexOf('⚠️', rosterStart);
    expect(rosterStart).toBeGreaterThan(-1);
    const rosterSection = prompt.slice(rosterStart, rosterEnd);
    expect(rosterSection).toContain('my-custom-agent');
  });

  it('sanitizeAssignees uses live roster: off-roster in team.yaml context gets replaced', async () => {
    const cwd = makeNestedTeamYamlDir({
      implementation: ['coder', 'frontend-dev'],
    });

    // LLM returns 'BackendEngineer' — not in the live 2-agent roster
    const runtime = makeMockRuntime(JSON.stringify({
      rankings: [
        { itemId: 'i1', title: 'Fix', rank: 1, score: 0.9, confidence: 0.9,
          estimatedCostUsd: 5, estimatedDurationMinutes: 20,
          rationale: 'r', dependencies: [], suggestedAssignee: 'BackendEngineer',
          suggestedTags: ['fix'], withinBudget: true },
      ],
      totalEstimatedCostUsd: 5, budgetOverflowUsd: 0, summary: 's', warnings: [],
    }));

    const { logger } = makeMockLogger();
    const pipeline = new ScoringPipeline(
      runtime as any, makeMockAdapter() as any, DEFAULT_CYCLE_CONFIG, logger, cwd,
    );
    const result = await pipeline.score(fakeBacklog);

    expect(result.withinBudget[0]!.suggestedAssignee).toBe('coder');
    expect(result.warnings.some(w => w.includes('BackendEngineer'))).toBe(true);
  });

  it('falls back to hardcoded roster when .agentforge/team.yaml is missing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentforge-no-yaml-'));
    // Note: no .agentforge directory created — team.yaml is absent

    const emptyResult = JSON.stringify({
      rankings: [], totalEstimatedCostUsd: 0, budgetOverflowUsd: 0, summary: 's', warnings: [],
    });
    const runtime = makeCapturingRuntime(emptyResult);
    const { logger } = makeMockLogger();
    const pipeline = new ScoringPipeline(
      runtime as any, makeMockAdapter() as any, DEFAULT_CYCLE_CONFIG, logger, cwd,
    );
    await pipeline.score(fakeBacklog);

    const prompt = runtime.getTask();
    // Hardcoded fallback must include well-known agents
    expect(prompt).toContain('coder');
    expect(prompt).toContain('frontend-dev');
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

  function makeAdapter(p50CostByTag: Record<string, number> = {}) {
    return {
      getSprintHistory: async () => [],
      getCostMedians: async () => ({}),
      getP50CostByTag: async () => p50CostByTag,
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

  it('all LLM retries fail → effort-estimator fires as third-strike fallback', async () => {
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
    // Effort-estimator fires BEFORE static since v15.x — static is now last resort
    expect(result.fallback).toBe('effort-estimator');
    expect(result.withinBudget.length).toBeGreaterThan(0);
    // P0 should still rank higher than P1 (both fallbacks sort by priority)
    expect(result.withinBudget[0]!.itemId).toBe('i1');
  });

  it('effort-estimator fallback respects per-cycle budget cap', async () => {
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
    // Effort-estimator now fires before static (v15.x ladder change)
    expect(result.fallback).toBe('effort-estimator');
    // Budget cap is respected regardless of which fallback fires
    const totalCost = result.withinBudget.reduce((sum, i) => sum + i.estimatedCostUsd, 0);
    expect(totalCost).toBeLessThanOrEqual(25);
  });

  it('effort-estimator fallback: costs are complexity-based, not p50CostByTag', async () => {
    // Effort-estimator fires BEFORE static (v15.x), so p50CostByTag (used by
    // staticFallback) is never consulted. All items get complexityScore*0.5 = $2.50.
    const runtime = makeAlternatingRuntime(['garbage', 'garbage', 'garbage']);
    const { logger } = makeLogger();
    const backlog = [
      { id: 'f1', title: 'Fix crash', description: 'x', priority: 'P0' as const, tags: ['fix'], source: 'failed-session' as const, confidence: 0.9 },
      { id: 'ft1', title: 'New feature', description: 'x', priority: 'P1' as const, tags: ['feature'], source: 'todo-marker' as const, confidence: 0.8 },
      { id: 'u1', title: 'Unknown tag', description: 'x', priority: 'P2' as const, tags: ['unknown-tag'], source: 'todo-marker' as const, confidence: 0.7 },
    ];
    const p50 = { fix: 1.10, feature: 1.65 };
    const pipeline = new ScoringPipeline(
      runtime as any,
      makeAdapter(p50) as any,
      DEFAULT_CYCLE_CONFIG,
      logger,
    );

    const result = await pipeline.scoreWithFallback(backlog);
    expect(result.fallback).toBe('effort-estimator');

    // All items cost complexityScore(5) * 0.5 = $2.50 — not the tag medians
    for (const item of [...result.withinBudget, ...result.requiresApproval]) {
      expect(item.estimatedCostUsd).toBeCloseTo(2.50);
    }
    // Priority ordering is still respected (P0 → P1 → P2)
    const sorted = [...result.withinBudget, ...result.requiresApproval].sort((a, b) => a.rank - b.rank);
    expect(sorted.at(0)?.itemId).toBe('f1');
    expect(sorted.at(1)?.itemId).toBe('ft1');
    expect(sorted.at(2)?.itemId).toBe('u1');
  });

  it('effort-estimator fires first even when getP50CostByTag throws', async () => {
    // getP50CostByTag is only used by staticFallback. Effort-estimator catches
    // its own adapter errors (getSprintHistory) internally; a throwing
    // getP50CostByTag has no effect on the effort-estimator tier.
    const runtime = makeAlternatingRuntime(['garbage', 'garbage', 'garbage']);
    const { logger } = makeLogger();
    const throwingP50Adapter = {
      getSprintHistory: async () => [],           // returns empty — effort-estimator uses zero history
      getCostMedians: async () => ({}),
      getP50CostByTag: async () => { throw new Error('adapter unavailable'); },
      getTeamState: async () => ({ utilization: {} }),
    };
    const pipeline = new ScoringPipeline(
      runtime as any,
      throwingP50Adapter as any,
      DEFAULT_CYCLE_CONFIG,
      logger,
    );

    const result = await pipeline.scoreWithFallback(fakeBacklog);
    // Effort-estimator fires (not static), even though getP50CostByTag throws
    expect(result.fallback).toBe('effort-estimator');
    // Costs = complexityScore(5) * 0.5 = $2.50 (zero-history analysis)
    for (const item of [...result.withinBudget, ...result.requiresApproval]) {
      expect(item.estimatedCostUsd).toBeCloseTo(2.50);
    }
  });
});

describe('ScoringPipeline.staticFallback — p50CostByTag lookup', () => {
  // staticFallback() is private; cast to any to exercise it directly.
  // These tests verify the fix: tag-specific p50 costs replace the flat $1.50
  // perItemUsd estimate, reducing estimation error from up to 1622× down to
  // median-calibrated values.

  function makeStaticAdapter(p50CostByTag: Record<string, number> = {}) {
    return {
      getSprintHistory: async () => [],
      getCostMedians: async () => ({}),
      getP50CostByTag: async () => p50CostByTag,
      getTeamState: async () => ({ utilization: {} }),
    };
  }

  function makeStaticLogger() {
    return {
      logs: [] as any[],
      logger: {
        logScoring: () => {},
        logScoringFallback: () => {},
      } as any,
    };
  }

  const backlogFixture = [
    { id: 'f1', title: 'Fix crash',    description: 'x', priority: 'P0' as const, tags: ['fix'],     source: 'failed-session' as const, confidence: 0.9 },
    { id: 'f2', title: 'New feature',  description: 'x', priority: 'P1' as const, tags: ['feature'], source: 'todo-marker'   as const, confidence: 0.8 },
    { id: 'f3', title: 'Cleanup',      description: 'x', priority: 'P2' as const, tags: ['chore'],   source: 'todo-marker'   as const, confidence: 0.7 },
  ];

  it('uses p50CostByTag cost for each known primary tag', async () => {
    const p50 = { fix: 1.10, feature: 1.65, chore: 0.55 };
    const { logger } = makeStaticLogger();
    const pipeline = new ScoringPipeline(
      {} as any,
      makeStaticAdapter(p50) as any,
      DEFAULT_CYCLE_CONFIG,
      logger,
    );

    const result = await (pipeline as any).staticFallback(backlogFixture);
    const byId = Object.fromEntries(
      [...result.withinBudget, ...result.requiresApproval].map((r: any) => [r.itemId, r]),
    );

    expect(byId['f1'].estimatedCostUsd).toBeCloseTo(1.10); // fix p50
    expect(byId['f2'].estimatedCostUsd).toBeCloseTo(1.65); // feature p50
    expect(byId['f3'].estimatedCostUsd).toBeCloseTo(0.55); // chore p50
  });

  it('falls back to perItemUsd ($1.50) for tags absent from p50CostByTag', async () => {
    // p50 has 'fix' but not 'feature' — feature item gets the flat $1.50 default.
    const p50 = { fix: 1.10 };
    const { logger } = makeStaticLogger();
    const pipeline = new ScoringPipeline(
      {} as any,
      makeStaticAdapter(p50) as any,
      DEFAULT_CYCLE_CONFIG, // perItemUsd: 1.5
      logger,
    );

    const backlog = [
      { id: 'known',   title: 'Fix', description: 'x', priority: 'P0' as const, tags: ['fix'],     source: 'failed-session' as const, confidence: 0.9 },
      { id: 'unknown', title: 'Feat', description: 'x', priority: 'P1' as const, tags: ['feature'], source: 'todo-marker'   as const, confidence: 0.8 },
    ];

    const result = await (pipeline as any).staticFallback(backlog);
    const byId = Object.fromEntries(
      [...result.withinBudget, ...result.requiresApproval].map((r: any) => [r.itemId, r]),
    );

    expect(byId['known'].estimatedCostUsd).toBeCloseTo(1.10);   // p50 used
    expect(byId['unknown'].estimatedCostUsd).toBeCloseTo(1.5);  // perItemUsd fallback
  });

  it('falls back to perItemUsd for items with an empty tags array', async () => {
    const p50 = { fix: 1.10 };
    const { logger } = makeStaticLogger();
    const pipeline = new ScoringPipeline(
      {} as any,
      makeStaticAdapter(p50) as any,
      DEFAULT_CYCLE_CONFIG,
      logger,
    );

    const backlog = [
      { id: 'i1', title: 'No tags', description: 'x', priority: 'P0' as const, tags: [], source: 'todo-marker' as const, confidence: 0.8 },
    ];

    const result = await (pipeline as any).staticFallback(backlog);
    const item = [...result.withinBudget, ...result.requiresApproval][0];
    expect(item.estimatedCostUsd).toBeCloseTo(1.5); // perItemUsd default (tags[0] is undefined)
  });

  it('falls back to perItemUsd when getP50CostByTag throws', async () => {
    const throwingAdapter = {
      getSprintHistory: async () => [],
      getCostMedians: async () => ({}),
      getP50CostByTag: async (): Promise<Record<string, number>> => { throw new Error('adapter offline'); },
      getTeamState: async () => ({ utilization: {} }),
    };
    const { logger } = makeStaticLogger();
    const pipeline = new ScoringPipeline(
      {} as any,
      throwingAdapter as any,
      DEFAULT_CYCLE_CONFIG,
      logger,
    );

    const backlog = [
      { id: 'i1', title: 'Fix crash', description: 'x', priority: 'P0' as const, tags: ['fix'], source: 'failed-session' as const, confidence: 0.9 },
    ];

    const result = await (pipeline as any).staticFallback(backlog);
    const item = [...result.withinBudget, ...result.requiresApproval][0];
    // Adapter throws → p50CostByTag stays {} → perItemUsd ($1.50) applies
    expect(item.estimatedCostUsd).toBeCloseTo(1.5);
    expect(result.fallback).toBe('static');
  });

  it('sets fallback marker to "static" and includes the expected warning', async () => {
    const { logger } = makeStaticLogger();
    const pipeline = new ScoringPipeline(
      {} as any,
      makeStaticAdapter() as any,
      DEFAULT_CYCLE_CONFIG,
      logger,
    );

    const result = await (pipeline as any).staticFallback([
      { id: 'i1', title: 'x', description: 'x', priority: 'P0' as const, tags: ['fix'], source: 'todo-marker' as const, confidence: 0.8 },
    ]);

    expect(result.fallback).toBe('static');
    expect(result.warnings).toContain('Scoring agent failed; used static priority ranking');
  });

  it('sorts items by priority (P0 → P1 → P2) when p50 costs differ', async () => {
    // Even with different costs per tag the priority ordering must hold.
    const p50 = { fix: 1.10, feature: 1.65, chore: 0.55 };
    const { logger } = makeStaticLogger();
    const pipeline = new ScoringPipeline(
      {} as any,
      makeStaticAdapter(p50) as any,
      DEFAULT_CYCLE_CONFIG,
      logger,
    );

    const result = await (pipeline as any).staticFallback(backlogFixture);
    const allItems = [...result.withinBudget, ...result.requiresApproval].sort(
      (a: any, b: any) => a.rank - b.rank,
    );

    expect(allItems[0].itemId).toBe('f1'); // P0
    expect(allItems[1].itemId).toBe('f2'); // P1
    expect(allItems[2].itemId).toBe('f3'); // P2
  });
});
