import { ResponseCache } from './response-cache.js';
import { BatchAggregator } from './batch-aggregator.js';
import type {
  AutopilotDecisionMetric,
  AutopilotStats,
  AutopilotTraceContext,
  BatchRequest,
  BatchResult,
  CacheConfig,
  ModelSelectionDecision,
  ModelTier,
  TaskComplexity,
} from './types.js';
export type { ModelTier } from './types.js';

export class AutopilotBudgetError extends Error {
  readonly code = 'AUTOPILOT_BUDGET_BLOCKED';

  constructor(message: string) {
    super(message);
    this.name = 'AutopilotBudgetError';
  }
}

export interface TaskContext {
  task: string;
  complexity?: TaskComplexity;
  maxCostUsd?: number;
  allowBatching?: boolean;
  modelOverride?: ModelTier;
  minModelTier?: ModelTier;
  trace?: AutopilotTraceContext;
}

export type TaskExecutor = (task: string, model: ModelTier) => Promise<{ response: unknown; costUsd: number }>;

export interface CostAutopilotOptions {
  cache?: Partial<CacheConfig>;
  batch?: {
    windowMs?: number;
    maxBatch?: number;
  };
}

const MODEL_COST_FACTOR: Record<ModelTier, number> = {
  haiku: 0.001,
  sonnet: 0.003,
  opus: 0.015,
};

const COMPLEXITY_MODEL: Record<TaskComplexity, ModelTier> = {
  low: 'haiku',
  medium: 'sonnet',
  high: 'opus',
};

const TIER_RANK: Record<ModelTier, number> = {
  haiku: 0,
  sonnet: 1,
  opus: 2,
};

const RANKED_TIERS: ModelTier[] = ['haiku', 'sonnet', 'opus'];

function modelCost(model: ModelTier): number {
  return MODEL_COST_FACTOR[model];
}

function normalizeTask(task: string): string {
  return task.toLowerCase().trim().replace(/\s+/g, ' ');
}

function normalizeKeyPart(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, '-');
}

function traceScope(trace?: AutopilotTraceContext): string {
  if (trace?.cacheScope) return normalizeKeyPart(trace.cacheScope);
  const parts = [trace?.cycleId, trace?.phase, trace?.agentId]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map(normalizeKeyPart);
  return parts.length > 0 ? parts.join('/') : 'global';
}

function allowSimilarCache(trace?: AutopilotTraceContext): boolean {
  return !trace?.taskFingerprint && !trace?.cacheScope && !trace?.cycleId && !trace?.phase && !trace?.agentId;
}

function buildCacheKey(ctx: TaskContext, model: ModelTier): string {
  const scope = traceScope(ctx.trace);
  const identity = ctx.trace?.taskFingerprint
    ? `fingerprint:${normalizeKeyPart(ctx.trace.taskFingerprint)}`
    : `task:${normalizeTask(ctx.task)}`;
  return `cost-autopilot:v1|scope:${scope}|model:${model}|${identity}`;
}

function ensureMinimumTier(model: ModelTier, minModelTier?: ModelTier): ModelTier {
  if (!minModelTier) return model;
  return TIER_RANK[model] < TIER_RANK[minModelTier] ? minModelTier : model;
}

function highestAffordableTier(maxCostUsd: number, ceiling: ModelTier): ModelTier | null {
  const affordable = RANKED_TIERS.filter(
    (tier) => TIER_RANK[tier] <= TIER_RANK[ceiling] && modelCost(tier) <= maxCostUsd,
  );
  return affordable.length > 0 ? affordable[affordable.length - 1]! : null;
}

function selectModel(ctx: TaskContext): ModelSelectionDecision {
  const complexity = ctx.complexity ?? 'medium';
  const baselineModel = ensureMinimumTier(ctx.modelOverride ?? COMPLEXITY_MODEL[complexity], ctx.minModelTier);
  const baselineCost = modelCost(baselineModel);

  if (ctx.maxCostUsd === undefined) {
    return {
      model: baselineModel,
      estimatedCostUsd: baselineCost,
      baselineModel,
      budgetConstrained: false,
      downgraded: false,
      reason: ctx.modelOverride ? 'explicit model override' : `${complexity} complexity default`,
    };
  }

  if (!Number.isFinite(ctx.maxCostUsd) || ctx.maxCostUsd < 0) {
    throw new AutopilotBudgetError(`Invalid maxCostUsd: ${String(ctx.maxCostUsd)}`);
  }

  if (baselineCost <= ctx.maxCostUsd) {
    return {
      model: baselineModel,
      estimatedCostUsd: baselineCost,
      baselineModel,
      budgetConstrained: true,
      downgraded: false,
      reason: `${baselineModel} fits maxCostUsd $${ctx.maxCostUsd.toFixed(4)}`,
    };
  }

  if (ctx.modelOverride || ctx.minModelTier) {
    throw new AutopilotBudgetError(
      `${baselineModel} estimated cost $${baselineCost.toFixed(4)} exceeds maxCostUsd $${ctx.maxCostUsd.toFixed(4)}`,
    );
  }

  const selected = highestAffordableTier(ctx.maxCostUsd, baselineModel);
  if (!selected) {
    throw new AutopilotBudgetError(
      `No model tier fits maxCostUsd $${ctx.maxCostUsd.toFixed(4)}; cheapest tier is $${MODEL_COST_FACTOR.haiku.toFixed(4)}`,
    );
  }

  return {
    model: selected,
    estimatedCostUsd: modelCost(selected),
    baselineModel,
    budgetConstrained: true,
    downgraded: true,
    reason: `${baselineModel} exceeds maxCostUsd; downgraded to ${selected}`,
  };
}

export class CostAutopilot {
  private readonly cache: ResponseCache;
  private readonly aggregator: BatchAggregator;
  private readonly defaultExecutor: TaskExecutor;
  private readonly inFlight = new Map<string, Promise<BatchResult>>();
  private totalRequests = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private totalCostUsd = 0;
  private estimatedSavingsUsd = 0;
  private redundantInvocationsPruned = 0;
  private budgetDowngrades = 0;
  private budgetBlocks = 0;
  private readonly modelSelections: Record<ModelTier, number> = { haiku: 0, sonnet: 0, opus: 0 };
  private readonly recentDecisions: AutopilotDecisionMetric[] = [];

  constructor(executor: TaskExecutor, options: CostAutopilotOptions = {}) {
    this.defaultExecutor = executor;
    this.cache = new ResponseCache(options.cache);

    const batchExecutor = async (requests: BatchRequest[]): Promise<BatchResult[]> => {
      return Promise.all(
        requests.map(async (req) => {
          const cached = this.cache.lookup(req.cacheKey, { allowSimilar: req.allowSimilarCache });
          if (cached) {
            this.estimatedSavingsUsd += cached.costUsd;
            this.cacheHits++;
            return {
              requestId: req.id,
              response: cached.response,
              costUsd: 0,
              fromCache: true,
              ...(cached.model ? { model: cached.model } : { model: req.model }),
              autopilot: this.autopilotMetadata(req.cacheKey, req.decision, req.trace),
            };
          }
          const result = await this.defaultExecutor(req.task, req.model);
          this.cache.store(req.cacheKey, result.response, result.costUsd, {
            model: req.model,
            ...(req.trace ? { trace: req.trace } : {}),
          });
          this.totalCostUsd += result.costUsd;
          return {
            requestId: req.id,
            response: result.response,
            costUsd: result.costUsd,
            fromCache: false,
            model: req.model,
            autopilot: this.autopilotMetadata(req.cacheKey, req.decision, req.trace),
          };
        }),
      );
    };

    this.aggregator = new BatchAggregator(batchExecutor, {
      windowMs: options.batch?.windowMs ?? 50,
      maxBatch: options.batch?.maxBatch ?? 10,
    });
  }

  async process(ctx: TaskContext, executor: TaskExecutor = this.defaultExecutor): Promise<BatchResult> {
    this.totalRequests++;
    const requestId = `req-${this.totalRequests}`;

    let decision: ModelSelectionDecision;
    try {
      decision = selectModel(ctx);
    } catch (err) {
      this.budgetBlocks++;
      this.recordDecision({
        requestId,
        action: 'blocked',
        reason: err instanceof Error ? err.message : String(err),
        ...(ctx.trace ? { trace: ctx.trace } : {}),
      });
      throw err;
    }

    this.modelSelections[decision.model]++;
    if (decision.downgraded) this.budgetDowngrades++;

    const cacheKey = buildCacheKey(ctx, decision.model);
    const canUseSimilarCache = allowSimilarCache(ctx.trace);

    // 1. Check cache
    const cached = this.cache.lookup(cacheKey, { allowSimilar: canUseSimilarCache });
    if (cached) {
      this.cacheHits++;
      this.estimatedSavingsUsd += cached.costUsd;
      const result: BatchResult = {
        requestId,
        response: cached.response,
        costUsd: 0,
        fromCache: true,
        ...(cached.model ? { model: cached.model } : { model: decision.model }),
        autopilot: this.autopilotMetadata(cacheKey, decision, ctx.trace),
      };
      this.recordDecision({
        requestId,
        action: 'cache-hit',
        model: result.model ?? decision.model,
        estimatedCostUsd: decision.estimatedCostUsd,
        savingsUsd: cached.costUsd,
        cacheKey,
        reason: 'served from response cache',
        ...(ctx.trace ? { trace: ctx.trace } : {}),
      });
      return result;
    }

    const inFlight = this.inFlight.get(cacheKey);
    if (inFlight) {
      this.redundantInvocationsPruned++;
      this.recordDecision({
        requestId,
        action: 'pruned',
        model: decision.model,
        estimatedCostUsd: decision.estimatedCostUsd,
        savingsUsd: decision.estimatedCostUsd,
        cacheKey,
        reason: 'joined equivalent in-flight invocation',
        ...(ctx.trace ? { trace: ctx.trace } : {}),
      });
      return inFlight.then((result) => {
        const savingsUsd = result.costUsd > 0 ? result.costUsd : decision.estimatedCostUsd;
        this.estimatedSavingsUsd += savingsUsd;
        return {
          requestId,
          response: result.response,
          costUsd: 0,
          fromCache: true,
          pruned: true,
          ...(result.batchId ? { batchId: result.batchId } : {}),
          ...(result.model ? { model: result.model } : { model: decision.model }),
          autopilot: this.autopilotMetadata(cacheKey, decision, ctx.trace),
        };
      });
    }

    this.cacheMisses++;

    const execution = ctx.allowBatching
      ? this.executeBatched(ctx, requestId, decision, cacheKey, canUseSimilarCache)
      : this.executeDirect(ctx, requestId, decision, cacheKey, executor);

    this.inFlight.set(cacheKey, execution);
    try {
      return await execution;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  private async executeBatched(
    ctx: TaskContext,
    requestId: string,
    decision: ModelSelectionDecision,
    cacheKey: string,
    canUseSimilarCache: boolean,
  ): Promise<BatchResult> {
    const req: BatchRequest = {
      id: requestId,
      task: ctx.task,
      enqueuedAt: Date.now(),
      model: decision.model,
      cacheKey,
      allowSimilarCache: canUseSimilarCache,
      decision,
      ...(ctx.trace ? { trace: ctx.trace } : {}),
    };
    const result = await this.aggregator.enqueue(req);
    this.recordDecision({
      requestId,
      action: result.fromCache ? 'cache-hit' : 'execute',
      model: result.model ?? decision.model,
      estimatedCostUsd: decision.estimatedCostUsd,
      actualCostUsd: result.costUsd,
      cacheKey,
      reason: result.fromCache ? 'served from response cache during batch flush' : 'batched invocation executed',
      ...(ctx.trace ? { trace: ctx.trace } : {}),
    });
    return result;
  }

  private async executeDirect(
    ctx: TaskContext,
    requestId: string,
    decision: ModelSelectionDecision,
    cacheKey: string,
    executor: TaskExecutor,
  ): Promise<BatchResult> {
    const result = await executor(ctx.task, decision.model);
    this.cache.store(cacheKey, result.response, result.costUsd, {
      model: decision.model,
      ...(ctx.trace ? { trace: ctx.trace } : {}),
    });
    this.totalCostUsd += result.costUsd;

    const batchResult: BatchResult = {
      requestId,
      response: result.response,
      costUsd: result.costUsd,
      fromCache: false,
      model: decision.model,
      autopilot: this.autopilotMetadata(cacheKey, decision, ctx.trace),
    };
    this.recordDecision({
      requestId,
      action: 'execute',
      model: decision.model,
      estimatedCostUsd: decision.estimatedCostUsd,
      actualCostUsd: result.costUsd,
      cacheKey,
      reason: 'direct invocation executed',
      ...(ctx.trace ? { trace: ctx.trace } : {}),
    });
    return batchResult;
  }

  private autopilotMetadata(
    cacheKey: string,
    decision: ModelSelectionDecision,
    trace?: AutopilotTraceContext,
  ): NonNullable<BatchResult['autopilot']> {
    return {
      cacheKey,
      decision,
      ...(trace ? { trace } : {}),
    };
  }

  private recordDecision(input: Omit<AutopilotDecisionMetric, 'timestamp'>): void {
    const metric: AutopilotDecisionMetric = {
      ...input,
      timestamp: new Date().toISOString(),
    };
    this.recentDecisions.push(metric);
    if (this.recentDecisions.length > 20) {
      this.recentDecisions.splice(0, this.recentDecisions.length - 20);
    }
  }

  getStats(): AutopilotStats {
    const total = this.cacheHits + this.cacheMisses;
    const batchStats = this.aggregator.getStats();
    return {
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      cacheHitRate: total > 0 ? this.cacheHits / total : 0,
      totalBatches: batchStats.totalBatches,
      totalRequests: this.totalRequests,
      estimatedSavingsUsd: this.estimatedSavingsUsd,
      avgCostPerRequest: this.totalRequests > 0 ? this.totalCostUsd / this.totalRequests : 0,
      redundantInvocationsPruned: this.redundantInvocationsPruned,
      budgetDowngrades: this.budgetDowngrades,
      budgetBlocks: this.budgetBlocks,
      activeInvocations: this.inFlight.size,
      modelSelections: { ...this.modelSelections },
      recentDecisions: [...this.recentDecisions],
    };
  }

  clearCache(): void {
    this.cache.clear();
  }
}
