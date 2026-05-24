import { FeatureFlagManager } from './feature-flag.js';
import { TrafficSplitter } from './traffic-splitter.js';
import type {
  FeatureFlag,
  TrafficSplitResult,
  RollbackResult,
  CanaryMetricsReport,
  CreateFlagRequest,
  UpdateFlagRequest,
  FlagStatus,
  CanaryOutcomeKind,
  VerifiedCanaryOutcomeResult,
} from './types.js';
import { generateId, nowIso } from '@agentforge/shared';

interface PendingCanaryOutcome {
  flagId: string;
  requestId: string;
  outcomeToken: string;
  routedAt: string;
  expiresAtMs: number;
}

export interface CanaryManagerOptions {
  pendingOutcomeTtlMs?: number;
  maxPendingOutcomes?: number;
  nowMs?: () => number;
}

const DEFAULT_PENDING_OUTCOME_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_PENDING_OUTCOMES = 1000;

/**
 * CanaryManager — orchestrates feature flags, traffic splitting, and auto-rollback.
 */
export class CanaryManager {
  private readonly flagManager = new FeatureFlagManager();
  private readonly splitter = new TrafficSplitter();
  private rollbackLog: RollbackResult[] = [];
  private readonly pendingOutcomes = new Map<string, PendingCanaryOutcome>();
  private readonly pendingOutcomeTtlMs: number;
  private readonly maxPendingOutcomes: number;
  private readonly nowMs: () => number;

  constructor(options: CanaryManagerOptions = {}) {
    this.pendingOutcomeTtlMs = this.resolvePositiveInteger(
      options.pendingOutcomeTtlMs,
      DEFAULT_PENDING_OUTCOME_TTL_MS,
    );
    this.maxPendingOutcomes = this.resolvePositiveInteger(
      options.maxPendingOutcomes,
      DEFAULT_MAX_PENDING_OUTCOMES,
    );
    this.nowMs = options.nowMs ?? Date.now;
  }

  // ── Flag management ──────────────────────────────────────────────────────────

  createFlag(req: CreateFlagRequest): FeatureFlag {
    return this.flagManager.create(req);
  }

  getFlag(id: string): FeatureFlag | undefined {
    return this.flagManager.get(id);
  }

  getFlagByName(name: string): FeatureFlag | undefined {
    return this.flagManager.getByName(name);
  }

  listFlags(status?: FlagStatus): FeatureFlag[] {
    return this.flagManager.list(status);
  }

  updateFlag(id: string, updates: UpdateFlagRequest): FeatureFlag | undefined {
    return this.flagManager.update(id, updates);
  }

  activateFlag(id: string): FeatureFlag | undefined {
    return this.flagManager.activate(id);
  }

  deactivateFlag(id: string): FeatureFlag | undefined {
    const flag = this.flagManager.deactivate(id);
    if (flag) {
      this.deletePendingOutcomesForFlag(id);
    }
    return flag;
  }

  deleteFlag(id: string): boolean {
    const deleted = this.flagManager.delete(id);
    if (deleted) {
      this.deletePendingOutcomesForFlag(id);
    }
    return deleted;
  }

  // ── Traffic splitting ────────────────────────────────────────────────────────

  /**
   * Route a request through canary splitting.
   * Canary routes receive a one-use token required for external outcome reports.
   */
  route(flagId: string, requestId: string, headerValue?: string): TrafficSplitResult {
    const flag = this.flagManager.get(flagId);
    if (!flag) {
      return {
        flagId,
        variant: 'control',
        requestId,
        reason: 'Flag not found, routing to control',
      };
    }

    const result = this.splitter.split(flag, requestId, headerValue);
    if (result.variant !== 'canary') {
      return result;
    }

    this.evictExpiredPendingOutcomes();
    const outcomeToken = generateId();
    const pendingKey = this.pendingKey(flagId, requestId);
    this.pendingOutcomes.delete(pendingKey);
    this.pendingOutcomes.set(pendingKey, {
      flagId,
      requestId,
      outcomeToken,
      routedAt: nowIso(),
      expiresAtMs: this.nowMs() + this.pendingOutcomeTtlMs,
    });
    this.enforcePendingOutcomeCap();

    return { ...result, outcomeToken };
  }

  /**
   * Record an outcome for a canary request and check auto-rollback threshold.
   * Returns a RollbackResult if rollback was triggered, undefined otherwise.
   */
  recordOutcome(
    flagId: string,
    isError: boolean,
  ): { flag: FeatureFlag; rollback?: RollbackResult } | undefined {
    const updated = this.flagManager.recordCanaryRequest(flagId, isError);
    if (!updated) return undefined;

    // Check auto-rollback
    if (
      updated.status === 'active' &&
      updated.canaryRequests >= 5 && // Minimum sample size
      updated.errorRate > updated.rollbackThreshold
    ) {
      const rollback = this.performRollback(
        flagId,
        `Auto-rollback: error rate ${(updated.errorRate * 100).toFixed(1)}% exceeds threshold ${(updated.rollbackThreshold * 100).toFixed(1)}%`,
      );
      const currentFlag = this.flagManager.get(flagId);
      if (!currentFlag) return undefined;
      return rollback ? { flag: currentFlag, rollback } : { flag: currentFlag };
    }

    return { flag: updated };
  }

  /**
   * Record an externally reported canary outcome only when it matches a prior
   * canary split decision. Runtime/infrastructure failures are accepted for
   * observability but intentionally excluded from rollback metrics.
   */
  recordVerifiedOutcome(
    flagId: string,
    requestId: string,
    outcomeToken: string,
    outcome: CanaryOutcomeKind,
  ): VerifiedCanaryOutcomeResult {
    this.evictExpiredPendingOutcomes();
    const flag = this.flagManager.get(flagId);
    if (!flag) {
      return {
        ok: false,
        statusCode: 404,
        code: 'FLAG_NOT_FOUND',
        error: 'Flag not found',
      };
    }
    if (flag.status !== 'active') {
      return {
        ok: false,
        statusCode: 409,
        code: 'CANARY_NOT_ACTIVE',
        error: 'Canary flag is not active',
      };
    }

    const pendingKey = this.pendingKey(flagId, requestId);
    const pending = this.pendingOutcomes.get(pendingKey);
    if (!pending || pending.outcomeToken !== outcomeToken) {
      return {
        ok: false,
        statusCode: 403,
        code: 'CANARY_OUTCOME_NOT_AUTHORIZED',
        error: 'Canary outcome was not authorized by a prior canary split decision',
      };
    }

    this.pendingOutcomes.delete(pendingKey);

    if (outcome === 'runtime_error' || outcome === 'infrastructure_error') {
      return {
        ok: true,
        ignored: true,
        outcome,
        flag,
      };
    }

    const result = this.recordOutcome(flagId, outcome === 'behavior_error');
    if (!result) {
      return {
        ok: false,
        statusCode: 404,
        code: 'FLAG_NOT_FOUND',
        error: 'Flag not found',
      };
    }

    return {
      ok: true,
      ignored: false,
      outcome,
      flag: result.flag,
      ...(result.rollback ? { rollback: result.rollback } : {}),
    };
  }

  /**
   * Manually trigger a rollback for a flag.
   */
  performRollback(flagId: string, reason: string): RollbackResult | null {
    const flag = this.flagManager.get(flagId);
    if (!flag) return null;

    const rolled = this.flagManager.markRolledBack(flagId, reason);
    if (!rolled) return null;

    this.deletePendingOutcomesForFlag(flagId);

    const result: RollbackResult = {
      flagId,
      success: true,
      reason,
      errorRate: flag.errorRate,
      threshold: flag.rollbackThreshold,
      rolledBackAt: nowIso(),
    };
    this.rollbackLog.push(result);
    return result;
  }

  // ── Metrics ──────────────────────────────────────────────────────────────────

  getMetrics(flagId: string): CanaryMetricsReport | undefined {
    const flag = this.flagManager.get(flagId);
    if (!flag) return undefined;

    return {
      flagId: flag.id,
      flagName: flag.name,
      status: flag.status,
      trafficPercent: flag.trafficPercent,
      canaryRequests: flag.canaryRequests,
      canaryErrors: flag.canaryErrors,
      errorRate: flag.errorRate,
      rollbackThreshold: flag.rollbackThreshold,
      isHealthy: flag.errorRate <= flag.rollbackThreshold,
    };
  }

  getAllMetrics(): CanaryMetricsReport[] {
    return this.flagManager.list().map(flag => ({
      flagId: flag.id,
      flagName: flag.name,
      status: flag.status,
      trafficPercent: flag.trafficPercent,
      canaryRequests: flag.canaryRequests,
      canaryErrors: flag.canaryErrors,
      errorRate: flag.errorRate,
      rollbackThreshold: flag.rollbackThreshold,
      isHealthy: flag.errorRate <= flag.rollbackThreshold,
    }));
  }

  getRollbackLog(): RollbackResult[] {
    return [...this.rollbackLog];
  }

  flagCount(): number {
    return this.flagManager.count();
  }

  pendingOutcomeCount(): number {
    this.evictExpiredPendingOutcomes();
    return this.pendingOutcomes.size;
  }

  private deletePendingOutcomesForFlag(flagId: string): void {
    for (const [key, pending] of this.pendingOutcomes.entries()) {
      if (pending.flagId === flagId) {
        this.pendingOutcomes.delete(key);
      }
    }
  }

  private evictExpiredPendingOutcomes(nowMs = this.nowMs()): void {
    for (const [key, pending] of this.pendingOutcomes.entries()) {
      if (pending.expiresAtMs <= nowMs) {
        this.pendingOutcomes.delete(key);
      }
    }
  }

  private enforcePendingOutcomeCap(): void {
    while (this.pendingOutcomes.size > this.maxPendingOutcomes) {
      const oldestKey = this.pendingOutcomes.keys().next().value as string | undefined;
      if (!oldestKey) return;
      this.pendingOutcomes.delete(oldestKey);
    }
  }

  private resolvePositiveInteger(value: number | undefined, fallback: number): number {
    if (!Number.isFinite(value) || value === undefined || value <= 0) {
      return fallback;
    }
    return Math.floor(value);
  }

  private pendingKey(flagId: string, requestId: string): string {
    return `${flagId}:${requestId}`;
  }
}
