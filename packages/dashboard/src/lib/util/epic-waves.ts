/**
 * epic-waves.ts
 *
 * Pure utility for wave-grouping decomposition children by topological order.
 * Wave 0 contains items with no predecessors; wave N contains items whose
 * predecessors all appear in waves 0..N-1.
 *
 * Items with dangling predecessor IDs (predecessors not present in the input
 * list) are placed defensively in the last wave — this function never throws.
 */

import type { DecompositionChild } from '../api/epic.js';

/**
 * Groups decomposition children into topological waves.
 *
 * @param children - Flat list of decomposition children with predecessor IDs.
 * @returns An array of waves; each wave is an array of children that can be
 *   executed in parallel once all earlier waves are complete.
 *   - Wave 0: items with no predecessors.
 *   - Wave N: items whose predecessors are all in waves 0..N-1.
 *   - Last wave: items with dangling predecessor IDs (predecessors not found
 *     in the input list), appended after all resolvable waves.
 */
export function groupIntoWaves(children: DecompositionChild[]): DecompositionChild[][] {
  if (children.length === 0) return [];

  const byId = new Map<string, DecompositionChild>(children.map(c => [c.id, c]));
  const idSet = new Set<string>(byId.keys());

  // Split children into those whose predecessors all exist in the list (resolved)
  // and those with at least one dangling predecessor reference (dangling).
  const resolved: DecompositionChild[] = [];
  const dangling: DecompositionChild[] = [];

  for (const child of children) {
    if (child.predecessors.every(p => idSet.has(p))) {
      resolved.push(child);
    } else {
      dangling.push(child);
    }
  }

  // Kahn's BFS topological sort on the resolved set only.
  // We only follow predecessor edges that stay within the resolved set;
  // cross-edges from a resolved child to a dangling child are ignored.
  const resolvedIds = new Set(resolved.map(c => c.id));

  // in-degree: number of predecessor edges (within resolved set) per item
  const inDegree = new Map<string, number>();
  // successors: resolved predecessor id → list of resolved successor ids
  const successors = new Map<string, string[]>();

  for (const child of resolved) {
    const knownPreds = child.predecessors.filter(p => resolvedIds.has(p));
    inDegree.set(child.id, knownPreds.length);
    for (const pred of knownPreds) {
      const list = successors.get(pred) ?? [];
      list.push(child.id);
      successors.set(pred, list);
    }
  }

  const waves: DecompositionChild[][] = [];
  // Wave 0: resolved items with in-degree 0 (no predecessors in resolved set)
  let frontier = resolved.filter(c => (inDegree.get(c.id) ?? 0) === 0);

  while (frontier.length > 0) {
    waves.push(frontier);
    const next: DecompositionChild[] = [];
    for (const child of frontier) {
      for (const succId of (successors.get(child.id) ?? [])) {
        const newDegree = (inDegree.get(succId) ?? 1) - 1;
        inDegree.set(succId, newDegree);
        if (newDegree === 0) {
          next.push(byId.get(succId)!);
        }
      }
    }
    frontier = next;
  }

  // Defensive: any resolved items still unplaced are part of a cycle.
  // Append them as a trailing wave rather than silently dropping them.
  const placed = new Set(waves.flat().map(c => c.id));
  const cyclic = resolved.filter(c => !placed.has(c.id));
  if (cyclic.length > 0) {
    waves.push(cyclic);
  }

  // Append all dangling items as the final wave.
  if (dangling.length > 0) {
    waves.push(dangling);
  }

  return waves;
}
