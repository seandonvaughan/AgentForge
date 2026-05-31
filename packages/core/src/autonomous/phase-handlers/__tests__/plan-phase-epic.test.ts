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
});
