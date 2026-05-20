import { ResponseCache } from './response-cache.js';
import { BatchAggregator } from './batch-aggregator.js';
import { BudgetExceededError } from '../cost-governance/budget-enforcer.js';
import type { Span } from '../tracing/span.js';
import type { TraceCollector } from '../tracing/trace-collector.js';
import type {
  AutopilotModelStats,
  AutopilotModelTier,
  AutopilotStats,
  BatchRequest,
  BatchResult,
} from './types.js';

export type ModelTier = AutopilotModelTier;

export interface TaskContext {
  task: string;
  complexity?: 'low' | 'medium' | 'high';
  maxCostUsd?: number;
  allowBatching?: boolean;
}

export type TaskExecutor = (task: string, model: ModelTier) => Promise<{ response: unknown; costUsd: number }>;

export interface CostAutopilotOptions {
  batchWindowMs?: number;
  maxBatch?: number;
  traceCollector?: TraceCollector;
}

const MODEL_COST_FACTOR: Record<ModelTier, number> = {
  haiku: 0.001,
  sonnet: 0.003,
  opus: 0.015,
};

const MODEL_ORDER: ModelTier[] = ['haiku', 'sonnet', 'opus'];

const PREFERRED_MODEL_BY_COMPLEXITY: Record<NonNullable<TaskContext['complexity']>, ModelTier> = {
  low: 'haiku',
  medium: 'sonnet',
  high: 'opus',
};

interface ModelSelection {
  selected: ModelTier;
  estimatedCostUsd: number;
  downgradedByBudget: boolean;
}

interface AutopilotBatchRequest extends BatchRequest {
  executor: TaskExecutor;
  model: ModelTier;
  estimatedCostUsd: number;
  span?: Span;
}

function makeModelStats(): AutopilotModelStats {
  return { haiku: 0, sonnet: 0, opus: 0 };
}

function cacheKey(task: string, model: ModelTier): string {
  return `${model}\n${task}`;
}

function preferredModel(complexity: 'low' | 'medium' | 'high'): ModelTier {
  return PREFERRED_MODEL_BY_COMPLEXITY[complexity];
}

function assertValidBudget(maxCostUsd: number | undefined): void {
  if (maxCostUsd === undefined) return;
  if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0) {
    throw new BudgetExceededError('Autopilot request', MODEL_COST_FACTOR.haiku, 0);
  }
}

function selectModel(complexity: 'low' | 'medium' | 'high', maxCostUsd?: number): ModelSelection {
  assertValidBudget(maxCostUsd);

  const preferred = preferredModel(complexity);
  if (maxCostUsd === undefined || MODEL_COST_FACTOR[preferred] <= maxCostUsd) {
    return {
      selected: preferred,
      estimatedCostUsd: MODEL_COST_FACTOR[preferred],
      downgradedByBudget: false,
    };
  }

  const selected = [...MODEL_ORDER].reverse().find(model => MODEL_COST_FACTOR[model] <= maxCostUsd);
  if (!selected) {
    throw new BudgetExceededError('Autopilot request', MODEL_COST_FACTOR.haiku, maxCostUsd);
  }

  return {
    selected,
    estimatedCostUsd: MODEL_COST_FACTOR[selected],
    downgradedByBudget: selected !== preferred,
  };
}

function toAutopilotBatchRequest(request: BatchRequest): AutopilotBatchRequest {
  const candidate = request as Partial<AutopilotBatchRequest>;
  if (typeof candidate.executor !== 'function') {
    throw new Error(`Autopilot batch request ${request.id} is missing its per-call executor`);
  }
  if (candidate.model !== 'haiku' && candidate.model !== 'sonnet' && candidate.model !== 'opus') {
    throw new Error(`Autopilot batch request ${request.id} is missing its selected model tier`);
  }
  if (typeof candidate.estimatedCostUsd !== 'number' || !Number.isFinite(candidate.estimatedCostUsd)) {
    throw new Error(`Autopilot batch request ${request.id} is missing its estimated cost`);
  }
  return candidate as AutopilotBatchRequest;
}

export class CostAutopilot {
  private cache: ResponseCache;
  private aggregator: BatchAggregator;
  private readonly defaultExecutor: TaskExecutor;
  private readonly traceCollector: TraceCollector | undefined;
  private totalRequests = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private totalCostUsd = 0;
  private estimatedSavingsUsd = 0;
  private executorInvocations = 0;
  private dedupedRequests = 0;
  private budgetRejections = 0;
  private downgradedByBudget = 0;
  private modelDispatches = makeModelStats();
  private executorIds = new WeakMap<TaskExecutor, number>();
  private nextExecutorId = 1;

  constructor(executor: TaskExecutor, options: CostAutopilotOptions = {}) {
    this.defaultExecutor = executor;
    this.traceCollector = options.traceCollector;
    this.cache = new ResponseCache();

    const batchExecutor = async (requests: BatchRequest[]): Promise<BatchResult[]> => {
      const results = new Array<BatchResult | undefined>(requests.length);
      const pendingByKey = new Map<string, { seed: AutopilotBatchRequest; indexes: number[] }>();

      requests.forEach((rawRequest, index) => {
        const req = toAutopilotBatchRequest(rawRequest);
        const cached = this.cache.lookup(cacheKey(req.task, req.model));
        if (cached) {
          this.recordCacheHit(cached.costUsd);
          req.span?.addEvent('cost_autopilot.cache_hit', { model: req.model, stage: 'batch-flush' });
          results[index] = {
            requestId: req.id,
            response: cached.response,
            costUsd: 0,
            fromCache: true,
            model: req.model,
            decision: 'cache-hit',
            estimatedCostUsd: req.estimatedCostUsd,
          };
          return;
        }

        const key = `${cacheKey(req.task, req.model)}\nexecutor:${this.executorIdentity(req.executor)}`;
        const pending = pendingByKey.get(key);
        if (pending) {
          pending.indexes.push(index);
        } else {
          pendingByKey.set(key, { seed: req, indexes: [index] });
        }
      });

      await Promise.all(
        [...pendingByKey.values()].map(async ({ seed, indexes }) => {
          this.recordCacheMiss();
          this.recordDispatch(seed.model);
          const result = await seed.executor(seed.task, seed.model);
          this.cache.store(cacheKey(seed.task, seed.model), result.response, result.costUsd);
          this.totalCostUsd += result.costUsd;

          const firstIndex = indexes[0];
          if (firstIndex !== undefined) {
            results[firstIndex] = {
              requestId: seed.id,
              response: result.response,
              costUsd: result.costUsd,
              fromCache: false,
              model: seed.model,
              decision: 'executed',
              estimatedCostUsd: seed.estimatedCostUsd,
            };
          }

          const duplicateIndexes = indexes.slice(1);
          if (duplicateIndexes.length > 0) {
            this.dedupedRequests += duplicateIndexes.length;
            this.estimatedSavingsUsd += result.costUsd * duplicateIndexes.length;
          }

          for (const duplicateIndex of duplicateIndexes) {
            const duplicateRaw = requests[duplicateIndex];
            if (!duplicateRaw) continue;
            const duplicate = toAutopilotBatchRequest(duplicateRaw);
            duplicate.span?.addEvent('cost_autopilot.deduped', { model: duplicate.model });
            results[duplicateIndex] = {
              requestId: duplicate.id,
              response: result.response,
              costUsd: 0,
              fromCache: false,
              model: duplicate.model,
              decision: 'deduped',
              deduped: true,
              estimatedCostUsd: duplicate.estimatedCostUsd,
            };
          }
        }),
      );

      return results.map((result, index) => {
        if (result) return result;
        const fallback = requests[index];
        return {
          requestId: fallback?.id ?? `missing-${index}`,
          response: null,
          costUsd: 0,
          fromCache: false,
          decision: 'executed',
        };
      });
    };

    this.aggregator = new BatchAggregator(batchExecutor, {
      windowMs: options.batchWindowMs ?? 50,
      maxBatch: options.maxBatch ?? 10,
    });
  }

  async process(ctx: TaskContext, executor: TaskExecutor = this.defaultExecutor): Promise<BatchResult> {
    if (!this.traceCollector) {
      return this.processInternal(ctx, executor);
    }

    return this.traceCollector.withSpan(
      {
        name: 'cost-autopilot.process',
        attributes: {
          'cost_autopilot.task_chars': ctx.task.length,
          'cost_autopilot.complexity': ctx.complexity ?? 'medium',
          'cost_autopilot.allow_batching': ctx.allowBatching === true,
          ...(ctx.maxCostUsd !== undefined ? { 'cost_autopilot.max_cost_usd': ctx.maxCostUsd } : {}),
        },
        serviceName: 'agentforge-core',
      },
      span => this.processInternal(ctx, executor, span),
    );
  }

  private async processInternal(ctx: TaskContext, executor: TaskExecutor, span?: Span): Promise<BatchResult> {
    this.totalRequests++;
    const requestId = `req-${this.totalRequests}`;
    const complexity = ctx.complexity ?? 'medium';
    try {
      assertValidBudget(ctx.maxCostUsd);
    } catch (err) {
      this.budgetRejections++;
      span?.setAttribute('cost_autopilot.decision', 'budget-rejected');
      throw err;
    }

    const preferred = preferredModel(complexity);
    span?.setAttribute('cost_autopilot.request_id', requestId);
    span?.setAttribute('cost_autopilot.preferred_model', preferred);

    // 1. Check same-tier cache before budget downgrades; cached work costs $0.
    const preferredCached = this.cache.lookup(cacheKey(ctx.task, preferred));
    if (preferredCached) {
      this.recordCacheHit(preferredCached.costUsd);
      span?.setAttribute('cost_autopilot.decision', 'cache-hit');
      span?.setAttribute('cost_autopilot.selected_model', preferred);
      return {
        requestId,
        response: preferredCached.response,
        costUsd: 0,
        fromCache: true,
        model: preferred,
        decision: 'cache-hit',
        estimatedCostUsd: MODEL_COST_FACTOR[preferred],
      };
    }

    // 2. Select model tier under the per-request cap before dispatch.
    let selection: ModelSelection;
    try {
      selection = selectModel(complexity, ctx.maxCostUsd);
    } catch (err) {
      this.budgetRejections++;
      span?.setAttribute('cost_autopilot.decision', 'budget-rejected');
      throw err;
    }
    if (selection.downgradedByBudget) this.downgradedByBudget++;
    span?.setAttribute('cost_autopilot.selected_model', selection.selected);
    span?.setAttribute('cost_autopilot.estimated_cost_usd', selection.estimatedCostUsd);
    span?.setAttribute('cost_autopilot.downgraded_by_budget', selection.downgradedByBudget);

    // 3. Check the selected-tier cache after a budget downgrade.
    if (selection.selected !== preferred) {
      const selectedCached = this.cache.lookup(cacheKey(ctx.task, selection.selected));
      if (selectedCached) {
        this.recordCacheHit(selectedCached.costUsd);
        span?.setAttribute('cost_autopilot.decision', 'cache-hit');
        return {
          requestId,
          response: selectedCached.response,
          costUsd: 0,
          fromCache: true,
          model: selection.selected,
          decision: 'cache-hit',
          estimatedCostUsd: selection.estimatedCostUsd,
        };
      }
    }

    // 4. Execute (batch if allowed)
    if (ctx.allowBatching) {
      const req: AutopilotBatchRequest = {
        id: requestId,
        task: ctx.task,
        enqueuedAt: Date.now(),
        executor,
        model: selection.selected,
        estimatedCostUsd: selection.estimatedCostUsd,
        ...(span ? { span } : {}),
      };
      return this.aggregator.enqueue(req);
    }

    // 5. Direct execution
    this.recordCacheMiss();
    this.recordDispatch(selection.selected);
    span?.setAttribute('cost_autopilot.decision', 'executed');
    const result = await executor(ctx.task, selection.selected);
    this.cache.store(cacheKey(ctx.task, selection.selected), result.response, result.costUsd);
    this.totalCostUsd += result.costUsd;

    return {
      requestId,
      response: result.response,
      costUsd: result.costUsd,
      fromCache: false,
      model: selection.selected,
      decision: 'executed',
      estimatedCostUsd: selection.estimatedCostUsd,
    };
  }

  getStats(): AutopilotStats {
    const batchStats = this.aggregator.getStats();
    return {
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      cacheHitRate: this.totalRequests > 0 ? this.cacheHits / this.totalRequests : 0,
      totalBatches: batchStats.totalBatches,
      totalRequests: this.totalRequests,
      estimatedSavingsUsd: this.estimatedSavingsUsd,
      avgCostPerRequest: this.totalRequests > 0 ? this.totalCostUsd / this.totalRequests : 0,
      optimization: {
        executorInvocations: this.executorInvocations,
        dedupedRequests: this.dedupedRequests,
        budgetRejections: this.budgetRejections,
        downgradedByBudget: this.downgradedByBudget,
        modelDispatches: { ...this.modelDispatches },
      },
    };
  }

  clearCache(): void {
    this.cache.clear();
  }

  private recordCacheHit(savedCostUsd: number): void {
    this.cacheHits++;
    this.estimatedSavingsUsd += savedCostUsd;
  }

  private recordCacheMiss(): void {
    this.cacheMisses++;
  }

  private recordDispatch(model: ModelTier): void {
    this.executorInvocations++;
    this.modelDispatches[model]++;
  }

  private executorIdentity(executor: TaskExecutor): number {
    const existing = this.executorIds.get(executor);
    if (existing !== undefined) return existing;
    const id = this.nextExecutorId++;
    this.executorIds.set(executor, id);
    return id;
  }
}
