export type ModelTier = 'haiku' | 'sonnet' | 'opus';
export type TaskComplexity = 'low' | 'medium' | 'high';

export interface AutopilotTraceContext {
  traceId?: string;
  spanId?: string;
  cycleId?: string;
  phase?: string;
  agentId?: string;
  taskFingerprint?: string;
  cacheScope?: string;
}

export interface ModelSelectionDecision {
  model: ModelTier;
  estimatedCostUsd: number;
  baselineModel: ModelTier;
  budgetConstrained: boolean;
  downgraded: boolean;
  reason: string;
}

export interface CacheEntry {
  key: string;
  response: unknown;
  costUsd: number;
  createdAt: number;
  expiresAt: number;
  hits: number;
  model?: ModelTier;
  trace?: AutopilotTraceContext;
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
  model: ModelTier;
  cacheKey: string;
  allowSimilarCache: boolean;
  decision: ModelSelectionDecision;
  trace?: AutopilotTraceContext;
}

export interface BatchResult {
  requestId: string;
  response: unknown;
  costUsd: number;
  fromCache: boolean;
  batchId?: string;
  model?: ModelTier;
  pruned?: boolean;
  autopilot?: {
    cacheKey: string;
    decision: ModelSelectionDecision;
    trace?: AutopilotTraceContext;
  };
}

export interface AutopilotDecisionMetric {
  requestId: string;
  action: 'execute' | 'cache-hit' | 'pruned' | 'blocked';
  model?: ModelTier;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  savingsUsd?: number;
  cacheKey?: string;
  reason: string;
  timestamp: string;
  trace?: AutopilotTraceContext;
}

export interface AutopilotStats {
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  totalBatches: number;
  totalRequests: number;
  estimatedSavingsUsd: number;
  avgCostPerRequest: number;
  redundantInvocationsPruned: number;
  budgetDowngrades: number;
  budgetBlocks: number;
  activeInvocations: number;
  modelSelections: Record<ModelTier, number>;
  recentDecisions: AutopilotDecisionMetric[];
}
