import { nowIso } from '@agentforge/shared';
import type { SprintRunResult, SprintEvaluation, SprintLoopOptions } from './types.js';

export class SprintEvaluator {
  private readonly testPassRateFloor: number;

  constructor(opts: Pick<SprintLoopOptions, 'testPassRateFloor'> = {}) {
    this.testPassRateFloor = opts.testPassRateFloor ?? 1.0;
  }

  /**
   * Evaluate a sprint run result.
   * In dry-run mode, simulates test counts. In production, would shell out to vitest.
   */
  evaluate(
    runResult: SprintRunResult,
    testsBefore = 2708,
    failuresBefore = 0,
    dryRun = true,
  ): SprintEvaluation {
    let testsAfter: number;
    let failuresAfter: number;

    if (dryRun) {
      // Simulate: completed items add ~3 tests each, failed items add 0
      testsAfter = testsBefore + runResult.itemsCompleted * 3;
      failuresAfter = runResult.itemsFailed > 0 ? failuresBefore + 1 : 0;
    } else {
      // Production: would parse vitest JSON output
      testsAfter = testsBefore;
      failuresAfter = failuresBefore;
    }

    const regression = failuresAfter > failuresBefore || testsAfter < testsBefore;
    const passRate = testsAfter > 0 ? (testsAfter - failuresAfter) / testsAfter : 0;
    const passed = !regression && passRate >= this.testPassRateFloor && runResult.itemsFailed === 0;

    let verdict: SprintEvaluation['verdict'];
    if (passed) {
      verdict = 'ship';
    } else if (regression) {
      verdict = 'revert';
    } else {
      verdict = 'retry';
    }

    const notes = passed
      ? `All ${runResult.itemsCompleted} items completed. ${testsAfter} tests passing. Ready to ship.`
      : regression
      ? `Regression detected: ${failuresAfter} failures (was ${failuresBefore}). Reverting.`
      : `${runResult.itemsFailed} items failed. Retry or deprioritize.`;

    return {
      sprintVersion: runResult.sprintVersion,
      passed,
      testCountBefore: testsBefore,
      testCountAfter: testsAfter,
      testCountDelta: testsAfter - testsBefore,
      failuresBefore,
      failuresAfter,
      regression,
      costUsd: runResult.totalCostUsd,
      verdict,
      notes,
    };
  }
}
