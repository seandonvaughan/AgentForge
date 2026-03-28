import { ResponseCache } from './response-cache.js';
import { BatchAggregator } from './batch-aggregator.js';
import type { AutopilotStats, BatchRequest, BatchResult } from './types.js';

export type ModelTier = 'haiku' | 'sonnet' | 'opus';

export interface TaskContext {
  task: string;
  complexity?: 'low' | 'medium' | 'high';
  maxCostUsd?: number;
  allowBatching?: boolean;
}

export type TaskExecutor = (task: string, model: ModelTier) => Promise<{ response: unknown; costUsd: number }>;

const MODEL_COST_FACTOR: Record<ModelTier, number> = {
  haiku: 0.001,
  sonnet: 0.003,
  opus: 0.015,
};

function selectModel(complexity: 'low' | 'medium' | 'high', maxCostUsd?: number): ModelTier {
  if (complexity === 'low') return 'haiku';
  if (complexity === 'medium') return 'sonnet';

  // High complexity — use opus unless budget constrained
  if (maxCostUsd !== undefined && maxCostUsd < MODEL_COST_FACTOR.opus) {
    return maxCostUsd < MODEL_COST_FACTOR.sonnet ? 'haiku' : 'sonnet';
  }
  return 'opus';
}

export class CostAutopilot {
  private cache: ResponseCache;
  private aggregator: BatchAggregator;
  private totalRequests = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private totalCostUsd = 0;
  private estimatedSavingsUsd = 0;

  constructor(executor: TaskExecutor) {
    this.cache = new ResponseCache();

    const batchExecutor = async (requests: BatchRequest[]): Promise<BatchResult[]> => {
      return Promise.all(
        requests.map(async (req) => {
          const cached = this.cache.lookup(req.task);
          if (cached) {
            this.estimatedSavingsUsd += cached.costUsd;
            return {
              requestId: req.id,
              response: cached.response,
              costUsd: 0,
              fromCache: true,
            };
          }
          const result = await executor(req.task, 'sonnet');
          this.cache.store(req.task, result.response, result.costUsd);
          this.totalCostUsd += result.costUsd;
          return {
            requestId: req.id,
            response: result.response,
            costUsd: result.costUsd,
            fromCache: false,
          };
        }),
      );
    };

    this.aggregator = new BatchAggregator(batchExecutor, { windowMs: 50, maxBatch: 10 });
  }

  async process(ctx: TaskContext, executor: TaskExecutor): Promise<BatchResult> {
    this.totalRequests++;

    // 1. Check cache
    const cached = this.cache.lookup(ctx.task);
    if (cached) {
      this.cacheHits++;
      this.estimatedSavingsUsd += cached.costUsd;
      return {
        requestId: `req-${this.totalRequests}`,
        response: cached.response,
        costUsd: 0,
        fromCache: true,
      };
    }

    this.cacheMisses++;

    // 2. Select model tier
    const model = selectModel(ctx.complexity ?? 'medium', ctx.maxCostUsd);

    // 3. Execute (batch if allowed)
    if (ctx.allowBatching) {
      const req: BatchRequest = {
        id: `req-${this.totalRequests}`,
        task: ctx.task,
        enqueuedAt: Date.now(),
      };
      return this.aggregator.enqueue(req);
    }

    // 4. Direct execution
    const result = await executor(ctx.task, model);
    this.cache.store(ctx.task, result.response, result.costUsd);
    this.totalCostUsd += result.costUsd;

    return {
      requestId: `req-${this.totalRequests}`,
      response: result.response,
      costUsd: result.costUsd,
      fromCache: false,
    };
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
    };
  }

  clearCache(): void {
    this.cache.clear();
  }
}
