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
  /** One-use token required when recording metrics for a routed canary request. */
  outcomeToken?: string;
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
  id?: string;
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

export type CanaryOutcomeKind =
  | 'success'
  | 'behavior_error'
  | 'runtime_error'
  | 'infrastructure_error';

export interface VerifiedCanaryOutcomeAccepted {
  ok: true;
  ignored: boolean;
  outcome: CanaryOutcomeKind;
  flag: FeatureFlag;
  rollback?: RollbackResult;
}

export interface VerifiedCanaryOutcomeRejected {
  ok: false;
  statusCode: 400 | 403 | 404 | 409;
  code: string;
  error: string;
}

export type VerifiedCanaryOutcomeResult =
  | VerifiedCanaryOutcomeAccepted
  | VerifiedCanaryOutcomeRejected;
