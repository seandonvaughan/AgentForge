// packages/core/src/autonomous/decompose/file-overlap.ts
//
// Synthetic precedence edges between file-overlapping children that are not
// already ordered, so file-conflicting children never share a wave. Adding an
// edge only between currently-unordered pairs guarantees no cycle is created.
// (spec 2026-05-30 §6.3.2)

import type { EpicChild, ValidationReport } from './types.js';

/** True if `target` is reachable from `start` by following predecessor->child edges. */
function isReachable(
  start: string,
  target: string,
  dependents: Map<string, string[]>,
): boolean {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const d of dependents.get(id) ?? []) stack.push(d);
  }
  return false;
}

export function augmentFileOverlapEdges(input: EpicChild[]): {
  children: EpicChild[];
  syntheticFileEdges: ValidationReport['syntheticFileEdges'];
} {
  // Work on clones so the function stays pure.
  const children = input.map((c) => ({ ...c, predecessors: [...c.predecessors] }));
  const byId = new Map(children.map((c) => [c.id, c]));
  const dependents = new Map<string, string[]>(); // predecessorId -> [childId...]
  for (const c of children) dependents.set(c.id, []);
  for (const c of children) {
    for (const p of c.predecessors) {
      if (dependents.has(p)) dependents.get(p)!.push(c.id);
    }
  }

  const syntheticFileEdges: ValidationReport['syntheticFileEdges'] = [];

  // Declaration order = array order. i < j means i declared earlier.
  for (let i = 0; i < children.length; i++) {
    for (let j = i + 1; j < children.length; j++) {
      const ci = children[i]!;
      const cj = children[j]!;
      const shared = ci.files.filter((f) => cj.files.includes(f));
      if (shared.length === 0) continue;
      // Already ordered either way? leave it alone.
      if (isReachable(ci.id, cj.id, dependents) || isReachable(cj.id, ci.id, dependents)) {
        continue;
      }
      // Add edge ci -> cj (cj depends on ci).
      cj.predecessors.push(ci.id);
      dependents.get(ci.id)!.push(cj.id);
      syntheticFileEdges.push({ from: ci.id, to: cj.id, sharedFiles: shared });
    }
  }

  void byId;
  return { children, syntheticFileEdges };
}
