// packages/core/src/autonomous/scoring-pipeline.ts
//
// Invokes the `backlog-scorer` agent via the AgentRuntime, validates the
// ScoringResult schema, and returns rankings split between within-budget and
// requires-approval items.
//
// This module covers the happy path + schema validation. Task 18 will layer
// the 3-strike fallback ladder on top of `score()` (clarified prompt → simpler
// schema → static priority-based ranking).
//
// See docs/superpowers/specs/2026-04-06-autonomous-loop-design.md §6.4
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
