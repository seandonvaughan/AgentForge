// packages/core/src/autonomous/decompose/critical-path.ts
//
// Pure helper: compute the critical-path length of an EpicPlan from its raw
// `predecessors` edges — i.e. the maximum number of nodes on any chain
// following predecessor edges. This is the wall-clock lower bound on sequential
// waves and is meaningful BEFORE wave-layering has been applied.
//
// Algorithm: memoised DFS over the predecessor DAG.
// Cycle-safe: a node already on the current DFS stack contributes depth 0
// (rather than infinite recursion).
// Ghost-safe: predecessor ids that do not correspond to any child id in the
// plan are silently ignored (no throw, no depth inflation).

import type { EpicPlan } from './types.js';

/**
 * Return the length (number of nodes) of the longest predecessor chain in the
 * plan.
 *
 * - A child with no (valid) predecessors has depth 1.
 * - A child's depth = 1 + max depth over its predecessors that are actual
 *   child ids in the plan.
 * - Predecessor ids that do not match any child id are ignored.
 * - Cyclic edges are handled defensively: a node already on the active DFS
 *   stack is treated as contributing depth 0 (no infinite loop).
 * - Returns 0 when `plan.children` is empty (schema requires ≥1, but this
 *   function is defensive).
 */
export function criticalPathLength(plan: EpicPlan): number {
  const { children } = plan;
  if (children.length === 0) return 0;

  // Valid child ids for ghost-predecessor filtering.
  const childIds = new Set<string>(children.map((c) => c.id));

  // Filtered predecessor list per child id (unknown ids stripped).
  const predsOf = new Map<string, readonly string[]>();
  for (const c of children) {
    predsOf.set(
      c.id,
      c.predecessors.filter((p) => childIds.has(p)),
    );
  }

  // Memoised depths.
  const memo = new Map<string, number>();
  // Current DFS stack — used for cycle detection.
  const stack = new Set<string>();

  function depth(id: string): number {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;

    // Cycle detected: this node is already being resolved upstream.
    // Return 0 to avoid infinite recursion; the memoised result will be
    // written by the outer call once it unwinds.
    if (stack.has(id)) return 0;

    stack.add(id);

    const preds = predsOf.get(id) ?? [];
    const maxPredDepth = preds.reduce<number>(
      (acc, predId) => Math.max(acc, depth(predId)),
      0,
    );
    const d = 1 + maxPredDepth;

    stack.delete(id);
    memo.set(id, d);
    return d;
  }

  let max = 0;
  for (const c of children) {
    const d = depth(c.id);
    if (d > max) max = d;
  }
  return max;
}
