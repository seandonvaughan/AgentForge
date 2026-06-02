# AdaptiveRouter Live Wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing `AdaptiveRouter` Beta-bandit actually select the per-item model at dispatch, so the per-`(agent, capability, model)` quality signal AgentForge already collects in `step-scores.jsonl` is acted on instead of discarded.

**Architecture:** A per-call `capabilityTier` override is threaded `assign-phase → item.tier → execute-phase → RuntimeAdapter (cap by modelCap) → RunOptions → ExecutionService (effective config)`. `ExecutionService` derives an effective config without mutating the shared, cached `AgentRuntime` config (concurrency-safe across parallel items). The assign phase consults `AdaptiveRouter.recommendQualityAware()` and overrides `item.tier` only on a real learned signal; cold-start/empty-history cycles keep today's static policy tier.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import suffixes), vitest, pnpm workspaces. Node ≥22.13.

**Spec:** `docs/superpowers/specs/2026-06-02-adaptive-router-wiring-design.md`

---

## Environment setup (every task)

All commands assume Node lts/jod and pnpm via Corepack. At the start of each work session:

```bash
source "$HOME/.nvm/nvm.sh" && nvm use lts/jod   # Node >=22.13 (22.22.x)
cd /Users/seandonvaughan/Projects/AgentForge
corepack pnpm install --frozen-lockfile          # if node_modules is stale
```

Single-file test run: `corepack pnpm exec vitest run <path>`
Typecheck: `corepack pnpm exec tsc -b --noEmit --pretty false`
Lint a file: `corepack pnpm exec eslint <path>`

> **Note on pre-existing darwin failures:** 6 suites fail locally on macOS for environment reasons unrelated to this work (`invoke-service-cwd`, `codex-cli-transport`, `codex-readiness-launch-options`, `run-verify-tests.integration` ×2, `autonomous-worktree`). They pass on Linux CI. Do not try to fix them; only assert the suites this plan touches.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/core/src/agent-runtime/types.ts` | Low-level `RunOptions` contract | + optional `capabilityTier` field |
| `packages/core/src/runtime/execution-service.ts` | Resolves model from config, builds request, dispatches | honor `opts.capabilityTier` via effective config (`run` + `runStreaming`) |
| `packages/core/src/autonomous/runtime-adapter.ts` | Cycle's `ctx.runtime`; caches one AgentRuntime per agent | + `capabilityTier` on `RuntimeRunOptions`; cap by `modelCap` via new exported `cappedCallTier`; thread in `run` + `_runWithSupervisor` |
| `packages/core/src/autonomous/phase-handlers/assign-phase.ts` | Picks agent + writes routing decision per item | new `applyAdaptiveModel`; construct `AdaptiveRouter` once; `tierSource`/`tierReason` audit fields |
| `packages/core/src/autonomous/phase-handlers/execute-phase.ts` | Dispatches items to `ctx.runtime.run` | + `capabilityTier` on `ExecutePhaseRunOptions`; new `selectCapabilityTier`; set from `item.tier` |

Tests live beside each unit (existing `__tests__/` dirs and `tests/`).

---

## Task 0: Create the feature branch

**Files:** none (git only)

- [ ] **Step 1: Branch off main**

We are on `main`; never implement on it directly. The working tree has skip-worktree'd campaign files (`autonomous.yaml`, agent YAMLs) and `.git/info/exclude` entries — these stay invisible and will not enter the branch/PR.

```bash
source "$HOME/.nvm/nvm.sh" && nvm use lts/jod
cd /Users/seandonvaughan/Projects/AgentForge
git checkout -b feat/adaptive-router-wiring
git status   # expect: the 3 docs + memory files as untracked; no campaign-file noise
```

- [ ] **Step 2: Stage the design + plan docs**

```bash
git add docs/superpowers/specs/2026-06-02-adaptive-router-wiring-design.md \
        docs/superpowers/specs/2026-06-02-ruflo-gap-analysis.md \
        docs/superpowers/plans/2026-06-02-adaptive-router-wiring.md
git commit -m "docs(routing): adaptive-router wiring spec + plan + ruflo gap analysis

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 1: Per-call `capabilityTier` override in `ExecutionService`

**Files:**
- Modify: `packages/core/src/agent-runtime/types.ts` (`RunOptions`, ~line 27)
- Modify: `packages/core/src/runtime/execution-service.ts` (`run` ~114–121, `runStreaming` ~206–213)
- Test: `packages/core/src/runtime/__tests__/execution-service.test.ts` (append a describe block)

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/runtime/__tests__/execution-service.test.ts` (the top-of-file `config`, `buildExecutionResult`, and imports already exist):

```ts
import { MODEL_IDS } from '../../agent-runtime/types.js';

describe('ExecutionService — per-call capabilityTier override', () => {
  it('overrides the dispatched model + capabilityTier for a single call without mutating config', async () => {
    let capturedAgentModel: string | undefined;
    let capturedModelId: string | undefined;
    const transport: ExecutionTransport = {
      kind: 'anthropic-sdk',
      isAvailable: () => true,
      execute: vi.fn(async (req) => {
        capturedAgentModel = req.agent.model;
        capturedModelId = req.modelId;
        return buildExecutionResult('ok');
      }),
    };
    const service = new ExecutionService({ transports: [transport] });

    // config.model is 'sonnet'; override the call to 'haiku'
    const result = await service.run(config, { task: 'route this', capabilityTier: 'haiku' });

    expect(capturedAgentModel).toBe('haiku');
    expect(capturedModelId).toBe(MODEL_IDS.haiku);
    expect(result.capabilityTier).toBe('haiku');
    // The shared config object is NOT mutated.
    expect(config.model).toBe('sonnet');
  });

  it('falls back to the agent config model when capabilityTier is absent', async () => {
    let capturedAgentModel: string | undefined;
    const transport: ExecutionTransport = {
      kind: 'anthropic-sdk',
      isAvailable: () => true,
      execute: vi.fn(async (req) => {
        capturedAgentModel = req.agent.model;
        return buildExecutionResult('ok');
      }),
    };
    const service = new ExecutionService({ transports: [transport] });

    const result = await service.run(config, { task: 'no override' });

    expect(capturedAgentModel).toBe('sonnet');
    expect(result.capabilityTier).toBe('sonnet');
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

```bash
corepack pnpm exec vitest run packages/core/src/runtime/__tests__/execution-service.test.ts -t "capabilityTier"
```
Expected: FAIL — the first test gets `capturedAgentModel === 'sonnet'` (override ignored), and `result.capabilityTier === 'sonnet'`.

- [ ] **Step 3: Add the field to `RunOptions`**

In `packages/core/src/agent-runtime/types.ts`, inside `export interface RunOptions { … }` (after the `providerPreference` block, before `allowedTools`), add:

```ts
  /**
   * Per-call capability tier (model) override. When set, ExecutionService uses
   * this tier instead of the agent config's baked `model` for THIS call only —
   * concurrency-safe because it never mutates the shared, cached agent config.
   * Used by adaptive routing to select the learned-best model per item.
   * Absent → the agent's configured tier (legacy behavior).
   */
  capabilityTier?: ModelTier;
```

`ModelTier` is already imported at the top of the file.

- [ ] **Step 4: Honor it in `ExecutionService.run`**

In `packages/core/src/runtime/execution-service.ts`, in `run()`, immediately after `const startedAt = new Date().toISOString();` and before `const modelId = MODEL_IDS[config.model];`, insert:

```ts
    // Per-call model override (adaptive routing): use the requested tier for
    // THIS call without mutating the shared, cached agent config object.
    const cfg = opts.capabilityTier && opts.capabilityTier !== config.model
      ? { ...config, model: opts.capabilityTier }
      : config;
```

Then within `run()` replace the three `config` references that feed the model with `cfg`:
- `const modelId = MODEL_IDS[config.model];` → `const modelId = MODEL_IDS[cfg.model];`
- `const request = this.buildRequest(config, opts, modelId, apiKey);` → `const request = this.buildRequest(cfg, opts, modelId, apiKey);`
- `capabilityTier: config.model,` (in the `new RuntimeSession({…})` call) → `capabilityTier: cfg.model,`

Leave the `config.agentId` reference in the session unchanged (agentId does not change under a tier override).

- [ ] **Step 5: Honor it in `ExecutionService.runStreaming`**

Apply the identical change in `runStreaming()`: insert the same `const cfg = …` line after its `const startedAt = …`, then replace `MODEL_IDS[config.model]` → `MODEL_IDS[cfg.model]`, `this.buildRequest(config, opts, …)` → `this.buildRequest(cfg, opts, …)`, and `capabilityTier: config.model` → `capabilityTier: cfg.model`.

- [ ] **Step 6: Run the test — verify it passes**

```bash
corepack pnpm exec vitest run packages/core/src/runtime/__tests__/execution-service.test.ts
```
Expected: PASS (the new block + all existing ExecutionService tests).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/agent-runtime/types.ts packages/core/src/runtime/execution-service.ts packages/core/src/runtime/__tests__/execution-service.test.ts
git commit -m "feat(runtime): per-call capabilityTier override in ExecutionService

Threads an optional RunOptions.capabilityTier so a single call can select
a model tier without mutating the shared cached agent config. Backward
compatible: absent → the agent's configured model.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Cap + thread `capabilityTier` through `RuntimeAdapter`

**Files:**
- Modify: `packages/core/src/autonomous/runtime-adapter.ts` (`RuntimeRunOptions` ~61; export `cappedCallTier`; both `run` ~193 and `_runWithSupervisor` ~297 runOpts literals + assignment)
- Test: `packages/core/src/autonomous/__tests__/runtime-adapter-capability-tier.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/autonomous/__tests__/runtime-adapter-capability-tier.test.ts`:

```ts
/**
 * cappedCallTier — the per-call adaptive model tier, bounded by the operator's
 * modelCap. Caps must compose: a learned 'opus' recommendation under a 'sonnet'
 * modelCap must dispatch as 'sonnet', never above the cap.
 */
import { describe, it, expect } from 'vitest';
import { cappedCallTier } from '../runtime-adapter.js';

describe('cappedCallTier', () => {
  it('returns the requested tier when no modelCap is set', () => {
    expect(cappedCallTier('opus', undefined)).toBe('opus');
    expect(cappedCallTier('haiku', undefined)).toBe('haiku');
  });

  it('caps a higher requested tier down to the modelCap', () => {
    expect(cappedCallTier('opus', 'sonnet')).toBe('sonnet');
    expect(cappedCallTier('opus', 'haiku')).toBe('haiku');
    expect(cappedCallTier('sonnet', 'haiku')).toBe('haiku');
  });

  it('leaves a requested tier at or below the cap unchanged', () => {
    expect(cappedCallTier('haiku', 'sonnet')).toBe('haiku');
    expect(cappedCallTier('sonnet', 'sonnet')).toBe('sonnet');
    expect(cappedCallTier('sonnet', 'opus')).toBe('sonnet');
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

```bash
corepack pnpm exec vitest run packages/core/src/autonomous/__tests__/runtime-adapter-capability-tier.test.ts
```
Expected: FAIL — `cappedCallTier` is not exported.

- [ ] **Step 3: Export `cappedCallTier`**

In `packages/core/src/autonomous/runtime-adapter.ts`, after the existing `capModelTier` function (~line 77), add:

```ts
/**
 * The per-call model tier to dispatch, bounded by the operator's modelCap.
 * A learned/adaptive recommendation must never exceed the cap: opus under a
 * sonnet cap dispatches as sonnet. Reuses capModelTier's downgrade rule.
 */
export function cappedCallTier(requested: ModelTier, modelCap: ModelTier | undefined): ModelTier {
  return modelCap ? capModelTier(requested, modelCap).model : requested;
}
```

- [ ] **Step 4: Add the field to `RuntimeRunOptions` and thread it (run path)**

In the `RuntimeRunOptions` interface (~line 61), add:

```ts
  capabilityTier?: ModelTier;
```

In `run()`, extend the local `runOpts` object-literal type (the block starting `const runOpts: { task: string; … } = { task };`, ~line 193) by adding `capabilityTier?: ModelTier;` to its type, then after the `preferredProvider` assignment (~line 209) add:

```ts
    if (options?.capabilityTier !== undefined) {
      runOpts.capabilityTier = cappedCallTier(options.capabilityTier, this.options.modelCap);
    }
```

- [ ] **Step 5: Thread it in the supervisor path**

In `_runWithSupervisor()`, add `capabilityTier?: ModelTier;` to the inner `runOpts` object-literal type (~line 297), and after its `preferredProvider` assignment (~line 325) add the identical block:

```ts
      if (options?.capabilityTier !== undefined) {
        runOpts.capabilityTier = cappedCallTier(options.capabilityTier, this.options.modelCap);
      }
```

- [ ] **Step 6: Run the test — verify it passes**

```bash
corepack pnpm exec vitest run packages/core/src/autonomous/__tests__/runtime-adapter-capability-tier.test.ts
corepack pnpm exec vitest run packages/core/src/autonomous/__tests__/runtime-adapter-model-caps.test.ts
```
Expected: both PASS (new file + the existing model-caps suite, proving no regression).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/autonomous/runtime-adapter.ts packages/core/src/autonomous/__tests__/runtime-adapter-capability-tier.test.ts
git commit -m "feat(runtime): thread per-call capabilityTier through RuntimeAdapter

Adds cappedCallTier so an adaptive per-item model recommendation is bounded
by the operator's modelCap, then threads it through both the direct and
supervisor run paths into RunOptions.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Reward-sign round-trip guard for `AdaptiveRouter`

A guard test (no production change) pinning the utility sign so a *success* can never make a model *less* likely to be chosen — the exact ruflo `neural_train` inversion class of bug.

**Files:**
- Test: `tests/intelligence/adaptive-router-reward-sign.test.ts` (new)

- [ ] **Step 1: Write the test**

Create `tests/intelligence/adaptive-router-reward-sign.test.ts`:

```ts
/**
 * Reward-sign guard: higher quality / lower cost / lower latency MUST raise a
 * model's selection odds, and adding more good outcomes must never demote it.
 * Guards against an inverted utility sign (ruflo's neural_train bug class).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdaptiveRouter } from '../../packages/core/src/intelligence/adaptive-routing.js';

let dir: string;
let ledger: string;

const AGENT = 'coder';
const TAG = 'feature';

function record(model: 'opus' | 'sonnet' | 'haiku', quality: number, cost_usd: number, latency_ms: number) {
  return JSON.stringify({ agent_id: AGENT, capability_tag: TAG, model, quality, cost_usd, latency_ms }) + '\n';
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adaptive-reward-sign-'));
  ledger = join(dir, 'step-scores.jsonl');
  // haiku = strong (high quality, low cost/latency); sonnet = weak. 3 each clears
  // the MIN_OBSERVATIONS=3 per-triple floor.
  let body = '';
  for (let i = 0; i < 3; i++) body += record('haiku', 0.95, 0.02, 2000);
  for (let i = 0; i < 3; i++) body += record('sonnet', 0.30, 0.45, 90000);
  writeFileSync(ledger, body);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function freshRouter(): AdaptiveRouter {
  // explorationEpsilon 0 → deterministic exploit; rng never consulted but pinned anyway.
  return new AdaptiveRouter({ stepScoresPath: ledger, explorationEpsilon: 0, rng: () => 0.999 });
}

describe('AdaptiveRouter reward-sign', () => {
  it('prefers the high-quality / low-cost model', () => {
    const rec = freshRouter().recommendQualityAware({
      agentId: AGENT,
      capabilityTag: TAG,
      defaultModel: 'sonnet',
      candidateModels: ['haiku', 'sonnet'],
    });
    expect(rec.reason).toBe('pareto-utility');
    expect(rec.model).toBe('haiku');
  });

  it('adding more successful outcomes for the winner never demotes it', () => {
    for (let i = 0; i < 5; i++) appendFileSync(ledger, record('haiku', 0.97, 0.01, 1500));
    const rec = freshRouter().recommendQualityAware({
      agentId: AGENT,
      capabilityTag: TAG,
      defaultModel: 'sonnet',
      candidateModels: ['haiku', 'sonnet'],
    });
    expect(rec.model).toBe('haiku'); // still the winner — sign is correct
  });
});
```

- [ ] **Step 2: Run the test — verify it passes against current code**

```bash
corepack pnpm exec vitest run tests/intelligence/adaptive-router-reward-sign.test.ts
```
Expected: PASS. (This is a characterization guard — if it FAILS, the utility sign is already inverted and that is a real bug to surface before proceeding. Given `computeUtility` weights quality +0.6 and cost as `1 - cost/0.5`, it should pass.)

- [ ] **Step 3: Commit**

```bash
git add tests/intelligence/adaptive-router-reward-sign.test.ts
git commit -m "test(routing): reward-sign guard for AdaptiveRouter utility

Pins that higher quality / lower cost raises selection odds and more good
outcomes never demote the winner — guards against an inverted utility sign.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `applyAdaptiveModel` in the assign phase

**Files:**
- Modify: `packages/core/src/autonomous/phase-handlers/assign-phase.ts`
- Test: `packages/core/src/autonomous/phase-handlers/__tests__/assign-phase-adaptive.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/autonomous/phase-handlers/__tests__/assign-phase-adaptive.test.ts`:

```ts
/**
 * applyAdaptiveModel — overrides item.tier from the AdaptiveRouter ONLY on a
 * real learned signal; otherwise keeps the static policy tier. Fail-safe and
 * gated by AGENTFORGE_NO_QUALITY_BIAS.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { applyAdaptiveModel } from '../assign-phase.js';

type Rec = { model: 'opus' | 'sonnet' | 'haiku'; reason: string };

function stubRouter(rec: Rec | (() => never)) {
  return {
    recommendQualityAware: () => (typeof rec === 'function' ? rec() : rec),
  } as unknown as import('../../../intelligence/adaptive-routing.js').AdaptiveRouter;
}

afterEach(() => {
  delete process.env['AGENTFORGE_NO_QUALITY_BIAS'];
});

describe('applyAdaptiveModel', () => {
  it('overrides tier on a pareto-utility signal', () => {
    const item: any = { id: 'i1', title: 't', assignee: 'coder', tags: ['feature'], tier: 'sonnet' };
    applyAdaptiveModel(item, stubRouter({ model: 'haiku', reason: 'pareto-utility' }));
    expect(item.tier).toBe('haiku');
    expect(item.tierSource).toBe('adaptive');
    expect(item.tierReason).toBe('pareto-utility');
  });

  it('keeps the static tier on cold-start', () => {
    const item: any = { id: 'i1', title: 't', assignee: 'coder', tags: ['feature'], tier: 'sonnet' };
    applyAdaptiveModel(item, stubRouter({ model: 'opus', reason: 'cold-start' }));
    expect(item.tier).toBe('sonnet');
    expect(item.tierSource).toBe('policy');
  });

  it('does not override when AGENTFORGE_NO_QUALITY_BIAS=1', () => {
    process.env['AGENTFORGE_NO_QUALITY_BIAS'] = '1';
    const item: any = { id: 'i1', title: 't', assignee: 'coder', tags: ['feature'], tier: 'sonnet' };
    applyAdaptiveModel(item, stubRouter({ model: 'haiku', reason: 'pareto-utility' }));
    expect(item.tier).toBe('sonnet');
    expect(item.tierSource).toBe('policy');
  });

  it('is fail-safe: a throwing router leaves the static tier', () => {
    const item: any = { id: 'i1', title: 't', assignee: 'coder', tags: ['feature'], tier: 'sonnet' };
    applyAdaptiveModel(item, stubRouter(() => { throw new Error('boom'); }));
    expect(item.tier).toBe('sonnet');
    expect(item.tierSource).toBe('policy');
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

```bash
corepack pnpm exec vitest run packages/core/src/autonomous/phase-handlers/__tests__/assign-phase-adaptive.test.ts
```
Expected: FAIL — `applyAdaptiveModel` is not exported.

- [ ] **Step 3: Implement `applyAdaptiveModel` + imports + item fields**

In `packages/core/src/autonomous/phase-handlers/assign-phase.ts`:

Add imports near the top (after the existing `job-router` import):

```ts
import { AdaptiveRouter } from '../../intelligence/adaptive-routing.js';
import type { ModelTier } from '@agentforge/shared';
```

Extend the `SprintItem` interface with two audit fields (after `effort?: string;`):

```ts
  /** How item.tier was decided: 'adaptive' (learned) or 'policy' (static rules). */
  tierSource?: 'adaptive' | 'policy';
  /** The AdaptiveRouter reason code behind tierSource. */
  tierReason?: string;
```

Add a local tier guard near `inferAssigneeFromTag` (top-level):

```ts
function isModelTier(value: unknown): value is ModelTier {
  return value === 'opus' || value === 'sonnet' || value === 'haiku';
}
```

Add the helper (export it) after `applyJobRouting`:

```ts
/**
 * Override item.tier with the AdaptiveRouter's learned-best model — but ONLY
 * when the router has a real signal (pareto-utility or epsilon-explore). On
 * cold-start / no-data / fallback, keep the static policy tier. Fail-safe:
 * any router error leaves the static tier. Gated by AGENTFORGE_NO_QUALITY_BIAS.
 *
 * The learning loop is closed via .agentforge/memory/step-scores.jsonl, which
 * the execute phase already writes — this connects the consumer, not new data.
 */
export function applyAdaptiveModel(item: SprintItem, router: AdaptiveRouter): void {
  if (process.env['AGENTFORGE_NO_QUALITY_BIAS'] === '1') {
    item.tierSource = 'policy';
    return;
  }
  try {
    const defaultModel: ModelTier = isModelTier(item.tier) ? item.tier : 'sonnet';
    const capabilityTag = item.tags?.[0];
    const rec = router.recommendQualityAware({
      agentId: item.assignee ?? 'coder',
      ...(capabilityTag !== undefined ? { capabilityTag } : {}),
      defaultModel,
    });
    if (rec.reason === 'pareto-utility' || rec.reason === 'epsilon-explore') {
      item.tier = rec.model;
      item.tierSource = 'adaptive';
    } else {
      item.tierSource = 'policy';
    }
    item.tierReason = rec.reason;
  } catch {
    item.tierSource = 'policy';
  }
}
```

- [ ] **Step 4: Run the unit test — verify it passes**

```bash
corepack pnpm exec vitest run packages/core/src/autonomous/phase-handlers/__tests__/assign-phase-adaptive.test.ts
```
Expected: PASS.

- [ ] **Step 5: Wire `applyAdaptiveModel` into `runAssignPhase`**

In `runAssignPhase`, after the `availability` snapshot is read (after the `try { availability = getProviderAvailability(); } …` block, ~line 261) and before the `for (const item of items)` loop, construct the router once:

```ts
    // Adaptive per-item model selection. Reads the step-scores ledger once.
    // Exploit-only by default for reproducible cycles; opt into ε-greedy
    // exploration with AGENTFORGE_ADAPTIVE_EXPLORE=1.
    const adaptiveRouter = new AdaptiveRouter({
      feedbackFilePath: join(ctx.projectRoot, '.agentforge', 'memory', 'routing-feedback.jsonl'),
      stepScoresPath: join(ctx.projectRoot, '.agentforge', 'memory', 'step-scores.jsonl'),
      explorationEpsilon: process.env['AGENTFORGE_ADAPTIVE_EXPLORE'] === '1' ? 0.05 : 0,
    });
```

Inside the `for (const item of items)` loop, immediately after `applyJobRouting(item, availability);` add:

```ts
      applyAdaptiveModel(item, adaptiveRouter);
```

- [ ] **Step 6: Run the assign-phase suites — verify no regression**

```bash
corepack pnpm exec vitest run packages/core/src/autonomous/phase-handlers/__tests__/assign-phase-adaptive.test.ts packages/core/src/autonomous/phase-handlers/__tests__/assign-phase-routing.test.ts
```
Expected: both PASS. (The routing suite has no `step-scores.jsonl` in its fixture tmp dir, so the router cold-starts and the static tier is preserved — existing assertions hold.)

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/autonomous/phase-handlers/assign-phase.ts packages/core/src/autonomous/phase-handlers/__tests__/assign-phase-adaptive.test.ts
git commit -m "feat(routing): assign-phase consults AdaptiveRouter for per-item model

applyAdaptiveModel overrides item.tier with the learned-best model on a real
bandit signal (pareto-utility/epsilon-explore); cold-start keeps the static
policy tier. Fail-safe and gated by AGENTFORGE_NO_QUALITY_BIAS. Records
tierSource/tierReason for observability.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Carry `item.tier` to dispatch in the execute phase

**Files:**
- Modify: `packages/core/src/autonomous/phase-handlers/execute-phase.ts` (`SprintItem` ~257, `ExecutePhaseRunOptions` ~269, dispatch block ~1193, new `selectCapabilityTier`)
- Test: `packages/core/src/autonomous/phase-handlers/__tests__/execute-phase-capability-tier.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/autonomous/phase-handlers/__tests__/execute-phase-capability-tier.test.ts`:

```ts
/**
 * selectCapabilityTier — execute-phase converts a validated item.tier into the
 * per-call capabilityTier passed to ctx.runtime.run. Invalid/absent → undefined
 * (dispatch keeps the agent's configured tier).
 */
import { describe, it, expect } from 'vitest';
import { selectCapabilityTier } from '../execute-phase.js';

describe('selectCapabilityTier', () => {
  it('returns the tier when it is a valid ModelTier', () => {
    expect(selectCapabilityTier({ tier: 'haiku' })).toBe('haiku');
    expect(selectCapabilityTier({ tier: 'opus' })).toBe('opus');
  });

  it('returns undefined when tier is absent or invalid', () => {
    expect(selectCapabilityTier({})).toBeUndefined();
    expect(selectCapabilityTier({ tier: 'gpt-5' })).toBeUndefined();
    expect(selectCapabilityTier({ tier: undefined })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

```bash
corepack pnpm exec vitest run packages/core/src/autonomous/phase-handlers/__tests__/execute-phase-capability-tier.test.ts
```
Expected: FAIL — `selectCapabilityTier` is not exported.

- [ ] **Step 3: Add the `tier` field, the option, the helper, and the wiring**

In `packages/core/src/autonomous/phase-handlers/execute-phase.ts`:

Add `tier` to the `SprintItem` interface (after `providerPreference?: …`, ~line 262):

```ts
  /** Per-item model tier chosen by the assign phase (static or adaptive). */
  tier?: ModelTier;
```

Add `capabilityTier` to `ExecutePhaseRunOptions` (~line 269):

```ts
  capabilityTier?: ModelTier;
```

Export a helper near the existing `isModelTier` (~line 478):

```ts
/**
 * The per-call capabilityTier override for an item: the assign-phase-chosen
 * tier when it is a valid ModelTier, else undefined (keep the agent's tier).
 */
export function selectCapabilityTier(item: { tier?: unknown }): ModelTier | undefined {
  return isModelTier(item.tier) ? item.tier : undefined;
}
```

In the dispatch block, after the `if (item.providerPreference !== undefined) { runOptions.providerPreference = item.providerPreference; }` lines (~line 1201) and before `const result = await ctx.runtime.run(…)`, add:

```ts
          const capabilityTier = selectCapabilityTier(item);
          if (capabilityTier !== undefined) {
            runOptions.capabilityTier = capabilityTier;
          }
```

- [ ] **Step 4: Run the unit test — verify it passes**

```bash
corepack pnpm exec vitest run packages/core/src/autonomous/phase-handlers/__tests__/execute-phase-capability-tier.test.ts
```
Expected: PASS.

- [ ] **Step 5: Extend the routing-options integration test (end-to-end pass-through)**

Open `packages/core/src/autonomous/phase-handlers/__tests__/execute-phase-routing-options.test.ts`. It already runs `runExecutePhase` with a stub `ctx.runtime` that captures the options passed to `run()`. Add one test mirroring the file's existing setup (reuse its fixture/`makeCtx`/capturing-runtime helpers — do not invent new ones): seed a plan item with `tier: 'haiku'`, run the execute phase, and assert the captured run options include `capabilityTier: 'haiku'`. Add a second item with no `tier` and assert its captured options have `capabilityTier === undefined`.

```ts
  it('threads item.tier to ctx.runtime.run as capabilityTier', async () => {
    // ...arrange a plan.json item with tier:'haiku' using this file's existing
    // fixture builder, run runExecutePhase with the capturing runtime stub...
    const opts = capturedRunOptionsFor('item-with-tier'); // per this file's helper
    expect(opts.capabilityTier).toBe('haiku');
  });
```

If the file's existing helpers do not already expose per-item captured options, assert on the most recent captured `run()` call's third argument instead — match the file's established assertion style.

- [ ] **Step 6: Run the execute-phase suites — verify no regression**

```bash
corepack pnpm exec vitest run packages/core/src/autonomous/phase-handlers/__tests__/execute-phase-capability-tier.test.ts packages/core/src/autonomous/phase-handlers/__tests__/execute-phase-routing-options.test.ts
```
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/autonomous/phase-handlers/execute-phase.ts packages/core/src/autonomous/phase-handlers/__tests__/execute-phase-capability-tier.test.ts packages/core/src/autonomous/phase-handlers/__tests__/execute-phase-routing-options.test.ts
git commit -m "feat(routing): execute phase carries item.tier to dispatch as capabilityTier

selectCapabilityTier validates the assign-phase-chosen tier and threads it into
ctx.runtime.run, closing the adaptive routing loop end-to-end.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the workspace**

```bash
corepack pnpm exec tsc -b --noEmit --pretty false
```
Expected: no errors.

- [ ] **Step 2: Lint the touched files**

```bash
corepack pnpm exec eslint \
  packages/core/src/agent-runtime/types.ts \
  packages/core/src/runtime/execution-service.ts \
  packages/core/src/autonomous/runtime-adapter.ts \
  packages/core/src/autonomous/phase-handlers/assign-phase.ts \
  packages/core/src/autonomous/phase-handlers/execute-phase.ts
```
Expected: no errors (esp. no `no-param-reassign` — we used a new `const cfg`).

- [ ] **Step 2b: Build**

```bash
corepack pnpm build
```
Expected: all packages build.

- [ ] **Step 3: Run the full affected-test set**

```bash
corepack pnpm exec vitest run \
  packages/core/src/runtime/__tests__/execution-service.test.ts \
  packages/core/src/autonomous/__tests__/runtime-adapter-capability-tier.test.ts \
  packages/core/src/autonomous/__tests__/runtime-adapter-model-caps.test.ts \
  tests/intelligence/adaptive-router-reward-sign.test.ts \
  packages/core/src/autonomous/phase-handlers/__tests__/assign-phase-adaptive.test.ts \
  packages/core/src/autonomous/phase-handlers/__tests__/assign-phase-routing.test.ts \
  packages/core/src/autonomous/phase-handlers/__tests__/execute-phase-capability-tier.test.ts \
  packages/core/src/autonomous/phase-handlers/__tests__/execute-phase-routing-options.test.ts \
  tests/routing/adaptive-router.test.ts \
  tests/intelligence/adaptive-router-quality.test.ts
```
Expected: all PASS.

- [ ] **Step 4: Final acceptance check (manual reasoning against the spec)**

Confirm each acceptance criterion in the spec is met:
- Seeded ledger favoring `haiku` ⇒ a `sonnet`-policy item dispatches `capabilityTier='haiku'` (Task 1 + Task 4 + Task 5 chain; assert via the reward-sign + adaptive + routing-options tests).
- Empty ledger ⇒ static `sonnet`, `tierSource='policy'` (assign-phase-routing suite cold-starts).
- Reward-sign test fails on an inverted utility (Task 3).
- `modelCap='sonnet'` bounds an `opus` recommendation (Task 2 `cappedCallTier`).

- [ ] **Step 5: Finish the branch**

Use **superpowers:finishing-a-development-branch** to push and open the PR (option 2). The PR closes ruflo gap "Hidden Gem #1".

---

## Self-Review

**Spec coverage:**
- `RunOptions.capabilityTier` + `ExecutionService` effective-config → Task 1. ✔
- `RuntimeAdapter` cap + thread (both paths) → Task 2. ✔
- `assign-phase` AdaptiveRouter override + gating + fail-safe + audit fields → Task 4. ✔
- `execute-phase` option + `item.tier` → dispatch → Task 5. ✔
- Determinism (exploit-only default, ε-greedy opt-in) → Task 4 Step 5 (`explorationEpsilon`). ✔
- Reward-sign round-trip → Task 3. ✔
- Cold-start preserves static tier → Task 4 tests + assign-phase-routing regression. ✔
- modelCap bounds the override → Task 2 `cappedCallTier`. ✔

**Placeholder scan:** No TBD/TODO. Task 5 Step 5's integration assertion intentionally defers to the existing `execute-phase-routing-options.test.ts` helper style (its capture mechanism is established there); the runnable guarantee for Task 5 is the pure `selectCapabilityTier` unit test in Steps 1–4.

**Type consistency:** `ModelTier` ('opus'|'sonnet'|'haiku') used uniformly; `capabilityTier?: ModelTier` identical across `RunOptions`, `RuntimeRunOptions`, `ExecutePhaseRunOptions`; `cappedCallTier(requested, modelCap?)` and `recommendQualityAware({agentId, capabilityTag?, defaultModel, candidateModels?})` match the verified source signatures; `selectCapabilityTier` and `applyAdaptiveModel` names are stable across their definition and call sites.
