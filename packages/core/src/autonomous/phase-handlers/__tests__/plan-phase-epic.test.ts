import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlanPhase } from '../plan-phase.js';
import type { PhaseContext } from '../../phase-scheduler.js';

const CYCLE_ID = 'epiccyc1';

function epicPlanJson(): string {
  return JSON.stringify({
    epicId: 'epic-epiccyc1', rationale: 'split',
    children: [
      { id: 'c1', title: 'type', description: 'd', files: ['shared.ts'], capabilityTags: ['types'],
        suggestedAssignee: 'shared-utils-engineer', estimatedCostUsd: 2, estimatedComplexity: 'low', predecessors: [] },
      { id: 'c2', title: 'api', description: 'd', files: ['api.ts'], capabilityTags: ['route'],
        suggestedAssignee: 'fastify-v5-engineer', estimatedCostUsd: 3, estimatedComplexity: 'medium', predecessors: ['c1'] },
    ],
  });
}

function makeCtx(root: string, objective?: string): PhaseContext {
  const events: any[] = [];
  return {
    sprintId: 'v1-test', sprintVersion: '1.0.0', projectRoot: root,
    adapter: {}, bus: { publish: (_t: string, p: any) => events.push(p), subscribe: () => () => {} },
    runtime: { run: async () => ({ output: epicPlanJson(), costUsd: 0.5, model: 'opus' }) },
    cycleId: CYCLE_ID,
    ...(objective ? { objective } : {}),
  } as unknown as PhaseContext;
}

describe('plan phase epic branch', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'af-planepic-'));
    mkdirSync(join(root, '.agentforge', 'cycles', CYCLE_ID, 'phases'), { recursive: true });
    // Seed a plan.json envelope (as sprint-generator would have written pre-plan-phase).
    writeFileSync(join(root, '.agentforge', 'cycles', CYCLE_ID, 'plan.json'),
      JSON.stringify({ version: '1.0.0', sprintId: 'v1-test', title: 't', items: [], budget: 100 }));
  });

  it('decomposes the objective into wave-layered plan.json items + writes artifacts', async () => {
    const result = await runPlanPhase(makeCtx(root, 'Add multi-tenant RBAC'));
    expect(result.status).toBe('completed');
    const dir = join(root, '.agentforge', 'cycles', CYCLE_ID);
    expect(existsSync(join(dir, 'decomposition.json'))).toBe(true);
    expect(existsSync(join(dir, 'objective.json'))).toBe(true);
    const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
    expect(plan.items).toHaveLength(2);
    expect(plan.items[0].parentEpicId).toBe('epic-epiccyc1');
    const c2 = plan.items.find((i: any) => i.id === 'c2');
    expect(c2.wave).toBe(1);
    expect(c2.predecessors).toEqual(['c1']);
    // envelope preserved
    expect(plan.budget).toBe(100);
  });

  it('is a no-op for signal cycles (no objective): plan.json items unchanged', async () => {
    const result = await runPlanPhase(makeCtx(root)); // no objective
    const plan = JSON.parse(readFileSync(join(root, '.agentforge', 'cycles', CYCLE_ID, 'plan.json'), 'utf8'));
    expect(plan.items).toEqual([]); // architect path does not rewrite items
    expect(existsSync(join(root, '.agentforge', 'cycles', CYCLE_ID, 'decomposition.json'))).toBe(false);
    expect(result.phase).toBe('plan');
  });

  // P0.3 band enforcement (cycle 11955f95 follow-up): ctx.budgetUsd must reach
  // the EpicObjective so the planner prompt carries the BUDGET block and
  // validate-and-layer enforces the Σ(children) band. Budget 12.5 → spendable
  // (12.5−6)/1.2 = 5.4167 → band [3.79, 5.42]; fixture children sum to 5 ✓.
  it('threads ctx.budgetUsd onto the EpicObjective (prompt block + objective.json)', async () => {
    const prompts: string[] = [];
    const ctx = {
      ...(makeCtx(root, 'Add multi-tenant RBAC') as unknown as Record<string, unknown>),
      budgetUsd: 12.5,
      runtime: {
        run: async (_a: string, task: string) => {
          prompts.push(task);
          return { output: epicPlanJson(), costUsd: 0.5, model: 'opus' };
        },
      },
    } as unknown as PhaseContext;

    const result = await runPlanPhase(ctx);
    expect(result.status).toBe('completed');
    const objective = JSON.parse(
      readFileSync(join(root, '.agentforge', 'cycles', CYCLE_ID, 'objective.json'), 'utf8'),
    );
    expect(objective.budgetUsd).toBe(12.5);
    expect(prompts[0]).toContain('BUDGET — size this plan to fill the money it is given.');
  });

  it('omits budgetUsd from the objective when ctx has none (band check skipped)', async () => {
    await runPlanPhase(makeCtx(root, 'Add multi-tenant RBAC'));
    const objective = JSON.parse(
      readFileSync(join(root, '.agentforge', 'cycles', CYCLE_ID, 'objective.json'), 'utf8'),
    );
    expect(objective.budgetUsd).toBeUndefined();
  });
});
