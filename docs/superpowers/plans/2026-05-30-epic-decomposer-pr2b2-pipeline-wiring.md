# Epic Decomposer — PR-2b2: Pipeline Wiring (fold decomposition into the plan phase)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make `agentforge cycle run --objective "..."` decompose end-to-end. Thread an `objective` through the CLI → `CycleRunner` → `PhaseContext`, and have the existing **plan phase** branch (when an objective is present) into the epic path: call `decomposeObjective` (PR-2b1), write `objective.json` + `decomposition.json`, and overwrite `plan.json` items with the wave-layered children. Signal cycles (no `--objective`) are byte-for-byte unchanged.

**Architecture (approved deviation from spec §4):** Rather than a 10th canonical `decompose` phase — the 9-phase sequence is hard-coded in ~13 files (incl. the shared `step-score` Zod enum, the dashboard `CYCLE_PHASES`, `sprint-framework`) and asserted in ~15 tests — decomposition runs at the **tail of the `plan` phase**, gated on `ctx.objective`. Identical artifacts (`decomposition.json` + wave-layered `plan.json`); near-zero blast radius; PR-2c (execute waves) and PR-2d (gate/release) are unaffected because they read the flattened `plan.json` and touch execute/gate, not the plan phase.

**Tech Stack:** TypeScript (strict, NodeNext, ESM — `.js` suffixes), Vitest. Node **>=22.13.0** (`nvm use lts/jod`).

**Environment note for every command:** prefix with `source "$HOME/.nvm/nvm.sh" && nvm use lts/jod >/dev/null 2>&1 &&`. Working dir `/Users/seandonvaughan/Projects/AgentForge`, branch `feat/epic-decomposer` (do NOT switch, do NOT push). `git add` new files immediately. Read a file before Edit.

**Verification:** test `corepack pnpm exec vitest run <path>`; typecheck `corepack pnpm run check:types` (`tsc -b`; expect exit 0 — never `tsc -b --noEmit`).

---

## File Structure

- New: `packages/core/src/autonomous/decompose/flatten.ts` — `flattenEpicPlanToPlanItems(plan)`: EpicPlan → `SprintPlanItem`-shaped objects with epic fields. Pure.
- Modify: `packages/core/src/autonomous/decompose/index.ts` — export the flatten surface.
- Modify: `packages/core/src/autonomous/phase-scheduler.ts` — add `objective?: string` to `PhaseContext`.
- Modify: `packages/core/src/autonomous/cycle-runner.ts` — add `objective?: string` to `CycleRunnerOptions`; populate `ctx.objective` in every `PhaseContext` construction.
- Modify: `packages/cli/src/commands/autonomous.ts` — `--objective` on `cycle run`; `CycleRunOptions.objective`; thread into the `CycleRunner({...})` spread.
- Modify: `packages/core/src/autonomous/phase-handlers/plan-phase.ts` — branch on `ctx.objective` to the epic path (`runEpicDecompositionPlan`); local `atomicWriteJson` helper.
- New tests: `decompose/__tests__/flatten.test.ts`, `phase-handlers/__tests__/plan-phase-epic.test.ts`.

---

## Task 1: `flattenEpicPlanToPlanItems` helper

**Files:**
- Create: `packages/core/src/autonomous/decompose/flatten.ts`
- Modify: `packages/core/src/autonomous/decompose/index.ts`
- Test: `packages/core/src/autonomous/decompose/__tests__/flatten.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { flattenEpicPlanToPlanItems } from '../flatten.js';
import type { EpicPlan } from '../types.js';

const plan: EpicPlan = {
  epicId: 'epic-abc12345',
  rationale: 'r',
  children: [
    { id: 'c1', title: 'type', description: 'add type', files: ['shared.ts'], capabilityTags: ['types'],
      suggestedAssignee: 'shared-utils-engineer', estimatedCostUsd: 2, estimatedComplexity: 'low', predecessors: [], wave: 0 },
    { id: 'c2', title: 'api', description: 'use type', files: ['api.ts'], capabilityTags: ['route'],
      suggestedAssignee: 'fastify-v5-engineer', estimatedCostUsd: 3, estimatedComplexity: 'medium', predecessors: ['c1'], wave: 1 },
  ],
};

describe('flattenEpicPlanToPlanItems', () => {
  it('maps children to plan items carrying epic fields', () => {
    const items = flattenEpicPlanToPlanItems(plan);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: 'c1', title: 'type', assignee: 'shared-utils-engineer', status: 'planned',
      parentEpicId: 'epic-abc12345', wave: 0, predecessors: [], tags: ['types'], files: ['shared.ts'],
    });
    expect(items[1]!.predecessors).toEqual(['c1']);
    expect(items[1]!.wave).toBe(1);
  });

  it('defaults wave to 0 when a child was not layered', () => {
    const unlayered: EpicPlan = { ...plan, children: [{ ...plan.children[0]!, wave: undefined }] };
    expect(flattenEpicPlanToPlanItems(unlayered)[0]!.wave).toBe(0);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `corepack pnpm exec vitest run packages/core/src/autonomous/decompose/__tests__/flatten.test.ts`

- [ ] **Step 3: Create `flatten.ts`**

```ts
// packages/core/src/autonomous/decompose/flatten.ts
//
// Flatten a wave-layered EpicPlan into plan.json item objects. The shape
// matches SprintPlanItem (sprint-generator.ts) including the epic fields
// added in PR-0 (parentEpicId/wave/predecessors). (spec 2026-05-30 §6.4)

import type { EpicPlan } from './types.js';

export interface FlattenedPlanItem {
  id: string;
  title: string;
  description: string;
  priority: 'P1';
  assignee: string;
  status: 'planned';
  estimatedCostUsd: number;
  tags: string[];
  files: string[];
  parentEpicId: string;
  wave: number;
  predecessors: string[];
}

export function flattenEpicPlanToPlanItems(plan: EpicPlan): FlattenedPlanItem[] {
  return plan.children.map((c) => ({
    id: c.id,
    title: c.title,
    description: c.description,
    priority: 'P1',
    assignee: c.suggestedAssignee,
    status: 'planned',
    estimatedCostUsd: c.estimatedCostUsd,
    tags: [...c.capabilityTags],
    files: [...c.files],
    parentEpicId: plan.epicId,
    wave: c.wave ?? 0,
    predecessors: [...c.predecessors],
  }));
}
```

- [ ] **Step 4: Export from barrel** — append to `packages/core/src/autonomous/decompose/index.ts`:

```ts
export { flattenEpicPlanToPlanItems } from './flatten.js';
export type { FlattenedPlanItem } from './flatten.js';
```

- [ ] **Step 5: Run, expect PASS** + commit

```bash
corepack pnpm exec vitest run packages/core/src/autonomous/decompose/__tests__/flatten.test.ts
git add packages/core/src/autonomous/decompose/flatten.ts packages/core/src/autonomous/decompose/index.ts packages/core/src/autonomous/decompose/__tests__/flatten.test.ts
git commit -m "feat(decompose): flattenEpicPlanToPlanItems helper (PR-2b2)"
```

---

## Task 2: Objective plumbing (PhaseContext → CycleRunner → CLI)

**Files:**
- Modify: `packages/core/src/autonomous/phase-scheduler.ts` (`PhaseContext`, ~line 84-135)
- Modify: `packages/core/src/autonomous/cycle-runner.ts` (`CycleRunnerOptions`; every `PhaseContext` construction)
- Modify: `packages/cli/src/commands/autonomous.ts` (`CycleRunOptions`, command registration, `CycleRunner` spread)

No new test file — Task 3's plan-phase-epic test exercises the threaded `ctx.objective` end-to-end; this task is plumbing verified by `check:types` + the existing cycle-runner/CLI tests staying green.

- [ ] **Step 1: Add `objective?: string` to `PhaseContext`**

In `phase-scheduler.ts`, inside `interface PhaseContext` (after `budgetUsd?: number;`, before the closing brace):

```ts
  /**
   * Epic-decomposer (spec 2026-05-30): the operator's objective text. When
   * present, the plan phase decomposes it into wave-layered plan.json items
   * instead of producing a signal-backlog text plan. Absent on signal cycles.
   */
  objective?: string;
```

- [ ] **Step 2: Add `objective?: string` to `CycleRunnerOptions`**

In `cycle-runner.ts`, inside `interface CycleRunnerOptions` (add near `dryRun?`):

```ts
  /** Epic-decomposer: operator objective threaded to the plan phase's epic path. */
  objective?: string;
```

- [ ] **Step 3: Populate `ctx.objective` in every `PhaseContext` construction**

In `cycle-runner.ts`, every `PhaseContext` is built with a line `baseBranch: this.options.config.git.baseBranch,`. There are ~4 such constructions (grep: `grep -n "baseBranch: this.options.config.git.baseBranch" packages/core/src/autonomous/cycle-runner.ts`). Immediately after EACH such line, add:

```ts
        ...(this.options.objective ? { objective: this.options.objective } : {}),
```

Match the surrounding indentation at each site. (Spread of an optional keeps `objective` absent on signal cycles, preserving exact current behavior.)

- [ ] **Step 4: Add the `--objective` flag + option type + thread it (CLI)**

In `autonomous.ts`:
(a) `CycleRunOptions` interface (~line 53-68): add `objective?: string;` after `fallback?: boolean;`.
(b) `registerCycleRunCommand` (~line 371-389): add this option before `.action(runCycleAction);`:

```ts
    .option('--objective <text>', 'Decompose a high-level objective into a dependency-ordered epic instead of a signal backlog')
```

(c) The `CycleRunner({...})` instantiation (~line 596-613): add to the options spread (next to the other `...(opts.x ? {...} : {})` spreads):

```ts
        ...(opts.objective ? { objective: opts.objective } : {}),
```

- [ ] **Step 5: Typecheck + existing suites green**

`corepack pnpm run check:types` → exit 0.
`corepack pnpm exec vitest run tests/autonomous/unit/cycle-runner.test.ts tests/autonomous/unit/phase-scheduler.test.ts` → all pass (plumbing must not change existing behavior).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/autonomous/phase-scheduler.ts packages/core/src/autonomous/cycle-runner.ts packages/cli/src/commands/autonomous.ts
git commit -m "feat(decompose): thread --objective through CLI -> CycleRunner -> PhaseContext (PR-2b2)"
```

---

## Task 3: Plan-phase epic branch

**Files:**
- Modify: `packages/core/src/autonomous/phase-handlers/plan-phase.ts`
- Test: `packages/core/src/autonomous/phase-handlers/__tests__/plan-phase-epic.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlanPhase } from '../plan-phase.js';
import type { PhaseContext } from '../../phase-scheduler.js';

const CYCLE_ID = 'epiccyc1';

function epicPlanJson(): string {
  return JSON.stringify({
    epicId: 'epic-epiccyc1', rationale: 'split',
    children: [
      { id: 'c1', title: 'type', description: 'd', files: ['shared.ts'], capabilityTags: ['types'],
        suggestedAssignee: 'shared-utils-engineer', estimatedCostUsd: 2, estimatedComplexity: 'low', predecessors: [] },
      { id: 'c2', title: 'api', description: 'd', files: ['api.ts'], capabilityTags: ['route'],
        suggestedAssignee: 'fastify-v5-engineer', estimatedCostUsd: 3, estimatedComplexity: 'medium', predecessors: ['c1'] },
    ],
  });
}

function makeCtx(root: string, objective?: string): PhaseContext {
  const events: any[] = [];
  return {
    sprintId: 'v1-test', sprintVersion: '1.0.0', projectRoot: root,
    adapter: {}, bus: { publish: (_t, p) => events.push(p), subscribe: () => () => {} },
    runtime: { run: async () => ({ output: epicPlanJson(), costUsd: 0.5, model: 'opus' }) },
    cycleId: CYCLE_ID,
    ...(objective ? { objective } : {}),
  } as unknown as PhaseContext;
}

describe('plan phase epic branch', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'af-planepic-'));
    mkdirSync(join(root, '.agentforge', 'cycles', CYCLE_ID, 'phases'), { recursive: true });
    // Seed a plan.json envelope (as sprint-generator would have written pre-plan-phase).
    writeFileSync(join(root, '.agentforge', 'cycles', CYCLE_ID, 'plan.json'),
      JSON.stringify({ version: '1.0.0', sprintId: 'v1-test', title: 't', items: [], budget: 100 }));
  });

  it('decomposes the objective into wave-layered plan.json items + writes artifacts', async () => {
    const result = await runPlanPhase(makeCtx(root, 'Add multi-tenant RBAC'));
    expect(result.status).toBe('completed');
    const dir = join(root, '.agentforge', 'cycles', CYCLE_ID);
    expect(existsSync(join(dir, 'decomposition.json'))).toBe(true);
    expect(existsSync(join(dir, 'objective.json'))).toBe(true);
    const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
    expect(plan.items).toHaveLength(2);
    expect(plan.items[0].parentEpicId).toBe('epic-epiccyc1');
    const c2 = plan.items.find((i: any) => i.id === 'c2');
    expect(c2.wave).toBe(1);
    expect(c2.predecessors).toEqual(['c1']);
    // envelope preserved
    expect(plan.budget).toBe(100);
  });

  it('is a no-op for signal cycles (no objective): plan.json items unchanged', async () => {
    const result = await runPlanPhase(makeCtx(root)); // no objective
    const plan = JSON.parse(readFileSync(join(root, '.agentforge', 'cycles', CYCLE_ID, 'plan.json'), 'utf8'));
    expect(plan.items).toEqual([]); // architect path does not rewrite items
    expect(existsSync(join(root, '.agentforge', 'cycles', CYCLE_ID, 'decomposition.json'))).toBe(false);
    expect(result.phase).toBe('plan');
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `corepack pnpm exec vitest run packages/core/src/autonomous/phase-handlers/__tests__/plan-phase-epic.test.ts`

- [ ] **Step 3: Add imports + the epic branch to `plan-phase.ts`**

(a) Extend the existing imports at the top of `plan-phase.ts`:

```ts
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { PhaseContext, PhaseResult } from '../phase-scheduler.js';
import { historicalQuality } from '../../scoring/historical-quality.js';
import {
  decomposeObjective,
  flattenEpicPlanToPlanItems,
  type EpicObjective,
} from '../decompose/index.js';
```

(b) Insert the branch immediately after the `sprint.phase.started` publish (currently lines 115-120), before the `// Read audit findings` block:

```ts
  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    startedAt: new Date(startedAt).toISOString(),
  });

  // Epic-decomposer (spec 2026-05-30): when an objective is present, the plan
  // phase decomposes it into wave-layered plan.json items instead of producing
  // a signal-backlog text plan. Signal cycles (no objective) fall through to
  // the existing architect path below.
  if (ctx.objective) {
    return runEpicDecompositionPlan(ctx, startedAt);
  }
```

(c) Add these two functions at the end of `plan-phase.ts` (after `runPlanPhase`):

```ts
/** Atomic JSON write (.tmp + rename), mirroring the cycle-checkpoint pattern. */
function atomicWriteJson(finalPath: string, value: unknown): void {
  mkdirSync(dirname(finalPath), { recursive: true });
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmpPath, finalPath);
}

/**
 * Epic path of the plan phase: decompose ctx.objective into a wave-layered
 * EpicPlan, persist objective.json + decomposition.json, and overwrite
 * plan.json items[] with the flattened children. (spec 2026-05-30 §6, §4 —
 * folded into the plan phase rather than a distinct DECOMPOSE phase.)
 */
async function runEpicDecompositionPlan(
  ctx: PhaseContext,
  startedAt: number,
): Promise<PhaseResult> {
  const phase = 'plan' as const;
  const objectiveText = ctx.objective ?? '';
  const safeCycle = (ctx.cycleId ?? 'cycle').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 8) || 'cycle';
  const objective: EpicObjective = {
    id: `epic-${safeCycle}`,
    title: (objectiveText.split('\n')[0] ?? objectiveText).slice(0, 120),
    description: objectiveText,
    createdAt: new Date().toISOString(),
  };

  let status: PhaseResult['status'] = 'completed';
  let error: string | undefined;
  let costUsd = 0;
  let childCount = 0;
  let waveCount = 0;
  let repaired = false;

  try {
    const result = await decomposeObjective(objective, ctx.runtime);
    costUsd = result.costUsd;
    childCount = result.plan.children.length;
    waveCount = result.report.waveCount;
    repaired = result.repaired;

    if (ctx.cycleId) {
      const cycleDir = join(ctx.projectRoot, '.agentforge', 'cycles', ctx.cycleId);
      atomicWriteJson(join(cycleDir, 'objective.json'), objective);
      atomicWriteJson(join(cycleDir, 'decomposition.json'), {
        ...result.plan,
        validationReport: result.report,
      });
      // Overwrite plan.json items with the flattened epic children, preserving
      // the existing SprintPlan envelope (version/sprintId/title/budget/...).
      const planPath = join(cycleDir, 'plan.json');
      let envelope: Record<string, unknown> = {};
      try {
        envelope = JSON.parse(readFileSync(planPath, 'utf8')) as Record<string, unknown>;
      } catch {
        // No prior plan.json — start from a minimal envelope.
      }
      atomicWriteJson(planPath, {
        ...envelope,
        items: flattenEpicPlanToPlanItems(result.plan),
        parentEpicId: objective.id,
      });
    }
  } catch (err) {
    status = 'failed';
    error = err instanceof Error ? err.message : String(err);
  }

  const durationMs = Date.now() - startedAt;
  const phaseResult: PhaseResult = {
    phase,
    status,
    durationMs,
    costUsd,
    agentRuns: [
      {
        agentId: 'epic-planner',
        costUsd,
        durationMs,
        ...(error ? { error } : {}),
      },
    ],
    ...(error ? { error } : {}),
  };

  if (ctx.cycleId) {
    const phaseJsonPath = join(ctx.projectRoot, '.agentforge', 'cycles', ctx.cycleId, 'phases', 'plan.json');
    try {
      atomicWriteJson(phaseJsonPath, {
        phase,
        mode: 'epic-decomposition',
        sprintId: ctx.sprintId,
        sprintVersion: ctx.sprintVersion,
        cycleId: ctx.cycleId,
        epicId: objective.id,
        childCount,
        waveCount,
        repaired,
        costUsd,
        durationMs,
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date().toISOString(),
        ...(error ? { error } : {}),
      });
    } catch {
      // non-fatal
    }
  }

  ctx.bus.publish(status === 'failed' ? 'sprint.phase.failed' : 'sprint.phase.completed', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    ...(status === 'failed' ? { error } : { result: phaseResult }),
    [status === 'failed' ? 'failedAt' : 'completedAt']: new Date().toISOString(),
  });

  return phaseResult;
}
```

- [ ] **Step 4: Run, expect PASS** — `corepack pnpm exec vitest run packages/core/src/autonomous/phase-handlers/__tests__/plan-phase-epic.test.ts`

- [ ] **Step 5: Typecheck** — `corepack pnpm run check:types` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/autonomous/phase-handlers/plan-phase.ts packages/core/src/autonomous/phase-handlers/__tests__/plan-phase-epic.test.ts
git commit -m "feat(decompose): plan phase decomposes --objective into wave-layered plan.json (PR-2b2)"
```

---

## Task 4: Verification gate (no regression on signal cycles)

- [ ] **Step 1:** `corepack pnpm run check:types` → exit 0.
- [ ] **Step 2:** Full affected suites — `corepack pnpm exec vitest run packages/core tests/autonomous tests/server packages/server`. Expect the same 3 PRE-EXISTING unrelated failures and NOTHING new (`invoke-service-cwd`, `codex-cli-transport`, `codex-readiness` — Windows/cwd tests). Any *other* failure means a regression — investigate. The existing plan-phase tests must still pass (signal path unchanged).
- [ ] **Step 3:** Confirm the help text shows the new flag: `corepack pnpm exec node packages/cli/dist/bin.js cycle run --help 2>&1 | grep -i objective` (after a build, or check the source registration). If `bin.js` is stale, this is non-fatal — the registration edit + check:types is sufficient evidence.

---

## Self-Review

**Spec coverage:** `--objective` → `objective.json` → decomposition → `decomposition.json` + wave-layered `plan.json` (§5, §6.4) ✓, via the plan phase (approved §4 deviation). `decomposeObjective` (PR-2b1) reused; `flattenEpicPlanToPlanItems` new. Fail-loud: a `DecomposeError` sets the plan phase `status='failed'` (the kill switch then stops the cycle), never ships a half-decomposition.

**Placeholder scan:** none — complete code. The ~4-site ctx-population edit is anchor-specified (`grep` given).

**Type consistency:** `objective?: string` named identically on `PhaseContext`, `CycleRunnerOptions`, `CycleRunOptions`. `FlattenedPlanItem` matches the `SprintPlanItem` shape + epic fields (PR-0). `ctx.runtime` satisfies `DecomposeRuntime` (structural subset). `EpicObjective` imported from the decompose barrel.

**No-regression argument:** every change is gated on `ctx.objective` being present (the plan-phase branch, the ctx spreads, the CLI flag). With no objective, `PhaseContext.objective` is `undefined`, the plan phase takes the unchanged architect path, and no new artifacts are written — so signal cycles behave exactly as before. No phase-sequence/schema/dashboard change, so the ~15 nine-phase assertions are untouched.

---

## Deferred to PR-2c / PR-2d

- **PR-2c:** wave-aware execute loop (the flattened `plan.json` now carries `wave`/`predecessors`, ready to consume), integration branch, smokeGuard, merge-under-lock, cascade. (Pack §4.)
- **PR-2d:** gate on integration HEAD, release PR-opener + epic risk classification, `epic.*` caps, `cycle.json` observability. (Pack §5.)
- **Also deferred:** import-edge augmentation §6.3.4 (slot into `decomposeObjective` before `validateAndLayerEpicPlan`); `cycle preview --objective` dry-run (needs runtime construction in the preview action).
