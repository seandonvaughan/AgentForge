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
} from './types.js';
import { nowIso } from '@agentforge/shared';

/**
 * CanaryManager — orchestrates feature flags, traffic splitting, and auto-rollback.
 */
export class CanaryManager {
  private readonly flagManager = new FeatureFlagManager();
  private readonly splitter = new TrafficSplitter();
  private rollbackLog: RollbackResult[] = [];

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
    return this.flagManager.deactivate(id);
  }

  deleteFlag(id: string): boolean {
    return this.flagManager.delete(id);
  }

  // ── Traffic splitting ────────────────────────────────────────────────────────

  /**
   * Route a request through canary splitting.
   * Automatically records the request and checks for auto-rollback.
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
    return result;
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
   * Manually trigger a rollback for a flag.
   */
  performRollback(flagId: string, reason: string): RollbackResult | null {
    const flag = this.flagManager.get(flagId);
    if (!flag) return null;

    const rolled = this.flagManager.markRolledBack(flagId, reason);
    if (!rolled) return null;

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
}
