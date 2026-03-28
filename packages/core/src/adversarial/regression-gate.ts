import { nowIso } from '@agentforge/shared';
import type { RegressionGateResult } from './types.js';

export interface TestSnapshot {
  totalTests: number;
  failingTests: number;
  timestamp: string;
  label?: string;
}

/**
 * RegressionGate — compares test snapshots before/after a change and blocks
 * promotion if tests have regressed.
 */
export class RegressionGate {
  private snapshots: TestSnapshot[] = [];
  private gateHistory: RegressionGateResult[] = [];

  // ── Snapshot management ──────────────────────────────────────────────────────

  /**
   * Record a test snapshot.
   */
  record(totalTests: number, failingTests: number, label?: string): TestSnapshot {
    const snapshot: TestSnapshot = {
      totalTests,
      failingTests,
      timestamp: nowIso(),
      label,
    };
    this.snapshots.push(snapshot);
    return snapshot;
  }

  /**
   * Get the most recent snapshot.
   */
  latest(): TestSnapshot | undefined {
    return this.snapshots[this.snapshots.length - 1];
  }

  /**
   * Get all snapshots.
   */
  listSnapshots(): TestSnapshot[] {
    return [...this.snapshots];
  }

  // ── Gate evaluation ──────────────────────────────────────────────────────────

  /**
   * Evaluate whether promotion should be blocked based on two snapshots.
   * Gate passes if:
   *  1. Test count has not decreased (no tests were deleted to hide failures)
   *  2. Failure count has not increased
   */
  evaluate(before: TestSnapshot, after: TestSnapshot): RegressionGateResult {
    const delta = after.totalTests - before.totalTests;
    const failureDelta = after.failingTests - before.failingTests;

    let passed = true;
    let reason: string | undefined;

    if (delta < 0) {
      passed = false;
      reason = `Test count decreased by ${Math.abs(delta)} (${before.totalTests} → ${after.totalTests}). Tests may have been deleted to hide failures.`;
    } else if (failureDelta > 0) {
      passed = false;
      reason = `Failure count increased by ${failureDelta} (${before.failingTests} → ${after.failingTests}).`;
    } else if (after.failingTests > 0 && before.failingTests === 0) {
      passed = false;
      reason = `New failures introduced: ${after.failingTests} tests now failing.`;
    }

    const result: RegressionGateResult = {
      passed,
      testsBefore: before.totalTests,
      testsAfter: after.totalTests,
      delta,
      failuresBefore: before.failingTests,
      failuresAfter: after.failingTests,
      failureDelta,
      reason,
      blockedAt: passed ? undefined : nowIso(),
    };

    this.gateHistory.push(result);
    return result;
  }

  /**
   * Evaluate using the last two recorded snapshots.
   */
  evaluateLatest(): RegressionGateResult | null {
    if (this.snapshots.length < 2) return null;
    const before = this.snapshots[this.snapshots.length - 2];
    const after = this.snapshots[this.snapshots.length - 1];
    return this.evaluate(before, after);
  }

  /**
   * Check if a specific test count and failure count would pass the gate
   * compared to the latest snapshot.
   */
  check(totalTests: number, failingTests: number): RegressionGateResult | null {
    const before = this.latest();
    if (!before) {
      // No baseline — record as baseline and pass
      const snapshot = this.record(totalTests, failingTests, 'initial');
      return {
        passed: true,
        testsBefore: 0,
        testsAfter: totalTests,
        delta: totalTests,
        failuresBefore: 0,
        failuresAfter: failingTests,
        failureDelta: failingTests,
      };
    }
    const after = this.record(totalTests, failingTests, 'check');
    return this.evaluate(before, after);
  }

  getGateHistory(): RegressionGateResult[] {
    return [...this.gateHistory];
  }

  /**
   * Reset all state — useful for testing.
   */
  reset(): void {
    this.snapshots = [];
    this.gateHistory = [];
  }
}
