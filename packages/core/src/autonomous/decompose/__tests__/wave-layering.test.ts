import { describe, it, expect } from 'vitest';
import { layerWaves } from '../wave-layering.js';
import type { EpicChild } from '../types.js';

function child(id: string, predecessors: string[]): EpicChild {
  return { id, title: id, description: '', files: [], capabilityTags: [],
    suggestedAssignee: 'eng', estimatedCostUsd: 1, estimatedComplexity: 'low', predecessors };
}

describe('layerWaves', () => {
  it('assigns wave 0 to roots and longest-path layers to the rest', () => {
    const out = layerWaves([
      child('a', []),
      child('b', ['a']),
      child('c', ['a']),
      child('d', ['b', 'c']),
    ]);
    const w = (id: string) => out.find((c) => c.id === id)!.wave;
    expect(w('a')).toBe(0);
    expect(w('b')).toBe(1);
    expect(w('c')).toBe(1);
    expect(w('d')).toBe(2);
  });

  it('uses longest path (a->b->d and a->d puts d after b)', () => {
    const out = layerWaves([child('a', []), child('b', ['a']), child('d', ['a', 'b'])]);
    expect(out.find((c) => c.id === 'd')!.wave).toBe(2);
  });

  it('every predecessor is in a strictly earlier wave', () => {
    const out = layerWaves([child('a', []), child('b', ['a']), child('c', ['b'])]);
    const byId = new Map(out.map((c) => [c.id, c]));
    for (const c of out) {
      for (const p of c.predecessors) {
        expect(byId.get(p)!.wave!).toBeLessThan(c.wave!);
      }
    }
  });

  it('throws on a cyclic graph', () => {
    expect(() => layerWaves([child('a', ['b']), child('b', ['a'])])).toThrow(/cycl/i);
  });
});
