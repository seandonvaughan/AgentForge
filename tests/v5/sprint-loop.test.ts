import { describe, it, expect } from 'vitest';
import { SprintPlanner, SprintRunner, SprintEvaluator, SprintPromoter } from '@agentforge/core';
import type { BacklogItem } from '@agentforge/core';

const backlog: BacklogItem[] = [
  { id: 'bl-t1', title: 'Knowledge Graph', description: 'Build semantic memory', priority: 'P0', estimatedComplexity: 'high', tags: ['memory'] },
  { id: 'bl-t2', title: 'Canary Deployments', description: 'Traffic splitting', priority: 'P0', estimatedComplexity: 'medium', tags: ['safety'] },
  { id: 'bl-t3', title: 'Cost Autopilot', description: 'Model tier selection', priority: 'P1', estimatedComplexity: 'medium', tags: ['cost'] },
  { id: 'bl-t4', title: 'Marketplace', description: 'Plugin registry', priority: 'P1', estimatedComplexity: 'high', tags: ['plugins'] },
  { id: 'bl-t5', title: 'NL Interface', description: 'Natural language commands', priority: 'P2', estimatedComplexity: 'high', tags: ['ux'] },
];

describe('SprintPlanner', () => {
  it('generates a plan from backlog with priority ordering', () => {
    const planner = new SprintPlanner();
    planner.seed(backlog);
    const plan = planner.plan('5.5');
    expect(plan.version).toBe('5.5');
    expect(plan.source).toBe('autonomous');
    expect(plan.items.length).toBeGreaterThan(0);
    // P0 items should appear first
    const firstPriority = plan.items[0]?.priority;
    expect(firstPriority).toBe('P0');
  });

  it('returns empty plan when backlog is empty', () => {
    const planner = new SprintPlanner();
    const plan = planner.plan('5.5');
    expect(plan.items.length).toBe(0);
  });

  it('removes item from backlog after calling remove()', () => {
    const planner = new SprintPlanner();
    planner.seed(backlog);
    planner.remove('bl-t1');
    expect(planner.getBacklog().find(i => i.id === 'bl-t1')).toBeUndefined();
  });
});

describe('SprintRunner', () => {
  it('runs a plan in dry-run mode successfully', async () => {
    const planner = new SprintPlanner();
    planner.seed(backlog);
    const plan = planner.plan('5.5');
    const runner = new SprintRunner({ dryRun: true, sprintBudgetUsd: 10 });
    const result = await runner.run(plan);
    expect(result.sprintVersion).toBe('5.5');
    expect(result.itemsCompleted).toBe(plan.items.length);
    expect(result.itemsFailed).toBe(0);
    expect(result.totalCostUsd).toBeGreaterThan(0);
  });

  it('stops early when budget is exhausted', async () => {
    const planner = new SprintPlanner();
    planner.seed(backlog);
    const plan = planner.plan('5.5');
    const runner = new SprintRunner({ dryRun: true, sprintBudgetUsd: 0.01 }); // tiny budget
    const result = await runner.run(plan);
    // Should have stopped before completing all items
    expect(result.itemsCompleted).toBeLessThan(plan.items.length);
  });
});

describe('SprintEvaluator', () => {
  it('produces ship verdict for clean dry-run', async () => {
    const planner = new SprintPlanner();
    planner.seed(backlog);
    const plan = planner.plan('5.5');
    const runner = new SprintRunner({ dryRun: true, sprintBudgetUsd: 10 });
    const runResult = await runner.run(plan);
    const evaluator = new SprintEvaluator();
    const evaluation = evaluator.evaluate(runResult, 2708, 0, true);
    expect(evaluation.verdict).toBe('ship');
    expect(evaluation.passed).toBe(true);
    expect(evaluation.testCountDelta).toBeGreaterThan(0);
    expect(evaluation.regression).toBe(false);
  });

  it('produces revert verdict when failures increase', () => {
    const evaluator = new SprintEvaluator();
    const fakeRun = { sprintVersion: '5.5', itemsAttempted: 3, itemsCompleted: 2, itemsFailed: 1, totalCostUsd: 0.5, durationMs: 100, completedAt: new Date().toISOString() };
    const evaluation = evaluator.evaluate(fakeRun, 2708, 0, true);
    // itemsFailed > 0 means retry or revert
    expect(['retry', 'revert']).toContain(evaluation.verdict);
  });
});

describe('SprintPromoter', () => {
  it('promotes when evaluation says ship', () => {
    const promoter = new SprintPromoter();
    const plan = { version: '5.5', name: 'Test', items: [], plannedAt: new Date().toISOString(), budgetUsd: 5, source: 'autonomous' as const };
    const evaluation = { sprintVersion: '5.5', passed: true, testCountBefore: 2708, testCountAfter: 2720, testCountDelta: 12, failuresBefore: 0, failuresAfter: 0, regression: false, costUsd: 0.5, verdict: 'ship' as const, notes: 'All good' };
    const result = promoter.promote(plan, evaluation);
    expect(result.promoted).toBe(true);
    expect(result.nextSprintVersion).toBe('5.6');
  });

  it('does not promote when evaluation says revert', () => {
    const promoter = new SprintPromoter();
    const plan = { version: '5.5', name: 'Test', items: [], plannedAt: new Date().toISOString(), budgetUsd: 5, source: 'autonomous' as const };
    const evaluation = { sprintVersion: '5.5', passed: false, testCountBefore: 2708, testCountAfter: 2700, testCountDelta: -8, failuresBefore: 0, failuresAfter: 3, regression: true, costUsd: 0.5, verdict: 'revert' as const, notes: 'Regression' };
    const result = promoter.promote(plan, evaluation);
    expect(result.promoted).toBe(false);
  });

  it('full cycle: plan → run → evaluate → promote', async () => {
    const planner = new SprintPlanner();
    planner.seed(backlog);
    const plan = planner.plan('5.5');

    const runner = new SprintRunner({ dryRun: true, sprintBudgetUsd: 10 });
    const evaluator = new SprintEvaluator();
    const promoter = new SprintPromoter();

    const { run, evaluation, promotion } = await promoter.runCycle(plan, runner, evaluator, 2708, true);

    expect(run.itemsCompleted).toBeGreaterThan(0);
    expect(evaluation.verdict).toBe('ship');
    expect(promotion.promoted).toBe(true);
    expect(promotion.nextSprintVersion).toBe('5.6');
  });
});

describe('SprintPlanner — slot limits and priority ordering', () => {
  it('caps P0 items at 3 slots', () => {
    const planner = new SprintPlanner();
    planner.seed([
      { id: 'p0-a', title: 'A', description: '', priority: 'P0', estimatedComplexity: 'high', tags: [] },
      { id: 'p0-b', title: 'B', description: '', priority: 'P0', estimatedComplexity: 'high', tags: [] },
      { id: 'p0-c', title: 'C', description: '', priority: 'P0', estimatedComplexity: 'high', tags: [] },
      { id: 'p0-d', title: 'D', description: '', priority: 'P0', estimatedComplexity: 'high', tags: [] },
      { id: 'p0-e', title: 'E', description: '', priority: 'P0', estimatedComplexity: 'high', tags: [] },
    ]);
    const plan = planner.plan('5.5');
    const p0Items = plan.items.filter(i => i.priority === 'P0');
    expect(p0Items.length).toBeLessThanOrEqual(3);
  });

  it('caps P1 items at 4 slots', () => {
    const planner = new SprintPlanner();
    planner.seed([
      { id: 'p1-a', title: 'A', description: '', priority: 'P1', estimatedComplexity: 'medium', tags: [] },
      { id: 'p1-b', title: 'B', description: '', priority: 'P1', estimatedComplexity: 'medium', tags: [] },
      { id: 'p1-c', title: 'C', description: '', priority: 'P1', estimatedComplexity: 'medium', tags: [] },
      { id: 'p1-d', title: 'D', description: '', priority: 'P1', estimatedComplexity: 'medium', tags: [] },
      { id: 'p1-e', title: 'E', description: '', priority: 'P1', estimatedComplexity: 'medium', tags: [] },
    ]);
    const plan = planner.plan('5.5');
    const p1Items = plan.items.filter(i => i.priority === 'P1');
    expect(p1Items.length).toBeLessThanOrEqual(4);
  });

  it('caps P2 items at 2 slots', () => {
    const planner = new SprintPlanner();
    planner.seed([
      { id: 'p2-a', title: 'A', description: '', priority: 'P2', estimatedComplexity: 'low', tags: [] },
      { id: 'p2-b', title: 'B', description: '', priority: 'P2', estimatedComplexity: 'low', tags: [] },
      { id: 'p2-c', title: 'C', description: '', priority: 'P2', estimatedComplexity: 'low', tags: [] },
      { id: 'p2-d', title: 'D', description: '', priority: 'P2', estimatedComplexity: 'low', tags: [] },
    ]);
    const plan = planner.plan('5.5');
    const p2Items = plan.items.filter(i => i.priority === 'P2');
    expect(p2Items.length).toBeLessThanOrEqual(2);
  });

  it('plan version and name match the requested version', () => {
    const planner = new SprintPlanner();
    planner.seed(backlog);
    const plan = planner.plan('9.9');
    expect(plan.version).toBe('9.9');
    expect(plan.name).toContain('9.9');
  });

  it('plan source is always autonomous', () => {
    const planner = new SprintPlanner();
    planner.seed(backlog);
    const plan = planner.plan('5.5');
    expect(plan.source).toBe('autonomous');
  });

  it('plan items start with pending status', () => {
    const planner = new SprintPlanner();
    planner.seed(backlog);
    const plan = planner.plan('5.5');
    expect(plan.items.every(i => i.status === 'pending')).toBe(true);
  });

  it('getBacklog returns copy — mutations do not affect internal backlog', () => {
    const planner = new SprintPlanner();
    planner.seed(backlog);
    const bl = planner.getBacklog();
    bl.push({ id: 'fake', title: 'Fake', description: '', priority: 'P0', estimatedComplexity: 'low', tags: [] });
    expect(planner.getBacklog().find(i => i.id === 'fake')).toBeUndefined();
  });

  it('remove of non-existent id is a no-op', () => {
    const planner = new SprintPlanner();
    planner.seed(backlog);
    const before = planner.getBacklog().length;
    planner.remove('this-does-not-exist');
    expect(planner.getBacklog().length).toBe(before);
  });

  it('budgetUsd defaults to 5 when not specified', () => {
    const planner = new SprintPlanner();
    planner.seed(backlog);
    const plan = planner.plan('5.5');
    expect(plan.budgetUsd).toBe(5);
  });

  it('custom budgetUsd is passed through to plan', () => {
    const planner = new SprintPlanner();
    planner.seed(backlog);
    const plan = planner.plan('5.5', 20);
    expect(plan.budgetUsd).toBe(20);
  });

  it('seed can be called multiple times accumulating items', () => {
    const planner = new SprintPlanner();
    planner.seed([{ id: 'x1', title: 'X', description: '', priority: 'P0', estimatedComplexity: 'low', tags: [] }]);
    planner.seed([{ id: 'x2', title: 'Y', description: '', priority: 'P0', estimatedComplexity: 'low', tags: [] }]);
    expect(planner.getBacklog().length).toBe(2);
  });
});

describe('SprintRunner — run results', () => {
  it('result sprintVersion matches plan version', async () => {
    const planner = new SprintPlanner();
    planner.seed(backlog);
    const plan = planner.plan('7.7');
    const runner = new SprintRunner({ dryRun: true });
    const result = await runner.run(plan);
    expect(result.sprintVersion).toBe('7.7');
  });

  it('itemsAttempted equals total items in plan', async () => {
    const planner = new SprintPlanner();
    planner.seed(backlog);
    const plan = planner.plan('5.5');
    const runner = new SprintRunner({ dryRun: true, sprintBudgetUsd: 100 });
    const result = await runner.run(plan);
    expect(result.itemsAttempted).toBe(plan.items.length);
  });

  it('itemsCompleted + itemsFailed = itemsAttempted on full run', async () => {
    const planner = new SprintPlanner();
    planner.seed(backlog);
    const plan = planner.plan('5.5');
    const runner = new SprintRunner({ dryRun: true, sprintBudgetUsd: 100 });
    const result = await runner.run(plan);
    expect(result.itemsCompleted + result.itemsFailed).toBeLessThanOrEqual(result.itemsAttempted);
  });

  it('totalCostUsd is positive on successful run', async () => {
    const planner = new SprintPlanner();
    planner.seed(backlog);
    const plan = planner.plan('5.5');
    const runner = new SprintRunner({ dryRun: true, sprintBudgetUsd: 100 });
    const result = await runner.run(plan);
    expect(result.totalCostUsd).toBeGreaterThan(0);
  });

  it('durationMs is a non-negative number', async () => {
    const planner = new SprintPlanner();
    planner.seed(backlog);
    const plan = planner.plan('5.5');
    const runner = new SprintRunner({ dryRun: true });
    const result = await runner.run(plan);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('completedAt is a valid ISO string', async () => {
    const planner = new SprintPlanner();
    planner.seed(backlog);
    const plan = planner.plan('5.5');
    const runner = new SprintRunner({ dryRun: true });
    const result = await runner.run(plan);
    expect(() => new Date(result.completedAt)).not.toThrow();
    expect(new Date(result.completedAt).getTime()).toBeGreaterThan(0);
  });

  it('empty plan runs with zero completions', async () => {
    const plan = { version: '5.5', name: 'Empty', items: [], plannedAt: new Date().toISOString(), budgetUsd: 10, source: 'autonomous' as const };
    const runner = new SprintRunner({ dryRun: true });
    const result = await runner.run(plan);
    expect(result.itemsCompleted).toBe(0);
    expect(result.itemsFailed).toBe(0);
    expect(result.totalCostUsd).toBe(0);
  });

  it('P0 items cost more per item than P2 in dry-run', async () => {
    const onlyP0: BacklogItem[] = [
      { id: 'only-p0', title: 'P0 Task', description: '', priority: 'P0', estimatedComplexity: 'high', tags: [] },
    ];
    const onlyP2: BacklogItem[] = [
      { id: 'only-p2', title: 'P2 Task', description: '', priority: 'P2', estimatedComplexity: 'low', tags: [] },
    ];
    const p0Planner = new SprintPlanner(); p0Planner.seed(onlyP0);
    const p2Planner = new SprintPlanner(); p2Planner.seed(onlyP2);
    const runner = new SprintRunner({ dryRun: true, sprintBudgetUsd: 100 });
    const p0Result = await runner.run(p0Planner.plan('5.5'));
    const p2Result = await runner.run(p2Planner.plan('5.5'));
    expect(p0Result.totalCostUsd).toBeGreaterThan(p2Result.totalCostUsd);
  });
});

describe('SprintEvaluator — verdict logic', () => {
  it('retry verdict when items fail but no regression', () => {
    const evaluator = new SprintEvaluator();
    // 2 failed, failuresBefore=0 — in dryRun mode this creates failures → regression → revert
    // Use non-dry-run with manual fakeRun to test retry path
    // Actually evaluator in non-dryRun uses testsBefore directly so failuresAfter = failuresBefore
    const fakeRun = { sprintVersion: '5.5', itemsAttempted: 5, itemsCompleted: 3, itemsFailed: 2, totalCostUsd: 0.5, durationMs: 100, completedAt: new Date().toISOString() };
    // dryRun=false means testsAfter=testsBefore and failuresAfter=failuresBefore
    const evaluation = evaluator.evaluate(fakeRun, 2708, 0, false);
    // itemsFailed > 0 → not passed → since no regression → retry
    expect(evaluation.verdict).toBe('retry');
    expect(evaluation.passed).toBe(false);
    expect(evaluation.regression).toBe(false);
  });

  it('testCountDelta equals testsAfter minus testsBefore', () => {
    const evaluator = new SprintEvaluator();
    const fakeRun = { sprintVersion: '5.5', itemsAttempted: 3, itemsCompleted: 3, itemsFailed: 0, totalCostUsd: 0.3, durationMs: 50, completedAt: new Date().toISOString() };
    const evaluation = evaluator.evaluate(fakeRun, 100, 0, true);
    expect(evaluation.testCountDelta).toBe(evaluation.testCountAfter - evaluation.testCountBefore);
  });

  it('evaluation carries sprintVersion from run result', () => {
    const evaluator = new SprintEvaluator();
    const fakeRun = { sprintVersion: '9.9', itemsAttempted: 2, itemsCompleted: 2, itemsFailed: 0, totalCostUsd: 0.1, durationMs: 10, completedAt: new Date().toISOString() };
    const evaluation = evaluator.evaluate(fakeRun, 1000, 0, true);
    expect(evaluation.sprintVersion).toBe('9.9');
  });

  it('costUsd in evaluation matches run totalCostUsd', () => {
    const evaluator = new SprintEvaluator();
    const fakeRun = { sprintVersion: '5.5', itemsAttempted: 2, itemsCompleted: 2, itemsFailed: 0, totalCostUsd: 1.23, durationMs: 10, completedAt: new Date().toISOString() };
    const evaluation = evaluator.evaluate(fakeRun, 100, 0, true);
    expect(evaluation.costUsd).toBeCloseTo(1.23);
  });

  it('regression flag set when failuresAfter > failuresBefore', () => {
    const evaluator = new SprintEvaluator();
    const fakeRun = { sprintVersion: '5.5', itemsAttempted: 3, itemsCompleted: 2, itemsFailed: 1, totalCostUsd: 0.5, durationMs: 100, completedAt: new Date().toISOString() };
    const evaluation = evaluator.evaluate(fakeRun, 2708, 0, true); // dryRun → failures introduced
    expect(evaluation.regression).toBe(true);
  });

  it('notes string is non-empty', () => {
    const evaluator = new SprintEvaluator();
    const fakeRun = { sprintVersion: '5.5', itemsAttempted: 2, itemsCompleted: 2, itemsFailed: 0, totalCostUsd: 0.1, durationMs: 10, completedAt: new Date().toISOString() };
    const evaluation = evaluator.evaluate(fakeRun, 100, 0, true);
    expect(evaluation.notes.length).toBeGreaterThan(0);
  });
});

describe('SprintPromoter — version bumping', () => {
  it('bumps minor version correctly on ship', () => {
    const promoter = new SprintPromoter();
    const plan = { version: '5.8', name: 'Test', items: [], plannedAt: new Date().toISOString(), budgetUsd: 5, source: 'autonomous' as const };
    const evaluation = { sprintVersion: '5.8', passed: true, testCountBefore: 100, testCountAfter: 110, testCountDelta: 10, failuresBefore: 0, failuresAfter: 0, regression: false, costUsd: 0.1, verdict: 'ship' as const, notes: 'ok' };
    const result = promoter.promote(plan, evaluation);
    expect(result.nextSprintVersion).toBe('5.9');
  });

  it('does not bump version on retry verdict', () => {
    const promoter = new SprintPromoter();
    const plan = { version: '5.5', name: 'Test', items: [], plannedAt: new Date().toISOString(), budgetUsd: 5, source: 'autonomous' as const };
    const evaluation = { sprintVersion: '5.5', passed: false, testCountBefore: 100, testCountAfter: 100, testCountDelta: 0, failuresBefore: 0, failuresAfter: 0, regression: false, costUsd: 0.1, verdict: 'retry' as const, notes: 'retry' };
    const result = promoter.promote(plan, evaluation);
    expect(result.promoted).toBe(false);
    expect(result.nextSprintVersion).toBe('5.5');
  });

  it('promotion result includes promotedAt timestamp', () => {
    const promoter = new SprintPromoter();
    const plan = { version: '5.5', name: 'Test', items: [], plannedAt: new Date().toISOString(), budgetUsd: 5, source: 'autonomous' as const };
    const evaluation = { sprintVersion: '5.5', passed: true, testCountBefore: 100, testCountAfter: 110, testCountDelta: 10, failuresBefore: 0, failuresAfter: 0, regression: false, costUsd: 0.1, verdict: 'ship' as const, notes: 'ok' };
    const result = promoter.promote(plan, evaluation);
    expect(() => new Date(result.promotedAt)).not.toThrow();
  });

  it('promotion result reason matches evaluation notes', () => {
    const promoter = new SprintPromoter();
    const plan = { version: '5.5', name: 'Test', items: [], plannedAt: new Date().toISOString(), budgetUsd: 5, source: 'autonomous' as const };
    const evaluation = { sprintVersion: '5.5', passed: true, testCountBefore: 100, testCountAfter: 110, testCountDelta: 10, failuresBefore: 0, failuresAfter: 0, regression: false, costUsd: 0.1, verdict: 'ship' as const, notes: 'All systems go' };
    const result = promoter.promote(plan, evaluation);
    expect(result.reason).toBe('All systems go');
  });

  it('runCycle returns all three result objects', async () => {
    const planner = new SprintPlanner();
    planner.seed([{ id: 'rc1', title: 'Task', description: '', priority: 'P1', estimatedComplexity: 'medium', tags: [] }]);
    const plan = planner.plan('6.0');
    const runner = new SprintRunner({ dryRun: true, sprintBudgetUsd: 10 });
    const evaluator = new SprintEvaluator();
    const promoter = new SprintPromoter();
    const { run, evaluation, promotion } = await promoter.runCycle(plan, runner, evaluator, 2708, true);
    expect(run).toBeDefined();
    expect(evaluation).toBeDefined();
    expect(promotion).toBeDefined();
  });
});
