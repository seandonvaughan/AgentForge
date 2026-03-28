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
}

export interface AutopilotStats {
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  totalBatches: number;
  totalRequests: number;
  estimatedSavingsUsd: number;
  avgCostPerRequest: number;
}
