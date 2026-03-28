/** Configuration for RetryPolicy. */
export interface RetryPolicyConfig {
  /** Maximum number of attempts (including the first). Default: 3 */
  maxAttempts?: number;
  /** Initial delay in ms before first retry. Default: 100 */
  initialDelayMs?: number;
  /** Exponential backoff multiplier. Default: 2 */
  backoffMultiplier?: number;
  /** Maximum delay cap in ms. Default: 10000 */
  maxDelayMs?: number;
  /** Jitter fraction (0–1) applied to each delay. Default: 0.2 */
  jitterFraction?: number;
  /** Predicate to decide whether to retry a given error. Default: always retry */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
}

/** Configuration for TimeoutWrapper. */
export interface TimeoutConfig {
  /** Timeout in milliseconds. Default: 5000 */
  timeoutMs?: number;
}

/** Per-service health record maintained by HealthMonitor. */
export interface ServiceHealth {
  service: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  /** Current success rate as a fraction 0–1. */
  successRate: number;
  /** Whether the service circuit is currently open (suspended). */
  circuitOpen: boolean;
  /** ISO timestamp of last failure, if any. */
  lastFailureAt?: string;
  /** ISO timestamp of last success, if any. */
  lastSuccessAt?: string;
  /** When this service's circuit was opened, if open. */
  circuitOpenedAt?: string;
}

/** Configuration for HealthMonitor. */
export interface HealthMonitorConfig {
  /**
   * Failure rate (0–1) above which the circuit auto-opens.
   * Default: 0.5 (50%)
   */
  failureRateThreshold?: number;
  /**
   * Rolling window in milliseconds to evaluate the failure rate.
   * Default: 30000 (30 s)
   */
  windowMs?: number;
  /**
   * Minimum calls in window before circuit-open is evaluated.
   * Default: 5
   */
  minCallsBeforeOpen?: number;
}

/** Summary returned by HealthMonitor.summary(). */
export interface HealthSummary {
  services: ServiceHealth[];
  healthyCount: number;
  degradedCount: number;
  timestamp: string;
}
