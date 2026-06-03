import { describe, it, expect } from 'vitest';
import { criticalPathLength } from '../critical-path.js';
import type { EpicPlan } from '../types.js';

// Minimal helper to build a child with explicit predecessor list.
function child(
  id: string,
  predecessors: string[] = [],
): EpicPlan['children'][number] {
  return {
    id,
    title: `Task ${id}`,
    description: `Description for ${id}`,
    files: [],
    capabilityTags: [],
    suggestedAssignee: 'test-agent',
    estimatedCostUsd: 1,
    estimatedComplexity: 'low',
    predecessors,
  };
}

describe('criticalPathLength', () => {
  it('returns 4 for the a→b→c→e chain in a 5-node DAG', () => {
    // DAG:
    //   a (no preds)
    //   b (preds: a)
    //   c (preds: b)
    //   d (no preds)
    //   e (preds: c, d)   ← longest chain: a→b→c→e = depth 4
    const plan: EpicPlan = {
      epicId: 'epic-cp',
      rationale: 'critical path test',
      children: [
        child('a'),
        child('b', ['a']),
        child('c', ['b']),
        child('d'),
        child('e', ['c', 'd']),
      ],
    };

    expect(criticalPathLength(plan)).toBe(4);
  });

  it('returns 1 for a single child with no predecessors', () => {
    const plan: EpicPlan = {
      epicId: 'epic-solo',
      rationale: 'single item',
      children: [child('only')],
    };

    expect(criticalPathLength(plan)).toBe(1);
  });

  it('does not throw and does not inflate depth when a predecessor id is absent from the plan', () => {
    // 'ghost' is not a child id — must be silently ignored.
    const plan: EpicPlan = {
      epicId: 'epic-ghost',
      rationale: 'ghost predecessor',
      children: [child('x', ['ghost'])],
    };

    let result: number | undefined;
    expect(() => {
      result = criticalPathLength(plan);
    }).not.toThrow();

    // Without the ghost, 'x' has no real predecessors → depth 1.
    expect(result).toBe(1);
  });

  it('does not infinite-loop on a 2-node cycle (a preds [b], b preds [a])', () => {
    const plan: EpicPlan = {
      epicId: 'epic-cycle',
      rationale: 'cyclic',
      children: [child('a', ['b']), child('b', ['a'])],
    };

    let result: number | undefined;
    expect(() => {
      result = criticalPathLength(plan);
    }).not.toThrow();

    // Must return a finite number (exact value is unspecified for cyclic input,
    // but the function must terminate).
    expect(typeof result).toBe('number');
    expect(Number.isFinite(result as number)).toBe(true);
  });

  it('returns 0 for an empty children array (defensive)', () => {
    // EpicPlanSchema requires children.min(1), so we cast to bypass validation.
    const plan = {
      epicId: 'epic-empty',
      rationale: 'empty',
      children: [],
    } as unknown as EpicPlan;

    expect(criticalPathLength(plan)).toBe(0);
  });
});
