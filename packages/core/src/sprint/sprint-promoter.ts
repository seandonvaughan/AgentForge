import { nowIso } from '@agentforge/shared';
import type { SprintPlan, SprintEvaluation } from './types.js';

export interface PromotionResult {
  promoted: boolean;
  newVersion: string;
  reason: string;
  nextSprintVersion: string;
  promotedAt: string;
}

export class SprintPromoter {
  /** Decide whether to promote based on evaluation verdict, then return promotion result. */
  promote(plan: SprintPlan, evaluation: SprintEvaluation): PromotionResult {
    const promoted = evaluation.verdict === 'ship';
    const [major, minor] = plan.version.split('.').map(Number);

    const nextMinor = (minor ?? 0) + 1;
    const nextVersion = promoted
      ? `${major ?? 5}.${nextMinor}`
      : plan.version; // re-use same version on retry/revert

    return {
      promoted,
      newVersion: plan.version,
      reason: evaluation.notes,
      nextSprintVersion: nextVersion,
      promotedAt: nowIso(),
    };
  }

  /**
   * Full autonomous loop iteration:
   *   plan → run → evaluate → promote → return
   */
  async runCycle(
    plan: SprintPlan,
    runner: import('./sprint-runner.js').SprintRunner,
    evaluator: import('./sprint-evaluator.js').SprintEvaluator,
    testsBefore?: number,
    dryRun = true,
  ): Promise<{ run: import('./types.js').SprintRunResult; evaluation: SprintEvaluation; promotion: PromotionResult }> {
    const run = await runner.run(plan);
    const evaluation = evaluator.evaluate(run, testsBefore, 0, dryRun);
    const promotion = this.promote(plan, evaluation);
    return { run, evaluation, promotion };
  }
}
