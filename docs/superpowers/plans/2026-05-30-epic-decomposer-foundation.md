# Epic Decomposer — Foundation Implementation Plan (PR-0 + PR-1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the two behavior-free, independently-shippable foundations from the epic-decomposer spec (`2026-05-30-epic-campaign-decomposer-design.md` §13.1 steps 1–2, §18 PR-0/PR-1): the epic fields on the item model, and the checkpoint-file collision fix. Neither changes runtime behavior of existing cycles; both unblock the wave-execution core (PR-2, separate plan).

**Architecture:** PR-0 adds three optional fields (`parentEpicId`, `wave`, `predecessors`) to the four item shapes and the persisted `PlanItemSchema`, so a later DECOMPOSE phase can populate them and the execute phase can read them — signal cycles ignore absent fields. PR-1 resolves the verified latent collision where two writers (`cycle-checkpoint.ts` phase-level, `item-checkpoint.ts` item-level) both write `.agentforge/cycles/<id>/checkpoint.json` with incompatible schemas: split into `checkpoint-cycle.json` and `checkpoint-execute.json`, with a legacy read-shim so old cycles and existing test fixtures still resolve.

**Tech Stack:** TypeScript (strict, NodeNext, ESM — imports end in `.js`), Zod for persisted schemas, Vitest for tests. Node **>=22.13.0** (use `nvm use lts/jod` → 22.22.3; the default shell Node 22.9.0 is below the floor). pnpm via Corepack.

**Environment note for every test/build command below:** run `source "$HOME/.nvm/nvm.sh" && nvm use lts/jod` first in any fresh shell, or the commands fail the version gate.

---

## File Structure

**PR-0 — modified files:**
- `packages/core/src/autonomous/cycle-artifacts/schemas.ts` — add 3 optional fields to `PlanItemSchema` (lines 88–101).
- `packages/core/src/autonomous/sprint-generator.ts` — add 3 optional fields to `SprintPlanItem` (lines 46–64).
- `packages/core/src/autonomous/sprint-framework.ts` — add 3 optional fields to `SprintItem` (lines 45–59).
- `packages/core/src/autonomous/phase-handlers/execute-phase.ts` — add 3 optional fields to the execute-local `SprintItem` (line ~252).
- `packages/core/src/autonomous/types.ts` — annotate `RankedItem.dependencies` `@deprecated` (line 236).
- **New test:** `packages/core/src/autonomous/cycle-artifacts/__tests__/plan-item-epic-fields.test.ts`.

**PR-1 — modified files:**
- `packages/core/src/autonomous/cycle-artifacts/cycle-checkpoint.ts` — write `checkpoint-cycle.json`; read-shim for legacy `checkpoint.json`.
- `packages/core/src/autonomous/checkpoint/item-checkpoint.ts` — write `checkpoint-execute.json`; read-shim for legacy `checkpoint.json`.
- `packages/server/src/routes/v5/durability.ts` — read `checkpoint-execute.json` (legacy fallback) at line ~75.
- `packages/server/src/routes/v5/cycles.ts` — read `checkpoint-cycle.json` (legacy fallback) at line ~173.
- `packages/mcp-server/src/tools/af-codex-workflows.ts` — read new files (legacy fallback) at line ~321.
- **Test updates (write-path assertions only):** `packages/core/src/autonomous/cycle-artifacts/__tests__/cycle-checkpoint.test.ts`, `tests/autonomous/cycle-artifacts/cycle-checkpoint.test.ts`, `tests/autonomous/checkpoint/item-checkpoint.test.ts`, `packages/core/src/autonomous/phase-handlers/__tests__/execute-phase-worktree.test.ts:539`, `tests/autonomous/unit/phase-scheduler.test.ts:323,369`, `tests/autonomous/unit/cycle-runner.test.ts:356`.
- **New test:** `packages/core/src/autonomous/checkpoint/__tests__/checkpoint-no-collision.test.ts`.

---

# PR-0 — Epic fields on the item model

## Task 1: Epic fields in `PlanItemSchema` (persisted round-trip)

**Files:**
- Modify: `packages/core/src/autonomous/cycle-artifacts/schemas.ts:88-101`
- Test: `packages/core/src/autonomous/cycle-artifacts/__tests__/plan-item-epic-fields.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/autonomous/cycle-artifacts/__tests__/plan-item-epic-fields.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PlanJsonSchema } from '../schemas.js';

describe('PlanItemSchema epic fields', () => {
  it('parses and preserves parentEpicId, wave, and predecessors as typed fields', () => {
    const plan = {
      items: [
        {
          id: 'child-1',
          title: 'Add shared RBAC type',
          parentEpicId: 'epic-abc12345',
          wave: 0,
          predecessors: [],
        },
        {
          id: 'child-2',
          title: 'Consume RBAC type in API',
          parentEpicId: 'epic-abc12345',
          wave: 1,
          predecessors: ['child-1'],
        },
      ],
    };

    const parsed = PlanJsonSchema.parse(plan);

    expect(parsed.items[0]!.wave).toBe(0);
    expect(parsed.items[0]!.parentEpicId).toBe('epic-abc12345');
    expect(parsed.items[0]!.predecessors).toEqual([]);
    expect(parsed.items[1]!.wave).toBe(1);
    expect(parsed.items[1]!.predecessors).toEqual(['child-1']);
  });

  it('accepts plan items with no epic fields (signal-cycle back-compat)', () => {
    const parsed = PlanJsonSchema.parse({ items: [{ id: 'i1', title: 'fix bug' }] });
    expect(parsed.items[0]!.wave).toBeUndefined();
    expect(parsed.items[0]!.parentEpicId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm exec vitest run packages/core/src/autonomous/cycle-artifacts/__tests__/plan-item-epic-fields.test.ts`
Expected: FAIL — `parsed.items[0].wave` is `undefined` because the fields are only passthrough-preserved as `unknown`, not typed (TypeScript error on `.wave` access, or the typed assertion fails to compile).

- [ ] **Step 3: Add the fields to `PlanItemSchema`**

In `schemas.ts`, modify `PlanItemSchema` (lines 88–101) to add three optional fields after `tags`:

```ts
const PlanItemSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string().nullish(),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).nullish(),
    assignee: z.string().nullish(),
    status: z
      .enum(['pending', 'in_progress', 'completed', 'skipped', 'failed'])
      .nullish(),
    estimatedCostUsd: NonNegative.nullish(),
    tags: z.array(z.string()).nullish(),
    // Epic-decomposer fields (spec 2026-05-30). Absent on signal cycles.
    parentEpicId: z.string().nullish(),
    wave: z.number().int().min(0).nullish(),
    predecessors: z.array(z.string()).nullish(),
  })
  .passthrough();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm exec vitest run packages/core/src/autonomous/cycle-artifacts/__tests__/plan-item-epic-fields.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/autonomous/cycle-artifacts/schemas.ts \
        packages/core/src/autonomous/cycle-artifacts/__tests__/plan-item-epic-fields.test.ts
git commit -m "feat(decomposer): epic fields on PlanItemSchema (PR-0)"
```

---

## Task 2: Epic fields on the three TypeScript item interfaces

**Files:**
- Modify: `packages/core/src/autonomous/sprint-generator.ts:46-64`
- Modify: `packages/core/src/autonomous/sprint-framework.ts:45-59`
- Modify: `packages/core/src/autonomous/phase-handlers/execute-phase.ts:252`
- Modify: `packages/core/src/autonomous/types.ts:236` (deprecation annotation)
- Test: append to `packages/core/src/autonomous/cycle-artifacts/__tests__/plan-item-epic-fields.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the test file from Task 1:

```ts
import type { SprintPlanItem } from '../../sprint-generator.js';

describe('SprintPlanItem epic fields', () => {
  it('allows constructing an item with epic fields (compile + runtime)', () => {
    const item: SprintPlanItem = {
      id: 'child-1',
      title: 'Add shared type',
      description: 'd',
      priority: 'P1',
      assignee: 'coder',
      status: 'planned',
      estimatedCostUsd: 5,
      tags: ['feature'],
      parentEpicId: 'epic-abc12345',
      wave: 0,
      predecessors: [],
    };
    expect(item.wave).toBe(0);
    expect(item.predecessors).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm exec vitest run packages/core/src/autonomous/cycle-artifacts/__tests__/plan-item-epic-fields.test.ts`
Expected: FAIL — TypeScript compile error: `Object literal may only specify known properties, and 'parentEpicId' does not exist in type 'SprintPlanItem'`.

- [ ] **Step 3: Add the fields to all three interfaces + deprecate `RankedItem.dependencies`**

In `sprint-generator.ts`, add to `SprintPlanItem` (after `rationale?`, before the closing brace at line 64):

```ts
  /** Scorer explanation kept separately from the backlog acceptance contract. */
  rationale?: string;
  /** Epic-decomposer fields (spec 2026-05-30). Absent on signal cycles. */
  parentEpicId?: string;
  wave?: number;
  predecessors?: string[];
}
```

In `sprint-framework.ts`, add to `SprintItem` (after the `tags?` field, before the closing brace at line 59):

```ts
  tags?: string[];
  /** Epic-decomposer fields (spec 2026-05-30). Absent on signal cycles. */
  parentEpicId?: string;
  wave?: number;
  predecessors?: string[];
}
```

In `execute-phase.ts`, add to the local `SprintItem` interface (after the `files?` field, before the closing brace at ~line 264):

```ts
  files?: string[];
  /** Epic-decomposer fields (spec 2026-05-30). Read by the wave-aware
   *  execute loop (PR-2). Absent on signal cycles. */
  parentEpicId?: string;
  wave?: number;
  predecessors?: string[];
}
```

In `types.ts`, annotate `RankedItem.dependencies` (line 236). **Deliberate deviation from spec §7:** removal is deferred — the required field is touched by ~20 literal sites across 6 files incl. the public `preview-cycle.ts` surface; it does not collide with the new `predecessors` (different type, different code path). Mark it deprecated instead:

```ts
  rationale: string;
  /** @deprecated Dead since the epic decomposer (spec 2026-05-30). The scorer
   *  still emits `[]`; nothing reads it. Epic ordering uses `predecessors` on
   *  the plan item, not this field. Slated for removal in a later cleanup PR. */
  dependencies: string[];
  suggestedAssignee: string;
```

- [ ] **Step 4: Run test + typecheck to verify they pass**

Run: `corepack pnpm exec vitest run packages/core/src/autonomous/cycle-artifacts/__tests__/plan-item-epic-fields.test.ts`
Expected: PASS.
Run: `corepack pnpm exec tsc -b --noEmit`
Expected: clean (no errors).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/autonomous/sprint-generator.ts \
        packages/core/src/autonomous/sprint-framework.ts \
        packages/core/src/autonomous/phase-handlers/execute-phase.ts \
        packages/core/src/autonomous/types.ts \
        packages/core/src/autonomous/cycle-artifacts/__tests__/plan-item-epic-fields.test.ts
git commit -m "feat(decomposer): epic fields on SprintItem family; deprecate RankedItem.dependencies (PR-0)"
```

---

# PR-1 — Checkpoint-file collision fix

## Task 3: `cycle-checkpoint.ts` writes `checkpoint-cycle.json` with legacy read-shim

**Files:**
- Modify: `packages/core/src/autonomous/cycle-artifacts/cycle-checkpoint.ts:87-93,105-115,137-161`
- Test: `packages/core/src/autonomous/cycle-artifacts/__tests__/cycle-checkpoint.test.ts` (and `tests/autonomous/cycle-artifacts/cycle-checkpoint.test.ts`)

- [ ] **Step 1: Write the failing test**

Add to `packages/core/src/autonomous/cycle-artifacts/__tests__/cycle-checkpoint.test.ts`:

```ts
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

describe('cycle-checkpoint filename split (PR-1)', () => {
  it('writes to checkpoint-cycle.json, not checkpoint.json', () => {
    const cycleDir = makeTmpCycleDir(); // existing helper in this file
    writeCheckpoint(cycleDir, validCheckpoint('abc12345'));
    expect(existsSync(join(cycleDir, 'checkpoint-cycle.json'))).toBe(true);
    expect(existsSync(join(cycleDir, 'checkpoint.json'))).toBe(false);
  });

  it('reads back from checkpoint-cycle.json', () => {
    const cycleDir = makeTmpCycleDir();
    writeCheckpoint(cycleDir, validCheckpoint('abc12345'));
    expect(readCheckpoint(cycleDir)?.cycleId).toBe('abc12345');
  });

  it('read-shim: falls back to legacy checkpoint.json when new file absent', () => {
    const cycleDir = makeTmpCycleDir();
    mkdirSync(cycleDir, { recursive: true });
    writeFileSync(join(cycleDir, 'checkpoint.json'),
      JSON.stringify(validCheckpoint('abc12345'), null, 2));
    expect(readCheckpoint(cycleDir)?.cycleId).toBe('abc12345');
  });
});
```

> If `makeTmpCycleDir`/`validCheckpoint` helpers don't already exist in the file, define them at the top mirroring the existing test's setup (a `mkdtempSync` dir ending in an 8+ char id, and a `CycleCheckpoint` literal with `v:1, cycleId, capturedAt, resumeFromPhase:'audit', completedPhases:[], budgetUsd:0, spentUsd:0`).

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm exec vitest run packages/core/src/autonomous/cycle-artifacts/__tests__/cycle-checkpoint.test.ts`
Expected: FAIL — first test fails because `writeCheckpoint` still writes `checkpoint.json`.

- [ ] **Step 3: Implement the filename split + read-shim**

In `cycle-checkpoint.ts`, replace `resolveCheckpointPath` (lines 87–93) and add a legacy resolver:

```ts
function resolveCheckpointPath(cycleDir: string): string {
  return resolveNamedCheckpointPath(cycleDir, 'checkpoint-cycle.json');
}

/** Legacy single-file name, kept for the one-release read-shim. */
function resolveLegacyCheckpointPath(cycleDir: string): string {
  return resolveNamedCheckpointPath(cycleDir, 'checkpoint.json');
}

function resolveNamedCheckpointPath(cycleDir: string, filename: string): string {
  const parts = cycleDir.split(/[\\/]/).filter(Boolean);
  const last = parts[parts.length - 1] ?? '';
  const safeId = safeCycleId(last);
  const parentDir = cycleDir.slice(0, cycleDir.length - last.length);
  return join(parentDir, safeId, filename);
}
```

`writeCheckpoint` (line 105) needs no change — it calls `resolveCheckpointPath`, which now returns the new name.

Replace `readCheckpoint` (lines 137–161) with a shim that tries the new file then the legacy file:

```ts
export function readCheckpoint(cycleDir: string): CycleCheckpoint | null {
  for (const resolver of [resolveCheckpointPath, resolveLegacyCheckpointPath]) {
    let finalPath: string;
    try {
      finalPath = resolver(cycleDir);
    } catch {
      return null;
    }
    let raw: string;
    try {
      raw = readFileSync(finalPath, 'utf8');
    } catch {
      continue; // ENOENT or unreadable — try the next candidate.
    }
    try {
      const result = CycleCheckpointSchema.safeParse(JSON.parse(raw));
      if (result.success) return result.data;
      // Wrong schema (e.g. a legacy file that held the execute checkpoint) — skip.
    } catch {
      // malformed JSON — skip to next candidate.
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm exec vitest run packages/core/src/autonomous/cycle-artifacts/__tests__/cycle-checkpoint.test.ts`
Expected: PASS (all three new tests + existing tests).

- [ ] **Step 5: Update the legacy write-path assertion in the mirror test**

In `tests/autonomous/cycle-artifacts/cycle-checkpoint.test.ts`, the assertions that the write produces `checkpoint.json` (lines ~47, 51, 63, 73) must target `checkpoint-cycle.json`. The ENOENT/malformed read tests (lines ~109, 130, 136) write a legacy `checkpoint.json` and are still valid via the shim — leave them, they now exercise the fallback. Update only the **write-path** assertions:

```ts
// line ~47
it('writes a valid checkpoint to checkpoint-cycle.json', () => {
// line ~51
const path = join(cycleDir, 'checkpoint-cycle.json');
// line ~63
expect(files).toContain('checkpoint-cycle.json');
// line ~73
const raw = JSON.parse(readFileSync(join(cycleDir, 'checkpoint-cycle.json'), 'utf8'));
```

- [ ] **Step 6: Run both checkpoint test files**

Run: `corepack pnpm exec vitest run packages/core/src/autonomous/cycle-artifacts/__tests__/cycle-checkpoint.test.ts tests/autonomous/cycle-artifacts/cycle-checkpoint.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/autonomous/cycle-artifacts/cycle-checkpoint.ts \
        packages/core/src/autonomous/cycle-artifacts/__tests__/cycle-checkpoint.test.ts \
        tests/autonomous/cycle-artifacts/cycle-checkpoint.test.ts
git commit -m "feat(checkpoint): cycle checkpoint writes checkpoint-cycle.json + legacy read-shim (PR-1)"
```

---

## Task 4: `item-checkpoint.ts` writes `checkpoint-execute.json` with legacy read-shim

**Files:**
- Modify: `packages/core/src/autonomous/checkpoint/item-checkpoint.ts:65-68,184-242`
- Test: `tests/autonomous/checkpoint/item-checkpoint.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/autonomous/checkpoint/item-checkpoint.test.ts`:

```ts
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';

describe('item-checkpoint filename split (PR-1)', () => {
  it('writes to checkpoint-execute.json, not checkpoint.json', async () => {
    const root = makeTmpRoot(); // existing helper
    const w = new ItemCheckpointWriter(root, 2);
    await w.enqueue(CYCLE_ID, 'i1', 'completed');
    await w.flush();
    const dir = join(root, '.agentforge', 'cycles', CYCLE_ID);
    expect(existsSync(join(dir, 'checkpoint-execute.json'))).toBe(true);
    expect(existsSync(join(dir, 'checkpoint.json'))).toBe(false);
  });

  it('static readProgress reads checkpoint-execute.json', async () => {
    const root = makeTmpRoot();
    const w = new ItemCheckpointWriter(root, 2);
    await w.enqueue(CYCLE_ID, 'i1', 'completed');
    await w.flush();
    expect(ItemCheckpointWriter.getCompletedItemIds(root, CYCLE_ID).has('i1')).toBe(true);
  });

  it('read-shim: falls back to legacy checkpoint.json when new file absent', () => {
    const root = makeTmpRoot();
    const dir = join(root, '.agentforge', 'cycles', CYCLE_ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify({
      cycleId: CYCLE_ID, phase: 'execute', completedItemIds: ['i9'],
      currentItemId: null, totalItems: 1, lastUpdatedAt: new Date().toISOString(),
      schemaVersion: 2,
    }, null, 2));
    expect(ItemCheckpointWriter.getCompletedItemIds(root, CYCLE_ID).has('i9')).toBe(true);
  });
});
```

> `makeTmpRoot`/`CYCLE_ID` mirror the existing test setup (`CYCLE_ID` is an 8+ char `[a-zA-Z0-9-]` string).

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm exec vitest run tests/autonomous/checkpoint/item-checkpoint.test.ts`
Expected: FAIL — writer still emits `checkpoint.json`.

- [ ] **Step 3: Implement the filename split + read-shim**

In `item-checkpoint.ts`, replace `resolveCheckpointPath` (lines 65–68) and add a legacy resolver:

```ts
function resolveCheckpointPath(projectRoot: string, cycleId: string): string {
  const safeId = safeSegment(cycleId, 'cycleId');
  return join(projectRoot, '.agentforge', 'cycles', safeId, 'checkpoint-execute.json');
}

/** Legacy single-file name, kept for the one-release read-shim. */
function resolveLegacyCheckpointPath(projectRoot: string, cycleId: string): string {
  const safeId = safeSegment(cycleId, 'cycleId');
  return join(projectRoot, '.agentforge', 'cycles', safeId, 'checkpoint.json');
}
```

Add a shared read helper and route both `_readProgress` and the static `readProgress` through it. Add this private helper near `_readProgress`:

```ts
function tryParseProgress(checkpointPath: string, cycleId: string): ExecuteProgress | null {
  try {
    const raw = readFileSync(checkpointPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ExecuteProgress>;
    if (
      parsed.schemaVersion === 2 &&
      parsed.cycleId === cycleId &&
      parsed.phase === 'execute' &&
      Array.isArray(parsed.completedItemIds)
    ) {
      return parsed as ExecuteProgress;
    }
  } catch {
    // ENOENT or malformed — fall through.
  }
  return null;
}
```

Replace the body of `_readProgress` (lines 184–210) to try new then legacy before starting fresh:

```ts
  private _readProgress(cycleId: string, checkpointPath: string): ExecuteProgress {
    const fromNew = tryParseProgress(checkpointPath, cycleId);
    if (fromNew) return fromNew;
    const fromLegacy = tryParseProgress(
      resolveLegacyCheckpointPath(this.projectRoot, cycleId), cycleId);
    if (fromLegacy) return fromLegacy;
    return {
      cycleId,
      phase: 'execute',
      completedItemIds: [],
      currentItemId: null,
      totalItems: this.totalItems,
      lastUpdatedAt: new Date().toISOString(),
      schemaVersion: 2,
    };
  }
```

Replace the static `readProgress` (lines 220–242) to try new then legacy:

```ts
  static readProgress(projectRoot: string, cycleId: string): ExecuteProgress | null {
    let newPath: string;
    let legacyPath: string;
    try {
      newPath = resolveCheckpointPath(projectRoot, cycleId);
      legacyPath = resolveLegacyCheckpointPath(projectRoot, cycleId);
    } catch {
      return null;
    }
    return tryParseProgress(newPath, cycleId) ?? tryParseProgress(legacyPath, cycleId);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm exec vitest run tests/autonomous/checkpoint/item-checkpoint.test.ts`
Expected: PASS.

- [ ] **Step 5: Update legacy write-path assertions in the same file**

In `tests/autonomous/checkpoint/item-checkpoint.test.ts`, update the helper path (line ~34) and write-path assertions (lines ~60, 90, 147, 155) from `checkpoint.json` to `checkpoint-execute.json`. The read-shim keeps any legacy-fixture tests valid.

```ts
// line ~34
return join(root, '.agentforge', 'cycles', CYCLE_ID, 'checkpoint-execute.json');
// line ~60
it('writes checkpoint-execute.json after first enqueue', async () => {
// line ~90
expect(files).toContain('checkpoint-execute.json');
```

- [ ] **Step 6: Run test to verify it passes**

Run: `corepack pnpm exec vitest run tests/autonomous/checkpoint/item-checkpoint.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/autonomous/checkpoint/item-checkpoint.ts \
        tests/autonomous/checkpoint/item-checkpoint.test.ts
git commit -m "feat(checkpoint): item checkpoint writes checkpoint-execute.json + legacy read-shim (PR-1)"
```

---

## Task 5: No-collision integration test

**Files:**
- Test (new): `packages/core/src/autonomous/checkpoint/__tests__/checkpoint-no-collision.test.ts`

- [ ] **Step 1: Write the test (this is the regression guard for the whole PR)**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ItemCheckpointWriter } from '../item-checkpoint.js';
import { writeCheckpoint, readCheckpoint } from '../../cycle-artifacts/cycle-checkpoint.js';

const CYCLE_ID = 'collide01';

describe('checkpoint writers do not collide (PR-1)', () => {
  it('cycle and item checkpoints write distinct files; neither clobbers the other', async () => {
    const root = mkdtempSync(join(tmpdir(), 'af-ckpt-'));
    const cycleDir = join(root, '.agentforge', 'cycles', CYCLE_ID);

    // Phase-level checkpoint (cycle-checkpoint).
    writeCheckpoint(cycleDir, {
      v: 1, cycleId: CYCLE_ID, capturedAt: new Date().toISOString(),
      resumeFromPhase: 'execute', completedPhases: ['audit', 'plan', 'assign'],
      budgetUsd: 100, spentUsd: 10,
    });

    // Item-level checkpoint (item-checkpoint), same cycle, interleaved.
    const w = new ItemCheckpointWriter(root, 3);
    await w.enqueue(CYCLE_ID, 'i1', 'completed');
    await w.flush();

    // Both survive: each reader gets its own intact data.
    expect(readCheckpoint(cycleDir)?.completedPhases).toEqual(['audit', 'plan', 'assign']);
    expect(ItemCheckpointWriter.getCompletedItemIds(root, CYCLE_ID).has('i1')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `corepack pnpm exec vitest run packages/core/src/autonomous/checkpoint/__tests__/checkpoint-no-collision.test.ts`
Expected: PASS. (Before Tasks 3–4 it would have failed: the second writer clobbered the first.)

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/autonomous/checkpoint/__tests__/checkpoint-no-collision.test.ts
git commit -m "test(checkpoint): regression guard proving the two writers no longer collide (PR-1)"
```

---

## Task 6: Update `durability.ts` consumer → `checkpoint-execute.json` (legacy fallback)

**Files:**
- Modify: `packages/server/src/routes/v5/durability.ts:75`
- Test: `tests/server/v5/durability.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/server/v5/durability.test.ts` (mirror the existing fixture helper that writes to a cycle dir):

```ts
it('reads item progress from checkpoint-execute.json', async () => {
  const dir = join(cyclesDir, 'cycle-exec1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'checkpoint-execute.json'), JSON.stringify({
    cycleId: 'cycle-exec1', phase: 'execute', completedItemIds: ['a', 'b'],
    currentItemId: null, totalItems: 3, lastUpdatedAt: new Date().toISOString(),
    schemaVersion: 2,
  }));
  const res = await app.inject({ method: 'GET', url: '/api/v5/durability/checkpoints' });
  const rec = res.json().data.find((c: { cycleId: string }) => c.cycleId === 'cycle-exec1');
  expect(rec.completedItemIds).toEqual(['a', 'b']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm exec vitest run tests/server/v5/durability.test.ts`
Expected: FAIL — the route only scans for `checkpoint.json`, so `cycle-exec1` is skipped.

- [ ] **Step 3: Implement new-then-legacy resolution**

In `durability.ts`, change `readCheckpoint` (line 75) to try the new file then legacy, and update the directory scan in the route (line ~128 region) to detect either filename. Replace line 75:

```ts
  const newPath = resolve(join(cyclesBaseDir, safeId, 'checkpoint-execute.json'));
  const legacyPath = resolve(join(cyclesBaseDir, safeId, 'checkpoint.json'));
  const checkpointPath = existsSync(newPath) ? newPath : legacyPath;
```

(The existing traversal guard on `checkpointPath` and the `existsSync(checkpointPath)` check below it stay as-is — both candidates resolve inside `cyclesBaseDir`.) In the scan loop that lists cycle dirs, ensure a directory is included when **either** `checkpoint-execute.json` **or** `checkpoint.json` exists.

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm exec vitest run tests/server/v5/durability.test.ts`
Expected: PASS (new test + all existing legacy-fixture tests via fallback).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/v5/durability.ts tests/server/v5/durability.test.ts
git commit -m "feat(server): durability reads checkpoint-execute.json with legacy fallback (PR-1)"
```

---

## Task 7: Update `cycles.ts` consumer → `checkpoint-cycle.json` (legacy fallback)

**Files:**
- Modify: `packages/server/src/routes/v5/cycles.ts:172-187`
- Test: `tests/server/routes/cycles-checkpoint-field.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/server/routes/cycles-checkpoint-field.test.ts`:

```ts
it('reads phase checkpoint from checkpoint-cycle.json', () => {
  mkdirSync(join(tmpDir, 'cycle-abc123'), { recursive: true });
  writeFileSync(join(tmpDir, 'cycle-abc123', 'checkpoint-cycle.json'), JSON.stringify({
    v: 1, cycleId: 'cycle-abc123', capturedAt: new Date().toISOString(),
    resumeFromPhase: 'execute', completedPhases: ['audit', 'plan'],
    budgetUsd: 50, spentUsd: 5,
  }));
  const result = readCycleCheckpoint(join(tmpDir, 'cycle-abc123'));
  expect(result?.resumeFromPhase).toBe('execute');
});
```

> If `readCycleCheckpoint` isn't exported, export it from `cycles.ts` for the test (it is currently module-private — add `export`).

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm exec vitest run tests/server/routes/cycles-checkpoint-field.test.ts`
Expected: FAIL — reader only opens `checkpoint.json`.

- [ ] **Step 3: Implement new-then-legacy resolution**

In `cycles.ts`, change `readCycleCheckpoint` (line 172–174):

```ts
export function readCycleCheckpoint(dir: string): CycleCheckpoint | undefined {
  const newFile = join(dir, 'checkpoint-cycle.json');
  const legacyFile = join(dir, 'checkpoint.json');
  const file = existsSync(newFile) ? newFile : legacyFile;
  if (!existsSync(file)) return undefined;
  // ...rest unchanged
```

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm exec vitest run tests/server/routes/cycles-checkpoint-field.test.ts`
Expected: PASS (new + existing legacy tests via fallback).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/routes/v5/cycles.ts tests/server/routes/cycles-checkpoint-field.test.ts
git commit -m "feat(server): cycle detail reads checkpoint-cycle.json with legacy fallback (PR-1)"
```

---

## Task 8: Update mcp `af-codex-workflows.ts` consumer (legacy fallback)

**Files:**
- Modify: `packages/mcp-server/src/tools/af-codex-workflows.ts:321`

- [ ] **Step 1: Read the current call site**

Run: `sed -n '310,330p' packages/mcp-server/src/tools/af-codex-workflows.ts`
Expected: a `readJson(join(cycleDir, 'checkpoint.json'))` call assigned to a `checkpoint` field for `af_cycle_status`.

- [ ] **Step 2: Implement new-then-legacy resolution**

Replace the single read with a helper that prefers the cycle checkpoint, then execute, then legacy:

```ts
    checkpoint:
      readJson(join(cycleDir, 'checkpoint-cycle.json')) ??
      readJson(join(cycleDir, 'checkpoint-execute.json')) ??
      readJson(join(cycleDir, 'checkpoint.json')),
```

(`readJson` already returns `null`/`undefined` on ENOENT — confirm by reading its definition in the same file; if it throws, wrap each call in the existing try/catch pattern.)

- [ ] **Step 3: Build the mcp package to verify it compiles**

Run: `corepack pnpm exec tsc -b --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-server/src/tools/af-codex-workflows.ts
git commit -m "feat(mcp): af_cycle_status reads split checkpoint files with legacy fallback (PR-1)"
```

---

## Task 9: Update remaining write-path test assertions

**Files:**
- Modify: `packages/core/src/autonomous/phase-handlers/__tests__/execute-phase-worktree.test.ts:539`
- Modify: `tests/autonomous/unit/phase-scheduler.test.ts:323,369`
- Modify: `tests/autonomous/unit/cycle-runner.test.ts:356`

These tests read a checkpoint file the code now writes under a new name. `phase-scheduler` and `cycle-runner` write **cycle** checkpoints → `checkpoint-cycle.json`. `execute-phase-worktree` reads the **item** checkpoint → `checkpoint-execute.json`.

- [ ] **Step 1: Update each literal**

```ts
// execute-phase-worktree.test.ts:539 (item checkpoint)
readFileSync(join(tmpRoot, '.agentforge', 'cycles', 'cycle-wt-1', 'checkpoint-execute.json'), 'utf8'),
// phase-scheduler.test.ts:323 and :369 (cycle checkpoint)
readFileSync(join(tmpDir, '.agentforge', 'cycles', cycleId, 'checkpoint-cycle.json'), 'utf8'),
// cycle-runner.test.ts:356 (cycle checkpoint)
join(tmpDir, '.agentforge', 'cycles', ctx.cycleId, 'checkpoint-cycle.json'),
```

- [ ] **Step 2: Run the affected suites**

Run: `corepack pnpm exec vitest run packages/core/src/autonomous/phase-handlers/__tests__/execute-phase-worktree.test.ts tests/autonomous/unit/phase-scheduler.test.ts tests/autonomous/unit/cycle-runner.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/autonomous/phase-handlers/__tests__/execute-phase-worktree.test.ts \
        tests/autonomous/unit/phase-scheduler.test.ts \
        tests/autonomous/unit/cycle-runner.test.ts
git commit -m "test(checkpoint): update write-path assertions to split filenames (PR-1)"
```

---

## Task 10: Full-suite verification gate

- [ ] **Step 1: Typecheck the whole monorepo**

Run: `corepack pnpm exec tsc -b --noEmit`
Expected: clean.

- [ ] **Step 2: Run the affected package test suites**

Run: `corepack pnpm exec vitest run packages/core tests/autonomous tests/server`
Expected: all PASS. Investigate any failure before proceeding — a remaining hard-coded `checkpoint.json` literal in a write-path assertion is the most likely culprit; grep `grep -rn "checkpoint.json" packages/*/src tests --include=*.ts | grep -v -- -cycle.json | grep -v -- -execute.json` and confirm each remaining hit is a *read-shim fallback fixture* (intended), not a stale write assertion.

- [ ] **Step 3: Update the CLAUDE.md durability note (M1 doc correction)**

The Wave 5 T1 entry in `CLAUDE.md` (~line 329) says checkpoints write `checkpoints/<item-id>.json`. Reality is a single aggregated file, now `checkpoint-execute.json`. Correct the line:

```md
Each cycle item's completion is recorded in `.agentforge/cycles/<id>/checkpoint-execute.json`
(aggregated `completedItemIds[]`). Phase-level resume state is in `checkpoint-cycle.json`.
Use `--resume <cycle-id>` to re-enter at the first incomplete item.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: correct checkpoint filenames after the collision-split (PR-1)"
```

---

## Self-Review

**Spec coverage (against §13.1 steps 1–2 and §18 PR-0/PR-1):**
- §13.1 step 1 (types + schema, fix toSprintItem, dependencies) → Tasks 1–2. **Note:** `toSprintItem` carry-through is intentionally *not* done here — `RankedItem` has no epic fields (epic children are written to `plan.json` by DECOMPOSE in PR-2, not via the scoring→RankedItem path), so there is nothing to carry yet. The schema + interface fields are what PR-2 needs. `dependencies` removal deferred (documented in Task 2).
- §13.1 step 2 (checkpoint split) → Tasks 3–9, with the M1 resume-ordering invariant (flush-after-push) correctly **deferred to PR-2**, since it only matters once waves write mid-phase. Doc correction in Task 10.
- §11 read-shim → implemented in both writers (Tasks 3–4) and all three consumers (Tasks 6–8).

**Placeholder scan:** none — every code step shows complete code. The only "read the current call site" step (Task 8 Step 1) is a verification step before an exact edit, not a placeholder.

**Type consistency:** `parentEpicId`/`wave`/`predecessors` named identically across all four shapes and the schema. `resolveCheckpointPath` / `resolveLegacyCheckpointPath` / `tryParseProgress` named consistently within each module. `checkpoint-cycle.json` (phase) vs `checkpoint-execute.json` (item) used consistently: phase consumers (cycles.ts, phase-scheduler, cycle-runner) → cycle; item consumers (durability.ts, execute-phase-worktree) → execute.

**Gap check:** the `cycles-detail.test.ts` and `cycles-stages-field.test.ts` write legacy `checkpoint.json` fixtures and read via the route — these pass unchanged through the fallback (no edit needed). Verified intentional in Task 10 Step 2.

---

## Deferred to the PR-2 plan (wave-execution core — separate document)

Per spec §13.1 steps 3–10 and §18 PR-2, written against the *merged* foundation: `EpicObjective` + `--objective` flag + `objective.json`; the `epic-planner` Opus agent + `EpicPlan` schemas; the DECOMPOSE phase (cycle-check + file-overlap + import-edge augmentation + wave layering + `decomposition.json`); worktree base-branch threading; the strict wave-barrier execute loop + `smokeGuard` flag in `run-verify-tests.mjs`; merge-under-lock/push-verify; the quarantine/blocked cascade; gate/release epic-awareness; `epic.*` caps + `cycle.json` observability; `cycle preview --objective`; and the resume-ordering invariant (flush checkpoint after push).
