import { describe, it, expect } from 'vitest';
import { detectCycle } from '../detect-cycle.js';
import type { EpicChild } from '../types.js';

function child(id: string, predecessors: string[]): EpicChild {
  return { id, title: id, description: '', files: [], capabilityTags: [],
    suggestedAssignee: 'eng', estimatedCostUsd: 1, estimatedComplexity: 'low', predecessors };
}

describe('detectCycle', () => {
  it('accepts an acyclic DAG', () => {
    const r = detectCycle([child('a', []), child('b', ['a']), child('c', ['a', 'b'])]);
    expect(r.acyclic).toBe(true);
    expect(r.cycle).toBeUndefined();
    expect(r.missingPredecessors).toEqual([]);
  });

  it('detects a cycle and reports the involved ids', () => {
    const r = detectCycle([child('a', ['c']), child('b', ['a']), child('c', ['b'])]);
    expect(r.acyclic).toBe(false);
    expect(r.cycle).toBeDefined();
    expect(r.cycle!.sort()).toEqual(['a', 'b', 'c']);
  });

  it('detects a self-loop', () => {
    const r = detectCycle([child('a', ['a'])]);
    expect(r.acyclic).toBe(false);
    expect(r.cycle).toContain('a');
  });

  it('reports predecessors that reference unknown ids', () => {
    const r = detectCycle([child('a', []), child('b', ['ghost'])]);
    expect(r.missingPredecessors).toEqual([{ childId: 'b', missing: ['ghost'] }]);
    // A missing predecessor does not count as a cycle.
    expect(r.acyclic).toBe(true);
  });
});
