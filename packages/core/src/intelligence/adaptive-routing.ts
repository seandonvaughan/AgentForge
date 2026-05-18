import { readFileSync, statSync } from 'node:fs';
import { appendRoutingFeedback, readRoutingFeedback } from './adaptive-routing-store.js';
import { computeUtility } from './utility.js';
import { paretoFront } from './pareto.js';

interface RoutingFeedback {
  agentId: string;
  model: 'opus' | 'sonnet' | 'haiku';
  outcome: 'success' | 'failure';
  taskComplexity: string;
  timestamp: string;
}

interface AgentPerformance {
  agentId: string;
  model: 'opus' | 'sonnet' | 'haiku';
  successRate: number;
  sampleCount: number;
  lastUpdated: string;
}

type ModelId = 'opus' | 'sonnet' | 'haiku';

/** One record loaded from `.agentforge/memory/step-scores.jsonl`. */
interface StepScoreRecord {
  id?: string;
  agent_id: string;
  capability_tag?: string;
  skill_set?: string;
  model: ModelId;
  quality: number;
  cost_usd: number;
  latency_ms: number;
  ts?: string;
}

/** Aggregated observations for a (agent, capability_tag, skill_set, model) triple. */
interface TripleStats {
  meanUtility: number;
  meanCost: number;
  meanQuality: number;
  meanLatency: number;
  count: number;
}

export interface AdaptiveRouterOptions {
  /** Path to the JSONL persistence file. Defaults to `.agentforge/memory/routing-feedback.jsonl`. */
  feedbackFilePath?: string;
  /** Path to the step-scores ledger. Defaults to `.agentforge/memory/step-scores.jsonl`. */
  stepScoresPath?: string;
  /** Cap on records read from the step-scores ledger. Defaults to 5000. */
  stepScoresCap?: number;
  /** Soft timeout (ms) for the initial step-scores read. Defaults to 10ms. */
  stepScoresReadTimeoutMs?: number;
  /** Epsilon for greedy exploration within the Pareto front. Defaults to 0.05. */
  explorationEpsilon?: number;
  /** Deterministic RNG hook for tests. */
  rng?: () => number;
}

interface QualityRecommendInput {
  agentId: string;
  capabilityTag?: string;
  skillSet?: string;
  defaultModel: ModelId;
  candidateModels?: ModelId[];
}

interface QualityRecommendResult {
  model: ModelId;
  reason:
    | 'cold-start'
    | 'pareto-utility'
    | 'epsilon-explore'
    | 'no-data'
    | 'wave2-fallback';
  utility?: number;
  paretoSize?: number;
}

const DEFAULT_CANDIDATES: ModelId[] = ['haiku', 'sonnet', 'opus'];
const MIN_OBSERVATIONS = 3;
const RECENT_WINDOW = 20;
const HALF_LIFE_OBS = 50;
const STEP_SCORES_CAP_DEFAULT = 5000;
const STEP_SCORES_TIMEOUT_DEFAULT_MS = 10;

export class AdaptiveRouter {
  private feedback: RoutingFeedback[] = [];
  private performanceCache: Map<string, AgentPerformance> = new Map();
  private readonly feedbackFilePath: string;
  private readonly stepScoresPath: string;
  private readonly stepScoresCap: number;
  private readonly explorationEpsilon: number;
  private readonly rng: () => number;

  /**
   * Step-score records grouped by triple key. Ordered oldest-first within each
   * bucket; only the most recent RECENT_WINDOW observations are scored.
   */
  private readonly stepScoresByTriple: Map<string, StepScoreRecord[]> =
    new Map();

  /** True iff step-scores.jsonl yielded at least one valid record. */
  private readonly stepScoresAvailable: boolean;

  constructor(opts: AdaptiveRouterOptions = {}) {
    this.feedbackFilePath = opts.feedbackFilePath ?? '.agentforge/memory/routing-feedback.jsonl';
    this.stepScoresPath = opts.stepScoresPath ?? '.agentforge/memory/step-scores.jsonl';
    this.stepScoresCap = opts.stepScoresCap ?? STEP_SCORES_CAP_DEFAULT;
    this.explorationEpsilon = opts.explorationEpsilon ?? 0.05;
    this.rng = opts.rng ?? Math.random;

    // Replay persisted records into in-memory state on construction
    for (const record of readRoutingFeedback(this.feedbackFilePath)) {
      this.feedback.push({
        agentId: record.agentId,
        model: record.model as ModelId,
        outcome: record.success ? 'success' : 'failure',
        taskComplexity: '',
        timestamp: record.ts,
      });
    }

    this.stepScoresAvailable = this.loadStepScores(
      opts.stepScoresReadTimeoutMs ?? STEP_SCORES_TIMEOUT_DEFAULT_MS,
    );
  }

  // ------------------------------------------------------------------- loaders

  private loadStepScores(timeoutMs: number): boolean {
    const started = Date.now();
    let raw: string;
    try {
      // Probe size to allow quick bail on huge files. We still cap below.
      statSync(this.stepScoresPath);
      raw = readFileSync(this.stepScoresPath, 'utf8');
    } catch {
      return false;
    }
    if (Date.now() - started > timeoutMs) {
      // soft timeout — accept whatever we read; do not retry
    }

    const lines = raw.split('\n');
    // Cap last N records (tail-end)
    const start = Math.max(0, lines.length - this.stepScoresCap - 1);
    let loaded = 0;
    for (let i = start; i < lines.length; i++) {
      const trimmed = lines[i]!.trim();
      if (!trimmed) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const rec = this.normaliseStepScore(obj);
      if (!rec) continue;
      const key = this.tripleKey(rec.agent_id, rec.capability_tag, rec.skill_set, rec.model);
      const bucket = this.stepScoresByTriple.get(key) ?? [];
      bucket.push(rec);
      this.stepScoresByTriple.set(key, bucket);
      loaded++;
    }
    return loaded > 0;
  }

  private normaliseStepScore(obj: unknown): StepScoreRecord | null {
    if (!obj || typeof obj !== 'object') return null;
    const r = obj as Record<string, unknown>;
    const agentId = typeof r['agent_id'] === 'string' ? (r['agent_id'] as string) : undefined;
    const model = r['model'];
    if (!agentId) return null;
    if (model !== 'opus' && model !== 'sonnet' && model !== 'haiku') return null;
    const quality = typeof r['quality'] === 'number' ? (r['quality'] as number) : NaN;
    const cost = typeof r['cost_usd'] === 'number' ? (r['cost_usd'] as number) : NaN;
    const latency = typeof r['latency_ms'] === 'number' ? (r['latency_ms'] as number) : NaN;
    if (!Number.isFinite(quality) || !Number.isFinite(cost) || !Number.isFinite(latency)) {
      return null;
    }
    const tag = typeof r['capability_tag'] === 'string' ? (r['capability_tag'] as string) : undefined;
    const skill = typeof r['skill_set'] === 'string' ? (r['skill_set'] as string) : undefined;
    const id = typeof r['id'] === 'string' ? (r['id'] as string) : undefined;
    const ts = typeof r['ts'] === 'string' ? (r['ts'] as string) : undefined;
    const result: StepScoreRecord = {
      agent_id: agentId,
      model: model as ModelId,
      quality,
      cost_usd: cost,
      latency_ms: latency,
    };
    if (id !== undefined) result.id = id;
    if (tag !== undefined) result.capability_tag = tag;
    if (skill !== undefined) result.skill_set = skill;
    if (ts !== undefined) result.ts = ts;
    return result;
  }

  private tripleKey(
    agentId: string,
    capabilityTag: string | undefined,
    skillSet: string | undefined,
    model: ModelId,
  ): string {
    return `${agentId}${capabilityTag ?? ''}${skillSet ?? ''}${model}`;
  }

  // ----------------------------------------------------- utility aggregation

  /**
   * Mean utility for a triple using last N=20 observations and exponential
   * decay with a half-life of 50. Returns null if fewer than MIN_OBSERVATIONS.
   */
  private tripleStats(
    agentId: string,
    capabilityTag: string | undefined,
    skillSet: string | undefined,
    model: ModelId,
  ): TripleStats | null {
    // Direct triple
    let bucket = this.stepScoresByTriple.get(
      this.tripleKey(agentId, capabilityTag, skillSet, model),
    );

    // Fall back through coarser keys: tag-only, agent-only — to surface signal
    // without a perfect (agent,tag,skill,model) match. Uses String.includes for
    // capability-tag matching (no regex, CodeQL-safe).
    if (!bucket || bucket.length === 0) {
      const merged: StepScoreRecord[] = [];
      for (const [key, recs] of this.stepScoresByTriple.entries()) {
        if (!key.includes(`${agentId}`)) continue;
        if (!key.endsWith(`${model}`)) continue;
        if (capabilityTag && !key.includes(`${capabilityTag}`)) continue;
        merged.push(...recs);
      }
      bucket = merged;
    }

    if (!bucket || bucket.length < MIN_OBSERVATIONS) return null;
    const window = bucket.slice(-RECENT_WINDOW);

    // Exponential decay: weight = 0.5 ** (age / HALF_LIFE_OBS)
    // age 0 = newest. Newest is window[window.length-1].
    let wSum = 0;
    let qSum = 0;
    let cSum = 0;
    let lSum = 0;
    let uSum = 0;
    const last = window.length - 1;
    for (let i = 0; i < window.length; i++) {
      const age = last - i;
      const weight = Math.pow(0.5, age / HALF_LIFE_OBS);
      const rec = window[i]!;
      const u = computeUtility({
        quality: rec.quality,
        cost_usd: rec.cost_usd,
        latency_ms: rec.latency_ms,
      });
      wSum += weight;
      qSum += weight * rec.quality;
      cSum += weight * rec.cost_usd;
      lSum += weight * rec.latency_ms;
      uSum += weight * u;
    }
    if (wSum === 0) return null;
    return {
      meanUtility: uSum / wSum,
      meanQuality: qSum / wSum,
      meanCost: cSum / wSum,
      meanLatency: lSum / wSum,
      count: bucket.length,
    };
  }

  // --------------------------------------------------------- public API: ROUTE

  /**
   * Quality-aware recommendation that combines step-score utilities with a
   * Pareto front filter and 5% epsilon-greedy exploration. Falls back to the
   * Wave-2 `recommend()` path when step-scores are unavailable or the triple
   * is in cold-start.
   *
   * IMPORTANT: this is purely additive — it does not change the existing
   * `recommend(agentId, defaultModel)` signature.
   */
  recommendQualityAware(input: QualityRecommendInput): QualityRecommendResult {
    const candidates = input.candidateModels ?? DEFAULT_CANDIDATES;

    if (!this.stepScoresAvailable) {
      const fallback = this.recommend(input.agentId, input.defaultModel);
      return { model: fallback, reason: 'wave2-fallback' };
    }

    // Gather stats for each candidate
    const statsByModel = new Map<ModelId, TripleStats>();
    for (const m of candidates) {
      const s = this.tripleStats(input.agentId, input.capabilityTag, input.skillSet, m);
      if (s) statsByModel.set(m, s);
    }

    if (statsByModel.size < MIN_OBSERVATIONS && statsByModel.size < candidates.length) {
      // Not enough triples have crossed the cold-start floor for a confident
      // multi-arm comparison — defer to Wave-2 cost-only routing.
      const fallback = this.recommend(input.agentId, input.defaultModel);
      return { model: fallback, reason: 'cold-start' };
    }

    // Build Pareto front from candidates that have stats
    const points = [...statsByModel.entries()].map(([model, s]) => ({
      model,
      cost: s.meanCost,
      quality: s.meanQuality,
      latency: s.meanLatency,
      utility: s.meanUtility,
    }));
    if (points.length === 0) {
      const fallback = this.recommend(input.agentId, input.defaultModel);
      return { model: fallback, reason: 'no-data' };
    }
    const front = paretoFront(points);

    // Epsilon-greedy: with probability epsilon, pick a random model from the
    // Pareto front; otherwise pick max-utility.
    if (front.length > 1 && this.rng() < this.explorationEpsilon) {
      const idx = Math.min(front.length - 1, Math.floor(this.rng() * front.length));
      const pick = front[idx]!;
      return {
        model: pick.model,
        reason: 'epsilon-explore',
        utility: pick.utility,
        paretoSize: front.length,
      };
    }

    const best = front.reduce((a, b) => (b.utility > a.utility ? b : a));
    return {
      model: best.model,
      reason: 'pareto-utility',
      utility: best.utility,
      paretoSize: front.length,
    };
  }

  // ----------------------------------------------------- public API: feedback

  /** Record feedback from a completed session (legacy signature). */
  recordOutcome(
    agentId: string,
    model: ModelId,
    outcome: 'success' | 'failure',
    taskComplexity: string,
  ): void;
  /** Record feedback with latency and cost (new persistent signature). */
  recordOutcome(
    agentId: string,
    model: ModelId,
    success: boolean,
    latencyMs: number,
    costUsd: number,
  ): void;
  /**
   * Record feedback with quality-aware extras. Additive optional fields are
   * persisted to routing-feedback.jsonl alongside the Wave-2 record so dashboards
   * and replays can read them without a schema migration.
   */
  recordOutcome(
    agentId: string,
    model: ModelId,
    success: boolean,
    latencyMs: number,
    costUsd: number,
    extras: { stepScoreId?: string; quality?: number; utility?: number },
  ): void;
  recordOutcome(
    agentId: string,
    model: ModelId,
    outcomeOrSuccess: 'success' | 'failure' | boolean,
    taskComplexityOrLatencyMs: string | number,
    costUsd?: number,
    extras?: { stepScoreId?: string; quality?: number; utility?: number },
  ): void {
    const ts = new Date().toISOString();

    if (typeof outcomeOrSuccess === 'boolean') {
      // New persistent signature
      const success = outcomeOrSuccess;
      const latencyMs = taskComplexityOrLatencyMs as number;
      const cost = costUsd ?? 0;
      this.feedback.push({
        agentId,
        model,
        outcome: success ? 'success' : 'failure',
        taskComplexity: '',
        timestamp: ts,
      });
      const record: Record<string, unknown> = {
        ts,
        agentId,
        model,
        success,
        latencyMs,
        costUsd: cost,
      };
      if (extras?.stepScoreId !== undefined) record['stepScoreId'] = extras.stepScoreId;
      if (extras?.quality !== undefined) record['quality'] = extras.quality;
      if (extras?.utility !== undefined) record['utility'] = extras.utility;
      appendRoutingFeedback(
        this.feedbackFilePath,
        record as unknown as Parameters<typeof appendRoutingFeedback>[1],
      );
    } else {
      // Legacy signature
      const outcome = outcomeOrSuccess;
      const taskComplexity = taskComplexityOrLatencyMs as string;
      this.feedback.push({ agentId, model, outcome, taskComplexity, timestamp: ts });
    }

    this.performanceCache.delete(agentId);
  }

  // ---------------------------------------------------- public API: Wave-2

  /** Get the recommended model for an agent based on historical performance. */
  recommend(agentId: string, defaultModel: ModelId): ModelId {
    const agentFeedback = this.feedback.filter(f => f.agentId === agentId);
    if (agentFeedback.length < 5) return defaultModel;

    const byModel = new Map<string, { success: number; total: number }>();
    for (const f of agentFeedback) {
      const stats = byModel.get(f.model) ?? { success: 0, total: 0 };
      stats.total++;
      if (f.outcome === 'success') stats.success++;
      byModel.set(f.model, stats);
    }

    const modelCost = { haiku: 1, sonnet: 5, opus: 15 };
    const candidates = (['haiku', 'sonnet', 'opus'] as const)
      .filter(m => {
        const stats = byModel.get(m);
        return stats && stats.total >= 3 && stats.success / stats.total >= 0.7;
      })
      .sort((a, b) => modelCost[a] - modelCost[b]);

    return candidates[0] ?? defaultModel;
  }

  /** Get performance stats for all agents. */
  getPerformance(): AgentPerformance[] {
    const agentIds = [...new Set(this.feedback.map(f => f.agentId))];
    return agentIds.map(agentId => {
      const agentFeedback = this.feedback.filter(f => f.agentId === agentId);
      const modelGroups = new Map<string, { success: number; total: number }>();
      for (const f of agentFeedback) {
        const g = modelGroups.get(f.model) ?? { success: 0, total: 0 };
        g.total++;
        if (f.outcome === 'success') g.success++;
        modelGroups.set(f.model, g);
      }
      const best = [...modelGroups.entries()].sort(
        (a, b) => b[1].success / b[1].total - a[1].success / a[1].total,
      )[0];
      return {
        agentId,
        model: (best?.[0] ?? 'sonnet') as ModelId,
        successRate: best ? best[1].success / best[1].total : 0,
        sampleCount: agentFeedback.length,
        lastUpdated: agentFeedback[agentFeedback.length - 1]?.timestamp ?? new Date().toISOString(),
      };
    });
  }

  /** Whether the router has step-score data available for quality-aware routing. */
  hasQualitySignal(): boolean {
    return this.stepScoresAvailable;
  }
}
