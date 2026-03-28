/** Canary Deployment & Feature Flag types */

export type FlagStatus = 'inactive' | 'active' | 'rolled_back';
export type TrafficSplitStrategy = 'percentage' | 'hash' | 'header';

export interface FeatureFlag {
  id: string;
  name: string;
  description?: string;
  status: FlagStatus;
  /** Percentage of traffic (0-100) routed to canary variant */
  trafficPercent: number;
  /** Strategy for splitting traffic */
  strategy: TrafficSplitStrategy;
  /** Auto-rollback threshold: error rate (0-1) that triggers rollback */
  rollbackThreshold: number;
  /** Current error rate observed for this flag */
  errorRate: number;
  /** Number of requests routed to canary */
  canaryRequests: number;
  /** Number of errors on canary */
  canaryErrors: number;
  createdAt: string;
  updatedAt: string;
  rolledBackAt?: string;
  rollbackReason?: string;
}

export interface TrafficSplitResult {
  flagId: string;
  variant: 'control' | 'canary';
  requestId: string;
  reason: string;
}

export interface RollbackResult {
  flagId: string;
  success: boolean;
  reason: string;
  errorRate: number;
  threshold: number;
  rolledBackAt: string;
}

export interface CreateFlagRequest {
  name: string;
  description?: string;
  trafficPercent?: number;
  strategy?: TrafficSplitStrategy;
  rollbackThreshold?: number;
}

export interface UpdateFlagRequest {
  trafficPercent?: number;
  status?: FlagStatus;
  rollbackThreshold?: number;
}

export interface CanaryMetricsReport {
  flagId: string;
  flagName: string;
  status: FlagStatus;
  trafficPercent: number;
  canaryRequests: number;
  canaryErrors: number;
  errorRate: number;
  rollbackThreshold: number;
  isHealthy: boolean;
}
