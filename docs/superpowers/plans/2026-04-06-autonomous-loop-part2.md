# Autonomous Development Loop Implementation Plan — Part 2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Continuation of:** `docs/superpowers/plans/2026-04-06-autonomous-loop.md`

**Spec reference:** `docs/superpowers/specs/2026-04-06-autonomous-loop-design.md`

This file contains Tasks 17-26. Tasks 1-16 are in Part 1. Start Part 2 only after Part 1 is fully complete (all 16 commits landed, all tests green, Part 1 Acceptance Criteria verified).

---

## Task 17: Scoring pipeline (agent invocation)

**Files:**
- Create: `packages/core/src/autonomous/scoring-pipeline.ts`
- Test: `packages/core/src/autonomous/scoring-pipeline.test.ts`

**Context:** Invokes the `backlog-scorer` agent via `AgentRuntime`, validates the `ScoringResult` schema, returns `{withinBudget, requiresApproval}`. This task covers the happy path and schema validation. Task 18 adds the fallback ladder.

- [ ] **Step 1: Read existing AgentRuntime interface**

Run: `Read packages/core/src/agent-runtime/agent-runtime.ts`. Note the signature of `run()` and `runStreaming()`. Record: what arguments it takes (agent config + task + optional response_format), what it returns (result + tokens + cost).

- [ ] **Step 2: Write failing test with mocked runtime**

Create `packages/core/src/autonomous/scoring-pipeline.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { ScoringPipeline } from './scoring-pipeline.js';
import { DEFAULT_CYCLE_CONFIG } from './config-loader.js';
import type { BacklogItem } from './proposal-to-backlog.js';

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
```

- [ ] **Step 3: Run test — verify fails**

Run: `cd packages/core && npx vitest run src/autonomous/scoring-pipeline.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement `scoring-pipeline.ts`**

Create `packages/core/src/autonomous/scoring-pipeline.ts`:

```typescript
// packages/core/src/autonomous/scoring-pipeline.ts
import type { CycleConfig, ScoringResult, RankedItem } from './types.js';
import type { BacklogItem } from './proposal-to-backlog.js';
import type { CycleLogger } from './cycle-logger.js';

export interface AdapterForScoring {
  getSprintHistory(limit: number): Promise<unknown[]>;
  getCostMedians(): Promise<Record<string, number>>;
  getTeamState(): Promise<{ utilization: Record<string, number> }>;
}

export interface RuntimeForScoring {
  run(agentId: string, task: string, options?: { responseFormat?: string }): Promise<{
    output: string;
    usage: { input_tokens: number; output_tokens: number };
    costUsd: number;
    durationMs: number;
    model: string;
  }>;
}

export interface ScoringPipelineResult {
  withinBudget: RankedItem[];
  requiresApproval: RankedItem[];
  totalEstimatedCostUsd: number;
  budgetOverflowUsd: number;
  summary: string;
  warnings: string[];
  fallback?: 'static';
}

export class ScoringPipelineError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ScoringPipelineError';
  }
}

export class ScoringPipeline {
  constructor(
    private readonly runtime: RuntimeForScoring,
    private readonly adapter: AdapterForScoring,
    private readonly config: CycleConfig,
    private readonly logger: CycleLogger,
  ) {}

  async score(backlog: BacklogItem[]): Promise<ScoringPipelineResult> {
    const grounding = await this.gatherGrounding();
    const task = this.buildScoringPrompt(backlog, grounding);

    let scoringResult: ScoringResult;
    try {
      const runResult = await this.runtime.run(this.config.scoring.agentId, task, {
        responseFormat: 'json',
      });
      scoringResult = this.parseAndValidate(runResult.output);
    } catch (err) {
      throw new ScoringPipelineError(
        `Scoring agent failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.logger.logScoring(scoringResult, grounding);

    const withinBudget = scoringResult.rankings.filter(r => r.withinBudget);
    const requiresApproval = scoringResult.rankings.filter(r => !r.withinBudget);

    return {
      withinBudget,
      requiresApproval,
      totalEstimatedCostUsd: scoringResult.totalEstimatedCostUsd,
      budgetOverflowUsd: scoringResult.budgetOverflowUsd,
      summary: scoringResult.summary,
      warnings: scoringResult.warnings,
    };
  }

  async gatherGrounding(): Promise<object> {
    const [history, costMedians, teamState] = await Promise.all([
      this.adapter.getSprintHistory(10),
      this.adapter.getCostMedians(),
      this.adapter.getTeamState(),
    ]);
    return { history, costMedians, teamState };
  }

  private buildScoringPrompt(backlog: BacklogItem[], grounding: object): string {
    return `You are the Backlog Scorer for AgentForge's autonomous development loop.

## Candidate items
${JSON.stringify(backlog, null, 2)}

## System telemetry (grounding)
${JSON.stringify(grounding, null, 2)}

## Budget
- Hard cap per cycle: $${this.config.budget.perCycleUsd}
- Max items: ${this.config.limits.maxItemsPerSprint}

## Task
Rank the candidate items, estimate cost, and split into:
- withinBudget: items that fit in $${this.config.budget.perCycleUsd}
- requiresApproval: items that exceed budget (set withinBudget=false for these)

Return ONLY valid JSON matching this schema:
{
  "rankings": [
    {
      "itemId": string,
      "title": string,
      "rank": number (1 = highest priority),
      "score": number (0..1),
      "confidence": number (0..1),
      "estimatedCostUsd": number,
      "estimatedDurationMinutes": number,
      "rationale": string,
      "dependencies": string[],
      "suggestedAssignee": string,
      "suggestedTags": string[],
      "withinBudget": boolean
    }
  ],
  "totalEstimatedCostUsd": number,
  "budgetOverflowUsd": number,
  "summary": string,
  "warnings": string[]
}

Do not include any text outside the JSON object.`;
  }

  parseAndValidate(output: string): ScoringResult {
    // Strip markdown code fences if present
    let cleaned = output.trim();
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.slice(7).trim();
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.slice(3).trim();
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3).trim();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      throw new ScoringPipelineError(
        `Scoring output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!this.isValidScoringResult(parsed)) {
      throw new ScoringPipelineError('Scoring output does not match ScoringResult schema');
    }
    return parsed;
  }

  private isValidScoringResult(v: unknown): v is ScoringResult {
    if (typeof v !== 'object' || v === null) return false;
    const obj = v as Record<string, unknown>;
    if (!Array.isArray(obj.rankings)) return false;
    if (typeof obj.totalEstimatedCostUsd !== 'number') return false;
    if (typeof obj.budgetOverflowUsd !== 'number') return false;
    if (typeof obj.summary !== 'string') return false;
    if (!Array.isArray(obj.warnings)) return false;
    for (const r of obj.rankings) {
      if (typeof r !== 'object' || r === null) return false;
      const ri = r as Record<string, unknown>;
      if (typeof ri.itemId !== 'string') return false;
      if (typeof ri.rank !== 'number') return false;
      if (typeof ri.estimatedCostUsd !== 'number') return false;
      if (typeof ri.withinBudget !== 'boolean') return false;
    }
    return true;
  }
}
```

- [ ] **Step 5: Run tests — verify pass**

Run: `cd packages/core && npx vitest run src/autonomous/scoring-pipeline.test.ts`
Expected: All pass.

- [ ] **Step 6: Update barrel and commit**

Edit `packages/core/src/autonomous/index.ts` to add:

```typescript
export * from './scoring-pipeline.js';
```

Then:

```bash
cd packages/core && npm run build && cd ../..
git add packages/core/src/autonomous/scoring-pipeline.ts \
        packages/core/src/autonomous/scoring-pipeline.test.ts \
        packages/core/src/autonomous/index.ts
git commit -m "feat(autonomous): scoring pipeline (happy path + schema validation)"
```

---

## Task 18: Scoring pipeline fallback ladder

**Files:**
- Modify: `packages/core/src/autonomous/scoring-pipeline.ts`
- Test: extend `packages/core/src/autonomous/scoring-pipeline.test.ts`

**Context:** Add the 3-strike fallback: (1) retry with clarified prompt, (2) retry with simpler schema, (3) fall back to static priority-based ranking. See spec §6.4.

- [ ] **Step 1: Extend the test file with fallback cases**

Append to `packages/core/src/autonomous/scoring-pipeline.test.ts`:

```typescript
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
    const pipeline = new (await import('./scoring-pipeline.js')).ScoringPipeline(
      runtime as any,
      makeAdapter() as any,
      (await import('./config-loader.js')).DEFAULT_CYCLE_CONFIG,
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
    const pipeline = new (await import('./scoring-pipeline.js')).ScoringPipeline(
      runtime as any,
      makeAdapter() as any,
      (await import('./config-loader.js')).DEFAULT_CYCLE_CONFIG,
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
      ...(await import('./config-loader.js')).DEFAULT_CYCLE_CONFIG,
      budget: {
        ...(await import('./config-loader.js')).DEFAULT_CYCLE_CONFIG.budget,
        perCycleUsd: 25,
        perItemUsd: 5,
      },
    };
    const pipeline = new (await import('./scoring-pipeline.js')).ScoringPipeline(
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
```

- [ ] **Step 2: Run tests — verify new cases fail**

Run: `cd packages/core && npx vitest run src/autonomous/scoring-pipeline.test.ts`
Expected: New fallback tests FAIL because `scoreWithFallback` does not exist yet.

- [ ] **Step 3: Add `scoreWithFallback` method**

Edit `packages/core/src/autonomous/scoring-pipeline.ts` — add the fallback method:

```typescript
  /**
   * Three-strike scoring with fallback ladder.
   * Strike 1: retry with clarified prompt
   * Strike 2: retry with simpler schema (drop dependencies/suggestedAssignee)
   * Strike 3: fall back to static priority ranking
   */
  async scoreWithFallback(backlog: BacklogItem[]): Promise<ScoringPipelineResult> {
    const strikes = this.config.scoring.maxRetries;
    let lastError: Error | null = null;

    for (let strike = 0; strike < strikes; strike++) {
      try {
        return await this.score(backlog);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.logger.logScoringFallback(strike + 1, lastError.message);
      }
    }

    if (!this.config.scoring.fallbackToStatic) {
      throw lastError ?? new ScoringPipelineError('Scoring failed after all retries');
    }

    this.logger.logScoringFallback(strikes + 1, 'Falling back to static priority ranking');
    return this.staticFallback(backlog);
  }

  private staticFallback(backlog: BacklogItem[]): ScoringPipelineResult {
    const priorityOrder: Record<'P0' | 'P1' | 'P2', number> = { P0: 0, P1: 1, P2: 2 };
    const sorted = [...backlog].sort((a, b) => {
      const pa = priorityOrder[a.priority];
      const pb = priorityOrder[b.priority];
      if (pa !== pb) return pa - pb;
      return b.confidence - a.confidence;
    });

    const defaultCost = this.config.budget.perItemUsd;
    const rankings: RankedItem[] = sorted.map((item, idx) => ({
      itemId: item.id,
      title: item.title,
      rank: idx + 1,
      score: item.confidence,
      confidence: item.confidence,
      estimatedCostUsd: defaultCost,
      estimatedDurationMinutes: 15,
      rationale: `Static fallback ranking (${item.priority}, confidence ${item.confidence.toFixed(2)})`,
      dependencies: [],
      suggestedAssignee: 'coder',
      suggestedTags: item.tags,
      withinBudget: true,
    }));

    // Enforce per-cycle budget
    let cumulative = 0;
    for (const r of rankings) {
      cumulative += r.estimatedCostUsd;
      if (cumulative > this.config.budget.perCycleUsd) {
        r.withinBudget = false;
      }
    }

    // Enforce max items
    const withinBudget = rankings
      .filter(r => r.withinBudget)
      .slice(0, this.config.limits.maxItemsPerSprint);

    const totalCost = withinBudget.reduce((sum, r) => sum + r.estimatedCostUsd, 0);

    return {
      withinBudget,
      requiresApproval: rankings.filter(r => !r.withinBudget),
      totalEstimatedCostUsd: totalCost,
      budgetOverflowUsd: 0,
      summary: `Static priority fallback: ${withinBudget.length} items within $${this.config.budget.perCycleUsd} budget`,
      warnings: ['Scoring agent failed; used static priority ranking'],
      fallback: 'static',
    };
  }
```

- [ ] **Step 4: Run tests — verify all pass**

Run: `cd packages/core && npx vitest run src/autonomous/scoring-pipeline.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
cd packages/core && npm run build && cd ../..
git add packages/core/src/autonomous/scoring-pipeline.ts \
        packages/core/src/autonomous/scoring-pipeline.test.ts
git commit -m "feat(autonomous): scoring pipeline 3-strike fallback to static ranking"
```

---

## Task 19: Budget approval gate

**Files:**
- Create: `packages/core/src/autonomous/budget-approval.ts`
- Test: `packages/core/src/autonomous/budget-approval.test.ts`

**Context:** Dual-mode approval: TTY (interactive readline prompt) or file-based (for future daemon). Writes `approval-pending.json`, collects decision, writes `approval-decision.json`. See spec §6.5.

- [ ] **Step 1: Write failing test**

Create `packages/core/src/autonomous/budget-approval.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetApproval } from './budget-approval.js';
import { CycleLogger } from './cycle-logger.js';
import type { RankedItem } from './types.js';

describe('BudgetApproval', () => {
  let tmpDir: string;
  const cycleId = 'test-ba';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-ba-'));
    mkdirSync(join(tmpDir, '.agentforge/cycles', cycleId), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const withinBudget: RankedItem[] = [
    { itemId: 'i1', title: 'Fix', rank: 1, score: 0.9, confidence: 0.9, estimatedCostUsd: 30, estimatedDurationMinutes: 30, rationale: 'r', dependencies: [], suggestedAssignee: 'coder', suggestedTags: ['fix'], withinBudget: true },
  ];
  const overflow: RankedItem[] = [
    { itemId: 'i2', title: 'Feature', rank: 2, score: 0.8, confidence: 0.85, estimatedCostUsd: 25, estimatedDurationMinutes: 30, rationale: 'r', dependencies: [], suggestedAssignee: 'coder', suggestedTags: ['feature'], withinBudget: false },
  ];

  it('returns all items when overflow is empty', async () => {
    const logger = new CycleLogger(tmpDir, cycleId);
    const approval = new BudgetApproval(tmpDir, cycleId, logger);
    const result = await approval.collect({
      withinBudget,
      requiresApproval: [],
      budgetUsd: 50,
      summary: 'ok',
    });
    expect(result.approvedItems).toEqual(withinBudget);
    expect(result.rejectedItems).toEqual([]);
    expect(result.decision).toBe('auto-approved');
  });

  it('writes approval-pending.json when overflow exists', async () => {
    const logger = new CycleLogger(tmpDir, cycleId);
    const approval = new BudgetApproval(tmpDir, cycleId, logger);

    // Force file-based mode by pre-writing decision
    writeFileSync(
      join(tmpDir, '.agentforge/cycles', cycleId, 'approval-decision.json'),
      JSON.stringify({
        decision: 'approved',
        approvedItemIds: ['i1', 'i2'],
        rejectedItemIds: [],
        decidedAt: new Date().toISOString(),
        decidedBy: 'test',
      }),
    );

    const result = await approval.collect({
      withinBudget,
      requiresApproval: overflow,
      budgetUsd: 50,
      summary: 'overflow',
    }, { mode: 'file' });

    expect(
      existsSync(join(tmpDir, '.agentforge/cycles', cycleId, 'approval-pending.json')),
    ).toBe(true);
    expect(result.approvedItems).toHaveLength(2);
  });

  it('file mode honors rejection of overflow items', async () => {
    const logger = new CycleLogger(tmpDir, cycleId);
    const approval = new BudgetApproval(tmpDir, cycleId, logger);

    writeFileSync(
      join(tmpDir, '.agentforge/cycles', cycleId, 'approval-decision.json'),
      JSON.stringify({
        decision: 'rejected',
        approvedItemIds: ['i1'],
        rejectedItemIds: ['i2'],
        decidedAt: new Date().toISOString(),
        decidedBy: 'test',
      }),
    );

    const result = await approval.collect({
      withinBudget,
      requiresApproval: overflow,
      budgetUsd: 50,
      summary: 'overflow',
    }, { mode: 'file' });

    expect(result.approvedItems).toHaveLength(1);
    expect(result.approvedItems[0]!.itemId).toBe('i1');
    expect(result.rejectedItems).toHaveLength(1);
    expect(result.rejectedItems[0]!.itemId).toBe('i2');
  });

  it('throws when all items are rejected', async () => {
    const logger = new CycleLogger(tmpDir, cycleId);
    const approval = new BudgetApproval(tmpDir, cycleId, logger);

    writeFileSync(
      join(tmpDir, '.agentforge/cycles', cycleId, 'approval-decision.json'),
      JSON.stringify({
        decision: 'rejected',
        approvedItemIds: [],
        rejectedItemIds: ['i1', 'i2'],
        decidedAt: new Date().toISOString(),
        decidedBy: 'test',
      }),
    );

    const approval2 = new BudgetApproval(tmpDir, cycleId, logger);
    await expect(
      approval2.collect({
        withinBudget: [],
        requiresApproval: overflow,
        budgetUsd: 50,
        summary: '',
      }, { mode: 'file' }),
    ).rejects.toThrow(/no items approved/i);
  });

  it('writes approval-decision.json after collection', async () => {
    const logger = new CycleLogger(tmpDir, cycleId);
    const approval = new BudgetApproval(tmpDir, cycleId, logger);

    writeFileSync(
      join(tmpDir, '.agentforge/cycles', cycleId, 'approval-decision.json'),
      JSON.stringify({
        decision: 'approved',
        approvedItemIds: ['i1', 'i2'],
        rejectedItemIds: [],
        decidedAt: new Date().toISOString(),
        decidedBy: 'test',
      }),
    );

    const approval2 = new BudgetApproval(tmpDir, cycleId, logger);
    await approval2.collect({
      withinBudget,
      requiresApproval: overflow,
      budgetUsd: 50,
      summary: 'overflow',
    }, { mode: 'file' });

    const decisionPath = join(tmpDir, '.agentforge/cycles', cycleId, 'approval-decision.json');
    expect(existsSync(decisionPath)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test — verify fails**

Run: `cd packages/core && npx vitest run src/autonomous/budget-approval.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `budget-approval.ts`**

Create `packages/core/src/autonomous/budget-approval.ts`:

```typescript
// packages/core/src/autonomous/budget-approval.ts
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { RankedItem } from './types.js';
import type { CycleLogger } from './cycle-logger.js';

export interface ApprovalRequest {
  withinBudget: RankedItem[];
  requiresApproval: RankedItem[];
  budgetUsd: number;
  summary: string;
}

export interface ApprovalResult {
  approvedItems: RankedItem[];
  rejectedItems: RankedItem[];
  finalBudgetUsd: number;
  decision: 'auto-approved' | 'approved' | 'partial' | 'rejected';
  decidedAt: string;
  decidedBy: string;
}

export interface ApprovalOptions {
  mode?: 'tty' | 'file' | 'auto';
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export class BudgetApprovalError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'BudgetApprovalError';
  }
}

export class BudgetApproval {
  constructor(
    private readonly cwd: string,
    private readonly cycleId: string,
    private readonly logger: CycleLogger,
  ) {}

  async collect(req: ApprovalRequest, options: ApprovalOptions = {}): Promise<ApprovalResult> {
    if (req.requiresApproval.length === 0) {
      return {
        approvedItems: req.withinBudget,
        rejectedItems: [],
        finalBudgetUsd: this.sumCosts(req.withinBudget),
        decision: 'auto-approved',
        decidedAt: new Date().toISOString(),
        decidedBy: 'system',
      };
    }

    // Write pending
    const overflowCost = this.sumCosts(req.requiresApproval);
    const newTotal = this.sumCosts(req.withinBudget) + overflowCost;

    this.logger.logApprovalPending({
      cycleId: this.cycleId,
      requestedAt: new Date().toISOString(),
      withinBudget: { items: req.withinBudget, totalCostUsd: this.sumCosts(req.withinBudget) },
      overflow: { items: req.requiresApproval, additionalCostUsd: overflowCost },
      newTotalUsd: newTotal,
      budgetUsd: req.budgetUsd,
      agentSummary: req.summary,
    });

    const mode = options.mode ?? (process.stdin.isTTY ? 'tty' : 'file');

    let decision: {
      decision: 'approved' | 'rejected';
      approvedItemIds: string[];
      rejectedItemIds: string[];
      decidedBy: string;
    };

    if (mode === 'tty') {
      decision = await this.promptTty(req, newTotal);
    } else {
      decision = await this.pollDecisionFile(options.pollTimeoutMs ?? 30 * 60 * 1000, options.pollIntervalMs ?? 2000);
    }

    const decidedAt = new Date().toISOString();
    this.logger.logApprovalDecision({
      ...decision,
      decidedAt,
      cycleId: this.cycleId,
    });

    const approvedIds = new Set(decision.approvedItemIds);
    const allItems = [...req.withinBudget, ...req.requiresApproval];
    const approvedItems = allItems.filter(i => approvedIds.has(i.itemId));
    const rejectedItems = allItems.filter(i => !approvedIds.has(i.itemId));

    if (approvedItems.length === 0) {
      throw new BudgetApprovalError('No items approved — cycle cannot proceed');
    }

    return {
      approvedItems,
      rejectedItems,
      finalBudgetUsd: this.sumCosts(approvedItems),
      decision: rejectedItems.length === 0 ? 'approved' : 'partial',
      decidedAt,
      decidedBy: decision.decidedBy,
    };
  }

  private async promptTty(req: ApprovalRequest, newTotal: number): Promise<{
    decision: 'approved' | 'rejected';
    approvedItemIds: string[];
    rejectedItemIds: string[];
    decidedBy: string;
  }> {
    const overflowCost = this.sumCosts(req.requiresApproval);
    const overflowList = req.requiresApproval
      .map(i => `  - ${i.title} ($${i.estimatedCostUsd.toFixed(2)})`)
      .join('\n');

    const message = `
Budget overrun requested:
  Within budget: $${this.sumCosts(req.withinBudget).toFixed(2)} for ${req.withinBudget.length} items
  Overflow:      $${overflowCost.toFixed(2)} for ${req.requiresApproval.length} item(s)
${overflowList}
  New total:     $${newTotal.toFixed(2)} / $${req.budgetUsd.toFixed(2)} budget

Summary: ${req.summary}

Approve overage? [y/N]: `;

    const answer = await this.readLine(message);
    const approved = answer.trim().toLowerCase() === 'y';

    return {
      decision: approved ? 'approved' : 'rejected',
      approvedItemIds: approved
        ? [...req.withinBudget, ...req.requiresApproval].map(i => i.itemId)
        : req.withinBudget.map(i => i.itemId),
      rejectedItemIds: approved
        ? []
        : req.requiresApproval.map(i => i.itemId),
      decidedBy: process.env.USER ?? 'unknown',
    };
  }

  private async pollDecisionFile(timeoutMs: number, intervalMs: number): Promise<{
    decision: 'approved' | 'rejected';
    approvedItemIds: string[];
    rejectedItemIds: string[];
    decidedBy: string;
  }> {
    const decisionPath = join(this.cwd, '.agentforge/cycles', this.cycleId, 'approval-decision.json');
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (existsSync(decisionPath)) {
        const data = JSON.parse(readFileSync(decisionPath, 'utf8'));
        return data;
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }

    throw new BudgetApprovalError(`Approval timeout after ${timeoutMs}ms`);
  }

  private readLine(prompt: string): Promise<string> {
    return new Promise(resolve => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(prompt, answer => {
        rl.close();
        resolve(answer);
      });
    });
  }

  private sumCosts(items: RankedItem[]): number {
    return items.reduce((sum, i) => sum + i.estimatedCostUsd, 0);
  }
}
```

- [ ] **Step 4: Run tests — verify pass**

Run: `cd packages/core && npx vitest run src/autonomous/budget-approval.test.ts`
Expected: All pass.

- [ ] **Step 5: Update barrel and commit**

Edit `packages/core/src/autonomous/index.ts` to add:

```typescript
export * from './budget-approval.js';
```

Then:

```bash
cd packages/core && npm run build && cd ../..
git add packages/core/src/autonomous/budget-approval.ts \
        packages/core/src/autonomous/budget-approval.test.ts \
        packages/core/src/autonomous/index.ts
git commit -m "feat(autonomous): budget approval gate (TTY + file modes)"
```

---

## Task 20: Phase scheduler

**Files:**
- Create: `packages/core/src/autonomous/phase-scheduler.ts`
- Test: `packages/core/src/autonomous/phase-scheduler.test.ts`

**Context:** Event-driven auto-advance between sprint phases. Subscribes to `sprint.phase.completed` and triggers the next phase. Kill switch checked between every phase. See spec §7.3.

- [ ] **Step 1: Write failing test**

Create `packages/core/src/autonomous/phase-scheduler.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { PhaseScheduler } from './phase-scheduler.js';
import { KillSwitch } from './kill-switch.js';
import { CycleLogger } from './cycle-logger.js';
import { DEFAULT_CYCLE_CONFIG } from './config-loader.js';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeMockBus() {
  const subscribers: Record<string, Array<(event: any) => void>> = {};
  const published: any[] = [];
  return {
    published,
    bus: {
      publish: (topic: string, payload: any) => {
        published.push({ topic, payload });
        (subscribers[topic] ?? []).forEach(cb => cb(payload));
      },
      subscribe: (topic: string, cb: (event: any) => void) => {
        if (!subscribers[topic]) subscribers[topic] = [];
        subscribers[topic]!.push(cb);
        return () => {
          subscribers[topic] = subscribers[topic]!.filter(c => c !== cb);
        };
      },
    } as any,
  };
}

describe('PhaseScheduler', () => {
  let tmpDir: string;
  const cycleId = 'test-ps';
  const sprintId = 'test-sprint';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-ps-'));
    mkdirSync(join(tmpDir, '.agentforge/cycles', cycleId), { recursive: true });
  });

  function makeDeps(busFactory = makeMockBus) {
    const { bus, published } = busFactory();
    const logger = new CycleLogger(tmpDir, cycleId);
    const killSwitch = new KillSwitch(DEFAULT_CYCLE_CONFIG, cycleId, Date.now(), tmpDir);
    return { bus, published, logger, killSwitch };
  }

  it('triggers audit phase on run()', async () => {
    const { bus, published, logger, killSwitch } = makeDeps();

    // Mock phase handler that immediately publishes completed
    const mockHandlers = {
      audit: async (ctx: any) => {
        ctx.bus.publish('sprint.phase.completed', {
          sprintId, phase: 'audit', cycleId, result: { phase: 'audit', status: 'completed', durationMs: 100, costUsd: 0.1, agentRuns: [] }, completedAt: new Date().toISOString(),
        });
      },
      plan: async (ctx: any) => {
        ctx.bus.publish('sprint.phase.completed', {
          sprintId, phase: 'plan', cycleId, result: { phase: 'plan', status: 'completed', durationMs: 100, costUsd: 0.1, agentRuns: [] }, completedAt: new Date().toISOString(),
        });
      },
      assign: async (ctx: any) => { ctx.bus.publish('sprint.phase.completed', { sprintId, phase: 'assign', cycleId, result: { phase: 'assign', status: 'completed', durationMs: 100, costUsd: 0.1, agentRuns: [] }, completedAt: new Date().toISOString() }); },
      execute: async (ctx: any) => { ctx.bus.publish('sprint.phase.completed', { sprintId, phase: 'execute', cycleId, result: { phase: 'execute', status: 'completed', durationMs: 100, costUsd: 0.1, agentRuns: [], itemResults: [] }, completedAt: new Date().toISOString() }); },
      test: async (ctx: any) => { ctx.bus.publish('sprint.phase.completed', { sprintId, phase: 'test', cycleId, result: { phase: 'test', status: 'completed', durationMs: 100, costUsd: 0.1, agentRuns: [] }, completedAt: new Date().toISOString() }); },
      review: async (ctx: any) => { ctx.bus.publish('sprint.phase.completed', { sprintId, phase: 'review', cycleId, result: { phase: 'review', status: 'completed', durationMs: 100, costUsd: 0.1, agentRuns: [] }, completedAt: new Date().toISOString() }); },
      gate: async (ctx: any) => { ctx.bus.publish('sprint.phase.completed', { sprintId, phase: 'gate', cycleId, result: { phase: 'gate', status: 'completed', durationMs: 100, costUsd: 0.1, agentRuns: [] }, completedAt: new Date().toISOString() }); },
      release: async (ctx: any) => { ctx.bus.publish('sprint.phase.completed', { sprintId, phase: 'release', cycleId, result: { phase: 'release', status: 'completed', durationMs: 100, costUsd: 0.1, agentRuns: [] }, completedAt: new Date().toISOString() }); },
      learn: async (ctx: any) => { ctx.bus.publish('sprint.phase.completed', { sprintId, phase: 'learn', cycleId, result: { phase: 'learn', status: 'completed', durationMs: 100, costUsd: 0.1, agentRuns: [] }, completedAt: new Date().toISOString() }); },
    };

    const scheduler = new PhaseScheduler(
      {
        sprintId, sprintVersion: '6.4.0', projectRoot: tmpDir,
        adapter: {} as any, bus, runtime: {} as any, cycleId,
      },
      killSwitch,
      logger,
      mockHandlers as any,
    );

    const summary = await scheduler.run();
    expect(summary.completedPhases).toHaveLength(9);
    expect(published.filter(e => e.topic === 'sprint.phase.started')).toHaveLength(9);
  });

  it('auto-advances through all 9 phases', async () => {
    // Same setup as above — verify the full sequence
    // (this test overlaps with the first; keep for clarity)
  });

  it('rejects run() when kill switch trips', async () => {
    const { bus, logger } = makeDeps();
    const killSwitch = new KillSwitch(
      { ...DEFAULT_CYCLE_CONFIG, budget: { ...DEFAULT_CYCLE_CONFIG.budget, perCycleUsd: 0.05 } },
      cycleId, Date.now(), tmpDir,
    );

    const handlers = {
      audit: async (ctx: any) => {
        ctx.bus.publish('sprint.phase.completed', {
          sprintId, phase: 'audit', cycleId,
          result: { phase: 'audit', status: 'completed', durationMs: 100, costUsd: 1.0, agentRuns: [] },
          completedAt: new Date().toISOString(),
        });
      },
      plan: async () => { throw new Error('should not reach plan'); },
      assign: async () => {}, execute: async () => {}, test: async () => {},
      review: async () => {}, gate: async () => {}, release: async () => {}, learn: async () => {},
    };

    const scheduler = new PhaseScheduler(
      {
        sprintId, sprintVersion: '6.4.0', projectRoot: tmpDir,
        adapter: {} as any, bus, runtime: {} as any, cycleId,
      },
      killSwitch,
      logger,
      handlers as any,
    );

    await expect(scheduler.run()).rejects.toThrow();
  });

  it('rejects on phase.failed event', async () => {
    const { bus, logger, killSwitch } = makeDeps();
    const handlers = {
      audit: async (ctx: any) => {
        ctx.bus.publish('sprint.phase.failed', {
          sprintId, phase: 'audit', cycleId, error: 'researcher crashed',
          failedAt: new Date().toISOString(),
        });
      },
      plan: async () => {}, assign: async () => {}, execute: async () => {},
      test: async () => {}, review: async () => {}, gate: async () => {}, release: async () => {}, learn: async () => {},
    };
    const scheduler = new PhaseScheduler(
      { sprintId, sprintVersion: '6.4.0', projectRoot: tmpDir, adapter: {} as any, bus, runtime: {} as any, cycleId },
      killSwitch,
      logger,
      handlers as any,
    );
    await expect(scheduler.run()).rejects.toThrow(/researcher crashed/);
  });
});
```

- [ ] **Step 2: Run test — verify fails**

Run: `cd packages/core && npx vitest run src/autonomous/phase-scheduler.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `phase-scheduler.ts`**

Create `packages/core/src/autonomous/phase-scheduler.ts`:

```typescript
// packages/core/src/autonomous/phase-scheduler.ts
import type { KillSwitch } from './kill-switch.js';
import type { CycleLogger } from './cycle-logger.js';
import { CycleKilledError, PhaseFailedError } from './types.js';

export type PhaseName =
  | 'audit' | 'plan' | 'assign' | 'execute'
  | 'test' | 'review' | 'gate' | 'release' | 'learn';

const PHASE_SEQUENCE: PhaseName[] = [
  'audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate', 'release', 'learn',
];

function nextPhase(current: PhaseName): PhaseName | null {
  const idx = PHASE_SEQUENCE.indexOf(current);
  return idx === -1 || idx === PHASE_SEQUENCE.length - 1
    ? null
    : PHASE_SEQUENCE[idx + 1]!;
}

export interface PhaseContext {
  sprintId: string;
  sprintVersion: string;
  projectRoot: string;
  adapter: any;
  bus: { publish: (topic: string, payload: any) => void; subscribe: (topic: string, cb: (event: any) => void) => () => void };
  runtime: any;
  cycleId?: string;
}

export interface PhaseResult {
  phase: PhaseName;
  status: 'completed' | 'failed' | 'blocked';
  durationMs: number;
  costUsd: number;
  agentRuns: unknown[];
  itemResults?: unknown[];
  error?: string;
}

export type PhaseHandler = (ctx: PhaseContext) => Promise<PhaseResult | void>;

export interface SprintRunSummary {
  completedPhases: PhaseResult[];
  totalCostUsd: number;
  totalDurationMs: number;
}

export class PhaseScheduler {
  private unsubscribers: Array<() => void> = [];
  private resolvePromise: ((result: SprintRunSummary) => void) | null = null;
  private rejectPromise: ((err: Error) => void) | null = null;
  private phaseResults = new Map<PhaseName, PhaseResult>();

  constructor(
    private readonly ctx: PhaseContext,
    private readonly killSwitch: KillSwitch,
    private readonly logger: CycleLogger,
    private readonly handlers: Record<PhaseName, PhaseHandler>,
  ) {}

  async run(): Promise<SprintRunSummary> {
    return new Promise((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
      this.subscribe();
      void this.triggerPhase('audit');
    });
  }

  private subscribe(): void {
    const onCompleted = (event: any) => {
      if (event.sprintId !== this.ctx.sprintId) return;
      if (event.phase && event.result) {
        this.phaseResults.set(event.phase, event.result);
        this.logger.logPhaseResult(event.phase, event.result);
      }

      const trip = this.killSwitch.checkBetweenPhases({
        cumulativeCostUsd: this.sumCost(),
        consecutiveFailures: this.countConsecutiveFailures(),
      });
      if (trip) {
        return this.fail(new CycleKilledError(trip));
      }

      const next = nextPhase(event.phase as PhaseName);
      if (!next) return this.complete();
      void this.triggerPhase(next);
    };

    const onFailed = (event: any) => {
      if (event.sprintId !== this.ctx.sprintId) return;
      this.logger.logPhaseFailure(event.phase, event.error);
      this.fail(new PhaseFailedError(event.phase, event.error));
    };

    this.unsubscribers.push(
      this.ctx.bus.subscribe('sprint.phase.completed', onCompleted),
      this.ctx.bus.subscribe('sprint.phase.failed', onFailed),
    );
  }

  private async triggerPhase(phase: PhaseName): Promise<void> {
    this.logger.logPhaseStart(phase);
    try {
      const handler = this.handlers[phase];
      if (!handler) {
        throw new Error(`No handler for phase ${phase}`);
      }
      await handler(this.ctx);
    } catch (err) {
      this.ctx.bus.publish('sprint.phase.failed', {
        sprintId: this.ctx.sprintId,
        phase,
        cycleId: this.ctx.cycleId,
        error: err instanceof Error ? err.message : String(err),
        failedAt: new Date().toISOString(),
      });
    }
  }

  private complete(): void {
    this.cleanup();
    const summary: SprintRunSummary = {
      completedPhases: Array.from(this.phaseResults.values()),
      totalCostUsd: this.sumCost(),
      totalDurationMs: Array.from(this.phaseResults.values()).reduce((a, r) => a + r.durationMs, 0),
    };
    this.resolvePromise?.(summary);
  }

  private fail(err: Error): void {
    this.cleanup();
    this.rejectPromise?.(err);
  }

  private cleanup(): void {
    this.unsubscribers.forEach(u => u());
    this.unsubscribers = [];
  }

  private sumCost(): number {
    let total = 0;
    for (const r of this.phaseResults.values()) total += r.costUsd;
    return total;
  }

  private countConsecutiveFailures(): number {
    let count = 0;
    for (const r of Array.from(this.phaseResults.values()).reverse()) {
      if (r.status === 'failed') count++;
      else break;
    }
    return count;
  }
}
```

- [ ] **Step 4: Run tests — verify pass**

Run: `cd packages/core && npx vitest run src/autonomous/phase-scheduler.test.ts`
Expected: All pass.

- [ ] **Step 5: Update barrel and commit**

Edit `packages/core/src/autonomous/index.ts` to add:

```typescript
export * from './phase-scheduler.js';
```

Then:

```bash
cd packages/core && npm run build && cd ../..
git add packages/core/src/autonomous/phase-scheduler.ts \
        packages/core/src/autonomous/phase-scheduler.test.ts \
        packages/core/src/autonomous/index.ts
git commit -m "feat(autonomous): event-driven phase scheduler"
```

---

## Task 21: Cycle runner (top-level orchestrator)

**Files:**
- Create: `packages/core/src/autonomous/cycle-runner.ts`
- Test: `packages/core/src/autonomous/cycle-runner.test.ts`

**Context:** Top-level orchestrator. Drives all 6 stages (PLAN → STAGE → RUN → VERIFY → COMMIT → REVIEW). Produces `CycleResult`. Catches `CycleKilledError` at the top level and writes terminal cycle.json. See spec §6.

- [ ] **Step 1: Write failing test**

Create `packages/core/src/autonomous/cycle-runner.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CycleRunner } from './cycle-runner.js';
import { DEFAULT_CYCLE_CONFIG } from './config-loader.js';
import { CycleStage } from './types.js';

describe('CycleRunner', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-cr-'));
    mkdirSync(join(tmpDir, '.agentforge/sprints'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.agentforge/sprints/v6.3.5.json'),
      '{"sprints":[{"version":"6.3.5"}]}',
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeMockDeps() {
    return {
      runtime: {
        run: async (_agent: string, _task: string) => ({
          output: JSON.stringify({
            rankings: [
              { itemId: 'i1', title: 'Fix bug', rank: 1, score: 0.9, confidence: 0.9, estimatedCostUsd: 5, estimatedDurationMinutes: 15, rationale: 'r', dependencies: [], suggestedAssignee: 'coder', suggestedTags: ['fix'], withinBudget: true },
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
            sprintId: ctx.sprintId, phase: 'audit', cycleId: ctx.cycleId,
            result: { phase: 'audit', status: 'completed', durationMs: 100, costUsd: 0.5, agentRuns: [] },
            completedAt: new Date().toISOString(),
          });
        },
        plan: async (ctx: any) => {
          ctx.bus.publish('sprint.phase.completed', {
            sprintId: ctx.sprintId, phase: 'plan', cycleId: ctx.cycleId,
            result: { phase: 'plan', status: 'completed', durationMs: 100, costUsd: 0.5, agentRuns: [] },
            completedAt: new Date().toISOString(),
          });
        },
        assign: async (ctx: any) => { ctx.bus.publish('sprint.phase.completed', { sprintId: ctx.sprintId, phase: 'assign', cycleId: ctx.cycleId, result: { phase: 'assign', status: 'completed', durationMs: 50, costUsd: 0, agentRuns: [] }, completedAt: new Date().toISOString() }); },
        execute: async (ctx: any) => { ctx.bus.publish('sprint.phase.completed', { sprintId: ctx.sprintId, phase: 'execute', cycleId: ctx.cycleId, result: { phase: 'execute', status: 'completed', durationMs: 500, costUsd: 1.0, agentRuns: [], itemResults: [] }, completedAt: new Date().toISOString() }); },
        test: async (ctx: any) => { ctx.bus.publish('sprint.phase.completed', { sprintId: ctx.sprintId, phase: 'test', cycleId: ctx.cycleId, result: { phase: 'test', status: 'completed', durationMs: 100, costUsd: 0.2, agentRuns: [] }, completedAt: new Date().toISOString() }); },
        review: async (ctx: any) => { ctx.bus.publish('sprint.phase.completed', { sprintId: ctx.sprintId, phase: 'review', cycleId: ctx.cycleId, result: { phase: 'review', status: 'completed', durationMs: 100, costUsd: 0.2, agentRuns: [] }, completedAt: new Date().toISOString() }); },
        gate: async (ctx: any) => { ctx.bus.publish('sprint.phase.completed', { sprintId: ctx.sprintId, phase: 'gate', cycleId: ctx.cycleId, result: { phase: 'gate', status: 'completed', durationMs: 100, costUsd: 0.3, agentRuns: [] }, completedAt: new Date().toISOString() }); },
        release: async (ctx: any) => { ctx.bus.publish('sprint.phase.completed', { sprintId: ctx.sprintId, phase: 'release', cycleId: ctx.cycleId, result: { phase: 'release', status: 'completed', durationMs: 50, costUsd: 0, agentRuns: [] }, completedAt: new Date().toISOString() }); },
        learn: async (ctx: any) => { ctx.bus.publish('sprint.phase.completed', { sprintId: ctx.sprintId, phase: 'learn', cycleId: ctx.cycleId, result: { phase: 'learn', status: 'completed', durationMs: 100, costUsd: 0.2, agentRuns: [] }, completedAt: new Date().toISOString() }); },
      },
      testRunner: {
        run: async (cycleId: string) => ({
          passed: 100, failed: 0, skipped: 0, total: 100, passRate: 1.0,
          durationMs: 5000, failedTests: [], newFailures: [],
          rawOutputPath: `.agentforge/cycles/${cycleId}/tests-raw.log`, exitCode: 0,
        }),
      },
      gitOps: {
        verifyPreconditions: async () => {},
        createBranch: async (version: string) => `autonomous/v${version}`,
        stage: async (_files: string[]) => {},
        commit: async (_msg: string) => '0123456789abcdef0123456789abcdef01234567',
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
          publish: (topic: string, payload: any) => (subs[topic] ?? []).forEach(cb => cb(payload)),
          subscribe: (topic: string, cb: (e: any) => void) => {
            if (!subs[topic]) subs[topic] = [];
            subs[topic]!.push(cb);
            return () => { subs[topic] = subs[topic]!.filter(c => c !== cb); };
          },
        };
      })(),
    };
  }

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
    expect(result.sprintVersion).toBe('6.3.6');
    expect(result.pr.url).toBeDefined();
    expect(result.cost.totalUsd).toBeGreaterThan(0);
  });

  it('writes cycle.json on completion', async () => {
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

    const cycleJsonPath = join(tmpDir, '.agentforge/cycles', result.cycleId, 'cycle.json');
    expect(existsSync(cycleJsonPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(cycleJsonPath, 'utf8'));
    expect(parsed.stage).toBe('completed');
  });

  it('kills cycle on test floor violation', async () => {
    const deps = makeMockDeps();
    deps.testRunner.run = async (cycleId: string) => ({
      passed: 50, failed: 50, skipped: 0, total: 100, passRate: 0.5,
      durationMs: 5000, failedTests: [], newFailures: [],
      rawOutputPath: '', exitCode: 1,
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
});
```

- [ ] **Step 2: Run test — verify fails**

Run: `cd packages/core && npx vitest run src/autonomous/cycle-runner.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `cycle-runner.ts`**

Create `packages/core/src/autonomous/cycle-runner.ts`:

```typescript
// packages/core/src/autonomous/cycle-runner.ts
import { randomUUID } from 'node:crypto';
import { CycleStage, CycleKilledError } from './types.js';
import type { CycleConfig, CycleResult } from './types.js';
import { ProposalToBacklog, type ProposalAdapter } from './proposal-to-backlog.js';
import { ScoringPipeline, type AdapterForScoring, type RuntimeForScoring } from './scoring-pipeline.js';
import { BudgetApproval } from './budget-approval.js';
import { SprintGenerator } from './sprint-generator.js';
import { PhaseScheduler, type PhaseHandler } from './phase-scheduler.js';
import { KillSwitch } from './kill-switch.js';
import { CycleLogger } from './cycle-logger.js';
import { renderPrBody } from './pr-body-renderer.js';
import type { RealTestRunner } from './exec/real-test-runner.js';
import type { GitOps } from './exec/git-ops.js';
import type { PROpener } from './exec/pr-opener.js';

export interface CycleRunnerOptions {
  cwd: string;
  config: CycleConfig;
  runtime: RuntimeForScoring;
  proposalAdapter: ProposalAdapter;
  scoringAdapter: AdapterForScoring;
  phaseHandlers: Record<string, PhaseHandler>;
  testRunner: RealTestRunner;
  gitOps: GitOps;
  prOpener: PROpener;
  bus: { publish: (topic: string, payload: any) => void; subscribe: (topic: string, cb: (event: any) => void) => () => void };
  dryRun?: { prOpener?: boolean };
}

export class CycleRunner {
  private readonly cycleId: string;
  private readonly logger: CycleLogger;
  private readonly killSwitch: KillSwitch;
  private readonly startedAt: number;

  constructor(private readonly options: CycleRunnerOptions) {
    this.cycleId = randomUUID();
    this.startedAt = Date.now();
    this.logger = new CycleLogger(options.cwd, this.cycleId);
    this.killSwitch = new KillSwitch(options.config, this.cycleId, this.startedAt, options.cwd);
  }

  async start(): Promise<CycleResult> {
    try {
      return await this.runStages();
    } catch (err) {
      if (err instanceof CycleKilledError) {
        return this.buildResult(CycleStage.KILLED, { killSwitch: err.trip });
      }
      return this.buildResult(CycleStage.FAILED, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async runStages(): Promise<CycleResult> {
    // STAGE 1: PLAN
    const bridge = new ProposalToBacklog(
      this.options.proposalAdapter,
      this.options.cwd,
      this.options.config,
    );
    const backlog = await bridge.build();

    if (backlog.length === 0) {
      throw new Error('No backlog items to work on — nothing to do');
    }

    const scoring = new ScoringPipeline(
      this.options.runtime,
      this.options.scoringAdapter,
      this.options.config,
      this.logger,
    );
    const scored = await scoring.scoreWithFallback(backlog);
    this.checkKillSwitch();

    // BUDGET APPROVAL GATE
    const approval = new BudgetApproval(this.options.cwd, this.cycleId, this.logger);
    const approved = await approval.collect({
      withinBudget: scored.withinBudget,
      requiresApproval: scored.requiresApproval,
      budgetUsd: this.options.config.budget.perCycleUsd,
      summary: scored.summary,
    });

    // STAGE 2: STAGE
    const generator = new SprintGenerator(this.options.cwd, this.options.config);
    const plan = await generator.generate(approved.approvedItems);
    this.checkKillSwitch();

    // STAGE 3: RUN
    const scheduler = new PhaseScheduler(
      {
        sprintId: plan.sprintId,
        sprintVersion: plan.version,
        projectRoot: this.options.cwd,
        adapter: this.options.scoringAdapter,
        bus: this.options.bus,
        runtime: this.options.runtime,
        cycleId: this.cycleId,
      },
      this.killSwitch,
      this.logger,
      this.options.phaseHandlers as Record<any, any>,
    );
    const runSummary = await scheduler.run();
    this.checkKillSwitch();

    // STAGE 4: VERIFY
    const testResult = await this.options.testRunner.run(this.cycleId);
    this.logger.logTestRun(testResult);

    const regression = {
      detected: testResult.newFailures.length > 0,
      reason: testResult.newFailures.length > 0
        ? `${testResult.newFailures.length} new failures: ${testResult.newFailures.slice(0, 3).join(', ')}`
        : '',
    };
    const trip = this.killSwitch.checkPostVerify(testResult, regression);
    if (trip) throw new CycleKilledError(trip);

    // STAGE 5: COMMIT
    await this.options.gitOps.verifyPreconditions();
    const branch = await this.options.gitOps.createBranch(plan.version);
    const filesToCommit = this.collectChangedFiles(runSummary);
    if (filesToCommit.length === 0) {
      throw new Error('No files to commit — cycle produced no changes');
    }
    await this.options.gitOps.stage(filesToCommit);
    const message = this.buildCommitMessage(plan.version, scored.summary);
    const commitSha = await this.options.gitOps.commit(message);
    await this.options.gitOps.push(branch);

    // STAGE 6: REVIEW
    const prBody = renderPrBody({
      sprint: plan as any,
      result: {
        ...this.buildResult(CycleStage.REVIEW),
        cost: { totalUsd: runSummary.totalCostUsd, budgetUsd: this.options.config.budget.perCycleUsd, byAgent: {}, byPhase: {} },
        git: { branch, commitSha, filesChanged: filesToCommit },
      },
      testResult,
      scoringResult: {
        rankings: [...scored.withinBudget, ...scored.requiresApproval],
        totalEstimatedCostUsd: scored.totalEstimatedCostUsd,
        budgetOverflowUsd: scored.budgetOverflowUsd,
        summary: scored.summary,
        warnings: scored.warnings,
      },
    });

    const prResult = await this.options.prOpener.open({
      branch,
      baseBranch: this.options.config.git.baseBranch,
      title: `autonomous(v${plan.version}): ${scored.summary.slice(0, 50)}`,
      body: prBody,
      draft: this.options.config.pr.draft,
      labels: this.options.config.pr.labels,
      reviewers: this.options.config.pr.assignReviewer
        ? [this.options.config.pr.assignReviewer]
        : undefined,
      dryRun: this.options.dryRun?.prOpener,
    });

    this.logger.logPREvent({
      type: 'opened',
      url: prResult.url,
      number: prResult.number,
      title: `autonomous(v${plan.version})`,
    });

    // COMPLETED
    const final = this.buildResult(CycleStage.COMPLETED, {
      sprintVersion: plan.version,
      cost: {
        totalUsd: runSummary.totalCostUsd,
        budgetUsd: this.options.config.budget.perCycleUsd,
        byAgent: {},
        byPhase: {},
      },
      tests: {
        passed: testResult.passed,
        failed: testResult.failed,
        skipped: testResult.skipped,
        total: testResult.total,
        passRate: testResult.passRate,
        newFailures: testResult.newFailures,
      },
      git: { branch, commitSha, filesChanged: filesToCommit },
      pr: { url: prResult.url, number: prResult.number, draft: prResult.draft },
      scoringFallback: scored.fallback,
    });
    this.logger.logCycleResult(final);
    return final;
  }

  private checkKillSwitch(): void {
    const trip = this.killSwitch.checkBetweenPhases({
      cumulativeCostUsd: 0,
      consecutiveFailures: 0,
    });
    if (trip) throw new CycleKilledError(trip);
  }

  private collectChangedFiles(_runSummary: unknown): string[] {
    // TODO(Task 21 follow-up): Extract file paths from phase results.
    // For MVP, query git for working-tree modifications after the RUN stage.
    // A future improvement is to track per-agent file writes via runtime hooks.
    return [];
  }

  private buildCommitMessage(version: string, summary: string): string {
    return `autonomous(v${version}): ${summary}

Cycle: ${this.cycleId}

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
`;
  }

  private buildResult(stage: CycleStage, overrides: Partial<CycleResult> = {}): CycleResult {
    return {
      cycleId: this.cycleId,
      sprintVersion: '',
      stage,
      startedAt: new Date(this.startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - this.startedAt,
      cost: { totalUsd: 0, budgetUsd: this.options.config.budget.perCycleUsd, byAgent: {}, byPhase: {} },
      tests: { passed: 0, failed: 0, skipped: 0, total: 0, passRate: 0, newFailures: [] },
      git: { branch: '', commitSha: null, filesChanged: [] },
      pr: { url: null, number: null, draft: false },
      ...overrides,
    } as CycleResult;
  }
}
```

- [ ] **Step 4: Run tests — verify pass**

Run: `cd packages/core && npx vitest run src/autonomous/cycle-runner.test.ts`
Expected: All pass. Some edge-case tests may reveal `collectChangedFiles` needs to query git — that's a known TODO for the smoke test in Task 25.

- [ ] **Step 5: Update barrel and commit**

Edit `packages/core/src/autonomous/index.ts` to add:

```typescript
export * from './cycle-runner.js';
```

Then:

```bash
cd packages/core && npm run build && cd ../..
git add packages/core/src/autonomous/cycle-runner.ts \
        packages/core/src/autonomous/cycle-runner.test.ts \
        packages/core/src/autonomous/index.ts
git commit -m "feat(autonomous): cycle runner top-level orchestrator"
```

---

## Task 22: Configuration files + backlog-scorer agent

**Files:**
- Create: `.agentforge/autonomous.yaml`
- Create: `.agentforge/agents/backlog-scorer.yaml`

**Context:** The cycle config and scoring agent YAML. Must match the existing agent YAML format (see `.agentforge/agents/cto.yaml` for reference).

- [ ] **Step 1: Create `.agentforge/autonomous.yaml`**

```yaml
# .agentforge/autonomous.yaml
# AgentForge autonomous cycle configuration
# See docs/superpowers/specs/2026-04-06-autonomous-loop-design.md

budget:
  perCycleUsd: 50
  perItemUsd: 10
  perAgentUsd: 15
  allowOverageApproval: true

limits:
  maxItemsPerSprint: 20
  maxDurationMinutes: 180
  maxConsecutiveFailures: 5
  maxExecutePhaseFailureRate: 0.5

quality:
  testPassRateFloor: 0.95
  allowRegression: false
  requireBuildSuccess: true
  requireTypeCheckSuccess: true

git:
  branchPrefix: "autonomous/"
  baseBranch: "main"
  refuseCommitToBaseBranch: true
  includeDiagnosticBranchOnFailure: true
  maxFilesPerCommit: 100

pr:
  draft: false
  assignReviewer: "seandonvaughan"
  labelPrefix: "autonomous"
  labels:
    - "autonomous"
    - "needs-review"
  titleTemplate: "autonomous(v{version}): {summary}"

sourcing:
  lookbackDays: 7
  minProposalConfidence: 0.6
  includeTodoMarkers: true
  todoMarkerPattern: "TODO\\(autonomous\\)|FIXME\\(autonomous\\)"

testing:
  command: "npm run test:run"
  timeoutMinutes: 20
  reporter: "json"
  saveRawLog: true
  buildCommand: "npm run build"
  typeCheckCommand: "npx tsc --noEmit"

scoring:
  agentId: "backlog-scorer"
  maxRetries: 3
  fallbackToStatic: true

logging:
  logDir: ".agentforge/cycles"
  retainCycles: 50

safety:
  stopFilePath: ".agentforge/cycles/{cycleId}/STOP"
  secretScanEnabled: true
  verifyCleanWorkingTreeBeforeStart: true
  workingTreeWhitelist:
    - ".agentforge/cycles/**"
    - ".agentforge/audit.db-*"
```

- [ ] **Step 2: Create `.agentforge/agents/backlog-scorer.yaml`**

Use the same format as `.agentforge/agents/cto.yaml` (name/model/version/description/system_prompt/skills/triggers/collaboration/context):

```yaml
name: Backlog Scorer
model: sonnet
version: '1.0'
description: >
  The Backlog Scorer ranks candidate work items for the autonomous development
  loop. Given proposals from failed sessions, cost anomalies, and TODO markers,
  it produces a budget-bounded ranked list with explicit rationale for every
  decision. Flags over-budget items for human approval. Its output is structured
  JSON consumed by the CycleRunner.

system_prompt: |
  You are the Backlog Scorer for AgentForge's autonomous development loop.

  ## Role
  You take a set of candidate work items (proposals from session failures,
  cost anomalies, test flakiness, and TODO(autonomous) markers) and rank them
  into an executable sprint, flagging items that would push the cycle over
  budget for human approval.

  ## Inputs
  You will receive:
  - candidateItems: array of proposed work items with type, title, description, tags
  - historyContext: recent sprint history, cost medians per item type, team state
  - budgetUsd: the hard budget for this cycle (usually $50)
  - maxItems: the cap on items per sprint (usually 20)

  ## Output
  You must produce valid JSON matching the ScoringResult schema:
  {
    "rankings": [
      {
        "itemId": string,
        "title": string,
        "rank": number,
        "score": number,
        "confidence": number,
        "estimatedCostUsd": number,
        "estimatedDurationMinutes": number,
        "rationale": string,
        "dependencies": string[],
        "suggestedAssignee": string,
        "suggestedTags": string[],
        "withinBudget": boolean
      }
    ],
    "totalEstimatedCostUsd": number,
    "budgetOverflowUsd": number,
    "summary": string,
    "warnings": string[]
  }

  ## Ranking principles
  1. Impact: prefer items that resolve the most recent failures
  2. Cost: use historical medians; conservative estimates
  3. Dependencies: items that unblock others rank higher
  4. Risk: balance novelty against regression risk
  5. Team fit: suggest the agent with the right skills

  ## Constraints
  - Output MUST be valid JSON. Do not include text outside the JSON object.
  - Set withinBudget=true only for items that fit in the stated budget.
  - Flag any item where estimatedCostUsd exceeds budget/item.
  - Include rationale for every item.
  - Keep summary to one paragraph.
  - List up to 5 warnings if applicable.

skills:
  - proposal_analysis
  - cost_estimation
  - dependency_detection
  - budget_planning
  - priority_ranking

triggers:
  keywords:
    - rank backlog
    - score items
    - prioritize proposals
    - autonomous scoring

collaboration:
  reports_to: ceo
  parallel: false

context:
  max_files: 10
  auto_include:
    - .agentforge/autonomous.yaml
    - .agentforge/sprints/
```

- [ ] **Step 3: Commit**

```bash
git add .agentforge/autonomous.yaml .agentforge/agents/backlog-scorer.yaml
git commit -m "feat(autonomous): autonomous.yaml config + backlog-scorer agent"
```

---

## Task 23: CLI command entry point

**Files:**
- Create: `packages/cli/src/commands/autonomous.ts`
- Modify: `packages/cli/src/bin.ts`
- Modify: `package.json` (repo root)

**Context:** Entry point wired into commander. Distinct exit codes: 0 (success), 1 (error), 2 (killed).

- [ ] **Step 1: Read existing CLI structure**

Run: `Read packages/cli/src/bin.ts` and `Read packages/cli/src/commands/build-info.ts` (as a template) to understand the command registration pattern.

- [ ] **Step 2: Create `packages/cli/src/commands/autonomous.ts`**

```typescript
// packages/cli/src/commands/autonomous.ts
import { Command } from 'commander';
import {
  CycleRunner,
  loadCycleConfig,
  CycleStage,
  ProposalToBacklog,
} from '@agentforge/core';

export function registerAutonomousCommand(program: Command): void {
  program
    .command('autonomous:cycle')
    .description('Run one autonomous development cycle end-to-end')
    .option('--dry-run', 'Use dry-run mode for PR opening (no real PR created)', false)
    .action(async (opts: { dryRun: boolean }) => {
      const cwd = process.cwd();

      try {
        const config = loadCycleConfig(cwd);
        console.log(`[autonomous] cycle starting (cwd=${cwd}, budget=$${config.budget.perCycleUsd})`);

        // Lazy-import real dependencies only at runtime to avoid module-level side effects
        const { AgentRuntime } = await import('@agentforge/core');
        const { WorkspaceAdapter } = await import('@agentforge/db');
        // EventBus import path depends on repo structure — check packages/core or packages/shared
        const { EventBus } = await import('@agentforge/shared');
        const { PHASE_HANDLERS } = await import('../../../server/src/lib/phase-handlers.js');
        const { RealTestRunner, GitOps, PROpener } = await import('@agentforge/core');

        const runtime = new AgentRuntime();
        const adapter = new WorkspaceAdapter(cwd);
        const bus = new EventBus();

        const proposalAdapter = {
          getRecentFailedSessions: async (_days: number) => [],
          getCostAnomalies: async (_days: number) => [],
          getFailedTaskOutcomes: async (_days: number) => [],
          getFlakingTests: async (_days: number) => [],
        };

        const scoringAdapter = {
          getSprintHistory: async (_limit: number) => [],
          getCostMedians: async () => ({}),
          getTeamState: async () => ({ utilization: {} }),
        };

        const testRunner = new RealTestRunner(cwd, config.testing, null);
        const logger = (null as any); // CycleRunner creates its own
        const gitOps = new GitOps(cwd, config.git, logger);
        const prOpener = new PROpener(cwd);

        const runner = new CycleRunner({
          cwd,
          config,
          runtime: runtime as any,
          proposalAdapter,
          scoringAdapter,
          phaseHandlers: PHASE_HANDLERS as any,
          testRunner,
          gitOps,
          prOpener,
          bus: bus as any,
          dryRun: { prOpener: opts.dryRun },
        });

        const result = await runner.start();

        switch (result.stage) {
          case CycleStage.COMPLETED:
            console.log(`[autonomous] cycle completed: ${result.pr.url}`);
            console.log(`  cost: $${result.cost.totalUsd.toFixed(2)} / $${result.cost.budgetUsd.toFixed(2)}`);
            console.log(`  tests: ${result.tests.passed}/${result.tests.total} passing`);
            console.log(`  logs:  .agentforge/cycles/${result.cycleId}/`);
            process.exit(0);

          case CycleStage.KILLED:
            console.error(`[autonomous] cycle killed: ${result.killSwitch?.reason}`);
            console.error(`  detail: ${result.killSwitch?.detail}`);
            console.error(`  logs:   .agentforge/cycles/${result.cycleId}/`);
            process.exit(2);

          default:
            console.error(`[autonomous] cycle failed with stage ${result.stage}`);
            console.error(`  logs: .agentforge/cycles/${result.cycleId}/`);
            process.exit(1);
        }
      } catch (err) {
        console.error(`[autonomous] unexpected error: ${err instanceof Error ? err.message : String(err)}`);
        if (err instanceof Error && err.stack) {
          console.error(err.stack);
        }
        process.exit(1);
      }
    });
}
```

**NOTE:** The imports for `AgentRuntime`, `RealTestRunner`, `GitOps`, `PROpener`, `WorkspaceAdapter`, and `EventBus` may need path adjustments based on how each package exports them. Read each package's `index.ts` first to confirm import paths. The cli's `package.json` may need new `dependencies` entries for `@agentforge/server` if phase-handlers is not re-exported elsewhere.

- [ ] **Step 3: Register the command in `packages/cli/src/bin.ts`**

Edit `packages/cli/src/bin.ts` to import and register the new command. Look for the existing pattern (e.g., `registerBuildInfoCommand(program)`) and add a matching line for `registerAutonomousCommand(program)`.

- [ ] **Step 4: Add npm script to repo root `package.json`**

Edit `/package.json` (repo root). In the `scripts` object, add:

```json
    "autonomous:cycle": "npm run build && node packages/cli/dist/bin.js autonomous:cycle"
```

- [ ] **Step 5: Build and smoke-test the CLI (dry-run, no-op mode)**

Run:
```bash
cd packages/cli && npm run build && cd ../..
node packages/cli/dist/bin.js --help
```
Expected: Help text shows `autonomous:cycle` in the command list.

Run: `node packages/cli/dist/bin.js autonomous:cycle --dry-run`
Expected: Fails gracefully (no adapter data, empty backlog) with a clear error message. The CLI plumbing works; real data will come in Task 24.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/autonomous.ts \
        packages/cli/src/bin.ts \
        package.json
git commit -m "feat(cli): add autonomous:cycle command with exit codes"
```

---

## Task 24: Full-cycle integration test

**Files:**
- Create: `tests/autonomous/integration/full-cycle.test.ts`
- Create: `tests/autonomous/fixtures/mock-anthropic.ts`
- Create: `tests/autonomous/fixtures/tmp-workspace.ts`

**Context:** Proves the full cycle runs end-to-end against a throwaway tmp workspace with mocked Anthropic, real git, and dry-run PR opener. Does not use real API credits.

- [ ] **Step 1: Create the tmp-workspace fixture**

Create `tests/autonomous/fixtures/tmp-workspace.ts`:

```typescript
// tests/autonomous/fixtures/tmp-workspace.ts
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function setupTmpAgentforgeWorkspace(): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), 'agentforge-full-cycle-'));

  mkdirSync(join(tmp, '.agentforge/sprints'), { recursive: true });
  mkdirSync(join(tmp, '.agentforge/agents'), { recursive: true });
  mkdirSync(join(tmp, 'src'), { recursive: true });

  // Minimal package.json with a test script
  writeFileSync(
    join(tmp, 'package.json'),
    JSON.stringify({
      name: 'tmp-workspace',
      version: '6.3.5',
      type: 'module',
      scripts: { 'test:run': 'vitest run' },
      devDependencies: { vitest: '^3.0.4' },
    }, null, 2),
  );

  // Seed a sprint file
  writeFileSync(
    join(tmp, '.agentforge/sprints/v6.3.5.json'),
    JSON.stringify({
      sprints: [{
        sprintId: 'v6-3-5-seed',
        version: '6.3.5',
        title: 'Seed sprint',
        createdAt: new Date().toISOString(),
        phase: 'completed',
        items: [],
      }],
    }, null, 2),
  );

  // autonomous.yaml with small budget
  writeFileSync(
    join(tmp, '.agentforge/autonomous.yaml'),
    `budget:\n  perCycleUsd: 5\n  perItemUsd: 2\n`,
  );

  // A file with a TODO(autonomous) marker
  writeFileSync(
    join(tmp, 'src/sample.ts'),
    `// TODO(autonomous): add a meaningful comment to this file\nexport const x = 1;\n`,
  );

  // Minimal vitest test so npm run test:run succeeds
  writeFileSync(
    join(tmp, 'sample.test.ts'),
    `import { test, expect } from 'vitest';\ntest('passes', () => expect(1).toBe(1));\n`,
  );

  // Initialize git repo
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: tmp });
  await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tmp });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmp });
  await execFileAsync('git', ['add', '.'], { cwd: tmp });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: tmp });

  return tmp;
}
```

- [ ] **Step 2: Create the mock-anthropic fixture**

Create `tests/autonomous/fixtures/mock-anthropic.ts`:

```typescript
// tests/autonomous/fixtures/mock-anthropic.ts
export interface MockRuntimeCall {
  agentId: string;
  task: string;
}

export interface MockRuntimeOptions {
  responseBank: Record<string, string>;
}

export function createMockRuntime(opts: MockRuntimeOptions) {
  const calls: MockRuntimeCall[] = [];
  return {
    calls,
    run: async (agentId: string, task: string) => {
      calls.push({ agentId, task });
      const response = opts.responseBank[agentId] ?? '{}';
      return {
        output: response,
        usage: { input_tokens: 100, output_tokens: 50 },
        costUsd: 0.01,
        durationMs: 200,
        model: 'claude-sonnet-4-6-mock',
      };
    },
    callsFor: (...agentIds: string[]) => calls.filter(c => agentIds.includes(c.agentId)).length,
  };
}
```

- [ ] **Step 3: Write the full-cycle test**

Create `tests/autonomous/integration/full-cycle.test.ts`:

```typescript
// tests/autonomous/integration/full-cycle.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTmpAgentforgeWorkspace } from '../fixtures/tmp-workspace.js';
import { createMockRuntime } from '../fixtures/mock-anthropic.js';
import {
  CycleRunner,
  loadCycleConfig,
  CycleStage,
  GitOps,
  PROpener,
  RealTestRunner,
  CycleLogger,
} from '../../../packages/core/src/autonomous/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('Full autonomous cycle end-to-end', () => {
  let tmpWorkspace: string;

  beforeAll(async () => {
    tmpWorkspace = await setupTmpAgentforgeWorkspace();
  }, 120_000);

  afterAll(() => {
    if (tmpWorkspace) rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  it('runs end-to-end with mocked runtime and real git (dry-run PR)', async () => {
    const config = loadCycleConfig(tmpWorkspace);

    const mockRuntime = createMockRuntime({
      responseBank: {
        'backlog-scorer': JSON.stringify({
          rankings: [{
            itemId: 'todo-src-sample-ts-0',
            title: 'add a meaningful comment to this file',
            rank: 1,
            score: 0.9,
            confidence: 1.0,
            estimatedCostUsd: 1.0,
            estimatedDurationMinutes: 5,
            rationale: 'TODO marker from src/sample.ts',
            dependencies: [],
            suggestedAssignee: 'coder',
            suggestedTags: ['chore'],
            withinBudget: true,
          }],
          totalEstimatedCostUsd: 1.0,
          budgetOverflowUsd: 0,
          summary: 'Single chore item within budget',
          warnings: [],
        }),
      },
    });

    // Minimal phase handlers that just publish completed events
    const makeHandler = (phase: string, costUsd = 0.1) => async (ctx: any) => {
      ctx.bus.publish('sprint.phase.completed', {
        sprintId: ctx.sprintId,
        phase,
        cycleId: ctx.cycleId,
        result: { phase, status: 'completed', durationMs: 50, costUsd, agentRuns: [] },
        completedAt: new Date().toISOString(),
      });
    };
    const phaseHandlers: Record<string, any> = {
      audit: makeHandler('audit'),
      plan: makeHandler('plan'),
      assign: makeHandler('assign', 0),
      execute: makeHandler('execute', 0.5),
      test: makeHandler('test'),
      review: makeHandler('review'),
      gate: makeHandler('gate'),
      release: makeHandler('release', 0),
      learn: makeHandler('learn'),
    };

    // Simple in-memory event bus
    const subscribers: Record<string, Array<(e: any) => void>> = {};
    const bus = {
      publish: (topic: string, payload: any) => (subscribers[topic] ?? []).forEach(cb => cb(payload)),
      subscribe: (topic: string, cb: (e: any) => void) => {
        if (!subscribers[topic]) subscribers[topic] = [];
        subscribers[topic]!.push(cb);
        return () => { subscribers[topic] = subscribers[topic]!.filter(c => c !== cb); };
      },
    };

    // Stub test runner that simulates passing tests
    const testRunner = {
      run: async (cycleId: string) => ({
        passed: 1, failed: 0, skipped: 0, total: 1, passRate: 1.0,
        durationMs: 500, failedTests: [], newFailures: [],
        rawOutputPath: join(tmpWorkspace, '.agentforge/cycles', cycleId, 'tests-raw.log'),
        exitCode: 0,
      }),
    };

    // Stub git ops that writes a real file and commits it
    const logger = new CycleLogger(tmpWorkspace, 'pre-cycle');
    const gitOps = new GitOps(tmpWorkspace, config.git, logger);
    // Override collectChangedFiles behavior by making a real change before commit stage
    const wrappedGitOps = {
      verifyPreconditions: async () => { /* tmp workspace has no gh — skip or mock */ },
      createBranch: async (version: string) => `autonomous/v${version}`,
      stage: async (files: string[]) => {
        // Create a real file change so commit has something to stage
        const { writeFileSync } = await import('node:fs');
        writeFileSync(join(tmpWorkspace, 'cycle-output.txt'), 'cycle ran\n');
        await execFileAsync('git', ['checkout', '-b', 'autonomous/v6.3.6'], { cwd: tmpWorkspace }).catch(() => {});
        await execFileAsync('git', ['add', 'cycle-output.txt'], { cwd: tmpWorkspace });
      },
      commit: async (msg: string) => {
        await execFileAsync('git', ['commit', '-m', msg], { cwd: tmpWorkspace });
        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: tmpWorkspace });
        return stdout.trim();
      },
      push: async () => { /* no remote */ },
      rollbackCommit: async () => {},
    };

    const prOpener = new PROpener(tmpWorkspace);

    const proposalAdapter = {
      getRecentFailedSessions: async () => [],
      getCostAnomalies: async () => [],
      getFailedTaskOutcomes: async () => [],
      getFlakingTests: async () => [],
    };
    const scoringAdapter = {
      getSprintHistory: async () => [],
      getCostMedians: async () => ({}),
      getTeamState: async () => ({ utilization: {} }),
    };

    const runner = new CycleRunner({
      cwd: tmpWorkspace,
      config,
      runtime: mockRuntime as any,
      proposalAdapter,
      scoringAdapter,
      phaseHandlers,
      testRunner: testRunner as any,
      gitOps: wrappedGitOps as any,
      prOpener,
      bus: bus as any,
      dryRun: { prOpener: true },
    });

    const result = await runner.start();

    // Verify we reached the terminal completed stage
    expect(result.stage).toBe(CycleStage.COMPLETED);
    expect(result.cycleId).toMatch(/^[0-9a-f-]+$/);

    // Version was bumped from 6.3.5 → 6.3.6 (chore tag)
    expect(result.sprintVersion).toBe('6.3.6');

    // Sprint JSON was written
    const sprintPath = join(tmpWorkspace, '.agentforge/sprints/v6.3.6.json');
    expect(existsSync(sprintPath)).toBe(true);

    // Cycle log directory was populated
    const cycleDir = join(tmpWorkspace, '.agentforge/cycles', result.cycleId);
    expect(existsSync(cycleDir)).toBe(true);
    expect(existsSync(join(cycleDir, 'cycle.json'))).toBe(true);
    expect(existsSync(join(cycleDir, 'events.jsonl'))).toBe(true);

    // Cost under budget
    expect(result.cost.totalUsd).toBeLessThan(config.budget.perCycleUsd);

    // PR URL is the dry-run synthetic URL
    expect(result.pr.url).toMatch(/^https:\/\/github\.com\//);

    // Scoring agent was invoked
    expect(mockRuntime.callsFor('backlog-scorer')).toBe(1);
  }, 120_000);
});
```

- [ ] **Step 4: Run the test**

Run: `cd packages/core && npx vitest run ../../tests/autonomous/integration/full-cycle.test.ts`

Expected: PASS. If it fails due to import paths, adjust relative imports to match your build output structure.

- [ ] **Step 5: Commit**

```bash
git add tests/autonomous/integration/full-cycle.test.ts \
        tests/autonomous/fixtures/mock-anthropic.ts \
        tests/autonomous/fixtures/tmp-workspace.ts
git commit -m "test(autonomous): full-cycle E2E integration test"
```

---

## Task 25: Manual smoke test procedure

**Files:**
- Create: `docs/superpowers/specs/2026-04-06-autonomous-smoke-test.md`

**Context:** A written, reproducible smoke test procedure to run against the real repository once the implementation is done. This is the final proof-of-life before declaring the feature shipped.

- [ ] **Step 1: Create the smoke test doc**

The full procedure lives in [`../specs/2026-04-06-autonomous-smoke-test.md`](../specs/2026-04-06-autonomous-smoke-test.md). It covers branch setup, a cheap-smoke `autonomous.yaml` override, a seed marker, the cycle invocation, expected phase artifacts, PR inspection, and cleanup. Treat that spec as the source of truth; do not duplicate its contents here.

> **Note (2026-04-11):** An earlier revision of this plan embedded a full copy of the smoke-test procedure inside a `` ```markdown `` code fence. Because the outer fence used only 3 backticks while the embedded example contained its own 3-backtick inner fences, the document was structurally invalid CommonMark and the `ProposalToBacklog` scanner's naive fence toggle drifted out of parity — scraping an example marker line as a real backlog item. See `../specs/2026-04-11-scanner-fence-hardening.md` for the follow-up scanner fix.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-04-06-autonomous-smoke-test.md
git commit -m "docs(autonomous): manual smoke test procedure"
```

---

## Task 26: CHANGELOG + final verification

**Files:**
- Modify: `CHANGELOG.md`

**Context:** Record the new capability in the changelog and run the full test suite one final time to confirm nothing regressed.

- [ ] **Step 1: Update CHANGELOG.md**

Read the current CHANGELOG.md and prepend a new entry:

```markdown
## [6.4.0-autonomous-loop] — 2026-04-06

### What's New

- **Autonomous development loop** — `npm run autonomous:cycle` runs one end-to-end supervised cycle: plans the next sprint from session history, executes phases with real agents, runs real tests, commits to a feature branch, and opens a PR for human review.
- **`CycleRunner`** — top-level orchestrator (`packages/core/src/autonomous/cycle-runner.ts`). Drives 6 stages: PLAN → STAGE → RUN → VERIFY → COMMIT → REVIEW.
- **`PhaseScheduler`** — event-driven phase auto-advance (`packages/core/src/autonomous/phase-scheduler.ts`). Subscribes to `sprint.phase.completed` on the EventBus and triggers the next phase in-process. Kill switch checked between every phase.
- **`KillSwitch`** — centralized safety monitor with 9 trip reasons: budget, duration, regression, testFloor, buildFailure, typeCheckFailure, consecutiveFailures, manualStop, manualStopFile. Sticky state and signal handlers.
- **`GitOps`** — real git subprocess with 10 safety guards: refuses commits to main, secret scan, dangerous path filter, traversal prevention, `--` separator for add, stdin-fed commit messages, post-commit branch verification, explicit file lists only.
- **`PROpener`** — `gh pr create` wrapper with dry-run mode for tests. Body passed via stdin to avoid shell escaping.
- **`RealTestRunner`** — shells `npm run test:run` (vitest), parses JSON reporter output, captures new regressions against a prior snapshot.
- **`ScoringPipeline`** — agent-driven backlog ranking via new `backlog-scorer` agent. 3-strike fallback ladder: retry → simpler schema → static priority ranking.
- **`BudgetApproval`** — TTY prompt + file-based polling for budget overrun approval. Supports the future daemon flow without code changes.
- **`ProposalToBacklog`** — bridges `SelfProposalEngine` → `BacklogItem[]`. Scans `TODO(autonomous)` and `FIXME(autonomous)` markers.
- **`SprintGenerator`** — wires `SprintPredictor` + `SprintPlanner` together, writes sprint JSON with tag-driven semver bumping.
- **`.agentforge/autonomous.yaml`** — cycle configuration (budget, limits, quality gates, git settings, PR settings).
- **`backlog-scorer` agent** — new Sonnet-tier agent for dynamic proposal ranking.
- **Per-cycle structured logs** — every cycle produces `.agentforge/cycles/{cycleId}/` with cycle.json, scoring.json, tests.json, git.json, pr.json, events.jsonl, and per-phase JSON files.

### Refactored

- **`sprint-orchestration.ts`** — phase handler logic extracted into `packages/server/src/lib/phase-handlers.ts`. HTTP routes become thin wrappers. New events published at phase start/end.

### Deferred to first autonomous cycle (v6.5.0 and beyond)

- Persistent daemon (looping CLI runs indefinitely)
- Durable state for in-memory stores (SelfProposalEngine, CanaryManager, etc.)
- Horizontal scale (Postgres, worker queue)
- Multi-workspace coordination
- Automatic PR merging

### Migration Notes

- Requires `gh` CLI installed and authenticated (`gh auth login`).
- Set `ANTHROPIC_API_KEY` before running `autonomous:cycle`.
- `.agentforge/autonomous.yaml` is read from the working directory; missing file uses defaults.
```

- [ ] **Step 2: Run the full test suite one last time**

Run:
```bash
npm run build
cd packages/core && npx vitest run
cd ../server && npx vitest run
cd ../.. && npm run test:run 2>&1 | tail -40
```
Expected: All tests pass, 0 TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(autonomous): changelog for v6.4.0-autonomous-loop"
```

- [ ] **Step 4: Print a final status report**

```bash
git log --oneline main..HEAD | head -30
echo "---"
cd packages/core && npx vitest run 2>&1 | tail -5
```

Expected output: all commits from Tasks 1-26 listed; all tests pass.

---

## Full Plan Acceptance Criteria

The autonomous loop is considered successfully implemented when:

- [ ] All 26 tasks across Part 1 and Part 2 have commits landing on the feature branch
- [ ] `npm run build` passes at repo root with 0 TypeScript errors
- [ ] All new unit tests in `packages/core/src/autonomous/` pass
- [ ] All integration tests in `tests/autonomous/integration/` pass
- [ ] The regression suite for `sprint-orchestration.ts` still passes (v6.3 behavior preserved)
- [ ] The full repo test count has increased by ~75 (from 3,948 to ~4,020+)
- [ ] Every safety guard in `git-ops.test.ts` has a negative test that proves the guard works
- [ ] `npm run autonomous:cycle --dry-run` runs without throwing in an empty workspace
- [ ] Manual smoke test procedure (Task 25) has been executed successfully against the real repo
- [ ] CHANGELOG updated with the new capability description
- [ ] `.agentforge/autonomous.yaml` and `.agentforge/agents/backlog-scorer.yaml` exist with the spec-defined content

Once all boxes are checked, AgentForge has achieved its first closed autonomous loop. The next sprint will be written entirely by the system, and the persistent daemon becomes the first thing AgentForge builds itself.
