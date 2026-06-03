# Epic Decomposer — PR-2c1: Wave Ordering (execute-phase barrier)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the execute phase run items in dependency-wave order: group `plan.json` items by `wave`, run each wave to completion (barrier) before starting the next. The wave barrier *is* the predecessor gate — PR-2a's layering guarantees every predecessor sits in a strictly earlier wave, so a per-wave `Promise.allSettled` barrier means a dependent never starts before its predecessors finish.

**Architecture + the safety invariant:** A pure `groupItemsByWave(items)` collapses items with **no `wave`** (every signal cycle) into a **single wave**, exactly reproducing today's flat dispatch. So the only structural change to the 1,623-line `execute-phase.ts` is wrapping the existing per-item loop in `for (const waveItems of groupItemsByWave(items))` and moving the end-of-loop `Promise.allSettled` barrier *inside* that wrapper. Non-epic behavior is byte-for-byte identical (one wave, one barrier, same order). The integration branch (so wave N+1 forks off wave N's merged code) is PR-2c2; the smokeGuard + quarantine/blocked cascade are PR-2c3.

**Tech Stack:** TypeScript (strict, NodeNext, ESM — `.js` suffixes), Vitest. Node **>=22.13.0** (`nvm use lts/jod`).

**Environment note for every command:** prefix with `source "$HOME/.nvm/nvm.sh" && nvm use lts/jod >/dev/null 2>&1 &&`. Working dir `/Users/seandonvaughan/Projects/AgentForge`, branch `feat/epic-decomposer` (do NOT switch, do NOT push). Read a file before Edit; `git add` new files immediately.

**Verification:** test `corepack pnpm exec vitest run <path>`; typecheck `corepack pnpm run check:types` (`tsc -b`; exit 0 — never `tsc -b --noEmit`).

---

## File Structure

- New: `packages/core/src/autonomous/decompose/wave-order.ts` — `groupItemsByWave(items)`. Pure.
- Modify: `packages/core/src/autonomous/decompose/index.ts` — export it.
- Modify: `packages/core/src/autonomous/phase-handlers/execute-phase.ts` — wrap the dispatch loop in the wave grouping; move the barrier inside.
- New test: `packages/core/src/autonomous/decompose/__tests__/wave-order.test.ts`.

---

## Task 1: `groupItemsByWave` pure helper

**Files:**
- Create: `packages/core/src/autonomous/decompose/wave-order.ts`
- Modify: `packages/core/src/autonomous/decompose/index.ts`
- Test: `packages/core/src/autonomous/decompose/__tests__/wave-order.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { groupItemsByWave } from '../wave-order.js';

const flat = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('groupItemsByWave', () => {
  it('collapses items with no wave into a single wave (flat / signal-cycle behavior)', () => {
    const groups = groupItemsByWave(flat);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns [] for an empty input', () => {
    expect(groupItemsByWave([])).toEqual([]);
  });

  it('groups by ascending wave, preserving within-wave order', () => {
    const items = [
      { id: 'c2', wave: 1 },
      { id: 'a1', wave: 0 },
      { id: 'c1', wave: 1 },
      { id: 'd', wave: 2 },
      { id: 'a2', wave: 0 },
    ];
    const groups = groupItemsByWave(items);
    expect(groups.map((g) => g.map((i) => i.id))).toEqual([
      ['a1', 'a2'],
      ['c2', 'c1'],
      ['d'],
    ]);
  });

  it('treats a missing wave as wave 0 when other items are layered', () => {
    const items = [{ id: 'x', wave: 1 }, { id: 'y' }];
    const groups = groupItemsByWave(items);
    expect(groups[0]!.map((i) => i.id)).toEqual(['y']); // wave 0 (defaulted)
    expect(groups[1]!.map((i) => i.id)).toEqual(['x']);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `corepack pnpm exec vitest run packages/core/src/autonomous/decompose/__tests__/wave-order.test.ts`

- [ ] **Step 3: Create `wave-order.ts`**

```ts
// packages/core/src/autonomous/decompose/wave-order.ts
//
// Group execute-phase items into ordered dependency waves. Items with no `wave`
// (signal cycles) collapse into a single wave, exactly reproducing the pre-wave
// flat dispatch order — so the wave-aware execute loop is a no-op for non-epic
// cycles. (spec 2026-05-30 §8.1)

export interface WaveOrderable {
  id: string;
  wave?: number;
  predecessors?: string[];
}

/**
 * Returns waves in ascending `wave` order; within a wave, original relative
 * order is preserved. If NO item declares a wave, returns a single wave
 * containing all items in their original order (flat behavior). Empty input
 * returns [].
 */
export function groupItemsByWave<T extends WaveOrderable>(items: T[]): T[][] {
  if (items.length === 0) return [];
  const anyWave = items.some((it) => typeof it.wave === 'number');
  if (!anyWave) return [items];

  const byWave = new Map<number, T[]>();
  for (const it of items) {
    const w = typeof it.wave === 'number' ? it.wave : 0;
    const bucket = byWave.get(w);
    if (bucket) bucket.push(it);
    else byWave.set(w, [it]);
  }
  return [...byWave.keys()].sort((a, b) => a - b).map((w) => byWave.get(w)!);
}
```

- [ ] **Step 4: Export from barrel** — append to `packages/core/src/autonomous/decompose/index.ts`:

```ts
export { groupItemsByWave } from './wave-order.js';
export type { WaveOrderable } from './wave-order.js';
```

- [ ] **Step 5: Run, expect PASS** + commit

```bash
corepack pnpm exec vitest run packages/core/src/autonomous/decompose/__tests__/wave-order.test.ts
git add packages/core/src/autonomous/decompose/wave-order.ts packages/core/src/autonomous/decompose/index.ts packages/core/src/autonomous/decompose/__tests__/wave-order.test.ts
git commit -m "feat(decompose): groupItemsByWave (flat-safe wave grouping) (PR-2c1)"
```

---

## Task 2: Wrap the execute-phase dispatch loop in a per-wave barrier

**Files:**
- Modify: `packages/core/src/autonomous/phase-handlers/execute-phase.ts`

This is a surgical, behavior-preserving edit. Do it carefully.

- [ ] **Step 1: Add the import**

Near the other imports in `execute-phase.ts`, add:

```ts
import { groupItemsByWave } from '../decompose/index.js';
```

- [ ] **Step 2: Locate the dispatch loop**

Run: `grep -n "for (const item of items) {" packages/core/src/autonomous/phase-handlers/execute-phase.ts`
and `grep -n "await Promise.allSettled(inFlight.keys());" packages/core/src/autonomous/phase-handlers/execute-phase.ts`

You are looking for THIS exact structure (the main dispatch loop — there is one `for (const item of items) {` that contains the `resumeCompletedIds`/`retryImplicatedIds` skip checks and ends with `inFlight.set(p, item.id);`, immediately followed by `await Promise.allSettled(inFlight.keys());` then `await checkpointWriter.flush();`):

```ts
  for (const item of items) {
    // ... skip/kept safeguards ...
    // ... file-lock while-gate ...
    // ... gateRelease + dispatchItem + inFlight.set(p, item.id) ...
  }
  await Promise.allSettled(inFlight.keys());
  await checkpointWriter.flush();
```

- [ ] **Step 3: Apply the wrap (two edits)**

**Edit A — open the wave wrapper.** Change the loop header line:

```ts
  for (const item of items) {
```

to:

```ts
  for (const waveItems of groupItemsByWave(items)) {
    for (const item of waveItems) {
```

(This adds an outer loop and re-indents conceptually; you do NOT need to re-indent the whole body — TS/ESLint tolerate the existing indentation, but if the project's ESLint enforces indent, re-indent the inner block by two spaces. Prefer correctness over cosmetics; run check:types after.)

**Edit B — close the inner loop and move the barrier inside the wave wrapper.** Change:

```ts
  }
  await Promise.allSettled(inFlight.keys());
  await checkpointWriter.flush();
```

to:

```ts
    }
    // Wave barrier (spec §8.1): block until every item in this wave settles
    // before starting the next wave. For flat (non-epic) cycles there is a
    // single wave, so this is exactly the prior end-of-loop barrier.
    await Promise.allSettled(inFlight.keys());
  }
  await checkpointWriter.flush();
```

> The net structure becomes:
> ```ts
>   for (const waveItems of groupItemsByWave(items)) {
>     for (const item of waveItems) {
>       ... unchanged per-item body ...
>     }
>     await Promise.allSettled(inFlight.keys()); // per-wave barrier
>   }
>   await checkpointWriter.flush();
> ```
> Brace count: you added one `for (...) {` and one matching `}` (the line that now reads `}` then the barrier then `}`). Verify braces balance by running check:types.

- [ ] **Step 4: Typecheck** — `corepack pnpm run check:types` → exit 0. (A brace imbalance shows up here immediately.)

- [ ] **Step 5: Regression — the existing execute-phase suite must stay green**

`corepack pnpm exec vitest run packages/core/src/autonomous/phase-handlers/__tests__`
Expect ALL pass. These tests exercise the flat dispatch path (no waves) — they prove the wrap is behavior-preserving (single wave = identical behavior). If any fails, the wrap broke flat execution — STOP and report.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/autonomous/phase-handlers/execute-phase.ts
git commit -m "feat(execute): wave-ordered dispatch with per-wave barrier (flat = single wave) (PR-2c1)"
```

---

## Task 3: Wave-ordering integration test

**Files:**
- Test: `packages/core/src/autonomous/phase-handlers/__tests__/execute-phase-waves.test.ts`

Prove that, with layered items, wave-1 items are not dispatched until all wave-0 items have settled. Use the lightest harness that drives `runExecutePhase` — model it on the existing `execute-phase-worktree.test.ts` setup (read that file first for the `makeCtx`/bus/runtime mock + the tmp plan.json scaffolding it uses, and reuse that exact pattern).

- [ ] **Step 1: Write the test** (adapt helper names to the existing harness in `execute-phase-worktree.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
// import the same helpers/harness execute-phase-worktree.test.ts uses
// (makeCtx, a tmp projectRoot with plan.json, a runtime whose run() records order)

describe('execute phase wave ordering', () => {
  it('does not start a wave-1 item until all wave-0 items have settled', async () => {
    // Build a plan.json with: c1 (wave 0), c2 (wave 0), c3 (wave 1, predecessors [c1,c2]).
    // Use a runtime mock whose run() pushes the item id onto a `startOrder` array
    // and resolves after a microtask. Run runExecutePhase with maxParallelism >= 2.
    // Assert: indexOf('c3') in startOrder is greater than indexOf('c1') AND indexOf('c2'),
    // i.e. c3 started only after both wave-0 items were dispatched+settled.
    //
    // Concretely, if the harness records completion order, assert c3 completes last
    // and c1/c2 both complete before c3 starts.
  });

  it('flat plan (no wave fields) dispatches exactly as before', async () => {
    // Build a plan.json with 3 items and NO wave fields. Assert all 3 run and
    // complete (single-wave path), matching the existing flat behavior.
  });
});
```

> Fill in the body using the harness from `execute-phase-worktree.test.ts`. If driving the full `runExecutePhase` proves too heavy to assert ordering deterministically, fall back to asserting via the `execute.snapshot` / `sprint.phase.item.completed` bus events the phase publishes (the worktree test already subscribes to bus events) — assert the completion order of c1/c2 precedes c3. Keep the test deterministic (resolve mocks on a controlled tick).

- [ ] **Step 2: Run, expect PASS** — `corepack pnpm exec vitest run packages/core/src/autonomous/phase-handlers/__tests__/execute-phase-waves.test.ts`

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/autonomous/phase-handlers/__tests__/execute-phase-waves.test.ts
git commit -m "test(execute): wave ordering — wave-1 waits for wave-0 barrier (PR-2c1)"
```

> If, after a genuine effort, a deterministic runtime ordering test is not achievable with the existing harness without large new scaffolding, report DONE_WITH_CONCERNS: ship Tasks 1-2 (the pure helper is exhaustively tested and the wrap is regression-proven by the existing suite), and note that the runtime ordering assertion is deferred to the PR-2c2 integration-branch E2E. Do NOT fabricate a test that asserts nothing meaningful.

---

## Task 4: Verification gate

- [ ] **Step 1:** `corepack pnpm run check:types` → exit 0.
- [ ] **Step 2:** Full affected suites — `corepack pnpm exec vitest run packages/core tests/autonomous`. Expect only the known pre-existing failures (`invoke-service-cwd`, `codex-cli-transport`, `codex-readiness`) and NOTHING new. Any other failure = the loop wrap broke flat execution → investigate.

---

## Self-Review

**Spec coverage (§8.1 wave barrier):** `groupItemsByWave` (Task 1) + the per-wave `Promise.allSettled` barrier (Task 2) implement "run each wave to completion before the next." Predecessor gating is satisfied transitively by PR-2a's layering (predecessors always in an earlier wave). **Deferred:** integration branch / `sourceRef` (PR-2c2 — without it, wave N+1 forks off main, so dependents get correct *timing* but not predecessor *code*; this is the next PR); smokeGuard between waves + quarantine/blocked cascade (PR-2c3).

**Placeholder scan:** Tasks 1-2 are complete exact code. Task 3's test body is intentionally a harness-adaptation (the existing `execute-phase-worktree.test.ts` harness is the source of truth for the mock shape) with an explicit DONE_WITH_CONCERNS fallback to avoid a meaningless test — this is a guided adaptation, not a placeholder.

**No-op invariant (the core safety argument):** `groupItemsByWave` returns `[items]` (a single wave) whenever no item has a `wave` — which is every signal cycle and every existing test. In that case the wrapped loop runs the identical body in the identical order with a single end barrier, exactly as before. The existing execute-phase suite (Task 2 Step 5, Task 4) is the regression proof.

**Type consistency:** `groupItemsByWave<T extends WaveOrderable>` accepts the execute-phase `SprintItem` (which has `id`/`wave?`/`predecessors?`). Barrier uses the existing `inFlight` map unchanged.

---

## Deferred to PR-2c2 / PR-2c3

- **PR-2c2 (integration branch):** create + push `codex/epic-<id>`; for wave N>0 items pass `sourceRef: 'origin/codex/epic-<id>'` to `allocateWorktreeForItem` (pack §4.4 — pool already supports `sourceRef`); after each wave's barrier, merge completed children into the integration branch under a lock + push + verify, so wave N+1 forks off predecessors' code.
- **PR-2c3 (smokeGuard + cascade):** add the `smokeGuard` arg to `selectGateMode` in `run-verify-tests.mjs` (pack §5.4) + a per-wave smoke check; quarantine a failed child + mark transitive dependents `blocked` (skip them in later waves).
- **PR-2d:** gate on integration HEAD; release PR-opener + epic risk classification; `epic.*` caps; `cycle.json` observability.
