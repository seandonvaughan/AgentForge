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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CycleConfig, ScoringResult, RankedItem } from './types.js';
import type { BacklogItem } from './proposal-to-backlog.js';
import type { CycleLogger } from './cycle-logger.js';
import { EffortEstimator } from '../predictive-planning/effort-estimator.js';
import { HistoryAnalyzer } from '../predictive-planning/history-analyzer.js';
import type { HistoryAnalysis } from '../predictive-planning/history-analyzer.js';
import type { SprintHistoryRecord, PriorityTier } from '../predictive-planning/types.js';

export interface AdapterForScoring {
  getSprintHistory(limit: number): Promise<unknown[]>;
  getCostMedians(): Promise<Record<string, number>>;
  /**
   * Returns the p50 (median) actual cost per sprint-item tag, derived from the
   * last 20 cycles. Used by staticFallback() to replace the flat $1.50 default
   * with tag-specific estimates (fix ~$1.10, feature ~$1.65, etc.).
   */
  getP50CostByTag(): Promise<Record<string, number>>;
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
  fallback?: 'static' | 'effort-estimator';
}

export class ScoringPipelineError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ScoringPipelineError';
  }
}

/** Hardcoded fallback agent list used when team.yaml cannot be read. */
const FALLBACK_AGENT_IDS = [
  'coder', 'architect', 'frontend-dev', 'dashboard-architect', 'ui-engineer',
  'api-specialist', 'api-gateway-engineer', 'db-specialist', 'dba',
  'devops-engineer', 'debugger', 'backend-qa', 'test-runner', 'code-reviewer',
  'code-explorer', 'documentation-writer', 'researcher', 'ml-engineer',
  'security-auditor', 'performance-engineer', 'observability-engineer',
  'build-release-lead', 'linter',
];

export class ScoringPipeline {
  /** Cached agent roster derived from .agentforge/team.yaml on first access. */
  private _agentRosterCache: string[] | null = null;

  constructor(
    private readonly runtime: RuntimeForScoring,
    private readonly adapter: AdapterForScoring,
    private readonly config: CycleConfig,
    private readonly logger: CycleLogger,
    /**
     * Project root for reading team.yaml. When omitted, falls back to the
     * hardcoded 23-agent list. Pass `cwd` from the CycleRunner so the scorer
     * sees every agent in the registry (44+ agents currently — vs. the
     * legacy hardcoded 23 that excluded qa-manager, project-manager,
     * business-analyst, team-reviewer, performance-engineer, etc.).
     */
    private readonly cwd?: string,
  ) {}

  /**
   * Read agent IDs from .agentforge/team.yaml. Falls back to a hardcoded
   * list when team.yaml is missing or unparseable. Cached per-instance.
   */
  private getAgentRoster(): string[] {
    if (this._agentRosterCache) return this._agentRosterCache;
    if (!this.cwd) {
      this._agentRosterCache = FALLBACK_AGENT_IDS;
      return this._agentRosterCache;
    }
    try {
      const teamPath = join(this.cwd, '.agentforge', 'team.yaml');
      if (!existsSync(teamPath)) {
        this._agentRosterCache = FALLBACK_AGENT_IDS;
        return this._agentRosterCache;
      }
      // Minimal YAML walk — we only need the leaf agent names under `agents:`.
      // Avoids pulling in a YAML dep when one isn't already imported here.
      const raw = readFileSync(teamPath, 'utf8');
      const ids: string[] = [];
      let inAgents = false;
      for (const line of raw.split('\n')) {
        if (/^agents:\s*$/.test(line)) { inAgents = true; continue; }
        if (inAgents && /^\S/.test(line) && !line.startsWith('agents:')) {
          // Hit a new top-level key — done with agents block
          break;
        }
        if (inAgents) {
          const m = line.match(/^\s*-\s+([a-zA-Z0-9_-]+)\s*$/);
          if (m && m[1]) ids.push(m[1]);
        }
      }
      this._agentRosterCache = ids.length > 0 ? Array.from(new Set(ids)) : FALLBACK_AGENT_IDS;
      return this._agentRosterCache;
    } catch {
      this._agentRosterCache = FALLBACK_AGENT_IDS;
      return this._agentRosterCache;
    }
  }

  async score(backlog: BacklogItem[]): Promise<ScoringPipelineResult> {
    const grounding = await this.gatherGrounding();
    const task = this.buildScoringPrompt(backlog, grounding);

    let scoringResult: ScoringResult;
    try {
      const runResult = await this.runtime.run(this.config.scoring.agentId, task, {
        responseFormat: 'json',
      });
      scoringResult = this.sanitizeAssignees(this.parseAndValidate(runResult.output));
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
   * Strike 1..N: retry LLM scorer up to maxRetries times
   * Strike N+1:  effort-estimator fallback (complexity + history-calibrated costs)
   * Strike N+2:  static priority ranking (flat perItemUsd / p50 by tag, last resort)
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

    // Effort-estimator fallback: uses historical avgCostUsd + complexity scores
    // to produce per-item estimates; better than the flat-cost static fallback.
    this.logger.logScoringFallback(strikes + 1, 'LLM scoring failed — falling back to effort-estimator');
    try {
      return await this.effortEstimatorFallback(backlog);
    } catch (effortErr) {
      const msg = effortErr instanceof Error ? effortErr.message : String(effortErr);
      this.logger.logScoringFallback(
        strikes + 2,
        `Effort-estimator failed (${msg}); falling back to static priority ranking`,
      );
    }

    return await this.staticFallback(backlog);
  }

  /**
   * Effort-estimator fallback: produces per-item cost and confidence estimates
   * using the EffortEstimator seeded with historical sprint data. Falls back to
   * zero-data analysis (confidence 0.3, cost = complexityScore * 0.5) when
   * history is unavailable. Always resolves; never throws.
   */
  private async effortEstimatorFallback(backlog: BacklogItem[]): Promise<ScoringPipelineResult> {
    const estimator = new EffortEstimator();
    const analyzer = new HistoryAnalyzer();

    // Build HistoryAnalysis from adapter sprint history. The history entries
    // carry avgItemCostUsd and completedCount but lack per-priority breakdowns,
    // so avgCostPerPriorityTier stays zero. avgCostUsd and totalSprints still
    // drive meaningful confidence calibration.
    let analysis: HistoryAnalysis;
    try {
      const raw = await this.adapter.getSprintHistory(10);
      const records = adaptRawToHistoryRecords(raw);
      analysis = analyzer.analyze(records);
    } catch {
      analysis = analyzer.analyze([]); // zero-data: confidence 0.3, no historical cost
    }

    // Adapt autonomous BacklogItem → predictive-planning BacklogItem.
    // complexityScore defaults to 5 (neutral midpoint of 1–10 scale) since
    // autonomous items don't carry a complexity field yet.
    const estimateMap = new Map(
      backlog.map(item => [
        item.id,
        estimator.estimate(
          {
            id: item.id,
            title: item.title,
            priority: item.priority as PriorityTier,
            complexityScore: 5,
            // exactOptionalPropertyTypes: only spread when defined to avoid
            // assigning `undefined` to a field typed as `number` (not `number | undefined`)
            ...(item.estimatedCostUsd !== undefined
              ? { estimatedCostUsd: item.estimatedCostUsd }
              : {}),
          },
          analysis,
        ),
      ]),
    );

    const priorityOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
    const sorted = [...backlog].sort((a, b) => {
      const pa = priorityOrder[a.priority] ?? 9;
      const pb = priorityOrder[b.priority] ?? 9;
      return pa !== pb ? pa - pb : b.confidence - a.confidence;
    });

    const rankings: RankedItem[] = sorted.map((item, idx) => {
      const est = estimateMap.get(item.id);
      const costUsd = est?.estimatedCostUsd ?? this.config.budget.perItemUsd;
      const confidence = est?.confidence ?? item.confidence;
      return {
        itemId: item.id,
        title: item.title,
        rank: idx + 1,
        score: confidence,
        confidence,
        estimatedCostUsd: costUsd,
        estimatedDurationMinutes: Math.round((est?.estimatedHours ?? 0.5) * 60),
        rationale: `Effort-estimator fallback (${item.priority}, est $${costUsd.toFixed(2)}, confidence ${confidence.toFixed(2)})`,
        dependencies: [],
        suggestedAssignee: 'coder',
        suggestedTags: item.tags,
        withinBudget: true,
      };
    });

    // Enforce per-cycle budget cap
    let cumulative = 0;
    for (const r of rankings) {
      cumulative += r.estimatedCostUsd;
      if (cumulative > this.config.budget.perCycleUsd) {
        r.withinBudget = false;
      }
    }

    const withinBudget = rankings
      .filter(r => r.withinBudget)
      .slice(0, this.config.limits.maxItemsPerSprint);

    const totalCost = withinBudget.reduce((sum, r) => sum + r.estimatedCostUsd, 0);

    return {
      withinBudget,
      requiresApproval: rankings.filter(r => !r.withinBudget),
      totalEstimatedCostUsd: totalCost,
      budgetOverflowUsd: 0,
      summary: `Effort-estimator fallback: ${withinBudget.length} items within $${this.config.budget.perCycleUsd} budget`,
      warnings: ['Scoring agent failed; used effort-estimator fallback'],
      fallback: 'effort-estimator',
    };
  }

  private async staticFallback(backlog: BacklogItem[]): Promise<ScoringPipelineResult> {
    // Fetch tag-specific medians; fall back to flat perItemUsd if the adapter throws.
    let p50CostByTag: Record<string, number> = {};
    try {
      p50CostByTag = await this.adapter.getP50CostByTag();
    } catch {
      // Adapter unavailable — perItemUsd flat fallback applies below.
    }

    const defaultCost = this.config.budget.perItemUsd;
    const priorityOrder: Record<'P0' | 'P1' | 'P2', number> = { P0: 0, P1: 1, P2: 2 };
    const sorted = [...backlog].sort((a, b) => {
      const pa = priorityOrder[a.priority];
      const pb = priorityOrder[b.priority];
      if (pa !== pb) return pa - pb;
      return b.confidence - a.confidence;
    });

    const rankings: RankedItem[] = sorted.map((item, idx) => ({
      itemId: item.id,
      title: item.title,
      rank: idx + 1,
      score: item.confidence,
      confidence: item.confidence,
      // Tag-specific median cost takes precedence over the flat per-item default.
      // item.tags[0] is the primary tag (e.g. "fix", "feature", "chore").
      estimatedCostUsd: p50CostByTag[item.tags[0] ?? ''] ?? defaultCost,
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
    // p50CostByTag is fetched separately so a missing or slow adapter doesn't
    // block the rest of grounding. Graceful degradation: empty object means the
    // scoring agent falls back to its built-in hardcoded priors.
    let p50CostByTag: Record<string, number> = {};
    try {
      p50CostByTag = await this.adapter.getP50CostByTag();
    } catch {
      // Adapter unavailable — grounding proceeds without tag-calibrated medians.
    }
    return { history, costMedians, teamState, p50CostByTag };
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

## Roster constraint — CRITICAL
The \`suggestedAssignee\` field MUST be one of the exact kebab-case IDs listed
below. Do NOT invent generic role names such as "BackendEngineer", "FrontendEngineer",
"QAEngineer", "InfraEngineer", "CoreAutonomyAgent", "DocsAgent", or any
PascalCase/camelCase name. Invented names are not routable — the cycle runner
cannot dispatch an agent that does not exist in the registry. Use "coder" as
the safe default when no specialist clearly fits.

Valid agent IDs (copy one verbatim, no modifications):
${this.getAgentRoster().join(', ')}

## Cost calibration (use as baseline, not training priors)
Recent actual cost per item from grounding.history:
${(() => {
  const hist = ((grounding as Record<string, unknown>).history ?? []) as Array<{ avgItemCostUsd?: number; version?: string }>;
  if (hist.length === 0) return '- (no history yet — use $0.50-$2.00 typical range)';
  const withCost = hist.filter(h => typeof h.avgItemCostUsd === 'number');
  if (withCost.length === 0) return '- (history present but no avgItemCostUsd recorded — use $0.50-$2.00 typical range)';
  return withCost.map(h => `- v${h.version ?? '?'}: $${h.avgItemCostUsd!.toFixed(2)}/item`).join('\n');
})()}

Item type → median actual (from prior cycles, use these as priors):
- ci/typecheck/release-gate: ~$0.75
- fix (specific file/function target): ~$1.10
- chore (verify/document/move): ~$0.55
- feature (wire up dashboard route, end-to-end UI+API): ~$1.65
- migration/refactor (move + test update): ~$2.00
- test (add unit/integration coverage): ~$0.90
- doc (README/CHANGELOG/spec write): ~$0.55
- e2e (Playwright): ~$2.50
- security (audit + fix): ~$1.00

DO NOT estimate above $5/item unless the item explicitly spans multiple
subsystems with new architecture. Trust the median, not your training priors.

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
      "suggestedAssignee": string (MUST be one of the agent IDs from the Roster constraint above — use "coder" if unsure),
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

  /**
   * Post-processing guard: replace any suggestedAssignee that isn't in the
   * team roster with 'coder', and append a warning for each replacement.
   * This is defense-in-depth — the prompt already forbids invented names, but
   * LLMs can still drift toward generic PascalCase roles like "BackendEngineer"
   * or "FrontendEngineer" that cannot be dispatched by the cycle runner.
   */
  private sanitizeAssignees(result: ScoringResult): ScoringResult {
    const roster = new Set(this.getAgentRoster());
    const sanitizationWarnings: string[] = [];

    const sanitizedRankings = result.rankings.map(r => {
      if (!roster.has(r.suggestedAssignee)) {
        sanitizationWarnings.push(
          `suggestedAssignee "${r.suggestedAssignee}" (item ${r.itemId}) is not in roster — replaced with "coder"`,
        );
        return { ...r, suggestedAssignee: 'coder' };
      }
      return r;
    });

    return {
      ...result,
      rankings: sanitizedRankings,
      warnings: [...result.warnings, ...sanitizationWarnings],
    };
  }

  parseAndValidate(output: string): ScoringResult {
    // Try, in order: strict parse → fenced-block parse → extract first {...} →
    // control-char sanitisation. Each step is cheap and targets a specific
    // failure mode seen in the wild (cycle 75bfaf96 strikes 2+3).
    const parsed = extractScoringJson(output);
    if (parsed === null) {
      throw new ScoringPipelineError(
        'Scoring output is not valid JSON (tried strict parse, fence stripping, brace extraction, and control-char sanitisation)',
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

/**
 * Adapt raw history entries from AdapterForScoring.getSprintHistory() into
 * the SprintHistoryRecord shape expected by HistoryAnalyzer.
 *
 * The adapter returns SprintHistoryEntry objects (version, itemCount,
 * completedCount, avgItemCostUsd) rather than SprintHistoryRecord.
 * Per-priority breakdowns are unavailable, so completedByPriority is zeroed —
 * but avgCostUsd and totalSprints are correctly derived, which drives the
 * confidence calibration in EffortEstimator.estimate().
 */
function adaptRawToHistoryRecords(raw: unknown[]): SprintHistoryRecord[] {
  const zeroPriority: Record<PriorityTier, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  const records: SprintHistoryRecord[] = [];

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    const completedItems = typeof r.completedCount === 'number' ? r.completedCount : 0;
    const avgItemCostUsd = typeof r.avgItemCostUsd === 'number' ? r.avgItemCostUsd : 0;
    const totalCostUsd = avgItemCostUsd * Math.max(1, completedItems);
    // Skip completely empty records — they add noise without signal
    if (totalCostUsd === 0 && completedItems === 0) continue;

    records.push({
      sprintId: typeof r.version === 'string' ? r.version : 'unknown',
      plannedItems: typeof r.itemCount === 'number' ? r.itemCount : completedItems,
      completedItems,
      totalCostUsd,
      durationDays: 1, // not available in SprintHistoryEntry; 1 is a neutral sentinel
      failedItems: [],
      itemsByPriority: { ...zeroPriority },
      completedByPriority: { ...zeroPriority },
      completedAt: typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString(),
    });
  }

  return records;
}

/**
 * Robust JSON extraction for scorer output. Returns parsed object or null.
 *
 * Strategy (each step cheap, bails early on success):
 *   1. Trim + strip markdown fences and try strict JSON.parse.
 *   2. Walk the string to find the first top-level `{...}` block (handles
 *      leading prose like "Here is the ranking: {...}").
 *   3. Sanitise unescaped control characters inside string literals —
 *      literal \n/\t/\r inside a quoted value break JSON.parse but are
 *      semantically obvious once escaped.
 *
 * This is called from parseAndValidate after an earlier retry already failed,
 * so the cost is negligible even when all four attempts run.
 */
function extractScoringJson(output: string): unknown | null {
  // 1. Strip fences + strict parse
  let cleaned = output.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7).trim();
  else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3).trim();
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3).trim();

  const attempts: string[] = [cleaned];

  // 2. Find first balanced {...} block (naive but effective — bails on the
  //    first syntactic JSON candidate even when prefixed with prose).
  const brace = findFirstBalancedBraces(cleaned);
  if (brace !== null && brace !== cleaned) attempts.push(brace);

  // 3. Sanitise unescaped control chars inside string literals
  for (const candidate of [...attempts]) {
    attempts.push(sanitiseControlCharsInStrings(candidate));
  }

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch { /* try next */ }
  }
  return null;
}

function findFirstBalancedBraces(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s.charAt(i);
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function sanitiseControlCharsInStrings(s: string): string {
  // Walk the string, tracking whether we're inside a JSON string literal.
  // Replace raw \n, \t, \r inside strings with their escaped forms. Outside
  // strings, leave them intact.
  const out: string[] = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (escape) { out.push(ch); escape = false; continue; }
    if (ch === '\\') { out.push(ch); escape = true; continue; }
    if (ch === '"') { out.push(ch); inString = !inString; continue; }
    if (inString && ch === '\n') out.push('\\n');
    else if (inString && ch === '\r') out.push('\\r');
    else if (inString && ch === '\t') out.push('\\t');
    else out.push(ch);
  }
  return out.join('');
}
