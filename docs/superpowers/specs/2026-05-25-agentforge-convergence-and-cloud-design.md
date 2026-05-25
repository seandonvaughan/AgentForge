# AgentForge Convergence & Cloud — Design / Plan

**Date:** 2026-05-25
**Status:** Approved — execution authorized ("write the plan and complete all phases")
**Author:** Claude (supervising), with Sean Vaughan
**Supersedes operational intent of:** the `codex/codex-version` fork

---

## 1. One-paragraph destination

Collapse the `codex/codex-version` fork back into **one unforked codebase, one version**, that uses **Claude *and* Codex at the same time**, routing each individual job to the best **(provider × model × effort)**. Make the autonomous loop **trustworthy** — it must reliably *ship* (either pass the quality gate clean, or self-correct the gate's findings on retry and then pass) instead of spinning. Then use that trustworthy engine to **build "AgentForge Cloud" from scratch** — a containerized, UI-first product that shares the existing engine and maps the operator's local Codex + Claude credentials in. Finally, point AgentForge Cloud back at *this* repository to audit and propose its own v1, and compare/integrate/learn.

## 2. Operating model (how we work)

- **Codex runs the loop, unattended-capable (24/7).** Codex credits are abundant; the loop does the volume work in `codex-cli` runtime mode.
- **Claude (this agent) supervises.** Each cycle: audit artifacts, merge PRs that pass, **fix what the loop could not fix**, and harden the loop itself. A capable auditor in the loop is what closes the gap *while we make the loop able to close it itself*.
- **Trust rule:** never accept self-reported "DONE." Verify against `pnpm verify:gates` and real artifacts (events, PRs, test output). Past specs were graded by the same agents that wrote them — that record is not evidence.

## 3. Diagnosis (grounded in cycle 9416c59d, 2026-05-25 14:23–14:54)

The loop is **not** broken at the level people feared. Evidence from one real cycle:

1. Build is clean: `tsc -b --force` across all 11 packages exits 0.
2. Tests are essentially green: **7,774 / 7,775 vitest tests pass** — exactly **one** failure: `packages/core/src/runtime/__tests__/worktree-pool.test.ts > WorktreePool > keeps truncated visible agent collisions unique via the hash suffix`.
3. The loop **does real work**: it planned 3 items, executed them, and opened **3 real PRs (#167/#168/#169)** with real code.
4. The **gate works correctly**: it rejected two genuine MAJOR bugs —
   - `packages/executor/src/planner.ts` inserts canary stages when `canary.enabled && selfModification`, but `packages/executor/src/executor.ts` skips self-modification canary execution when `enabledForSelfModification` is false → **plan/runtime divergence**.
   - `packages/embeddings/src/similarity.ts` `topKAsync` loops `i += batchSize` without validating `batchSize`, so `batchSize <= 0` **infinite-loops/hangs**.
5. **The retry path is what's broken.** On gate rejection the loop re-executed the same items with `filesHinted: []` — the agents were **never told which files the findings named** — all three retries went to `status: failed`, and the cycle died `"execute: execute phase reported blocked"`. No merge, no progress; debris (branches, PRs, version bump 10.41.7→.8) left behind.

**Conclusion:** AgentForge can build and self-critique. It cannot yet **fix what its own gate finds**. That single gap, plus the runtime fork and accumulated debris/doc-drift, is why two days produced no felt progress.

### Surrounding rot to clear
- **Fork not integrated:** `codex/codex-version` is 71 commits / +22.8k−3.5k LOC ahead of `main`; the runtime work lives only on the fork.
- **Debris:** ~130 local `codex/agent-*` branches, ~30 open draft agent PRs (#117–#169 range), 4 orphan worktrees (`pr-143-recovery`, `AgentForge-pr144/145/146`).
- **Version chaos:** `package.json` 10.5.1, truth-doc 10.5.0, cycles auto-stamping 10.41.x, docs narrating v22/v23.
- **Docs lie:** `CLAUDE.md` claims v22.1 / 24 agents / `packages/mcp`. Reality: converged version / 35 mixed-generation agents / `packages/mcp-server` / 11 packages.
- **Convergence half-done:** root `src/` reduced to a deprecation-stub CLI, but ~179 `.ts` files in ~29 root subdirs still shadow `packages/` (1,383 `.ts`).

## 4. Current-state facts (verified this session)

- Packages: `cli, core, dashboard, db, embeddings, executor, shared, plugins-sdk, mcp-server, skills-catalog` (+ root). 11 total.
- Runtime abstraction is **~80% built, not stubs**: `ExecutionTransport` interface + 4 real transports (`anthropic-sdk`, `claude-code-compat`/cli, `codex-cli`, `openai-sdk`), `ProviderResolver`, `ExecutionService`, `RuntimeAdapter`, and `resolveProviderModelProfiles()` (already computes per-job model+effort profiles for all four providers).
- Dashboard already has ~47 routes; server has ~65 route files (incl. a literal `dashboard-stubs.ts`). Much "Cloud" UI surface is scaffolded but partly fake.

## 5. Runtime convergence — concrete gaps (Phase 1, Stream B)

To reach "both providers at once, best provider×model×effort per job":
1. No per-job provider selection signal — add `preferredProvider`/`providerKind` hint to `ExecutionRequest`; thread `runtimeMode` per agent through `RuntimeAdapter.run()`.
2. Single-transport construction lock — add a `multi` mode so `ExecutionService` registers all transports and routes per job (today it hard-filters at construction by mode).
3. No routing policy — implement best-(provider×model×effort)-per-item policy.
4. Unified cross-provider cost — budget gates use Claude-only `MODEL_PRICING`; unify with `openai-pricing.ts`.
5. Codex auth env-injection — Codex relies on persistent `codex login`/`CODEX_HOME`; add `CODEX_API_KEY`/`OPENAI_API_KEY` passthrough (the seam the container needs).
6. `resolveAutoMode` ignores Codex/OpenAI — make `auto` aware of all transports.
7. `.agentforge/config/models.yaml` not wired to forge/dashboard — scaffold + validate.

**Key files:** `packages/core/src/runtime/{types.ts, provider-resolver.ts, execution-service.ts, execution-service-mode.ts, model-profiles.ts}`, `runtime/transports/{codex-cli-transport.ts, openai-sdk-transport.ts}`, `packages/core/src/autonomous/{runtime-adapter.ts, phase-handlers/execute-phase.ts}`, `packages/core/src/agent-runtime/types.ts`, `packages/core/src/runtime/codex-readiness.ts`, `.agentforge/config/models.yaml`.

---

## 6. Phases

### Phase 0 — Trust baseline + cleanup (stop the bleeding)
- Confirm no live cycle/daemon is running; stop it if so.
- Create a clean integration branch.
- Fix the 1 failing test (`worktree-pool` hash-suffix collision).
- Get `pnpm verify:gates` green end-to-end (has *never* been green) — the trust floor.
- Triage open PRs #167/#168/#169: hand-fix the two MAJOR findings (canary flag alignment; `batchSize > 0` guard), merge what's good, close the rest.
- Extract any value (gate findings → learnings), then **delete ~130 orphan branches, ~30 stale PRs, 4 orphan worktrees**.
- Reset the `.agentforge` team/flywheel history for a fresh start (re-forge a clean team).
- Tame version auto-bump so the loop stops minting 10.41.x.
- Add a guard: no re-bump / no opening >N PRs without a green gate.

### Phase 1 — Make the loop trustworthy (the core; "one working version")
- **Stream A (highest leverage):** feed gate findings **+ the file paths they name** into retry; re-execute in-place on the same branch; re-gate. (`filesHinted` is empty today.)
- **Stream B:** runtime-agnostic per-job routing (the 7 gaps in §5).
- **Stream C:** merge the fork into one line; one canonical CLI surface; one version scheme.
- **Stream D:** rewrite `CLAUDE.md`/`README.md`/`CHANGELOG.md` to match reality.

**Phase 1 Definition of Done (= "one working version"):**
- `verify:gates` green on the converged branch; no fork.
- Run unattended in Codex mode: **3 consecutive cycles** each take a real item, implement it, and either pass the gate clean **or self-correct findings on retry**, then **merge a PR** — no human rescue.
- A single cycle routes different items to different providers under one unified budget.

### Phase 2 — Engine builds AgentForge Cloud v1 (own spec when reached)
Point the trustworthy loop at an empty **AgentForge Cloud** target: containerized (single or stack), shares `packages/core`, maps local Codex + Claude Code auth into the container (API-key fallback), UI-first (no CLI front end), uses both providers at once. Watch it build v1.

### Phase 3 — Cloud audits its parent (own spec when reached)
Point Cloud/engine at this repo; it audits and proposes its own v1; compare against existing work; integrate, replace, or harvest learnings.

## 7. Risks actively managed
- **Container auth headless:** Codex/Claude CLIs use persistent local logins; mounting `CODEX_HOME`/Claude config may not refresh tokens headlessly. Spike early in Phase 2 with an API-key fallback.
- **Unattended debris:** 24/7 cycles pile up between audits. Phase-0 guard caps PRs/version-bumps without a green gate.
- **Self-reported trust:** verify against `verify:gates` and artifacts, never prose.

## 8. Definition of "done" for the whole effort
A single, green, documented codebase where the autonomous loop reliably ships under either/both providers; AgentForge Cloud v1 exists as a container the operator runs in the browser; and Cloud has produced an audit of this repo that we have reviewed.
