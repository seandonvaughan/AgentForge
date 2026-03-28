import type { RegressionReport } from './types.js';

export class RegressionDetector {
  /**
   * Compare pre/post sprint metrics to detect regressions.
   * A regression is any increase in failures or decrease in total test count.
   */
  compare(
    before: { testCount: number; failureCount: number },
    after: { testCount: number; failureCount: number },
  ): RegressionReport {
    const testDelta = after.testCount - before.testCount;
    const failureDelta = after.failureCount - before.failureCount;

    const detected = failureDelta > 0 || testDelta < 0;

    let reason: string | undefined;
    if (failureDelta > 0) {
      reason = `${failureDelta} new test failure(s) introduced`;
    } else if (testDelta < 0) {
      reason = `${Math.abs(testDelta)} test(s) removed`;
    }

    return {
      detected,
      testCountBefore: before.testCount,
      testCountAfter: after.testCount,
      failuresBefore: before.failureCount,
      failuresAfter: after.failureCount,
      delta: testDelta,
      reason,
    };
  }
}
