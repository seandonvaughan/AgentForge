# Epic Campaign Decomposer — Design

**Date:** 2026-05-30
**Status:** Approved (design); **hardened v2** after adversarial red-team; implementation plan pending
**Author:** Autonomous architect session
**Builds on:** `2026-05-28-production-autonomous-cycles-design.md` (size ramp, VERIFY hardening, provider routing, risk-based auto-merge), the 2026-05-30 enterprise diagnostic (root-cause #4: "no decomposition stage exists"), and the verified decomposer grounding brief (this session).
**Red-team:** A 72-agent adversarial review (6 lenses → independent per-finding verification → synthesis) produced 65 findings; 59 survived verification (10 blocker, 37 major, 12 minor), 6 refuted. **Verdict: core architecture sound; no blocker forces a master-decision rethink.** All confirmed findings are folded into this v2. The two genuine design sharpenings — the smoke-guard core-glob bug (§8.3) and import-edge augmentation (§6.3.4) — are incorporated as first-class mechanisms.

---

## 1. Context & motivation

AgentForge's autonomous cycle is **item-flat and strictly linear**. Source signals are unified into `BacklogItem[]` (`proposal-to-backlog.ts:95-183`), ranked into `RankedItem[]`, sliced to the top N by `SprintGenerator.generate()` (`sprint-generator.ts:89,108`), and executed in **iteration order** (`execute-phase.ts:1559-1623`) gated only by a numeric parallelism cap, a global `ConcurrencyGate`, and a `FileLockManager` that serializes items with *declared-overlapping files only*.

There is no notion of ordering, dependency, sub-task, or campaign. The `dependencies[]` field is **dead code, verified end-to-end**:

- `RankedItem.dependencies: string[]` exists (`types.ts:222-240`) and the scorer is prompted to populate it.
- Two of three scoring-fallback rungs hard-code `dependencies: []` (`scoring-pipeline.ts:294,360`); strike-2 explicitly instructs the agent to drop it.
- `SprintGenerator.toSprintItem()` (`sprint-generator.ts:120-142`) copies `files`, `runtimeMode`, `preferredProvider` but **never `dependencies`** — the field dies before `plan.json`.
- `execute-phase.ts` contains **zero** references to `dependencies`, `depends`, `topolog`, or `wave`.

So the system can develop a handful of independent items per cycle, but it **cannot express or execute a multi-step objective** as a dependency-ordered plan. This is the ceiling on cycle *ambition* and the last open P1 keystone after #223 (scoped VERIFY) and #224 (live provider failover) built the reliability floor.

This design adds a **true objective/epic campaign planner**: an operator hands AgentForge a high-level objective, an Opus planner decomposes it into a validated dependency DAG, and the execute phase runs that DAG in **dependency waves** within a single cycle, shipping one squashed PR per epic behind one deep VERIFY gate.

---

## 2. Goals & non-goals

### Goals
1. Accept an operator-provided objective and decompose it into a dependency-ordered set of child work items.
2. Execute children in **hard-ordered waves** — a child never starts until all its predecessors have landed.
3. Keep VERIFY economics flat: **one deep gate per epic**, regardless of child count, with cheap per-wave smoke barriers in between. *(This holds only if §8.3's `smokeGuard` mechanism ships — see B4.)*
4. Ship **one squashed PR per epic**, implementing a **new epic-level** auto-merge/observability contract. Epic cycles are a distinct execution mode; signal cycles retain the prior per-item `shouldAutoMerge`. *(Not "preserve the 1:1 item-PR contract" — epics intentionally replace it at epic granularity.)*
5. Degrade gracefully: a mid-DAG child failure blocks only its transitive dependents; independent branches still land.
6. Resolve the verified latent **checkpoint-file collision** before parallel waves make it active.
7. Leave signal-driven maintenance cycles **completely unchanged** when no objective is supplied.

### Non-goals (deferred — see §13)
- Multi-epic `objectives.json` queue (v1 = one objective per cycle via `--objective`).
- Auto-derived objectives from a roadmap doc.
- Dashboard epic-DAG visualization (data captured in `decomposition.json` now).
- Stacked per-child PRs.
- Cross-cycle epic spanning (an epic that takes several cycles).
- Read/write lock distinction in `FileLockManager`.

---

## 3. The two master decisions (approved)

| Decision | Choice | Consequence |
|---|---|---|
| **Epic → cycle mapping** | **One epic = one cycle.** Waves run inside the execute phase; one deep gate at the end; one PR. | Deep gates per epic = 1 (not N). Reuses gate/release phases nearly unchanged. |
| **Objective source** | **Operator-provided** via `--objective "..."`. Signal backlog drives ordinary cycles when no objective is given. | Epics are deliberate and operator-chosen; autonomous signal cycles are untouched. |

### The economic keystone (and its single point of failure)
Today VERIFY/gate runs **once per cycle**, not per item. With one-epic-one-cycle, an epic touching `packages/core/**` should pay **one** deep gate (the full ~7,966-test suite) regardless of child count. Between waves, a **cheap smoke barrier** (`build` + `vitest related` on just that wave's changed files) lets dependents build on green without paying for a deep gate.

> **CRITICAL (B4):** This keystone is *false against current code* unless §8.3 ships. `verify-test-planner.mjs:56` does an **unconditional `return 'full'`** on any `coreGlobs` match. Without a `smokeGuard` flag that skips the core-glob check, every wave touching core triggers the full suite and the design degrades to N deep gates — losing its entire reason to exist. **§8.3's `smokeGuard` parameter is the highest-leverage edit in this spec.**

---

## 4. Pipeline shape

A new **DECOMPOSE** phase runs between PLAN and ASSIGN, **active only on epic cycles** (an objective is present):

```
audit → plan → [DECOMPOSE] → assign → execute(waves) → test → review → gate → release → learn
```

When no objective is supplied, DECOMPOSE is a no-op pass-through and the cycle behaves exactly as today. The phase must be inserted into **both** `PHASE_SEQUENCE` (`phase-scheduler.ts:27-37`) and the duplicate copy in `packages/server/src/lib/phase-handlers.ts:69-79`, and added to the `PhaseName` union.

---

## 5. Input — `EpicObjective`

```ts
interface EpicObjective {
  id: string;                 // epic-<shortid>
  title: string;
  description: string;        // the operator's objective text
  constraints?: string[];     // optional: "do not touch auth", "TS only", budget hints
  createdAt: string;          // ISO
}
```

- v1 entrypoint: `agentforge cycle run --objective "Add multi-tenant RBAC across server + dashboard"`. This is a **real CLI change**, not trivial plumbing: add the flag to the cycle-run command, `objective` to `CycleRunnerOptions`, persist to `.agentforge/cycles/<id>/objective.json`, and thread `objective` onto `PhaseContext`.
- `.agentforge/objectives.json` queue is deferred (§13). The CLI flag is the v1 surface.

---

## 6. The DECOMPOSE phase — `EpicPlanner`

A dedicated **`epic-planner` agent (Opus tier)** — *not* the existing `architect` — for a clean prompt and independent testability. **It does not exist yet**: it must be authored (`.agentforge/agents/epic-planner.yaml` + `.claude/agents/epic-planner.md`), registered in `team.yaml` (strategic bucket) and the Opus routing index, with a dedicated system prompt + capability spec.

### 6.1 Inputs
- The `EpicObjective`.
- Audit findings (`audit.json`) from the audit phase. *(Optional, deferrable: a pre-decomposition feasibility diagnostic that flags an objective as too vague to decompose — non-blocking advisory.)*
- Repo grounding: the forge `routing-index.json` + subsystem map (so the planner knows which agents own which subsystems) and conventions.

### 6.2 LLM output — `EpicPlan` (Zod-validated)
```ts
interface EpicChild {
  id: string;                    // child-<n>
  title: string;
  description: string;
  files: string[];               // declared target files (drives wave safety + VERIFY scoping)
  capabilityTags: string[];      // specific, mutually-exclusive (see §6.4 routing trap)
  suggestedAssignee: string;     // a forged specialist id
  estimatedCostUsd: number;
  estimatedComplexity: 'low' | 'medium' | 'high';
  predecessors: string[];        // child ids this child depends on
}
interface EpicPlan {
  epicId: string;
  children: EpicChild[];
  rationale: string;             // brief audit-trail prose
}
```

### 6.3 Deterministic validate-and-repair (no LLM)
After the LLM returns, a pure-function pass enforces correctness:

1. **Cycle detection (Kahn's algorithm).** If the predecessor graph is cyclic, issue **one** LLM repair retry naming the cycle and asking it to break the edge. Still cyclic → **fail the DECOMPOSE phase** with a readable diagnostic. No partial/invalid DAG ever ships.
2. **File-overlap edge augmentation.** Any two children whose declared `files[]` intersect and are *not* already transitively ordered get a **synthetic precedence edge**, directed by **child declaration order** (the earlier child in `EpicPlan.children` becomes the predecessor) — a stable, deterministic tie-break. Guarantees file-conflicting children never share a wave.
3. **Wave layering.** Topological longest-path layering assigns each child a `wave: number` (0-indexed). Children with no predecessors are wave 0. Hard-validate `epic.*` caps here (§12); exceed ⇒ fail with a readable message **before** dispatch.

#### 6.3.4 Import-edge augmentation (M5 — closes the type/import-coupling hole)
File-overlap alone does **not** catch two children on *disjoint* files where child B imports a symbol child A exports. That passes §6.3.2, then fails only at the deep gate — exactly the late cascade this design claims to eliminate. So, after file-overlap augmentation:

- Run a lightweight static **import scan** (esbuild `--metafile`, or ts-morph) over each child's declared `files[]`. esbuild over declared files is fast and needs no merged tree (unlike `tsc --noEmit`).
- If child B imports a symbol that resolves into child A's declared files but A is not in B's `predecessors[]`, **add a synthetic edge A→B** (or issue one repair retry naming the missing import; hard-fail if still missing).
- This shifts trust from "the LLM got the DAG right" to "LLM + import-graph consensus," catching type-cascade breakage at *plan* time, not gate time.

### 6.4 Outputs
- **`.agentforge/cycles/<id>/decomposition.json`** — the `EpicPlan` + computed `wave` per child + the synthetic edges added in §6.3.2/§6.3.4 + a validation report (cycle-check result, augmented-edge list, cap-check).
- **`plan.json` `items[]`** — children flattened into the existing plan, each carrying new optional fields: `parentEpicId`, `wave`, `predecessors`, a routing seed (`preferredProvider`/`runtimeMode`), **a freshly-zeroed failure counter** (children must not inherit a parent `priorFailureCount`), and **specific mutually-exclusive `tags`**.

> **Routing trap (verified):** the tag-based re-router keys off `securityMarkers`/`cheapMarkers`. A security child tagged "cheap" would be downgraded; a child inheriting a parent's failure count auto-escalates to Opus at `escalateAfterFailures: 2` (`job-router.ts`). The planner must emit specific, non-conflicting tags and the DECOMPOSE flattening must zero failure counters.

---

## 7. Item-model changes

Extend **four** item shapes and the persisted schema with **optional** fields (absent ⇒ single wave 0 ⇒ signal cycles unaffected). The §1 spec table previously omitted the execute-phase-local shape — it is included here:

| Type | File | Added |
|---|---|---|
| `SprintPlanItem` | `sprint-generator.ts:46-64` | `parentEpicId?`, `wave?`, `predecessors?` |
| `SprintItem` (framework) | `sprint-framework.ts:45-59` | `parentEpicId?`, `wave?`, `predecessors?` |
| `SprintItem` (execute-local) | `execute-phase.ts:252` | `parentEpicId?`, `wave?`, `predecessors?` |
| `PlanItemSchema` | `cycle-artifacts/schemas.ts:88-101` (keep `.passthrough()`) | matching optional zod fields |

- **`toSprintItem()` (`sprint-generator.ts:120-142`) is fixed** to carry the new fields through (the same boundary that currently drops `dependencies`).
- **Decision (m2): remove** the vestigial dead `RankedItem.dependencies` (`types.ts:222-240`) in the types-only PR; introduce `predecessors` separately on the epic-child path. This avoids carrying a fourth dead dependency field. Update the hard-codes (`scoring-pipeline.ts:294,360`), the scoring prompt, and the schema field (`schemas.ts:201`). **Affected fixtures to update** (do not miss): `budget-approval.test.ts`, `sourcing-stability.test.ts`, `scoring-pipeline-roster.test.ts`, `plan-json-migration.test.ts`.

---

## 8. Wave-aware execute phase

The dispatch loop (`execute-phase.ts:1559-1623`) is restructured from a single flat iteration into **ordered waves**. Items are grouped by `wave` and processed in ascending order. **All wave operations are strictly sequential — no stage runs concurrently with another.**

### 8.1 Wave barrier (strict, sequential)
For each wave in ascending order:

1. **Launch** all *runnable* wave items (existing async + `ConcurrencyGate` + `FileLockManager`, unchanged). A wave whose children are all `blocked` is **skipped** (no deadlock; see §9.1).
2. **`await Promise.allSettled(waveInFlight)`.** All gate/worktree releases for this wave's items must have fired before step 3 — do not begin smoke/merge while any item's `finally` is still draining. Assert this wave's `inFlight` set is empty.
3. **Smoke guard** (§8.3) on the union of the wave's changed files. Fail ⇒ §9.1 cascade (do **not** merge).
4. **Merge — serialized under a single per-epic merge lock.** Iterate completed children in deterministic order (child id); merge each branch into `codex/epic-<id>` (`--no-ff`). A merge conflict ⇒ mark that child `needs-rebase`, retry against the updated integration branch. Release the lock only after all merges complete. **Capture the resulting integration-branch sha.**
5. **Push `codex/epic-<id>` to `origin` and verify** (`git push` exit code + `git ls-remote`). Next-wave worktrees fork from `origin/codex/epic-<id>` (§8.2), so this push is a hard prerequisite, not an optimization.
6. **Only now** allocate worktrees for the next wave's dependents. The execute checkpoint asserting "wave N complete" is flushed **after** this push+verify (§11), never before merge.

### 8.2 Integration branch (judgment call J1 — approved)
- The integration branch `codex/epic-<id>` is created from `baseBranch` by DECOMPOSE/assign on epic cycles and **pushed to origin** before any worktree allocation (step 5's invariant applies to wave 0 too: create+push the empty branch first).
- **The worktree pool needs no change.** It already accepts an optional `sourceRef` (`WorktreeAllocateOptions`, `worktree-pool-types.ts:30-31`), defaulting to `origin/<baseBranch>` (`worktree-pool.ts:118`). The missing wiring is at the item level:
  1. Add `epicIntegrationBranch?: string` to `PhaseContext`, set by DECOMPOSE to `codex/epic-<id>` only on epic cycles.
  2. In `allocateWorktreeForItem` (`execute-phase.ts:673-704`), the **normal (non-rejected-branch) path** (`684-694`) currently calls `pool.allocate({agentId, sessionId})` with no `sourceRef`. Pass `sourceRef = ctx.epicIntegrationBranch` when present, else omit (preserving today's `origin/main` default for signal cycles). The rejected-branch path is unchanged.
  3. `sourceRef` resolves to `origin/<branch>`, so the integration branch must exist on origin (step 5 / wave-0 create+push).
- **Merge-before-release ordering (M6):** wave-merge (step 4) runs **before** any worktree `release()` for that wave's items. Today the item-level `finally` releases at `execute-phase.ts:1466` with `deleteBranchOnRelease=true` (`worktree-pool.ts:119`), which would `git branch -d` a child branch before it is merged. The wave loop must defer release until after the merge so deletion is safe (commits already in the integration branch).
- **Pool-reuse reset (M6):** when the pool reuses a worktree dir for the next wave, `allocate()` with `sourceRef = origin/codex/epic-<id>` must **force-checkout the base** before returning, so wave N never inherits wave N-1 working-tree state. (`maxChildrenPerWave ≤ pool size` means reuse won't occur *within* a wave, but does *across* waves.)
- **Git is the final arbiter of undeclared collisions.** Same-wave children are isolated in separate worktrees (no live corruption); an undeclared shared-file conflict surfaces as a merge conflict at step 4 → `needs-rebase` retry. Robust by construction.

### 8.3 Wave smoke guard (judgment call J2 — approved; B4 mechanism)
- After each wave: `build` + `vitest related` on the **union of that wave's changed files**, reusing `scripts/run-verify-tests.mjs`.
- **MANDATORY (B4):** the smoke guard invokes `selectGateMode()` with a new `smokeGuard: true` argument. When true, the **core-glob check is skipped** — a wave that touches `packages/core/**` still runs only `vitest related`, never the full suite. During a smoke guard, `'full'` is reachable only via explicit `affectedMode: 'full'` or an unknown/empty diff. **This is the mechanism that makes "one deep gate per epic" true.** Require a unit test: *"selectGateMode ignores core-glob checks when smokeGuard=true."*
- `--maxWorkers` only — **never `--minWorkers`** (vitest 4.x fatal `CACError`).
- **Cost (corrected):** "Seconds on a warm `tsc -b` cache; ~30–90s cold (first wave or after cache invalidation) — still far cheaper than re-running the deep gate per wave." Optional `epic.waveSmokeBuild: false` skips `corepack pnpm build` and relies on `vitest related` type-checking; default is build+related.
- Pass ⇒ proceed to merge (step 4). Fail ⇒ §9.1.

---

## 9. Failure / retry / quarantine cascade (judgment call J3 — approved)

Item status today is only `completed`/`failed` (`execute-phase.ts:1628-1654`). This design adds a status enum `{ completed, failed, quarantined, blocked, needs-rebase }` and a **pure cascade function** (BFS over the predecessor graph) so it is unit-testable per §14.

- **Child fails** (execution error): existing per-item retry + provider failover applies.
- **Exhausts retries** ⇒ child marked `quarantined`; its **transitive dependents** (cascade BFS) ⇒ `blocked`, skipped. **Independent DAG branches keep running.**
- **Outcome mapping** (explicit): `complete` = all children landed; `partial` = ≥1 landed **and** ≥1 blocked (ships a PR); `failed` = a wave-0 / critical-path child is dead so nothing coherent ships (no PR). Add `outcome?: 'complete'|'partial'|'failed'` to the execute `PhaseResult` and `epicOutcome` to `cycle.json`.

### 9.1 Wave smoke-guard failure handling (B5 — per-wave semantics)
A smoke-guard failure is a *per-wave* event, distinct from per-item retry:

- **Implicated-child path:** parse smoke output → mark children whose declared `files[]` intersect the broken files as `implicatedBySmoke`; each retries against the integration branch under the normal per-item retry budget; on exhaustion ⇒ `quarantined`, transitive dependents ⇒ `blocked`.
- **Wave-fatal path** (smoke fails but *no* child is implicated — infra/build break): retry the whole wave at most `K=2`; on exhaustion ⇒ all wave children `quarantined`, all later waves `blocked`.
- **Dependents are released only after** all implicated-child retries and any wave retries are exhausted.

### 9.2 Partial epic + gate REJECT (M2)
If the end deep gate **REJECTS** a `partial` epic: the PR opens `draft=true` (never auto-merged); the body includes `GATE VERDICT: REJECT. Reason: <findings>. Partial epic — landed children may depend on blocked children (see decomposition.json). Manual fix + retry required.` Write `epicOutcome.gateVerdict: 'PASS'|'REJECT'` to `cycle.json` so automation distinguishes `partial+pass` (low-risk automerge eligible) from `partial+reject` (human review).

---

## 10. Gate / Release

- **Gate** runs **once** on `codex/epic-<id>` — the existing deep VERIFY (`run-verify-tests.mjs` deep-gate path). The gate must pass `baseBranch=codex/epic-<id>` into the deep-VERIFY subprocess env so tests run against the integration HEAD, not main.
- **Release (M3):** `release-phase.ts` is a *metadata-only marker today* (no agent, no PR). For epic cycles it must be promoted to an **active PR-opener**: read `baseBranch` from context, open **one squashed PR** `codex/epic-<id>` → `main`, and run **epic-level** risk classification (routing-index core-globs ∨ high-risk tags ∨ `maxFilesPerCommit` overflow ⇒ `needs-review`; else low-risk ⇒ automerge when `autoMergePRs` is enabled). PR body summarizes the objective, the wave plan, and any blocked children. Individual children produce **no** separate PRs or auto-merge decisions. Dependent on B2/B3.

---

## 11. Checkpoint collision fix

The grounding pass **confirmed** a latent collision: `item-checkpoint.ts:67` and `cycle-checkpoint.ts:92` both resolve to `.agentforge/cycles/<id>/checkpoint.json` with incompatible schemas (`schemaVersion: 2` vs `v: 1`). They coexist only because they never write concurrently; parallel waves will make atomic-rename writes interleave and clobber.

- **Reality note (M1):** `item-checkpoint` writes a *single aggregated* file with `completedItemIds[]` — **not** per-item `checkpoints/<item-id>.json`. The CLAUDE.md per-item contract (~line 329) is aspirational and must be corrected to match (aggregate + `--resume` re-enters at first incomplete item).
- Split the writers: `cycle-checkpoint.ts` → **`checkpoint-cycle.json`** (phase-level, `v:1`); `item-checkpoint.ts` → **`checkpoint-execute.json`** (item-level, `schemaVersion:2`). **Land this as its own PR ahead of wave code** — the collision is latent now.
- **Resume ordering invariant (M1):** the execute checkpoint asserting "wave N complete" must be flushed **only after** the wave-N merge is pushed to origin and verified (§8.1 step 5). Reorder `checkpointWriter.flush()` (`execute-phase.ts:1624`) to run after push. Write `integrationBranchSha` into the checkpoint; on resume, `git fetch` and verify that sha exists at origin before launching wave N+1.
- Extend `ExecuteProgress` with `currentWaveIndex`, `completedChildren`, `blockedSet`, `integrationBranchSha`. Add a one-release read-shim for the old `checkpoint.json`.

---

## 12. Budget / ramp / observability

- **Epic budget** = Σ(child `estimatedCostUsd`) × headroom, surfaced for approval; the per-cycle cap stays warn-only. The epic cycle's `perCycleUsd` is **derived from the epic estimate**, not the default 200, so the estimate doesn't falsely exhaust headroom before work runs.
- **New `epic:` config block** in `autonomous.yaml` + an `epic?` field on the `CycleConfig` TS interface (`types.ts`) + config-loader merge/validate: `maxChildren` (start 6), `maxWaves` (4), `maxChildrenPerWave` (4). **Hard-validated in DECOMPOSE before dispatch** (§6.3.3); exceed ⇒ readable failure. The signal-cycle `maxItemsPerSprint` ramp (1→3→5) is untouched.
- **Clean-cycle (M8):** epic and signal `cleanCycle` are intentionally different and tracked on **independent counters**. Epic `cleanCycle` = deep gate passed ∧ no OOM ∧ no failover exhaustion ∧ `outcome=complete`. `outcome=partial` **fails** epic `cleanCycle`. A 3-child epic passing the gate does **not** advance the signal `maxItemsPerSprint` ramp.
- **Observability (M4):** add optional Zod fields to `CycleJsonSchema` (`schemas.ts:66-80`): `epicId`, `epicOutcome` (incl. `gateVerdict`), `decomposition{epicId,childCount,waveCount}`, `waveResults[]{waveIndex,completed,failed,blocked,smokeStatus,durationMs}`, `blockedChildren`, `waveTimings[]`. Plus the three item fields on `PlanItemSchema` (§7). Dashboard epic-DAG view deferred; data captured now.

---

## 13. v1 scope & YAGNI

**In v1:**
- `--objective` single objective per cycle + `objective.json` persistence.
- `epic-planner` Opus agent (authored + registered) → `EpicPlan` → deterministic validate-and-repair (cycle-check + file-overlap + **import-edge**) → `decomposition.json`.
- Wave-aware execute: integration branch (create+push), strict wave barrier, smoke guard with `smokeGuard:true`, merge-under-lock + push+verify, merge-before-release, pool-reuse reset.
- One deep gate; one squashed PR; epic-level risk classification; partial+reject → draft PR.
- Partial-failure cascade with quarantine/blocked + pure cascade fn.
- Checkpoint split + wave-resume (own PR, first).
- Conservative `epic.*` caps, hard-validated.
- **`agentforge cycle preview --objective "..."` (m3 — promoted into v1):** runs the planner + deterministic pipeline and returns the DAG, waves, file overlaps, cost-by-wave, and validation warnings **without** running a full cycle. Given epics can be 15 children / high cost, a dry-run is a v1 safety requirement, not a nicety.

**Deferred:** `objectives.json` multi-epic queue; auto-derived roadmap objectives; dashboard epic-DAG view; stacked per-child PRs; cross-cycle epic spanning; read/write lock distinction; audit feasibility diagnostic (§6.1).

### 13.1 Implementation order (dependency-ordered — the spec's build backbone)
Each step is a prerequisite for the next. The first two ship as independent PRs *before* any wave code.

1. **Types + schema (no behavior):** add `parentEpicId?`/`wave?`/`predecessors?` to all four shapes (§7); fix `toSprintItem()`; remove dead `RankedItem.dependencies` + update fixtures. *Tests: type round-trip.*
2. **Checkpoint split (§11):** independent; lands the latent-collision fix regardless of epics. *Tests: round-trip + old-file migration.*
3. **`EpicObjective` + `objective.json` + `--objective` flag + `CycleRunnerOptions.objective` + `PhaseContext.objective`.** *Tests: flag parses, file written, context threaded.*
4. **`epic-planner` agent** (yaml + md, Opus tier, registered in `team.yaml` + opus routing) + `EpicPlan`/`EpicChild` Zod schemas.
5. **DECOMPOSE phase handler:** no-op when objective absent; else invoke planner, run §6.3 pipeline (incl. §6.3.4 import-edge), write `decomposition.json` + flatten into `plan.json`. Insert `decompose` into `PHASE_SEQUENCE` (`phase-scheduler.ts:27-37`), the `PhaseName` union, **and** the duplicate `packages/server/src/lib/phase-handlers.ts:69-79`.
6. **Worktree base-branch threading (§8.2):** `epicIntegrationBranch` on context; `sourceRef` at the item allocator; create+push integration branch.
7. **Wave-aware execute loop:** strict barrier (§8.1) + smoke guard `smokeGuard:true` (§8.3) + merge-under-lock/push-verify + merge-before-release + cascade (§9/§9.1).
8. **Gate/release epic-awareness (§10):** deep gate against integration HEAD; release promoted to PR-opener + epic risk classification.
9. **`epic.*` caps + observability fields (§12).**
10. **`cycle preview --objective` (§13 m3).**

---

## 14. Testing strategy (TDD)

Pure functions are directly unit-testable and form the correctness backbone:
- Cycle detection (acyclic accept / cyclic reject + repair-retry trigger).
- Wave layering (longest-path correctness; predecessors always in earlier waves).
- File-overlap edge augmentation (overlapping files never co-wave).
- **Import-edge augmentation** (disjoint files with an import edge get ordered).
- Cascade-block computation (transitive dependents of a quarantined child).
- `selectGateMode` with `smokeGuard:true` ignores core-globs.
- Checkpoint round-trip + old-file read-shim migration.

LLM-coupled:
- `EpicPlanner` contract-tested against a **mock runtime** returning a fixed `EpicPlan` (validates the deterministic pipeline + artifact writes without spending tokens).

Integration / E2E:
- Wave execution with a **mock dispatcher** (assert wave order, strict-barrier sequence, merge-before-release, cascade on injected failure, zero-runnable-wave skip).
- One real E2E against the §18 vertical slice on a throwaway branch.

---

## 15. Integration points (file:line anchors — verified)

| Seam | Location | Change |
|---|---|---|
| Plan output | `plan-phase.ts:189-212` | Unchanged; DECOMPOSE consumes its text plan + objective. |
| New DECOMPOSE phase | `phase-scheduler.ts:27-37` (PHASE_SEQUENCE) **and** `packages/server/src/lib/phase-handlers.ts:69-79` | Insert `decompose`; no-op when no objective. |
| Item→sprint conversion | `sprint-generator.ts:120-142` | Carry `parentEpicId`/`wave`/`predecessors`. |
| Item shapes | `sprint-generator.ts:46-64`, `sprint-framework.ts:45-59`, `execute-phase.ts:252`, `schemas.ts:88-101` | Add the three optional fields. |
| Routing preserve | `assign-phase.ts:197/200/207,268` | Already preserves upstream routing (verified); children pre-stamped, failure counters zeroed. |
| Dispatch loop | `execute-phase.ts:1559-1623` | Flat iteration → strict wave loop with barriers (§8.1). |
| Worktree base branch | `execute-phase.ts:673-704` (item allocator) | Thread `sourceRef = ctx.epicIntegrationBranch`. Pool unchanged. |
| Child commit/push | `agent-commit.ts:404` | Child branch push unchanged; wave-merge pushes integration branch separately. |
| Smoke guard | `scripts/run-verify-tests.mjs` (`selectGateMode` ~:46-59) | Add `smokeGuard` arg that skips core-glob check. |
| Deep gate | gate phase (existing) | Runs once on integration branch; pass `baseBranch` to subprocess env. |
| Release | `release-phase.ts` (marker-only today) | Promote to PR-opener for epic cycles. |
| Checkpoints | `item-checkpoint.ts:67`, `cycle-checkpoint.ts:92`, flush `execute-phase.ts:1624` | Split filenames; flush after push; add wave state. |
| Config | `.agentforge/autonomous.yaml`, `CycleConfig` (`types.ts`) | New `epic:` block. |
| Observability | `CycleJsonSchema` (`schemas.ts:66-80`) | Epic/wave fields. |

---

## 16. Risks & mitigations

| Risk | Mitigation |
|---|---|
| LLM invents a bad/cyclic DAG | Deterministic cycle-check + one repair retry + hard fail; file-overlap **and import-edge** augmentation backstop missed coupling. |
| Undeclared file collision in a wave | Worktree isolation + git merge conflict → `needs-rebase` retry. Never live corruption. |
| **Concurrent merges race the integration HEAD** | **Single per-epic merge lock; deterministic child-id merge order; push+verify before next wave (§8.1).** |
| **Core-glob silently forces full gate per wave** | **`smokeGuard:true` skips the core-glob check (§8.3) — the keystone fix.** |
| **Per-wave build heap pressure across N waves** | **Smoke runs `vitest related` only (no `--minWorkers`); `maxChildrenPerWave ≤ pool size`; verify 4 sequential builds fit `heapCapMb:2048` before raising caps.** |
| Worktree pool reuse leaks stale state / deletes unmerged branch | Merge-before-release; force-checkout base on pool reuse (§8.2). |
| Epic estimate exhausts cycle budget on paper | Derive epic cycle budget from the estimate; warn-only cap; operator approval surfaced. |
| Checkpoint clobber under parallel waves | Split files (§11) before parallel writers go live; flush after push. |
| Wave-3 regression hidden until end gate | Per-wave smoke guard catches gross breakage; deep gate is authoritative. |
| Zero-runnable wave (all blocked) | Wave is skipped, not awaited — no deadlock (§8.1 step 1). |

---

## 17. Success criteria

1. `agentforge cycle preview --objective "..."` returns a validated DAG (acyclic, file- and import-safe waves, cost-by-wave) without running a cycle.
2. `agentforge cycle run --objective "..."` persists `objective.json`, produces `decomposition.json`, and runs children in strict wave order; a dependent never starts before its predecessors land.
3. A wave touching `packages/core/**` runs **only `vitest related`** at its smoke barrier (proving B4); the epic pays exactly **one** deep gate.
4. The epic ships one squashed PR; a low-risk `complete` epic is automerge-eligible, a `partial+reject` epic opens a draft PR with fix guidance.
5. An injected mid-DAG failure quarantines only the affected child and its transitive dependents; independent branches still land; the epic reports `partial`.
6. A killed epic cycle resumes at the first incomplete wave using `integrationBranchSha`, with no checkpoint corruption.
7. Signal-only cycles (no `--objective`) behave byte-for-byte as before.

---

## 18. Minimal vertical slice (smallest v1 that proves the design end-to-end)

Prove the spine, defer the breadth. Ship the first two as independent PRs *before* any wave code.

1. **PR-0 (no behavior):** item-model + schema fields + `toSprintItem` fix + remove dead `dependencies`. Pure types; round-trip test. Unblocks everything.
2. **PR-1 (independent):** checkpoint split + read-shim. Lands the latent-collision fix regardless of epics.
3. **PR-2 (the vertical slice):** one real **3-child, 2-wave epic** (wave 0 = child-A adds a shared type; wave 1 = child-B and child-C import it, disjoint files), on a throwaway target, proving in one cycle:
   - `--objective` → `objective.json` → DECOMPOSE invokes `epic-planner` → `EpicPlan` → cycle-check + file-overlap + **import-edge** + wave layering → `decomposition.json`.
   - Integration branch `codex/epic-<id>` created from main and **pushed to origin**; wave-0 worktrees fork from it via threaded `sourceRef`.
   - Strict wave barrier: allSettled → smoke guard `smokeGuard:true` (proving a core-glob touch does *not* trigger the full suite) → serialized merge under lock → push+verify → release wave-1 from the updated origin branch.
   - One deep gate on `codex/epic-<id>`; release opens one squashed draft PR → main.
   - **Inject one failure in child-B** to exercise §9.1: B `quarantined`, dependents `blocked`, child-C still lands, epic reports `partial`, PR body lists blocked children.
   - Kill mid-wave-1 and `--resume`: re-enters at wave 1 using `integrationBranchSha`, no corruption.

**Out of the slice:** `epic.*` ramp promotion (static caps), gate-reject niceties beyond draft+body, dashboard, multi-epic queue, audit diagnostics. Irreducible core if cut further: **objective → validated `decomposition.json` → 2 waves with a real integration-branch merge between them → one deep gate → one PR.**
