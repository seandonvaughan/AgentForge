import { describe, expect, it } from 'vitest';
import { SprintRunner } from '../sprint-runner.js';
import type { SprintPlan } from '../types.js';

describe('SprintRunner execution modes', () => {
  it('keeps dry-run execution as the default', async () => {
    const plan = buildPlan();
    const result = await new SprintRunner().run(plan);

    expect(result.itemsCompleted).toBe(1);
    expect(result.itemsFailed).toBe(0);
    expect(plan.items[0]?.status).toBe('completed');
  });

  it('uses an injected executor when dryRun is false', async () => {
    const plan = buildPlan();
    const calls: string[] = [];
    const result = await new SprintRunner({
      dryRun: false,
      executor: {
        async executeSprintItem({ item }) {
          calls.push(item.id);
          return { success: true, costUsd: 0.25, output: 'done' };
        },
      },
    }).run(plan);

    expect(calls).toEqual(['item-1']);
    expect(result.itemsCompleted).toBe(1);
    expect(result.totalCostUsd).toBe(0.25);
    expect(plan.items[0]?.status).toBe('completed');
  });

  it('fails items when dryRun is false without an executor', async () => {
    const plan = buildPlan();
    const result = await new SprintRunner({ dryRun: false }).run(plan);

    expect(result.itemsCompleted).toBe(0);
    expect(result.itemsFailed).toBe(1);
    expect(plan.items[0]?.status).toBe('failed');
  });
});

function buildPlan(): SprintPlan {
  return {
    version: '1.0',
    name: 'Test sprint',
    plannedAt: '2026-04-30T00:00:00.000Z',
    budgetUsd: 1,
    source: 'human',
    items: [
      {
        id: 'item-1',
        priority: 'P1',
        title: 'Implement runtime path',
        description: 'Use a real executor',
        status: 'pending',
      },
    ],
  };
}
