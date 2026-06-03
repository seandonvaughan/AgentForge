// packages/core/src/autonomous/decompose/detect-cycle.ts
//
// Kahn's-algorithm cycle detection over the predecessor graph, plus
// missing-predecessor validation. Pure. (spec 2026-05-30 §6.3.1)

import type { EpicChild, ValidationReport } from './types.js';

export interface CycleResult {
  acyclic: boolean;
  /** When cyclic, the ids that remain in a cycle (could not be ordered). */
  cycle?: string[];
  missingPredecessors: ValidationReport['missingPredecessors'];
}

export function detectCycle(children: EpicChild[]): CycleResult {
  const ids = new Set(children.map((c) => c.id));

  // Missing-predecessor validation (does not affect cycle detection).
  const missingPredecessors: ValidationReport['missingPredecessors'] = [];
  for (const c of children) {
    const missing = c.predecessors.filter((p) => !ids.has(p));
    if (missing.length > 0) missingPredecessors.push({ childId: c.id, missing });
  }

  // Kahn's algorithm over edges predecessor -> child. Only count edges whose
  // predecessor is a known id (missing ones are reported separately).
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // predecessorId -> [childId...]
  for (const c of children) {
    indegree.set(c.id, 0);
    dependents.set(c.id, []);
  }
  for (const c of children) {
    for (const p of c.predecessors) {
      if (!ids.has(p)) continue;
      indegree.set(c.id, (indegree.get(c.id) ?? 0) + 1);
      dependents.get(p)!.push(c.id);
    }
  }

  const queue = [...children.map((c) => c.id)].filter((id) => indegree.get(id) === 0);
  let processed = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    processed++;
    for (const dep of dependents.get(id) ?? []) {
      indegree.set(dep, (indegree.get(dep) ?? 0) - 1);
      if (indegree.get(dep) === 0) queue.push(dep);
    }
  }

  if (processed === children.length) {
    return { acyclic: true, missingPredecessors };
  }
  // The unprocessed nodes (indegree still > 0) form / feed the cycle.
  const cycle = children.map((c) => c.id).filter((id) => (indegree.get(id) ?? 0) > 0);
  return { acyclic: false, cycle, missingPredecessors };
}
