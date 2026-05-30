// packages/core/src/autonomous/decompose/wave-layering.ts
//
// Longest-path topological layering: wave(c) = 0 for roots, else
// 1 + max(wave(predecessors)). Pure; throws on a cyclic graph (cycle-check
// upstream). (spec 2026-05-30 §6.3.3)

import type { EpicChild } from './types.js';

export function layerWaves(input: EpicChild[]): EpicChild[] {
  const children = input.map((c) => ({ ...c }));
  const byId = new Map(children.map((c) => [c.id, c]));
  const wave = new Map<string, number>();

  // Memoized longest-path depth with cycle guard.
  const inStack = new Set<string>();
  const computeWave = (id: string): number => {
    const cached = wave.get(id);
    if (cached !== undefined) return cached;
    if (inStack.has(id)) {
      throw new Error(`[wave-layering] cycle detected at child '${id}'`);
    }
    inStack.add(id);
    const c = byId.get(id);
    const preds = (c?.predecessors ?? []).filter((p) => byId.has(p));
    const depth = preds.length === 0 ? 0 : 1 + Math.max(...preds.map((p) => computeWave(p)));
    inStack.delete(id);
    wave.set(id, depth);
    return depth;
  };

  for (const c of children) {
    c.wave = computeWave(c.id);
  }
  return children;
}
