// packages/core/src/autonomous/kill-switch.ts
// Centralized safety monitor for the autonomous development cycle.
// Sticky state: once tripped, all checks return the same trip object.
// See docs/superpowers/specs/2026-04-06-autonomous-loop-design.md §8.4
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CycleConfig, KillReason, KillSwitchTrip, TestResult } from './types.js';
import { CycleStage } from './types.js';

export interface RegressionResult {
  detected: boolean;
  reason: string;
}

export class KillSwitch {
  private trippedState: KillSwitchTrip | null = null;
  private readonly stopFilePath: string;

  constructor(
    private readonly config: CycleConfig,
    private readonly cycleId: string,
    private readonly cycleStartedAt: number,
    private readonly cwd: string,
  ) {
    this.stopFilePath = join(
      cwd,
      config.safety.stopFilePath.replace('{cycleId}', cycleId),
    );
    this.installSignalHandlers();
  }

  /** Called by PhaseScheduler between every phase. */
  checkBetweenPhases(state: {
    cumulativeCostUsd: number;
    consecutiveFailures: number;
  }): KillSwitchTrip | null {
    if (this.trippedState) return this.trippedState;

    if (existsSync(this.stopFilePath)) {
      return this.trip('manualStopFile', `STOP file at ${this.stopFilePath}`, CycleStage.RUN);
    }

    if (state.cumulativeCostUsd >= this.config.budget.perCycleUsd) {
      return this.trip(
        'budget',
        `Cumulative cost $${state.cumulativeCostUsd.toFixed(2)} exceeds limit $${this.config.budget.perCycleUsd}`,
        CycleStage.RUN,
      );
    }

    const elapsedMin = (Date.now() - this.cycleStartedAt) / 60000;
    if (elapsedMin >= this.config.limits.maxDurationMinutes) {
      return this.trip(
        'duration',
        `Duration ${elapsedMin.toFixed(1)}m exceeds limit ${this.config.limits.maxDurationMinutes}m`,
        CycleStage.RUN,
      );
    }

    if (state.consecutiveFailures >= this.config.limits.maxConsecutiveFailures) {
      return this.trip(
        'consecutiveFailures',
        `${state.consecutiveFailures} consecutive failures (limit ${this.config.limits.maxConsecutiveFailures})`,
        CycleStage.RUN,
      );
    }

    return null;
  }

  /** Called after real test run in VERIFY stage. */
  checkPostVerify(testResult: TestResult, regression: RegressionResult): KillSwitchTrip | null {
    if (this.trippedState) return this.trippedState;

    if (testResult.passRate < this.config.quality.testPassRateFloor) {
      return this.trip(
        'testFloor',
        `Pass rate ${(testResult.passRate * 100).toFixed(1)}% below floor ${(this.config.quality.testPassRateFloor * 100).toFixed(1)}%`,
        CycleStage.VERIFY,
      );
    }

    if (regression.detected && !this.config.quality.allowRegression) {
      return this.trip('regression', regression.reason, CycleStage.VERIFY);
    }

    return null;
  }

  /** Check after build command. */
  checkBuildResult(result: { success: boolean; error?: string }): KillSwitchTrip | null {
    if (this.trippedState) return this.trippedState;
    if (!result.success && this.config.quality.requireBuildSuccess) {
      return this.trip('buildFailure', result.error ?? 'build failed', CycleStage.VERIFY);
    }
    return null;
  }

  /** Check after typecheck command. */
  checkTypeCheckResult(result: { success: boolean; error?: string }): KillSwitchTrip | null {
    if (this.trippedState) return this.trippedState;
    if (!result.success && this.config.quality.requireTypeCheckSuccess) {
      return this.trip('typeCheckFailure', result.error ?? 'typecheck failed', CycleStage.VERIFY);
    }
    return null;
  }

  /** Manual trip; idempotent — returns existing trip if already tripped. */
  trip(reason: KillReason, detail: string, stage: CycleStage): KillSwitchTrip {
    if (this.trippedState) return this.trippedState;
    this.trippedState = {
      reason,
      detail,
      triggeredAt: new Date().toISOString(),
      stageAtTrip: stage,
    };
    return this.trippedState;
  }

  isTripped(): boolean {
    return this.trippedState !== null;
  }

  getTrip(): KillSwitchTrip | null {
    return this.trippedState;
  }

  /** Install SIGINT/SIGTERM handlers that trip on receipt. */
  installSignalHandlers(): void {
    const handler = (sig: string) => {
      this.trip('manualStop', `Received ${sig}`, CycleStage.RUN);
    };
    process.once('SIGINT', () => handler('SIGINT'));
    process.once('SIGTERM', () => handler('SIGTERM'));
  }
}
