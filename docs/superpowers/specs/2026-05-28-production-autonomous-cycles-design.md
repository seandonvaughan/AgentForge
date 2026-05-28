# Production Autonomous Cycles — Design

**Date:** 2026-05-28
**Status:** Approved (design); pending implementation plan
**Author:** Sean Vaughan + Claude (Opus 4.8)
**Builds on:** v7 north-star items 2 (provider availability), 4 (codex-auth), 7 (per-job routing), 8 (auto-switch) — all merged to `main`.

## Goal

Make AgentForge's autonomous cycles **bigger and reliable enough to run all AgentForge development through the loop** on the current development box. "Production" here means: cycles that finish unattended without OOM, scale to multiple items per sprint, route each job to the best provider, and merge low-risk work automatically while escalating high-risk work to a human reviewer.

## Context & binding constraints

- **Runner:** this box — 8 cores, 33.9 GB total, ~10.2 GB free at design time (operator clears memory before runs). Design must degrade gracefully if free memory dips.
- **Prior failure:** the first supervised cycle OOM-crashed in the VERIFY stage. Root cause (commit `b032c9d`): the full **7,966-test** suite spawned default vitest worker forks (one per core, each loading the whole environment) on a box with only ~3.5 GB free. Mitigation at the time: cap `--maxWorkers=2` and drop `maxItemsPerSprint` 3 → 1.
- **Key insight:** the OOM lives in the **test gate**, and is **largely decoupled from sprint size** — the gate runs the full suite regardless of how many items the sprint had. Raising `maxItemsPerSprint` alone produces bigger cycles that crash in the same place. Therefore the gate must be hardened before (and alongside) scaling size.
- **Current config (`.agentforge/autonomous.yaml`):** `runtime: codex-cli`, `maxItemsPerSprint: 1`, `maxExecutePhaseParallelism: 10`, `testing.command: corepack pnpm exec vitest run --maxWorkers=2 --minWorkers=1`, `prMode: multi`, `autoMergePRs: false`, `budget.perCycleUsd: 200`.
- **VERIFY vs test-phase:** `phase-handlers/test-phase.ts` is the read-only AI "QA lead" analysis; the actual test execution is the cycle's VERIFY stage running `testing.command`. The OOM is in that command.

## Decisions captured during brainstorming

1. **Goal:** both bigger *and* reliable, as one production push (not throughput-only, not reliability-only).
2. **Runner:** this box, with memory freed (~10 GB); gate hardened to degrade if memory dips again.
3. **Merge model:** risk-based auto-merge (hybrid) — auto-merge low-risk green PRs, human-review high-risk.
4. **Approach:** A + B together — incremental hardening ramp **plus** affected-test gate selection now.

## Architecture overview

The existing 9-phase loop (`audit → plan → assign → execute → test → review → gate → release → learn`) gains four production upgrades, all config- and component-scoped (no rewrite of the loop):

1. **Memory-adaptive + affected-test VERIFY gate** (new `scripts/run-verify-tests.mjs` + `testing.*` config).
2. **Production routing + auto-switch** (execute-phase passes ordered `providerPreference`).
3. **Risk-based auto-merge** (release phase / pr-merge-manager + `pr.autoMerge.*` config).
4. **Size ramp + guardrails** (promotion rule on `maxItemsPerSprint` + free-RAM pre-flight guard).

Plus **observability** (per-cycle JSONL fields) that feeds the ramp promotion rule.

These are ~5 separable workstreams sequenced so each ships and is verified independently. The **gate runner ships first** — it unblocks safe scaling of everything else.

---

## Section 1 — Memory-adaptive + affected-test VERIFY gate

**Problem:** the gate is the OOM site and the throughput ceiling.

**New component:** `scripts/run-verify-tests.mjs` (Node ESM). It is the value of `testing.command` (e.g. `node scripts/run-verify-tests.mjs`). Responsibilities:

1. **Worker sizing from live memory.** Compute
   `workers = clamp(1, floor((freeGb − reserveGb) / perWorkerGb), cores − 1)`
   using `os.freemem()`, `os.cpus().length`, and config constants. Pass `--maxWorkers=<n> --minWorkers=1`. Set `NODE_OPTIONS=--max-old-space-size=<heapCapMb>` for the worker forks. Log the chosen worker count.
2. **OOM self-heal.** If the vitest process exits with code 137 / is SIGKILLed (OOM signature), retry **once** at `floor(workers/2)` (min 1) before declaring the gate failed. Record `oomRetryCount`.
3. **Affected-test selection (B).** Read the cycle's changed-file list (already tracked as `worktreeChangedFiles`; passed via env/arg). In `affectedMode: auto` (default), run `vitest related <changedFiles>` — only tests reachable from the diff via vitest's dependency graph.
4. **Deep-gate safety net.** Run the **full** suite (not affected-only) when ANY of:
   - a changed file matches `coreGlobs` (high blast radius — e.g. `packages/core/src/runtime/**`, `packages/shared/**`, `packages/core/src/autonomous/**`),
   - the cycle index is a multiple of `deepGateEveryNCycles`,
   - `affectedMode: full` is set, or the run is flagged deep on demand.
   This guarantees affected-test selection can never silently ship a core regression.

**Config (new `testing` keys):**
```yaml
testing:
  command: node scripts/run-verify-tests.mjs   # wrapper replaces the inline vitest call
  affectedMode: auto            # auto | related | full
  deepGateEveryNCycles: 5
  coreGlobs:
    - packages/core/src/runtime/**
    - packages/core/src/autonomous/**
    - packages/shared/**
  memory:
    reserveGb: 2.0              # headroom left for the OS + cycle process
    perWorkerGb: 1.0           # measured per-fork peak for this suite
    heapCapMb: 2048            # --max-old-space-size per worker fork
  timeoutMinutes: 20
  reporter: json
  saveRawLog: true
```

**Pure, unit-testable units inside the runner:**
- `computeWorkers(freeGb, cores, { reserveGb, perWorkerGb })` → integer.
- `selectGateMode({ changedFiles, coreGlobs, cycleIndex, deepGateEveryNCycles, affectedMode })` → `'related' | 'full'`.
- `isOomExit(code, signal)` → boolean.
- `buildVitestArgs({ mode, changedFiles, workers })` → string[].

**Invariants:** `testPassRateFloor: 0.95` still gates the cycle. A core-glob change always forces `full`. The runner exits non-zero if, after the one OOM retry, the run still fails.

---

## Section 2 — Production routing + auto-switch

**Problem:** routing (item 7) and auto-switch (item 8) exist but aren't wired into the live cycle, so the cycle still uses one global runtime.

**Change:** the execute phase already reads `item.preferredProvider` / `item.runtimeMode` (written by `assign-phase.applyJobRouting`). Extend execute-phase to also derive the **ordered `providerPreference`** (the routed provider followed by the policy's `alternate` chain from `DEFAULT_JOB_ROUTING_POLICY`) and pass it into `ExecutionService.run(opts.providerPreference)` (item 8), so a classified-retriable failure auto-switches to the next eligible provider.

**Dependencies already in place:** provider availability (item 2) excludes providers without credentials; file-based Codex auth (item 4) reports `authenticated|expired|missing`; `resolveOrdered` filters + de-dupes; `isRetriableTransportError` gates the switch.

**Config:** set `runtime: auto` (changed from `codex-cli`). A single global runtime defeats per-job routing; `auto` registers all transports so the per-item `providerPreference` actually selects between them. Anthropic profile requires `ANTHROPIC_API_KEY`; Codex profile requires a valid `codex login` (verified file-based, item 4). When a preferred provider is unavailable, routing falls back to the alternate (item 7) and auto-switch covers runtime failures (item 8). `AGENTFORGE_RUNTIME` env var still overrides for forced single-provider debugging.

**Net behavior:** bulk/docs/low-complexity → Codex; security/high-complexity/repeatedly-failing → Anthropic; transparent failover on retriable errors.

---

## Section 3 — Risk-based auto-merge

**Problem:** at `prMode: multi`, bigger cycles produce more PRs; human review becomes the throughput ceiling.

**Change:** the release phase / pr-merge-manager gains a risk-based auto-merge decision. **Reuse the job-router classification** rather than inventing a new one.

**Risk classification (pure function `classifyPrRisk`):** the classifier defaults to **low-risk** and escalates to **high-risk** if ANY hold (a deny-list, so unknown signals are treated as low-risk only when nothing trips):
- the job-router escalated the item to the Anthropic profile (security / high-complexity / repeatedly-failing), OR
- the item carries any tag in `highRiskTags`, OR
- the diff touches `coreGlobs`, OR
- changed files > `git.maxFilesPerCommit`.
Otherwise **low-risk**. (Signal-based, keyed off the router decision + tags + diff — not a hand-maintained per-item list.)

**Auto-merge decision (pure function `shouldAutoMerge`):** auto-merge iff `autoMergePRs` master switch is on AND risk == low AND all `requireGates` pass (test floor, build success, typecheck success, secret-scan clean) AND no cycle anomaly (no failed auto-switch, no OOM retry exhaustion). Low-risk + green → squash-merge + label `autonomous-automerged`. Everything else → leave open, assign `pr.assignReviewer`, label `needs-review`.

**Config (new `pr.autoMerge`):**
```yaml
autoMergePRs: false            # master kill-switch; flip to true once validated
pr:
  autoMerge:
    mode: risk-based
    highRiskTags: [security, auth, secret, migration, breaking]
    requireGates: [testFloor, build, typecheck, secretScan]
```
`highRiskTags` is the deny-list `classifyPrRisk` consults; `coreGlobs` (Section 1) and the router's Anthropic-escalation are the other escalation signals. There is intentionally no low-risk allowlist — low-risk is the default when nothing escalates.

**Safety:** `refuseCommitToBaseBranch` unchanged; never auto-merge on secret-scan flag, sub-floor gate, core-glob diff, oversize diff, or a cycle that needed retries/failover. The master switch stays `false` until N clean validated cycles.

---

## Section 4 — Size ramp + guardrails

**Promotion rule (not a flip):** `maxItemsPerSprint` advances **1 → 3 → 5** only after **K consecutive clean cycles** at the current level (`cleanCycle` = gate passed, no OOM, no manual fixups, no failover exhaustion). Default `K = 3`. Cap at 5 for now; revisit after validation.

**Parallelism:** `maxExecutePhaseParallelism` 4 → 6 (≤ cores − 2). Budgets scale with size (`perCycleUsd` ≈ `maxItemsPerSprint × perItemUsd`, with headroom).

**New pre-flight guard:** add a **free-RAM headroom guard** to the existing unattended guards (which already cover budget, clean tree, test baseline, stale checkpoints, disk). Abort before a cycle starts if `os.freemem()` < `minFreeGbToStart`. Pure function `checkMemoryHeadroom(freeGb, minFreeGb)`.

**Config:**
```yaml
limits:
  maxItemsPerSprint: 1          # ramp target managed by promotion rule
  maxExecutePhaseParallelism: 4
ramp:
  levels: [1, 3, 5]
  promoteAfterCleanCycles: 3
  minFreeGbToStart: 4.0
```

---

## Section 5 — Observability

Extend the per-cycle record (`.agentforge/memory/cycle-outcome.jsonl` and the cycle log) with:
- `gateMode` (`related` | `full`), `gateWorkers`, `oomRetryCount`,
- `providerSwitchCount` (sum of `RunResult.providerSwitches` across items),
- `autoMergedPrCount`, `humanReviewPrCount`,
- `cleanCycle` (boolean, drives the ramp promotion rule).

These fields are the evidence base for "production-ready" and the input to the promotion rule. No new storage; additive fields on the existing record.

---

## Section 6 — Testing strategy

TDD every decision as a **pure function**, verifiable without running the 7,966-test suite:
- `computeWorkers`, `selectGateMode`, `isOomExit`, `buildVitestArgs` (Section 1),
- ordered `providerPreference` derivation from a routed item (Section 2),
- `classifyPrRisk`, `shouldAutoMerge` (Section 3),
- `checkMemoryHeadroom`, ramp `promote` logic (Section 4).
Plus **one subprocess integration test** for `run-verify-tests.mjs` against a tiny fixture project (assert worker count chosen, affected vs full selection, OOM-retry path with a stubbed killer). Each workstream lands behind the existing gate; CLAUDE.md conventions apply (ESM `.js` imports, `node:` builtins, `execFile` not `exec`, `String.includes` over regex for matching, `js-yaml.dump` for any YAML writes).

## Implementation sequencing (for the plan)

1. **Gate runner (Section 1)** — unblocks safe scaling; ship + validate first.
2. **Observability (Section 5)** — needed to measure clean cycles for the ramp.
3. **Routing/auto-switch wiring (Section 2)** — turns v7 work live.
4. **Risk-based auto-merge (Section 3)** — keep master switch off until validated.
5. **Ramp + guardrails (Section 4)** — promote size only on observed reliability.

## Out of scope (YAGNI for now)

- Cloud/CI runner profile (this design targets the local box; cloud is a later memory profile).
- Distributed/multi-machine cycles.
- A second Commander surface / binary↔MCP parity (tracked separately from v7 item 6).
- Auto-remediation of the 7 pre-existing legacy-`src/` import violations (separate follow-up).

## Success criteria

- **N = 5 consecutive clean cycles** at `maxItemsPerSprint: 5` with **zero OOM**.
- Affected-test gate false-negative rate (regressions missed by `related`, caught by the deep gate) tracked and ≈ 0 over the validation window.
- Low-risk PRs auto-merge on green; high-risk consistently escalate to human review.
- Per-job routing observably selects ≥ 2 providers across a mixed sprint, with failover engaging on injected retriable failures.
