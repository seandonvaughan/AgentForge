# Wiring AdaptiveRouter into Live Per-Item Model Selection — Design

**Date:** 2026-06-02
**Status:** Approved (design)
**Source:** ruflo gap analysis "Hidden Gem #1" — see `docs/superpowers/specs/2026-06-02-ruflo-gap-analysis.md`
**Goal:** Make the existing `AdaptiveRouter` Beta-bandit actually select the per-item model at dispatch, instead of its output flowing into a field nothing reads.

---

## Problem (verified against the code)

AgentForge collects a rich per-`(agent, capability, model)` quality/cost/latency signal every cycle in `.agentforge/memory/step-scores.jsonl` (`execute-phase.ts:1360` `appendStepScore`), and ships a genuinely sophisticated bandit — `AdaptiveRouter.recommendQualityAware()` (`packages/core/src/intelligence/adaptive-routing.ts`): exponential-decay utility (half-life 50), a Pareto front across cost/quality/latency (`pareto.ts`), 5% ε-greedy exploration, and a cold-start fallback. **But the cycle never calls it** — it is instantiated only in the dashboard route `packages/server/src/routes/v5/intelligence.ts:8`.

The model an agent actually runs on is determined by `config.model` (the tier baked into the agent YAML at forge time), resolved in `ExecutionService.run()` (`execution-service.ts:115` `MODEL_IDS[config.model]`, `:121` `capabilityTier: config.model`). The cycle's per-item routing (`assign-phase.applyJobRouting`) sets `item.tier` from the **static** `DEFAULT_JOB_ROUTING_POLICY` rules (`job-router.ts:102`), but **`item.tier` is an audit/metadata field only** (job-router.ts:203 comment) — it is *not* passed to `ctx.runtime.run()`. The dispatch `runOptions` carry only `{allowedTools, cwd, runtimeMode, preferredProvider, providerPreference}` (`execute-phase.ts:269`, `:1187`).

**Consequence:** learned model-quality signal is collected but never acted on; model selection is hardcoded rules. This is precisely the "collect a signal, act on nothing" pattern the gap analysis flagged as theater.

## Non-goals (YAGNI)

- **No** recommender unification — `historicalQuality` (used by `plan-phase` for `assignment_hint`) stays as-is.
- **No** `recordOutcome` wiring (that feeds the unused Wave-2 `routing-feedback.jsonl` path; the quality-aware path reads `step-scores.jsonl`, which is already populated).
- **No** dashboard work.

> **Correction discovered during planning:** an earlier draft proposed overriding `config.model` inside `RuntimeAdapter` via the existing `applyCaps` mechanism. That is **not concurrency-safe**: the adapter caches **one `AgentRuntime` per agent** (`runtime-adapter.ts:142`, `getOrCreateRuntime`) and reuses it across the execute phase's *parallel* items, so mutating the cached config would race across items sharing an agent. The model override must therefore be a **per-call option** threaded through `opts`, which minimally touches `RunOptions` + `ExecutionService`. Behavior and scope are unchanged; only the thread-point moved to be correct under concurrency.

---

## Approach

The model override is a **per-call** field on `RunOptions`, honored by `ExecutionService.run`/`runStreaming` by deriving an *effective config* (`{...config, model: opts.capabilityTier}`) — never mutating the shared, cached `AgentRuntime` config. `RuntimeAdapter` re-applies the operator's `modelCap` to the per-call tier (reusing `capModelTier()`, `runtime-adapter.ts:72`) before threading it down. Because `buildRequest` also reads `config.model` directly (`execution-service.ts:329,337`), the override replaces the whole effective config inside the method, not just the resolved `modelId`. Once the effective config's `model` is set, `MODEL_IDS[...]`, `capabilityTier`, the provider-model-profile resolution, and the transport's model all follow.

### Data flow

```
plan-phase (unchanged) ── writes step-scores.jsonl each cycle ──┐
                                                                 ▼
assign-phase.applyJobRouting():                          .agentforge/memory/step-scores.jsonl
  1. static resolveJobRouting() → base decision (provider/effort/failover)   ← FLOOR (unchanged)
  2. NEW AdaptiveRouter(projectRoot).recommendQualityAware({                  ← reads ledger above
        agentId: item.assignee, capabilityTag, defaultModel: decision.tier })
  3. if reason ∈ {pareto-utility, epsilon-explore}: item.tier = rec.model     ← tier LOAD-BEARING
     else (cold-start/no-data/wave2-fallback):       keep decision.tier
  4. stamp item.tierSource ('adaptive'|'policy') + item.tierReason            ← observability
                                                                 ▼
execute-phase: runOptions.capabilityTier = item.tier → ctx.runtime.run(assignee, task, runOptions)
                                                                 ▼
RuntimeAdapter.run(): after loadAgentConfig + applyCaps, if opts.capabilityTier set →
  config.model = capModelTier(opts.capabilityTier, modelCap).model            ← reuse cap mechanism
                                                                 ▼
ExecutionService: MODEL_IDS[config.model] → model that actually runs          ← LOOP CLOSED
                                                                 ▼
execute-phase appendStepScore(...) → writes step-scores.jsonl ────┘  (feeds next cycle's bandit)
```

The learning loop is **already closed** through `step-scores.jsonl`; we are only connecting the consumer.

### Components / files touched

1. **`packages/core/src/agent-runtime/types.ts`** — add `capabilityTier?: ModelTier` to the low-level `RunOptions` (line ~27). `ModelTier` is already imported (line 1). `AgentRuntime.run` already forwards `opts` verbatim to `ExecutionService.run` (`agent-runtime.ts:20`), so no change there.

2. **`packages/core/src/runtime/execution-service.ts`** — in `run()` (line ~114) and `runStreaming()` (line ~206), before `const modelId = MODEL_IDS[config.model]`, derive an effective config without mutating the shared one:
   `const cfg = (opts.capabilityTier && opts.capabilityTier !== config.model) ? { ...config, model: opts.capabilityTier } : config;`
   then use `cfg` for `MODEL_IDS[cfg.model]`, `capabilityTier: cfg.model`, and the `buildRequest(cfg, …)` call. Lint-safe (new `const`, no param reassign). Backward-compatible: absent `capabilityTier` ⇒ `cfg === config`.

3. **`packages/core/src/autonomous/runtime-adapter.ts`**
   - Add `capabilityTier?: ModelTier` to `RuntimeRunOptions` (line ~61) and to BOTH local `runOpts` object-literal types (the `run()` path ~line 193 and the `_runWithSupervisor()` path ~line 297).
   - In `run()` and `_runWithSupervisor()`, when `options?.capabilityTier` is set, cap it by the operator `modelCap` then thread it: `runOpts.capabilityTier = this.options.modelCap ? capModelTier(options.capabilityTier, this.options.modelCap).model : options.capabilityTier;`
   - Backward-compatible: absent `capabilityTier` ⇒ identical to today.

4. **`packages/core/src/autonomous/phase-handlers/execute-phase.ts`**
   - Add `capabilityTier?: ModelTier` to `ExecutePhaseRunOptions` (line ~269).
   - In the dispatch block (~line 1193, alongside `runtimeMode`/`preferredProvider`): `if (item.tier !== undefined && isModelTier(item.tier)) runOptions.capabilityTier = item.tier;` (`isModelTier` already imported/used at `:1248`).

5. **`packages/core/src/autonomous/phase-handlers/assign-phase.ts`**
   - New exported helper `applyAdaptiveModel(item, router)` invoked from `runAssignPhase` after `inferAssignee` + `applyJobRouting`. It:
     - reads `defaultModel = item.tier` (the static decision, a `ModelTier`),
     - derives `capabilityTag` from the item (first capability tag / derived kind),
     - calls `router.recommendQualityAware({ agentId: item.assignee, capabilityTag, defaultModel })`,
     - overrides `item.tier = rec.model` only when `rec.reason === 'pareto-utility' || rec.reason === 'epsilon-explore'`,
     - sets `item.tierSource = 'adaptive' | 'policy'` and `item.tierReason = rec.reason`.
   - Construct the `AdaptiveRouter` **once per assign phase** in `runAssignPhase`, with absolute paths derived from `ctx.projectRoot`:
     `new AdaptiveRouter({ feedbackFilePath: join(projectRoot,'.agentforge/memory/routing-feedback.jsonl'), stepScoresPath: join(projectRoot,'.agentforge/memory/step-scores.jsonl'), explorationEpsilon: explore ? 0.05 : 0, rng })`.
   - Gating: skipped (keep static tier) when `AGENTFORGE_NO_QUALITY_BIAS=1`. Exploration enabled only when `AGENTFORGE_ADAPTIVE_EXPLORE=1`.
   - `SprintItem` gains `tierSource?: 'adaptive' | 'policy'` and `tierReason?: string` (audit fields persisted to `plan.json`).

### Determinism

`recommendQualityAware` uses 5% ε-greedy via `Math.random()`. Default the cycle's router to **exploit-only (`explorationEpsilon: 0`)** so production routing is reproducible; exploration is opt-in via `AGENTFORGE_ADAPTIVE_EXPLORE=1`. Tests inject a deterministic `rng`. The bandit still adapts: exploit tracks the Pareto-best as `step-scores.jsonl` accumulates.

### Behavior boundary (honest scope)

The recommendation chooses among `opus|sonnet|haiku`, which changes the real model only on **Anthropic transports**. On a codex-routed item the model is fixed (gpt-5.5) regardless of tier, so the override is a no-op there — expected and correct. Cold-start items (< `MIN_OBSERVATIONS = 3` observations for the triple) keep the static policy tier, so early/empty-history cycles behave exactly as today.

### Error handling

All-additive and fail-safe. Any `AdaptiveRouter` error, missing ledger, or unparseable record falls through to the static `decision.tier` (today's behavior). The override never throws into the assign phase: wrap `applyAdaptiveModel` in a try/catch that, on any error, leaves `item.tier` at the static decision and sets `item.tierSource = 'policy'`.

---

## Testing

Test files mirror existing conventions (`packages/core/src/autonomous/routing/__tests__/`, `tests/autonomous/`).

1. **assign-phase adaptive override** (`assign-phase` unit):
   - Given a router stubbed to return `{model:'opus', reason:'pareto-utility'}`, `applyAdaptiveModel` sets `item.tier='opus'`, `item.tierSource='adaptive'`.
   - Given `{reason:'cold-start'}`, `item.tier` keeps the static decision and `item.tierSource='policy'`.
   - `AGENTFORGE_NO_QUALITY_BIAS=1` ⇒ no override regardless of router output.
   - A router that throws ⇒ static tier retained, `tierSource='policy'`, no exception escapes.

2. **RuntimeAdapter capabilityTier override** (`runtime-adapter` unit):
   - `run(agentId, task, { capabilityTier:'opus' })` results in `config.model==='opus'` reaching the underlying runtime (assert via injected/inline agent config + captured `runOpts`/result model).
   - With `modelCap:'sonnet'` set, `capabilityTier:'opus'` is capped to `'sonnet'` (operator cap wins).
   - Absent `capabilityTier` ⇒ unchanged from the agent's configured tier.

3. **Reward-sign round-trip** (`adaptive-routing` unit — the guard against ruflo's inverted-sign bug):
   - Build a `step-scores.jsonl` fixture where model X has high-quality/low-cost/low-latency records and model Y has low-quality/high-cost records for the same `(agent, capability)`. Assert `recommendQualityAware` prefers X.
   - Append additional *successful* X records; assert X's selection is **strengthened, never weakened** (utility for X is monotonically non-decreasing in additional good outcomes). This pins the utility sign so a success can never make a model less likely to be chosen.

4. **No regression:** existing assign-phase / job-router / runtime-adapter suites stay green; with an empty ledger the cycle routes identically to today (cold-start ⇒ static policy).

---

## Acceptance criteria (ungameable)

- With a seeded `step-scores.jsonl` where `(agent, cap)` has ≥`MIN_OBSERVATIONS` records favoring `haiku` on utility, an item that the **static** policy would tier as `sonnet` is dispatched with `capabilityTier='haiku'` — verifiable by the captured runtime config model, not a log line, and `item.tierSource==='adaptive'`.
- With an **empty** ledger, the same item is dispatched with the static `sonnet` tier and `item.tierSource==='policy'` — proving graceful cold-start.
- The reward-sign test fails if the utility sign is inverted (a success de-ranking its model).
- `modelCap='sonnet'` still bounds an `opus` recommendation to `sonnet` at dispatch.
