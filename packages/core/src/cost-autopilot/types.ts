export interface CacheEntry {
  key: string;
  response: unknown;
  costUsd: number;
  createdAt: number;
  expiresAt: number;
  hits: number;
}

export interface CacheConfig {
  ttlMs: number;
  maxEntries: number;
  similarityThreshold: number;
}

export type AutopilotModelTier = 'haiku' | 'sonnet' | 'opus';

export type AutopilotDecision = 'cache-hit' | 'executed' | 'deduped';

export interface BatchRequest {
  id: string;
  task: string;
  enqueuedAt: number;
}

export interface BatchResult {
  requestId: string;
  response: unknown;
  costUsd: number;
  fromCache: boolean;
  batchId?: string;
  model?: AutopilotModelTier;
  decision?: AutopilotDecision;
  deduped?: boolean;
  estimatedCostUsd?: number;
}

export type AutopilotModelStats = Record<AutopilotModelTier, number>;

export interface AutopilotOptimizationStats {
  executorInvocations: number;
  dedupedRequests: number;
  budgetRejections: number;
  downgradedByBudget: number;
  modelDispatches: AutopilotModelStats;
}

export interface AutopilotStats {
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  totalBatches: number;
  totalRequests: number;
  estimatedSavingsUsd: number;
  avgCostPerRequest: number;
  optimization: AutopilotOptimizationStats;
}
