import { nowIso } from '@agentforge/shared';
import type { SprintPlan, SprintRunResult, SprintLoopOptions } from './types.js';

export class SprintRunner {
  private readonly opts: Required<SprintLoopOptions>;

  constructor(opts: SprintLoopOptions = {}) {
    this.opts = {
      dryRun: opts.dryRun ?? true,
      sprintBudgetUsd: opts.sprintBudgetUsd ?? 5.00,
      autoApprove: opts.autoApprove ?? false,
      autoApproveThreshold: opts.autoApproveThreshold ?? 0.7,
      testPassRateFloor: opts.testPassRateFloor ?? 1.0,
    };
  }

  async run(plan: SprintPlan): Promise<SprintRunResult> {
    const t0 = Date.now();
    let totalCostUsd = 0;
    let completed = 0;
    let failed = 0;

    for (const item of plan.items) {
      if (totalCostUsd >= this.opts.sprintBudgetUsd) {
        break; // budget ceiling — stop executing
      }

      item.status = 'in_progress';

      try {
        if (this.opts.dryRun) {
          // Simulate execution — cost proportional to complexity
          const cost = item.priority === 'P0' ? 0.15 : item.priority === 'P1' ? 0.08 : 0.03;
          totalCostUsd += cost;
          await new Promise(r => setTimeout(r, 5));
          item.status = 'completed';
          completed++;
        } else {
          // Production: ProposalExecutor integration point
          throw new Error('Production execution not yet wired — use dryRun: true');
        }
      } catch (err) {
        item.status = 'failed';
        failed++;
      }
    }

    return {
      sprintVersion: plan.version,
      itemsAttempted: plan.items.length,
      itemsCompleted: completed,
      itemsFailed: failed,
      totalCostUsd,
      durationMs: Date.now() - t0,
      completedAt: nowIso(),
    };
  }
}
