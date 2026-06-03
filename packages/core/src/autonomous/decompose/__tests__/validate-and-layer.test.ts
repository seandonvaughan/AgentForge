import { describe, it, expect } from 'vitest';
import { validateAndLayerEpicPlan } from '../validate-and-layer.js';
import type { EpicPlan } from '../types.js';

function plan(children: EpicPlan['children']): EpicPlan {
  return { epicId: 'epic-abc12345', rationale: 'r', children };
}
function child(id: string, files: string[], predecessors: string[] = []) {
  return { id, title: id, description: '', files, capabilityTags: [],
    suggestedAssignee: 'eng', estimatedCostUsd: 1, estimatedComplexity: 'low' as const, predecessors };
}

describe('validateAndLayerEpicPlan', () => {
  it('returns a layered plan for a valid DAG', () => {
    const r = validateAndLayerEpicPlan(plan([
      child('a', ['shared.ts']),
      child('b', ['api.ts'], ['a']),
    ]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.waveCount).toBe(2);
    expect(r.plan.children.find((c) => c.id === 'a')!.wave).toBe(0);
    expect(r.plan.children.find((c) => c.id === 'b')!.wave).toBe(1);
  });

  it('forces file-overlapping children into different waves', () => {
    const r = validateAndLayerEpicPlan(plan([
      child('a', ['x.ts']),
      child('b', ['x.ts']), // shares x.ts with a, no declared dep
    ]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const wa = r.plan.children.find((c) => c.id === 'a')!.wave!;
    const wb = r.plan.children.find((c) => c.id === 'b')!.wave!;
    expect(wa).not.toBe(wb);
    expect(r.report.syntheticFileEdges.length).toBe(1);
  });

  it('fails (not ok) on a cyclic plan with the cycle reported', () => {
    const r = validateAndLayerEpicPlan(plan([
      child('a', [], ['b']),
      child('b', [], ['a']),
    ]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('cycle');
    expect(r.report.cycle!.sort()).toEqual(['a', 'b']);
  });

  it('fails on missing predecessors', () => {
    const r = validateAndLayerEpicPlan(plan([child('a', [], ['ghost'])]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('missing-predecessors');
  });
});
