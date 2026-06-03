import { describe, it, expect } from 'vitest';
import { augmentFileOverlapEdges } from '../file-overlap.js';
import { detectCycle } from '../detect-cycle.js';
import type { EpicChild } from '../types.js';

function child(id: string, files: string[], predecessors: string[] = []): EpicChild {
  return { id, title: id, description: '', files, capabilityTags: [],
    suggestedAssignee: 'eng', estimatedCostUsd: 1, estimatedComplexity: 'low', predecessors };
}

describe('augmentFileOverlapEdges', () => {
  it('adds an edge (earlier -> later) between unordered children sharing a file', () => {
    const { children, syntheticFileEdges } = augmentFileOverlapEdges([
      child('a', ['x.ts']),
      child('b', ['x.ts']),
    ]);
    const b = children.find((c) => c.id === 'b')!;
    expect(b.predecessors).toContain('a');
    expect(syntheticFileEdges).toEqual([{ from: 'a', to: 'b', sharedFiles: ['x.ts'] }]);
  });

  it('does not add an edge when files are disjoint', () => {
    const { children, syntheticFileEdges } = augmentFileOverlapEdges([
      child('a', ['x.ts']),
      child('b', ['y.ts']),
    ]);
    expect(children.find((c) => c.id === 'b')!.predecessors).toEqual([]);
    expect(syntheticFileEdges).toEqual([]);
  });

  it('does not add a redundant edge when already transitively ordered', () => {
    // a -> b -> c (explicit), a and c also share a file but are already ordered.
    const { children, syntheticFileEdges } = augmentFileOverlapEdges([
      child('a', ['x.ts']),
      child('b', ['m.ts'], ['a']),
      child('c', ['x.ts'], ['b']),
    ]);
    // No new edge between a and c (c already reachable from a).
    expect(syntheticFileEdges).toEqual([]);
    expect(children.find((c) => c.id === 'c')!.predecessors).toEqual(['b']);
  });

  it('never introduces a cycle even when a backward dep already exists', () => {
    // b declared earlier depends on a (backward); a and b share a file.
    // a is reachable from b already, so we must NOT add b->a... we add nothing.
    const input = [child('a', ['x.ts'], ['b']), child('b', ['x.ts'])];
    const { children } = augmentFileOverlapEdges(input);
    expect(detectCycle(children).acyclic).toBe(true);
  });
});
