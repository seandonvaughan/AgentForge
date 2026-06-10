# v24 Platform Upgrades — Knowledge, Memory, Scale, Recovery, Visibility, Claude Code

**Date:** 2026-06-09
**Status:** DESIGN — researched against the codebase at `claude/effort-estimation-ylzl4f` (post-fable, post-`cycle preview --objective`)
**Operator asks:** (1) a real knowledge base, (2) per-agent memory that actually works, (3) more concurrent agents, (4) better learning, (5) better failure recovery, (6) dashboard gaps — work items show nothing while pending/running, no instructions, no progress, planning agent missing from stats, (7) first-class use of AgentForge inside Claude Code sessions.

---

## 0. Executive summary

The audit's headline: **most of the missing capability is already built but unwired.** The knowledge graph, its SQLite+JSONL persistence, the vector entity index, and the full `/api/v5/knowledge` route set all exist and work — nothing ever populates them (`writeKnowledgeEntry` has zero callers). Per-agent memory has a working *read* path (fresh-context injection into every run) but no *write* path — memory is written by phase handlers *about* agents, never *by* agents, and there is no per-agent store. The lesson-attribution layer (schema, writers, aggregation) exists end-to-end and not one phase calls it. Failure classification exists in `child-verify` but is flattened to an error string before it reaches `ItemResult`. The dashboard receives less data than the cycle artifacts already contain.

Seven workstreams (W1–W7) close these loops. Each is sized to run as ONE epic objective via `agentforge cycle run --objective "..."` (the ready-to-paste objective is at the end of each workstream), or to be picked up directly in a Claude Code session. Suggested order: **W6 → W2 → W3 → W1 → W5 → W4 → W7** (visibility first so every later run is observable; memory before learning because learning writes into memory; recovery before scale because the DAG scheduler builds on the blocked/cascade status machinery).

---

## 1. Current-state findings (file:line evidence)

### 1.1 Knowledge
- LIVE but EMPTY: `packages/core/src/knowledge/knowledge-graph.ts` (entity+relationship CRUD over WorkspaceAdapter SQLite, optional vector index), `knowledge/persistence.ts` (append-only `.agentforge/knowledge/entities.jsonl`, hydration), `packages/embeddings/src/kg-entity-index.ts` (semantic `searchEntities()`), `packages/server/src/routes/v5/knowledge.ts` (GET/POST entities, graph, semantic query, relationships).
- GAP: `writeKnowledgeEntry` (persistence.ts:84-138) has **zero callers**. No phase populates the graph; no agent prompt ever includes KB content; no dashboard page renders it.

### 1.2 Per-agent memory
- READ path LIVE: `agent-runtime/fresh-context.ts:162-199` injects top-5 role-filtered entries from the **global** `.agentforge/memory/*.jsonl` pool into every run; `cc-prologue-builder.ts:125-171` prepends it (16K cap).
- WRITE path MISSING: five phase handlers write shared memory (review-phase-handler.ts:172, gate-phase.ts:753, learn-phase.ts:157, cycle-logger.ts:319, manual/invoke-service.ts:84) but **no agent run ever writes back**, and there is **no per-agent file** — an agent cannot see "what *I* did last time"; it sees a role-tag soup shared with every other agent.

### 1.3 Learning
- Lesson-attribution storage fully built (`memory/lesson-attribution.ts`: schema, lock-safe append, `aggregateLessonOutcomes`) — **never called** from execute/gate/test (the 2026-06-02 lesson-flywheel plan's Phase 0-C/D/E were never implemented).
- Curator (`team/engine/learnings/curator.ts`) scores by tag/severity/recency only; outcome-correlated weighting (boost lessons with ≥3 attributed passes) is specced, unimplemented.
- Skills flywheel (`skills/propose-from-learnings`) is manual-only; never invoked from the learn phase.
- Cost-estimation calibration is read-side only: observed actuals reach the planner prompt, but the static cost table (decompose-objective.ts, re-fit by hand 2026-06-06) never auto-recalibrates.

### 1.4 Concurrency
- `ConcurrencyGate` (runtime/concurrency-gate.ts:20-22): default 8, HARD_MAX 40, priority queue, 30-min stale release, **optional** memory floor (`AGENTFORGE_MIN_FREE_MEM_GB`, off by default).
- The real ceiling is the **wave barrier**: execute-phase.ts:1840/1908 — `Promise.allSettled` after every wave; wave N+1 waits for the *slowest* item of wave N. Predecessor edges are not checked at dispatch (wave grouping only).
- Rate limits: circuit breaker halves parallelism after 3 rate-limit failures (execute-phase.ts:1088-1143); provider auto-switch on classified-retriable errors (execution-service.ts:168-213); **no exponential backoff** before switching.
- Worktree GC exists (keep 20 / 24h / 5GB) but never triggers mid-phase on allocation pressure.

### 1.5 Recovery
- WORKING: per-item resume (checkpoint-execute.json), gate fix-up loop with exact `faultedItems` (cycle-runner.ts:423-512), provider failover, knownFlakyTestFiles exclusion.
- GAPS: `ChildVerifyFailure` has a 7-kind taxonomy (child-verify.ts:114-127) but `ItemResult` records only an error **string**; **no cascade** — dependents of a failed child still dispatch and fail noisily; **retry prompts contain no failure evidence** (buildItemPrompt rebuilds the original prompt); auto-recovery-agent is spec-only (2026-04-08); checkpoint resume has no corruption guard; per-child budget overrun is tracked but unenforced.

### 1.6 Dashboard
- Items tab (dashboard/src/routes/cycles/[id]/+page.svelte:55-66) renders id/title/status/assignee/cost only. The sprint endpoint (server cycles.ts:~1441) **does not expose `description`/`tags`/`files`** even though plan.json has them. Pending and running items are information-free.
- No per-item live progress: `sprint.phase.item.started` is emitted in core but the SSE watcher (cycles.ts:709-827) forwards **phase-level** events only; cost/duration are written **after** completion.
- Phase agents invisible in stats: execute-phase runs record sessions via runtime-session → adapter; plan/audit/review/gate/learn/epic-review agent runs are written to `phases/*.json` **only** — epic-planner, epic-review, and backlog-scorer never reach the sessions store the agents page aggregates.

### 1.7 Claude Code surface
- EXISTS: 16 root `commands/*.md`; `.claude-plugin/plugin.json` (minimal — no commands/mcpServers/skills fields); `plugins/agentforge-codex` (3 skills + `.mcp.json`, Codex-oriented); `packages/mcp-server` with 6 read-only tools (`af_agent_dispatch`, `af_kb_lookup`, `af_memory_query`, `af_codex_readiness`, `af_cycle_preview`, `af_cycle_status`); forge writes `.claude/agents/<id>.md` mirrors.
- GAPS: `af_cycle_preview` has no `objective` param (the new `previewObjective()` core API is unexposed); no invoke/approve/start tools; no live cycle events tool; plugin manifest doesn't register the MCP server or skills; no setup command to wire a target project.

---

## 2. Workstreams

### W1 — Knowledge Base: populate, retrieve, browse

**Goal:** the existing KB stack becomes a living, queryable project brain.

1. **Population (writers).**
   - Review phase: after each CRITICAL/MAJOR finding (review-phase-handler.ts:125), `writeKnowledgeEntry({ text, source:'review', tags:[severity, ...], cycleId })` and create a graph entity (kind `finding`) linked to a `file` entity per affected path.
   - Learn phase: each `learned-fact` also lands as a KB entity (kind `lesson`).
   - Forge: seed the graph from recon artifacts — `SubsystemsReport` → `subsystem` entities with `owns` edges to agents; `ConventionsReport` → `convention` entities. One-time `agentforge kb seed` CLI for existing workspaces.
   - Epic runs: decomposition rationale + epic outcome → `decision` entities.
2. **Retrieval (readers).**
   - Extend `buildFreshContextBlock` (fresh-context.ts) with a `KB:` section — top-3 semantic hits from `kg-entity-index.searchEntities(itemTitle + description)` when the embeddings index is available, keyword fallback otherwise. Budget: ≤1.5K chars inside the existing 16K prologue cap.
   - Epic planner prompt: inject top-5 KB hits for the objective (decompose-objective.ts `buildEpicPlannerPrompt`) — grounded planning gets project memory, not just tree exploration.
   - MCP: add `af_kb_search` (semantic, top-k) beside the existing `af_kb_lookup`.
3. **Browse:** dashboard `/knowledge` page — entity list with type filter, semantic search box (POST /knowledge/query), entity detail with relationships. Reuse v2 component atoms.
4. **Curation:** memory-curator agent gains a KB dedupe pass (same-text cosine ≥0.95 → merge), run during the learn phase.

**Acceptance:** after one cycle on a fresh workspace, `GET /api/v5/knowledge/graph` returns >0 entities from review+learn; a child agent's prologue contains a `KB:` block relevant to its item; `/knowledge` renders and searches; `agentforge kb seed` populates subsystems from the last scan.

**Objective string:**
> Make the knowledge base live end-to-end: wire writeKnowledgeEntry + graph entities into the review and learn phases and forge recon seeding; inject top-K semantic KB hits into agent fresh-context prologues and the epic planner prompt; add af_kb_search to the MCP server; build a /knowledge dashboard page (list, semantic search, entity detail); add a kb-dedupe curation pass. The KB stack (knowledge-graph.ts, persistence.ts, kg-entity-index.ts, /api/v5/knowledge routes) already exists — population, retrieval, and UI are the work. All tests mocked, no LLM.

### W2 — Per-agent memory that works

**Goal:** every agent accumulates and re-reads its own experience.

1. **Per-agent store:** `.agentforge/memory/agents/<agentId>.jsonl`, same lock-safe entry shape as the shared pool (`type`, `value`, `tags`, `cycleId`, `itemId`, `outcome`).
2. **Write paths (deterministic first — no LLM cost):**
   - Execute phase, per settled item (execute-phase.ts ~1598/1649 where checkpoints enqueue): append to the *assignee's* file a distilled record — item title, status, failureClass (W5), files touched, cost, one-line error excerpt on failure, "fixed by retry N" when a fix-up succeeds.
   - Agent-initiated capture: `agent-runtime.run()` gains opt-in `captureMemory` — on completion, a structured `LEARNED:` marker in the agent's output (prompted for in the prologue) is extracted and appended. No marker → no write.
3. **Read path:** `buildFreshContextBlock` reads the agent's own file FIRST (top-K=5 by recency + task-similarity when embeddings available), labelled `Your history:`, then falls back to the role-filtered shared pool (existing behavior, K reduced to 3). cc-prologue keeps the 16K cap.
4. **Hygiene:** per-agent file capped at 200 entries — memory-curator compacts (dedupe, drop superseded, decay >30-cycle-old entries) during the learn phase. Surface per-agent memory in the dashboard agent detail page (read-only list).

**Acceptance:** run two cycles where the same agent handles similar items — the second run's prologue contains the first run's outcome under `Your history:`; failed-then-fixed items produce a memory entry naming the fix; files stay ≤200 entries; agent detail page lists memory.

**Objective string:**
> Implement per-agent memory: a lock-safe .agentforge/memory/agents/<agentId>.jsonl store; deterministic write paths (execute-phase appends a distilled per-item outcome record to the assignee's file; agent-runtime extracts an optional LEARNED: marker on completion); read path where buildFreshContextBlock injects the agent's own top-5 history before the shared role-filtered pool; memory-curator compaction (cap 200, dedupe, decay) in the learn phase; agent detail page shows the memory. Reuse memory/types.ts entry shape and locking. All tests mocked, no LLM.

### W3 — Close the learning loops

**Goal:** lessons are tracked to outcomes, proven lessons persist, estimates self-calibrate.

1. **Lesson attribution (the unbuilt Phase 0):** execute-phase records which injected lessons each item ran with (`appliedLessons` from the fresh-context block IDs) → `appendLessonAttributions`; gate phase augments rows with `gateVerdict`; test phase with `verifyPassed`. (lesson-attribution.ts is ready; this is 3 call sites + threading lesson IDs through the prologue.)
2. **Outcome-correlated curation (Phase 1):** curator.ts calls `aggregateLessonOutcomes`; lessons with ≥3 passes and ≥0.6 confidence get durable slots inside the 8-lesson cap; chronically failing lessons are dropped with a tombstone in the KB (`lesson`, `status:retired`).
3. **Skill flywheel goes automatic (propose-only):** learn phase ends by invoking the propose-from-learnings clustering in-process; proposals land in `.agentforge/flywheel/proposals/` exactly as the CLI does today; approval remains human (dashboard /flywheel/proposals exists).
4. **Estimator self-calibration (the effort-estimation namesake):** learn phase computes per-complexity (low/med/high) medians from completed cycles' spend-reports and writes `.agentforge/config/cost-priors.json`; `buildBudgetPromptBlock` prefers these priors over the hard-coded table (observed-repo medians still ranked above both). Spend-report gains `estimateAccuracy` (planned/actual ratio per item) so drift is visible in the epic PR body.

**Acceptance:** after a cycle: attribution rows exist with verdicts; curator output shows durable-slot decisions; flywheel proposals appear without manual CLI; cost-priors.json exists and the next preview's planner prompt cites it; spend-report shows estimateAccuracy.

**Objective string:**
> Close the learning loops: wire appendLessonAttributions into execute (appliedLessons threading from fresh-context), gate (gateVerdict), and test (verifyPassed) phases; make curator.ts use aggregateLessonOutcomes for durable-slot lesson selection inside the 8-cap; auto-run the skills propose-from-learnings clustering at the end of the learn phase (propose-only); add estimator self-calibration — learn phase writes per-complexity cost-priors.json from spend-report actuals, buildBudgetPromptBlock prefers it over the static table, spend-report gains per-item estimateAccuracy. lesson-attribution.ts and the flywheel clustering already exist. All tests mocked, no LLM.

### W4 — Scale: DAG scheduling + adaptive governor

**Goal:** real parallelism beyond the wave barrier; safe at 16–40 agents.

1. **DAG dispatch with rolling merge (replaces the per-wave `allSettled` barrier):** an item becomes eligible when all predecessors are `completed` **and merged** to the integration branch. On each child completion: merge-under-lock to `codex/epic-<id>` immediately (the wave-integration merge code already exists — it runs per-completion instead of per-wave), then re-evaluate eligibility. FileLockManager still serializes overlapping files. Failed predecessors mark dependents `blocked` (W5). Waves remain as a *visualization* grouping only.
2. **Adaptive governor:** generalize the rate-limit circuit breaker into a governor that (a) halves parallelism on rate-limit/OOM signatures, (b) restores by +1 per N clean completions, (c) enforces the memory floor by default (`minFreeMemGb` on, derived from `testing.memory.reserveGb`), (d) adds a disk floor that triggers mid-phase worktree GC before halving.
3. **Backoff before failover:** execution-service waits 2s/4s/8s (jittered) on 429 before switching providers — keeps fable/opus capacity instead of cascading to fallbacks.
4. **Caps:** HARD_MAX_PARALLEL 40 → 64 (concurrency-gate.ts:21); default stays 8; document the hardware reality (≈2GB disk + 1GB verify-RAM per concurrent child — 40 agents wants 64GB RAM / 200GB+ free disk).
5. **Checkpoint integrity:** schema-validated, try/caught checkpoint reads on resume (corrupt → warn + fresh start, never crash).

**Acceptance:** a synthetic 20-item diamond-DAG plan executes with measured makespan strictly below the wave-barrier baseline (test with stub runtimes + fake timers); governor halves on injected 429 storms and restores after clean runs; mid-phase GC fires under a simulated disk floor; corrupt checkpoint resumes gracefully.

**Objective string:**
> Replace the execute-phase wave barrier with predecessor-driven DAG dispatch + rolling per-child merge to the epic integration branch (merge-under-lock on each completion; eligibility = all predecessors completed AND merged; FileLockManager unchanged; failed predecessors mark dependents blocked); generalize the rate-limit circuit breaker into an adaptive governor (halve on 429/OOM signatures, restore gradually, memory floor on by default, disk floor triggers mid-phase worktree GC); add jittered exponential backoff on 429 before provider failover; raise HARD_MAX_PARALLEL to 64; schema-validate checkpoint reads. Simulated/stubbed tests only — no LLM, fake timers for makespan assertions.

### W5 — Recovery: taxonomy, cascade, evidence-rich retries

**Goal:** failures are classified, contained, and retried with the evidence.

1. **Failure taxonomy on ItemResult:** `failureClass: 'deps' | 'typecheck' | 'tests' | 'scope' | 'iron-law' | 'provider' | 'timeout' | 'budget' | 'unknown'` derived from ChildVerifyFailure checks + transport error classes + timeout/budget detection. Persisted in execute.json, checkpoint, spend-report, and surfaced in the UI (W6) and per-agent memory (W2).
2. **Cascade/blocked:** item status gains `blocked`; when a child fails, transitively mark dependents blocked (reuse critical-path traversal); blocked items don't dispatch, don't count as failures, and re-enter via `--resume` or the gate fix-up exactly like failed ones (the #282 resume semantics extend to `blocked`).
3. **Evidence-rich retries:** on retry/fix-up, `buildItemPrompt` appends a `PRIOR ATTEMPT` block — failureClass, error excerpt (≤2K), files actually touched vs declared, verify output tail. Per-class policy: `deps`→re-provision then same prompt; `typecheck/tests`→evidence retry; `scope`→evidence retry plus a planner micro-repair of the declared file list (one cheap call, reusing the existing repair-prompt machinery); `provider/timeout`→retry after backoff, different provider; `budget`→quarantine (no auto-retry); flaky-test signature→add to knownFlakyTestFiles suggestion in the cycle report.
4. **Diagnostic branch on failure:** implement the configured-but-missing `includeDiagnosticBranchOnFailure` — push the failed child's worktree branch as `diagnostic/<cycleId>-<itemId>` so the operator can inspect what the agent actually did.

**Acceptance:** unit-simulated failures of each class produce the right `failureClass`, policy, and (for cascades) blocked dependents; retry prompts contain the PRIOR ATTEMPT block; a failed child leaves a diagnostic branch in a fixture repo; resume picks up blocked items.

**Objective string:**
> Implement structured failure recovery: add failureClass to ItemResult derived from ChildVerifyFailure + transport error classes + timeout/budget detection, persisted through execute.json/checkpoint/spend-report; add a blocked item status with transitive cascade when a predecessor fails (blocked items skip dispatch and re-enter via resume and gate fix-up); make retry/fix-up prompts include a PRIOR ATTEMPT evidence block (failure class, error excerpt, touched-vs-declared files, verify tail) with per-class recovery policies (deps re-provision, scope planner micro-repair via the existing repair prompt, provider backoff, budget quarantine); implement includeDiagnosticBranchOnFailure pushing failed worktree branches as diagnostic/<cycleId>-<itemId>. All tests simulated, no LLM.

### W6 — Operator visibility: instructions, live progress, complete stats

**Goal:** pending and running items are fully legible; every agent that spends money shows up in stats.

1. **Item instructions:** sprint endpoint (server cycles.ts:~1441) exposes `description`, `tags`, `files`, `source`, `wave`, `predecessors`; dashboard Items tab gets an item detail drawer — full instructions (description/acceptance criteria), declared files, assignee + ModelChip, wave/predecessors, and for failed items the failureClass + error. Pending items show queue position and what they're waiting on.
2. **Live progress:** core emits per-item lifecycle events to events.jsonl — `item.started {itemId, agentId, ts}`, `item.heartbeat {elapsedMs, costUsd?}` every ~5s while running (timer around `runtime.run`; cost included when stream usage events arrive), `item.completed/failed {durationMs, costUsd, failureClass}`. SSE watcher (cycles.ts:709) forwards `item.*` events; dashboard NOW EXECUTING becomes a per-item card grid (live elapsed, cost-so-far, last-event age) and the kanban shows a pulse + elapsed on running cards.
3. **Phase-agent stats:** `RuntimeAdapter.recordPhaseAgentRun(phase, agentId, costUsd, durationMs, status)` persisting to the same sessions store execute items use; called from plan (epic-planner), audit, review, gate, learn, epic-review, and the backlog-scorer path. Agents page then shows epic-planner/epic-review with runs+cost; cycle Agents tab gains a "phase agents" section.
4. **Preview surfacing:** `/cycles` page lists `.agentforge/previews/` artifacts (objective previews) with a link to a read-only preview detail (children/waves/band) — the $5 rehearsal becomes visible in the UI.

**Acceptance:** clicking a pending item shows its full instructions; a running item shows live elapsed + cost updating via SSE; after an epic cycle, epic-planner and epic-review appear in /agents stats with non-zero cost; preview artifacts render. svelte-check stays at 0 errors; Playwright e2e covers the drawer + live card.

**Objective string:**
> Upgrade cycle visibility: expose description/tags/files/wave/predecessors in the /api/v5/cycles/:id/sprint endpoint and add an item detail drawer to the cycle Items tab (instructions, declared files, assignee+model chip, failureClass on failure, queue/wait info on pending); emit per-item lifecycle events (item.started/heartbeat with elapsed+cost/item.completed) from execute-phase, forward item.* through the SSE watcher, render a live NOW EXECUTING card grid with elapsed and cost-so-far; add RuntimeAdapter.recordPhaseAgentRun and call it from plan/audit/review/gate/learn/epic-review and backlog-scorer so phase agents (epic-planner!) appear in agent stats; list .agentforge/previews artifacts on the cycles page. Tests: vitest for server+core, Playwright for drawer and live card. No LLM.

### W7 — First-class Claude Code integration

**Goal:** AgentForge is operable from inside any Claude Code session.

1. **MCP upgrades (packages/mcp-server):** `af_cycle_preview` gains `objective` + `budgetUsd` params calling the new `previewObjective()` (core export already exists); new tools — `af_agent_invoke` (single-agent dispatch with hard `budgetUsd` cap + allowed-tools allowlist), `af_cycle_approvals` / `af_cycle_approve` (wrap the v5 approval API), `af_cycle_events` (incremental tail of events.jsonl with cursor — Claude Code polls during long cycles), `af_kb_search` (W1), `af_memory_write` (guarded append to the calling project's shared memory).
2. **Plugin manifest:** flesh out `.claude-plugin/plugin.json` — register the MCP server (`node packages/mcp-server/dist/index.js`, project-root env), the slash commands (preview/status/forge/invoke as thin CLI wrappers), and Claude Code-format skills ported from the three codex skills (runtime, cycle ops, maintenance) plus a new `agentforge-operate` skill teaching budget discipline and the preview-before-run rule.
3. **`agentforge claude setup` CLI:** writes `.mcp.json` + plugin registration into a target project, verifies `.claude/agents/*.md` mirrors exist (re-emit from `.agentforge/agents/*.yaml` if missing), and maps tiers to model strings Claude Code accepts (fable → `claude-fable-5` in the agent frontmatter — verify the writer; tier names alone are not valid CC `model` values).
4. **Session workflow docs:** `docs/guides/claude-code-sessions.md` — forge from a session, preview an objective, launch/monitor/approve a cycle via MCP, dispatch a single forged agent, query KB/memory.

**Acceptance:** from a Claude Code session in a forged project: `af_cycle_preview {objective}` returns the children/waves/band JSON; `af_agent_invoke` runs a haiku-tier agent under a $1 cap; `af_cycle_events` tails a running cycle; `claude setup` makes a fresh clone session-ready; `.claude/agents/epic-planner.md` carries a model string Claude Code accepts.

**Objective string:**
> Make AgentForge first-class inside Claude Code sessions: extend the MCP server with objective-aware af_cycle_preview (call core previewObjective), af_agent_invoke (budget-capped, tool-allowlisted), af_cycle_approvals/af_cycle_approve, af_cycle_events (cursor-based events.jsonl tail), af_kb_search, af_memory_write; flesh out .claude-plugin/plugin.json registering the MCP server, slash commands, and Claude Code-format skills ported from the codex plugin; add an `agentforge claude setup` command that writes .mcp.json/plugin config and re-emits .claude/agents mirrors with valid model strings (fable → claude-fable-5); write docs/guides/claude-code-sessions.md. Tests mocked, no LLM.

---

## 3. Sequencing and budget

| Order | Workstream | Why this position | Size (epic budget) |
|---|---|---|---|
| 1 | **W6 visibility** | Every later run becomes observable; smallest blast radius (server+dashboard+3 core emit points) | ~$150 |
| 2 | **W2 agent memory** | W3 writes into it; deterministic, low risk | ~$150 |
| 3 | **W3 learning loops** | Depends on W2's prologue threading for appliedLessons | ~$150 |
| 4 | **W1 knowledge base** | Independent; retrieval reuses W2's fresh-context changes | ~$200 |
| 5 | **W5 recovery** | Introduces failureClass + blocked status that W4 dispatch consumes | ~$200 |
| 6 | **W4 DAG + governor** | Highest-risk execute-phase rewrite; do it with W5's machinery and W6's live progress already in place | ~$250 |
| 7 | **W7 Claude Code** | Exposes everything built above (KB search, events, preview) | ~$150 |

W6+W2 and W3+W1 pairs touch mostly disjoint files and can run as back-to-back epics in one sitting. W5 and W4 must be sequential (both rewrite execute-phase dispatch). Every objective string above is preview-ready: run `agentforge cycle preview --objective "<W-string>"` first (~$5) and inspect the band/DAG before committing a budget.

## 4. Risks / out of scope
- **W4 rolling merge** changes epic integration semantics — keep the wave-barrier path behind a config flag (`execute.scheduler: waves|dag`, default `waves`) for one release; the DAG path must prove itself on a real epic before becoming default.
- **Embeddings availability:** KB/memory semantic ranking degrades to keyword/recency when the embeddings model isn't present — every W1/W2 feature must work without it.
- **Not in scope:** cross-instance federation, the agent marketplace, canary deployments (parked v6 backlog), multi-epic queues, dashboard epic-DAG visualization (data lands in W6; the graph rendering can ride a later UI pass).
