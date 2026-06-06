import { describe, it, expect } from 'vitest';
import {
  decomposeObjective,
  extractEpicPlanJson,
  buildEpicPlannerPrompt,
  DecomposeError,
  EPIC_PLAN_OUTPUT_SCHEMA,
} from '../decompose-objective.js';
import type { EpicObjective } from '../types.js';

const objective: EpicObjective = {
  id: 'epic-abc12345', title: 'RBAC', description: 'Add multi-tenant RBAC', createdAt: '2026-05-30T00:00:00.000Z',
};

function planJson(children: unknown): string {
  return JSON.stringify({ epicId: 'epic-abc12345', rationale: 'r', children });
}
const goodChildren = [
  { id: 'c1', title: 'type', description: 'd', files: ['shared.ts'], capabilityTags: ['types'],
    suggestedAssignee: 'eng', estimatedCostUsd: 2, estimatedComplexity: 'low', predecessors: [] },
  { id: 'c2', title: 'api', description: 'd', files: ['api.ts'], capabilityTags: ['route'],
    suggestedAssignee: 'eng', estimatedCostUsd: 3, estimatedComplexity: 'medium', predecessors: ['c1'] },
];
const cyclicChildren = [
  { id: 'c1', title: 'a', description: 'd', files: ['a.ts'], capabilityTags: ['x'],
    suggestedAssignee: 'eng', estimatedCostUsd: 1, estimatedComplexity: 'low', predecessors: ['c2'] },
  { id: 'c2', title: 'b', description: 'd', files: ['b.ts'], capabilityTags: ['y'],
    suggestedAssignee: 'eng', estimatedCostUsd: 1, estimatedComplexity: 'low', predecessors: ['c1'] },
];

function mockRuntime(outputs: string[]) {
  let i = 0;
  return { run: async () => ({ output: outputs[i++]!, costUsd: 0.5, model: 'opus' }) };
}

describe('extractEpicPlanJson', () => {
  it('parses a raw JSON object', () => {
    expect((extractEpicPlanJson('{"epicId":"e","rationale":"r","children":[]}') as any).epicId).toBe('e');
  });
  it('parses a ```json fenced block with surrounding prose', () => {
    const out = 'Here is the plan:\n```json\n{"epicId":"e","rationale":"r","children":[]}\n```\nDone.';
    expect((extractEpicPlanJson(out) as any).epicId).toBe('e');
  });
});

describe('decomposeObjective', () => {
  it('returns a layered plan on a valid first response', async () => {
    const r = await decomposeObjective(objective, mockRuntime([planJson(goodChildren)]));
    expect(r.repaired).toBe(false);
    expect(r.plan.children.find((c) => c.id === 'c2')!.wave).toBe(1);
    expect(r.costUsd).toBeCloseTo(0.5);
  });

  it('repairs once when the first response is cyclic', async () => {
    const r = await decomposeObjective(objective, mockRuntime([planJson(cyclicChildren), planJson(goodChildren)]));
    expect(r.repaired).toBe(true);
    expect(r.plan.children).toHaveLength(2);
    expect(r.costUsd).toBeCloseTo(1.0); // two runs
  });

  it('throws DecomposeError when still invalid after the repair retry', async () => {
    await expect(
      decomposeObjective(objective, mockRuntime([planJson(cyclicChildren), planJson(cyclicChildren)])),
    ).rejects.toBeInstanceOf(DecomposeError);
  });

  it('throws DecomposeError when output is not parseable JSON even after repair', async () => {
    await expect(
      decomposeObjective(objective, mockRuntime(['not json', 'still not json'])),
    ).rejects.toBeInstanceOf(DecomposeError);
  });

  // Acceptance-run fix (cycle 441c037f): the decompose calls must carry the
  // structured-output schema so the transports enforce/hint the EpicPlan shape
  // even under provider model fallback (opus→haiku produced invalid-json twice).
  it('passes EPIC_PLAN_OUTPUT_SCHEMA on the initial call AND the repair retry', async () => {
    const seenSchemas: Array<unknown> = [];
    const outputs = [planJson(cyclicChildren), planJson(goodChildren)];
    let i = 0;
    const runtime = {
      run: async (_agentId: string, _task: string, opts?: { outputSchema?: unknown }) => {
        seenSchemas.push(opts?.outputSchema);
        return { output: outputs[i++]!, costUsd: 0.5, model: 'opus' };
      },
    };
    const r = await decomposeObjective(objective, runtime);
    expect(r.repaired).toBe(true);
    expect(seenSchemas).toHaveLength(2);
    expect(seenSchemas[0]).toBe(EPIC_PLAN_OUTPUT_SCHEMA);
    expect(seenSchemas[1]).toBe(EPIC_PLAN_OUTPUT_SCHEMA);
  });

  it('EPIC_PLAN_OUTPUT_SCHEMA mirrors EpicPlanSchema requireds and complexity enum', () => {
    const schema = EPIC_PLAN_OUTPUT_SCHEMA.schema;
    expect(schema.required).toEqual(['epicId', 'rationale', 'children']);
    const child = (schema.properties['children'] as any).items;
    expect(child.required).toEqual([
      'id', 'title', 'description', 'suggestedAssignee', 'estimatedCostUsd', 'estimatedComplexity',
    ]);
    expect(child.properties.estimatedComplexity.enum).toEqual(['low', 'medium', 'high']);
    // `wave` is layering-internal — the model must never be asked to emit it.
    expect(child.properties.wave).toBeUndefined();
  });

  it('inlines the exact JSON contract in the task prompt (no agent-YAML dependency)', () => {
    const prompt = buildEpicPlannerPrompt(objective);
    expect(prompt).toContain('"epicId": "epic-abc12345"');
    expect(prompt).toContain('"estimatedComplexity": "low|medium|high"');
    expect(prompt).toContain('"suggestedAssignee"');
    // The old prompt deferred the shape to the agent system prompt — that
    // dependency is gone.
    expect(prompt).not.toContain('described in your system prompt');
  });

  // Cycle 11955f95 follow-up: 4/4 children were auto-failed for touching the
  // shared barrel (src/index.ts) they never declared. The planner prompt must
  // state that files[] is an enforced contract and route shared-file edits to
  // a dedicated integration child.
  it('states the enforced files[] contract and the shared-file integration-child rule', () => {
    const prompt = buildEpicPlannerPrompt(objective);
    expect(prompt).toContain('files[] is an ENFORCED contract');
    expect(prompt).toContain('barrel/index export files');
    expect(prompt).toContain('one later integration child');
  });
});
