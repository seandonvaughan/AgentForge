# Epic Decomposer — PR-2a: Decomposition Core (pure modules) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, dependency-free algorithmic core of the epic decomposer — the `EpicPlan`/`EpicChild`/`EpicObjective` types + Zod schemas, cycle detection, file-overlap edge augmentation, wave layering, and the orchestrator that composes them into a validated, wave-layered plan. No pipeline integration, no LLM, no filesystem.

**Architecture:** A new `packages/core/src/autonomous/decompose/` module. Each algorithm is a pure function over an `EpicChild[]` so it is fully unit-testable. The orchestrator `validateAndLayerEpicPlan()` runs: validate predecessors reference real ids → detect cycle (reject if cyclic) → augment file-overlap edges (only between currently-unordered children, so it can never introduce a cycle) → assign waves by longest-path topological layering. The LLM call and one-shot repair retry live in the DECOMPOSE *phase* (PR-2b), which consumes this core; they are deliberately out of scope here so the core stays pure and deterministic.

**Tech Stack:** TypeScript (strict, NodeNext, ESM — imports end in `.js`), Zod, Vitest. Node **>=22.13.0** (`nvm use lts/jod`). pnpm via Corepack.

**Environment note for every command:** prefix with `source "$HOME/.nvm/nvm.sh" && nvm use lts/jod >/dev/null 2>&1 &&`. Working dir `/Users/seandonvaughan/Projects/AgentForge`, branch `feat/epic-decomposer` (already checked out — do NOT switch, do NOT push). `git add` new files immediately after creating them.

**Verification commands:**
- Single test: `corepack pnpm exec vitest run <path>`
- Typecheck: `corepack pnpm run check:types` (runs `tsc -b`; expect exit 0. NOTE: do **not** use `tsc -b --noEmit` — it emits a pre-existing TS6310 error unrelated to this work.)

---

## File Structure

All new files under `packages/core/src/autonomous/decompose/`:
- `types.ts` — `EpicObjective`, `EpicChild`, `EpicPlan`, `ValidationReport` interfaces + `EpicChildSchema`, `EpicPlanSchema`, `EpicObjectiveSchema` Zod schemas. One responsibility: the decomposition data model.
- `detect-cycle.ts` — `detectCycle(children)`: Kahn's-algorithm cycle detection + missing-predecessor validation. Pure.
- `file-overlap.ts` — `augmentFileOverlapEdges(children)`: add synthetic precedence edges between file-overlapping children that are not already ordered. Pure.
- `wave-layering.ts` — `layerWaves(children)`: assign `wave` via longest-path layering. Pure; throws on cycle.
- `validate-and-layer.ts` — `validateAndLayerEpicPlan(plan)`: the orchestrator composing the above. Pure.
- `index.ts` — barrel re-exporting the public surface.
- `__tests__/` — one test file per module.

These are consumed by the DECOMPOSE phase in PR-2b. Nothing in PR-2a imports from outside `decompose/` except `zod`.

---

## Task 1: Decomposition types + Zod schemas

**Files:**
- Create: `packages/core/src/autonomous/decompose/types.ts`
- Test: `packages/core/src/autonomous/decompose/__tests__/types.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/autonomous/decompose/__tests__/types.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { EpicChildSchema, EpicPlanSchema, EpicObjectiveSchema } from '../types.js';

describe('EpicChildSchema', () => {
  const valid = {
    id: 'child-1',
    title: 'Add shared type',
    description: 'create the RBAC type',
    files: ['packages/shared/src/rbac.ts'],
    capabilityTags: ['types'],
    suggestedAssignee: 'shared-utils-engineer',
    estimatedCostUsd: 5,
    estimatedComplexity: 'low',
    predecessors: [],
  };

  it('accepts a valid child', () => {
    expect(EpicChildSchema.parse(valid).id).toBe('child-1');
  });

  it('rejects an invalid complexity', () => {
    expect(() => EpicChildSchema.parse({ ...valid, estimatedComplexity: 'huge' })).toThrow();
  });

  it('rejects a negative cost', () => {
    expect(() => EpicChildSchema.parse({ ...valid, estimatedCostUsd: -1 })).toThrow();
  });

  it('defaults predecessors to [] when omitted', () => {
    const { predecessors, ...noPred } = valid;
    expect(EpicChildSchema.parse(noPred).predecessors).toEqual([]);
  });
});

describe('EpicPlanSchema', () => {
  it('parses a plan with children', () => {
    const plan = EpicPlanSchema.parse({
      epicId: 'epic-abc12345',
      rationale: 'split into type + consumer',
      children: [
        { id: 'c1', title: 't', description: 'd', files: ['a.ts'], capabilityTags: ['x'],
          suggestedAssignee: 'eng', estimatedCostUsd: 1, estimatedComplexity: 'low', predecessors: [] },
      ],
    });
    expect(plan.children).toHaveLength(1);
  });

  it('rejects an empty children array', () => {
    expect(() => EpicPlanSchema.parse({ epicId: 'epic-1', rationale: 'r', children: [] })).toThrow();
  });
});

describe('EpicObjectiveSchema', () => {
  it('parses an objective', () => {
    const o = EpicObjectiveSchema.parse({
      id: 'epic-abc12345', title: 'RBAC', description: 'add rbac', createdAt: '2026-05-30T00:00:00.000Z',
    });
    expect(o.constraints).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module not found)

`corepack pnpm exec vitest run packages/core/src/autonomous/decompose/__tests__/types.test.ts`

- [ ] **Step 3: Create `packages/core/src/autonomous/decompose/types.ts`**

```ts
// packages/core/src/autonomous/decompose/types.ts
//
// Epic-decomposer data model (spec 2026-05-30 §5, §6.2). Pure types + Zod
// schemas. An EpicObjective is the operator's input; an EpicPlan is the
// planner's structured output; an EpicChild is one wave-schedulable work item.

import { z } from 'zod';

export const EpicObjectiveSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    constraints: z.array(z.string()).optional(),
    createdAt: z.string(),
  })
  .strict();
export type EpicObjective = z.infer<typeof EpicObjectiveSchema>;

export const EpicChildSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    files: z.array(z.string()).default([]),
    capabilityTags: z.array(z.string()).default([]),
    suggestedAssignee: z.string(),
    estimatedCostUsd: z.number().min(0),
    estimatedComplexity: z.enum(['low', 'medium', 'high']),
    predecessors: z.array(z.string()).default([]),
    /** Assigned by wave-layering; absent until layered. */
    wave: z.number().int().min(0).optional(),
  })
  .strict();
export type EpicChild = z.infer<typeof EpicChildSchema>;

export const EpicPlanSchema = z
  .object({
    epicId: z.string(),
    rationale: z.string(),
    children: z.array(EpicChildSchema).min(1),
  })
  .strict();
export type EpicPlan = z.infer<typeof EpicPlanSchema>;

export interface ValidationReport {
  acyclic: boolean;
  cycle?: string[];
  missingPredecessors: Array<{ childId: string; missing: string[] }>;
  syntheticFileEdges: Array<{ from: string; to: string; sharedFiles: string[] }>;
  waveCount: number;
}
```

- [ ] **Step 4: Run, expect PASS** — `corepack pnpm exec vitest run packages/core/src/autonomous/decompose/__tests__/types.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/autonomous/decompose/types.ts packages/core/src/autonomous/decompose/__tests__/types.test.ts
git commit -m "feat(decompose): epic plan types + zod schemas (PR-2a)"
```

---

## Task 2: Cycle detection + missing-predecessor validation

**Files:**
- Create: `packages/core/src/autonomous/decompose/detect-cycle.ts`
- Test: `packages/core/src/autonomous/decompose/__tests__/detect-cycle.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run, expect FAIL** — `corepack pnpm exec vitest run packages/core/src/autonomous/decompose/__tests__/detect-cycle.test.ts`

- [ ] **Step 3: Create `detect-cycle.ts`**

```ts
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
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/autonomous/decompose/detect-cycle.ts packages/core/src/autonomous/decompose/__tests__/detect-cycle.test.ts
git commit -m "feat(decompose): Kahn cycle detection + missing-predecessor validation (PR-2a)"
```

---

## Task 3: File-overlap edge augmentation

**Files:**
- Create: `packages/core/src/autonomous/decompose/file-overlap.ts`
- Test: `packages/core/src/autonomous/decompose/__tests__/file-overlap.test.ts`

**Key invariant (spec §6.3.2):** for any two children whose declared `files[]` intersect and that are NOT already ordered (no directed path either way), add a synthetic edge directed by declaration order (earlier child becomes the predecessor). Adding an edge only between *currently-unordered* children guarantees augmentation can never create a cycle.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Create `file-overlap.ts`**

```ts
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
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/autonomous/decompose/file-overlap.ts packages/core/src/autonomous/decompose/__tests__/file-overlap.test.ts
git commit -m "feat(decompose): file-overlap edge augmentation (cycle-safe) (PR-2a)"
```

---

## Task 4: Wave layering (longest-path topological layers)

**Files:**
- Create: `packages/core/src/autonomous/decompose/wave-layering.ts`
- Test: `packages/core/src/autonomous/decompose/__tests__/wave-layering.test.ts`

**Invariant:** `wave(child) = 0` if no predecessors, else `1 + max(wave(predecessor))`. Every predecessor is in a strictly earlier wave. Throws if the graph is cyclic (caller must cycle-check first).

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Create `wave-layering.ts`**

```ts
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
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/autonomous/decompose/wave-layering.ts packages/core/src/autonomous/decompose/__tests__/wave-layering.test.ts
git commit -m "feat(decompose): longest-path wave layering (PR-2a)"
```

---

## Task 5: Orchestrator `validateAndLayerEpicPlan` + barrel export

**Files:**
- Create: `packages/core/src/autonomous/decompose/validate-and-layer.ts`
- Create: `packages/core/src/autonomous/decompose/index.ts`
- Test: `packages/core/src/autonomous/decompose/__tests__/validate-and-layer.test.ts`

**Behavior:** Compose the pieces into one pure entry point. Returns either a layered plan + report, or a structured failure (cyclic / missing predecessors) that the DECOMPOSE phase (PR-2b) turns into an LLM repair retry or a hard phase failure.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Create `validate-and-layer.ts`**

```ts
// packages/core/src/autonomous/decompose/validate-and-layer.ts
//
// Pure orchestrator: validate predecessors -> detect cycle -> augment
// file-overlap edges -> re-check (defensive) -> layer waves. Returns a
// discriminated result the DECOMPOSE phase (PR-2b) turns into a repair retry
// or a layered plan. (spec 2026-05-30 §6.3)

import type { EpicPlan, ValidationReport } from './types.js';
import { detectCycle } from './detect-cycle.js';
import { augmentFileOverlapEdges } from './file-overlap.js';
import { layerWaves } from './wave-layering.js';

export type ValidateResult =
  | { ok: true; plan: EpicPlan; report: ValidationReport }
  | { ok: false; reason: 'cycle' | 'missing-predecessors'; report: ValidationReport };

export function validateAndLayerEpicPlan(plan: EpicPlan): ValidateResult {
  // 1. Cycle + missing-predecessor check on the LLM-provided graph.
  const initial = detectCycle(plan.children);
  if (initial.missingPredecessors.length > 0) {
    return {
      ok: false,
      reason: 'missing-predecessors',
      report: {
        acyclic: initial.acyclic,
        ...(initial.cycle ? { cycle: initial.cycle } : {}),
        missingPredecessors: initial.missingPredecessors,
        syntheticFileEdges: [],
        waveCount: 0,
      },
    };
  }
  if (!initial.acyclic) {
    return {
      ok: false,
      reason: 'cycle',
      report: {
        acyclic: false,
        ...(initial.cycle ? { cycle: initial.cycle } : {}),
        missingPredecessors: [],
        syntheticFileEdges: [],
        waveCount: 0,
      },
    };
  }

  // 2. File-overlap augmentation (only between currently-unordered pairs, so
  //    it cannot create a cycle — re-check defensively anyway).
  const { children: augmented, syntheticFileEdges } = augmentFileOverlapEdges(plan.children);
  const recheck = detectCycle(augmented);
  if (!recheck.acyclic) {
    return {
      ok: false,
      reason: 'cycle',
      report: {
        acyclic: false,
        ...(recheck.cycle ? { cycle: recheck.cycle } : {}),
        missingPredecessors: [],
        syntheticFileEdges,
        waveCount: 0,
      },
    };
  }

  // 3. Layer waves.
  const layered = layerWaves(augmented);
  const waveCount = layered.reduce((m, c) => Math.max(m, (c.wave ?? 0) + 1), 0);

  return {
    ok: true,
    plan: { ...plan, children: layered },
    report: { acyclic: true, missingPredecessors: [], syntheticFileEdges, waveCount },
  };
}
```

- [ ] **Step 4: Create the barrel `index.ts`**

```ts
// packages/core/src/autonomous/decompose/index.ts
export * from './types.js';
export { detectCycle } from './detect-cycle.js';
export type { CycleResult } from './detect-cycle.js';
export { augmentFileOverlapEdges } from './file-overlap.js';
export { layerWaves } from './wave-layering.js';
export { validateAndLayerEpicPlan } from './validate-and-layer.js';
export type { ValidateResult } from './validate-and-layer.js';
```

- [ ] **Step 5: Run the orchestrator test + the whole decompose dir + typecheck**

`corepack pnpm exec vitest run packages/core/src/autonomous/decompose`
`corepack pnpm run check:types`  (expect exit 0)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/autonomous/decompose/validate-and-layer.ts packages/core/src/autonomous/decompose/index.ts packages/core/src/autonomous/decompose/__tests__/validate-and-layer.test.ts
git commit -m "feat(decompose): validateAndLayerEpicPlan orchestrator + barrel (PR-2a)"
```

---

## Task 6: Verification gate

- [ ] **Step 1: Typecheck** — `corepack pnpm run check:types` → exit 0.
- [ ] **Step 2: Full decompose module + no regression** — `corepack pnpm exec vitest run packages/core/src/autonomous/decompose packages/core/src/autonomous/cycle-artifacts` → all pass.
- [ ] **Step 3:** Confirm no file outside `packages/core/src/autonomous/decompose/` was modified: `git diff --name-only main..HEAD | grep -v '^docs/' | grep -v 'decompose/' | grep -v '__tests__'` should show only the foundation files from PR-0/PR-1 (no new non-decompose changes from PR-2a).

---

## Self-Review

**Spec coverage (§6.2, §6.3.1–6.3.3):** EpicObjective/EpicChild/EpicPlan types (Task 1) ✓; cycle detection + missing-predecessor (Task 2, §6.3.1) ✓; file-overlap augmentation (Task 3, §6.3.2) ✓; wave layering (Task 4, §6.3.3) ✓; orchestrator (Task 5) ✓. **Deferred to PR-2b (noted):** §6.3.4 import-edge augmentation (needs filesystem/AST, not pure — belongs with the DECOMPOSE phase); the LLM call + one-shot repair retry (integration); `decomposition.json` write + `plan.json` flatten (integration); `--objective` flag, epic-planner agent, phase wiring, `cycle preview --objective`.

**Placeholder scan:** none — every step has complete code.

**Type consistency:** `EpicChild`/`EpicPlan`/`ValidationReport` used identically across modules; `detectCycle`/`augmentFileOverlapEdges`/`layerWaves`/`validateAndLayerEpicPlan` names consistent between definitions, the barrel, and tests. `syntheticFileEdges` shape `{from,to,sharedFiles}` matches between `file-overlap.ts`, `ValidationReport`, and the orchestrator. `wave` is the same optional field added to `EpicChildSchema` and assigned by `layerWaves`.

**Cycle-safety argument:** file-overlap only adds an edge between pairs with no existing path either direction, so it cannot close a cycle; the orchestrator re-checks anyway (defense in depth), and `layerWaves` throws on any residual cycle.

---

## Deferred to later PR-2 plans

- **PR-2b (decomposition pipeline):** import-edge augmentation (§6.3.4); `EpicObjective` + `--objective` flag + `objective.json` + `PhaseContext.objective`; `epic-planner` Opus agent (authored + registered); DECOMPOSE phase handler (invoke planner → `validateAndLayerEpicPlan` → on failure one LLM repair retry → write `decomposition.json` + flatten children into `plan.json`); insert `decompose` into `PHASE_SEQUENCE` (core + server duplicate) + `PhaseName` + `PHASE_HANDLERS`; `cycle preview --objective`. (Grounding pack: `/tmp/pr2-pack.md`, sections 1–3, 6.)
- **PR-2c (wave execution):** wave-aware execute loop, integration branch, base-branch threading, smokeGuard, merge-under-lock/push-verify, cascade, checkpoint wave-state/resume. (Pack section 4.)
- **PR-2d (ship + scale):** gate on integration HEAD, release PR-opener + epic risk classification, `epic.*` caps, `cycle.json` observability. (Pack section 5.)
