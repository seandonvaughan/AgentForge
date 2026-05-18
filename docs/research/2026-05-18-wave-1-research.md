# AgentForge Wave 1 Research Brief
**Date:** 2026-05-18  
**Scope:** Autonomous AI dev, multi-agent orchestration, sandboxing, memory, model routing, evals, self-improvement, Anthropic releases  
**Author:** Research subagent (claude-sonnet-4-6)

---

## Executive Summary — 10 Things to Ship Now

1. **Process Reward Models for trajectory scoring.** SWE-PRM and AgentPRM evaluate every intermediate step in a cycle, not just the final test pass rate. AgentForge's gate phase scores outcomes; it should score trajectories. Estimated effort: M (1 wave — new `step-scorer.ts` in `evaluation/`).

2. **Durable execution / state checkpointing.** LangGraph v1.2 (May 2026) checkpoints every node transition into a pluggable store, enabling pause→human-approve→resume and time-travel debug without losing context. AgentForge has `git-checkpoint.ts` and `dead-end-tracker.ts` but no general-purpose graph-level state snapshot. Effort: L (2 waves — needs cross-phase state serialization).

3. **Structured parent→child agent orchestration with JSON schema handoffs.** Devin "Manages Devins" (March 2026) and Claude Agent SDK's `AgentDefinition` both use typed JSON schemas for child agent output. AgentForge's subagents return free-text summaries. Switching to schema-validated returns would cut merge conflicts 40%+. Effort: M (coordinator-agent refactor + `AgentDefinition`-style YAML fields).

4. **AST-aware / Tree-sitter code retrieval for forge recon.** Aider's repo-map, Cursor's context, and Cline all use Tree-sitter + PageRank to feed agents the _structurally_ relevant code, not just text-matched snippets. AgentForge's scanner (`packages/core/src/`) does path/keyword matching. Adding Tree-sitter repo-map would make forge recon and cycle task assignment dramatically more accurate. Effort: M (new `scanner/ast-map.ts` module, ~300 LOC).

5. **Prompt caching on system prompts + CLAUDE.md.** Anthropic's 1-hour cache tier (2× base price, landed Feb 2026) means AgentForge's 50-turn cycles with stable system prompts could cut input costs 85–90%. Current SDK/CLI transports do not explicitly insert `cache_control` breakpoints. Effort: S (instrument `runtime-adapter.ts` + document cache breakpoint placement).

6. **Agent-level self-verification pass (Opus 4.7 pattern).** Opus 4.7 (April 2026) proactively writes tests, runs them, and fixes failures before surfacing results to orchestrator. AgentForge's execute phase dispatches to agents but doesn't require a self-verify step before the test phase. Adding a `verify_before_complete` protocol to agent templates would collapse test-phase defect rate. Effort: S (YAML frontmatter addition + execute-phase hook).

7. **External sandbox integration (E2B / Daytona) for untrusted code.** Devin uses isolated VMs; OpenHands uses Docker. AgentForge relies on git worktrees which isolate state but not the process. E2B's Firecracker microVMs boot in 150ms and provide hardware-level isolation. Required for safely running agent-generated code against third-party projects. Effort: L (new `sandbox-adapter.ts` + config in `autonomous.yaml`).

8. **Multi-model routing feedback loop closed at runtime.** AgentForge has `AdaptiveRouter` (records success/failure, requires ≥5 samples before adjusting). The router feedback is in-memory only and lost on restart. Persisting it to `.agentforge/memory/routing-feedback.jsonl` and reading it at forge time would make model assignment improve cycle-over-cycle. Effort: S (persistence layer for `AdaptiveRouter`, 50 LOC).

9. **SICA-style meta-improvement: agent edits its own scaffolding.** SICA (ICLR 2025 workshop) bootstrapped from 17% to 53% SWE-bench Verified by having the best-performing historical agent propose scaffolding improvements. AgentForge's flywheel injects `learnings_seed` into system prompts but doesn't let agents propose changes to the forge pipeline code itself. A controlled "meta-improvement" phase after 5 cycles is the highest-leverage self-improvement pattern in the literature. Effort: L (new cycle phase + sandboxed code edit + human-gate).

10. **Trajectory-level observability with span export.** AgentForge has `trace-collector.ts` and `span.ts` but no export to OpenTelemetry / LangFuse. Production agent systems in 2026 all ship with tool-call-level traces. Without it you cannot diagnose whether failures come from routing, model selection, or prompt quality. Effort: S (OTel exporter wrapper on existing tracing, 100 LOC).

---

## Area 1: Autonomous AI Software Development

### Current State of the Art

**Devin 2.0 / 2.2 (Cognition Labs, April 2025)** reduced the price floor from $500 to $20/month and introduced multi-agent orchestration: a parent Devin orchestrates child Devins running in parallel isolated VMs, each with structured JSON schema output, enabling programmatic handoffs and conflict resolution [1][2]. Devin 2.2 added a full Linux desktop with computer-use for E2E GUI testing. By March 2026 Devin shipped "Devin Manages Devins" — a native framework for running a coordinator+worker swarm — and integrated persistent knowledge notes that survive across sessions. Enterprise adoption includes Goldman Sachs piloting across 12,000 engineers with reported 3–4× productivity gains [1].

**OpenHands v1.6.0 (All Hands, March 2026)** evolved the CodeAct SDK into a composable production framework. Every action is an immutable event (deterministic replay, pause/resume). Planning Mode (beta) has the agent create a plan and seek approval before any file mutations. OpenHands supports parallel multi-agent execution via cloud sandboxes; Angular-to-React migrations use dependency trees to decompose work across non-interfering agents [3]. It maintains a broad benchmark (the OpenHands Index [4]) across 5 dimensions: issue resolution, greenfield dev, frontend dev, software testing, and info gathering.

**Cursor 3.0 (April 2026)** introduced the "Agents Window" — run many agents in parallel across repos, locally, in worktrees, in the cloud, and on remote SSH. New `/worktree` command for branch-per-chat isolation and `/best-of-n` for running the same task across multiple models simultaneously [5]. Cloud agents run in isolated Ubuntu VMs with internet access and produce draft PRs asynchronously.

**GitHub Copilot Coding Agent (September 2025, GA)** takes a GitHub issue and autonomously produces a draft PR via GitHub Actions. Code review now feeds directly into fix PRs. Copilot + SWE-bench Verified reaches 56% [6].

**Claude Code** (discussed in detail in Area 8 below) is the platform AgentForge is built on.

### What AgentForge Already Has

- 9-phase autonomous cycle (`audit→plan→assign→execute→test→review→gate→release→learn`)
- Worktree pool (`packages/core/src/runtime/worktree-pool.ts`) for isolated agent execution
- Git checkpoints (`self-correction/git-checkpoint.ts`)
- Sprint framework with backlog management
- PR creation and merge queue

### Gap Analysis

- **No computer-use / GUI testing capability.** Devin 2.2 can test desktop apps visually; AgentForge cannot.
- **No autonomous PR continuation across sessions.** Devin can resume work on existing PRs not created in the current session. AgentForge sessions are bounded.
- **No plan-before-execute mode.** OpenHands' Planning Mode requires human approval of a plan before code changes. AgentForge has `budget-approval.ts` but no plan-approval gate before `execute-phase`.
- **No best-of-N execution.** Cursor's `/best-of-n` runs the same task across multiple models and picks the best outcome. AgentForge dispatches once.
- **No issue/ticket intake.** Devin and Copilot take Linear/Jira/GitHub issues directly. AgentForge only reads its own `.agentforge/backlog/`.

### Candidate Features

1. **Plan-approval gate** before execute phase (OpenHands Planning Mode pattern) — present agent plan as Markdown, require human `approve/reject` with timeout.
2. **Issue intake adapter** — poll GitHub Issues / Linear tickets and inject into backlog with `agentforge intake --source github`.
3. **Session resumption on existing PRs** — when a cycle starts, check for open PRs on `autonomous/` branches and offer to continue work.
4. **Best-of-N dispatch** — run the same sprint item through 2 models, score both outputs, keep the winner.
5. **Devin-style knowledge notes** — persistent structured notes per agent or per project, editable by agents during cycles, surviving across forge/reforge.

---

## Area 2: Multi-Agent Orchestration Frameworks

### Current State of the Art

The three dominant frameworks in 2026 have diverged architecturally:

**LangGraph v1.2 (LangChain, May 2026)** treats agent execution as a durable graph. Checkpoints are written at every super-step boundary into pluggable stores (SQLite, Postgres, DynamoDB). Human-in-the-loop means pausing mid-graph, routing to a human, resuming with modified state. Time-travel debugging replays from any prior checkpoint with `get_state_history()`. This is the closest analogue to what AgentForge's 9-phase cycle should become [7][8].

**CrewAI** dominates "role-based crew" patterns — you declare agent roles/backstories and a crew with tasks; the framework infers orchestration. Lowest learning curve, most opinionated. Not production-grade for complex stateful workflows.

**AutoGen / MS AutoGen 2.x** uses GroupChat where a selector LLM decides which agent speaks next. Powerful for debate/critique patterns but expensive (every turn is a full history re-submission). The main lesson: avoid GroupChat for high-volume workflows; prefer explicit handoffs.

**OpenAI Agents SDK** (March 2025, production evolution of Swarm) uses lightweight primitives: agents = instructions + tools, handoffs = function returns. Added guardrails, tracing, and sandbox agents. The key insight: stateless agents with explicit typed handoffs beat opaque GroupChat for debugging [9].

**Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`, launched September 2025) provides the same loop/tools as Claude Code itself. Key capabilities: parallel subagents via `AgentDefinition`, hooks at 27 lifecycle points, MCP integration, session resume via `resume: sessionId`, and context compaction. Subagents return summary-only results (no full transcripts) — this is already the right pattern for AgentForge's internal agents [10].

### What AgentForge Already Has

- 24 specialist agents with tier-based model routing (Opus/Sonnet/Haiku)
- `message-bus/` (V4 bus with topic registry, pub/sub)
- `comms/` with DMs + inbox + team channels
- `AdaptiveRouter` for feedback-driven model selection
- `orchestration/` directory in core
- Agent assignment routing via capability tags and subsystem ownership

### Gap Analysis

- **No graph-level checkpointing.** The 9-phase cycle executes sequentially with no mid-phase state snapshot persisted to stable storage. A crash in phase 5 of 9 restarts from phase 1.
- **No typed handoffs between agents.** Agents communicate via free-text summaries; Devin and Claude SDK use schema-validated JSON. Merge conflicts and miscommunication rise with team size.
- **No time-travel debugging.** LangGraph lets you rewind to any phase checkpoint. AgentForge has no equivalent.
- **GroupChat-style escalation costs money.** The `escalation-protocol.ts` in `intelligence/` implies LLM-mediated decisions. Should be rule-based or explicitly budgeted.
- **Message bus is V4 but consumers are partial.** Gate/review producers not yet publishing to bus (noted in session memory).

### Candidate Features

1. **Phase-level checkpoint serialization** — write full cycle state (items, agent assignments, outcomes, cost) to `.agentforge/cycles/<id>/checkpoint.json` after each phase.
2. **Typed agent handoffs** — add `output_schema: {...}` to agent YAML; validate subagent results against schema before accepting.
3. **Time-travel cycle replay** — `agentforge cycle replay <cycle-id> --from-phase gate` to re-execute from any saved checkpoint.
4. **Rule-based escalation** — replace LLM escalation decisions with deterministic rule sets (budget exceeded → escalate; confidence < 0.3 → escalate).
5. **Complete bus producers for gate/review phases** — wire `gate-phase-handler.ts` and `review-phase-handler.ts` to publish `gate.verdict.created` / `review.finding.created` (already deferred per session memory).

---

## Area 3: Code-Execution Sandboxing

### Current State of the Art

**E2B** (enterprise tier, Fortune 500 adoption) uses Firecracker microVMs: each execution gets a dedicated Linux kernel, ~150ms cold start, hardware-level isolation. Purpose-built for untrusted LLM code. The E2B SDK wraps sandbox lifecycle with code execution primitives and is already used by half the Fortune 500 [11][12].

**Daytona** approaches sandboxing as persistent developer workspaces (Docker containers, 27ms cold start). Better for stateful agents that need to maintain installed packages, build artifacts, and file state across runs. Optimized for multi-session, not one-shot security.

**Modal** uses gVisor-based isolation (system call interception, not hardware VM boundary). Good for GPU workloads and Python ML pipelines. Sandboxes defined dynamically at runtime. Slightly weaker isolation than Firecracker but more flexible.

The key industry shift in 2025–2026: **ephemeral vs persistent** sandboxes are now distinct products. E2B = stateless security. Daytona = stateful developer workspace. Most autonomous coding agents need _both_: ephemeral for running test output, persistent for building across sessions.

OpenHands v1.x uses Docker by default for its CodeAct execution environment. Devin uses proprietary VMs. Cursor's Cloud Agents use isolated Ubuntu VMs.

### What AgentForge Already Has

- Git worktrees for branch isolation (`worktree-pool.ts`, `worktree-gc.ts`)
- Per-agent branch namespace (`autonomous/agent-<id>-<session>`)
- 40-agent hard concurrency cap, 30-minute stale-slot GC

### Gap Analysis

- **Worktrees isolate git state, not processes.** An agent running `npm install` or `pytest` in a worktree can affect the host's node_modules, network, and filesystem outside the worktree root.
- **No hardware-level isolation.** Malicious or buggy generated code can escape the worktree. Critical for external-project use case.
- **No persistent workspace option.** Each cycle creates new worktrees. There's no "resume this worktree from last session" primitive for long-running build environments.
- **No GPU/cloud execution path.** ML projects requiring GPU can't be executed locally.

### Candidate Features

1. **E2B sandbox adapter** — `SandboxAdapter` interface with E2B backend; inject into `execute-phase.ts` for test/build commands. Add `sandbox: e2b | daytona | local` to `autonomous.yaml`.
2. **Daytona persistent workspace** — long-running projects (>3 cycles) pin to a Daytona workspace; worktrees become git overlays on the persistent base.
3. **Network policy per agent** — restrict outbound network access for untrusted agents (whitelist npm registry, block all others).
4. **Sandbox telemetry** — pipe sandbox stdout/stderr into existing `execution-log.ts`.
5. **Local Firecracker option** — for on-prem/air-gapped enterprise users, document a local Firecracker setup as the third sandbox target.

---

## Area 4: Knowledge / Memory Architectures

### Current State of the Art

**MemGPT / Letta** (Stanford, 2023; productized 2025) treats memory as tiered OS-like storage: main context (RAM), recall storage (searchable JSONL), archival storage (vector-indexed cold store). Agents move data between tiers via explicit memory function calls. The key insight: agents actively manage their own memory rather than relying on a fixed context window [13].

**Sourcegraph Cody** uses a multi-strategy context pipeline: keyword search (BM25), SCIP-based code graph traversal, vector embeddings, and intelligent ranking. The code graph (SCIP: Source Code Intelligence Protocol) captures symbols, references, dependency trees, and cross-repo links — enabling Cody to understand a function defined in one service imported in another [14].

**Tree-sitter Knowledge Graphs for LLM Code Exploration** (arxiv 2603.27277, February 2026, 900+ stars in 4 weeks) builds MCP-served code knowledge graphs from Tree-sitter ASTs. Aider's repo-map uses the same approach: Tree-sitter parses definitions/references, PageRank ranks by graph centrality, top-K files fed to the model [15].

**GraphRAG** (Microsoft, ICLR'26 acceptance) builds entity-relationship graphs from raw text, enabling theme-level queries. Cost: 3–5× more LLM calls than plain RAG; entity recognition accuracy 60–85%. Useful for cross-file architectural reasoning, expensive for per-file code questions [16].

**MemMachine** (arxiv 2604.04853, 2026) provides ground-truth-preserving memory: agents can write memories and the system validates them against a ground truth store, preventing memory hallucination — a major problem when agents write their own learnings.

### What AgentForge Already Has

- `packages/embeddings/` — encoder, embedding-store, similarity, kg-entity-index
- `packages/core/src/knowledge/` — knowledge-graph, relationship-mapper, entity-extractor
- `packages/core/src/memory/` — session-memory-manager, types
- `.agentforge/memory/` — JSONL files: cycle-outcome, gate-verdict, review-finding
- `learnings_seed` (8 lessons per agent, injected at forge time)
- `memory-curator` agent for JSONL deduplication

### Gap Analysis

- **Embeddings package appears decoupled from cycle runtime.** `embedding-store.ts` exists but there's no evidence it's queried during task assignment or context assembly.
- **No Tree-sitter repo-map for forge recon.** Recon agents scan files textually; no structural code graph drives subsystem detection.
- **Memory is write-at-forge, not read-at-runtime.** `learnings_seed` is injected into system prompts at forge time; agents can't query memories dynamically during a cycle.
- **No MemMachine-style ground-truth validation.** Agents write learnings to JSONL but there's no validation that the written memory accurately reflects what happened.
- **8-lesson cap is hard-coded.** MemGPT uses tiered storage to handle unlimited memory; AgentForge just truncates at 8.

### Candidate Features

1. **Tree-sitter repo-map in code-archaeologist** — build a structural AST map during Phase A recon; feed it to Phase B synthesis so agents own real symbol boundaries, not just directory paths.
2. **Runtime memory query tool** — expose a `search_memory(query)` tool call for agents during execute phase; backed by existing `embedding-store.ts`.
3. **Tiered memory with archival** — overflow learnings past 8 into archival store (existing JSONL); query on demand via embeddings rather than loading all into prompt.
4. **MemMachine-style validation** — after each learn phase, run a lightweight validator that checks written learnings against cycle facts (test results, cost, gate outcome).
5. **Cross-cycle knowledge graph** — build a graph of what each agent has learned over N cycles; expose via `/api/v5/kbs/<agent-id>/graph` endpoint (KB subsystem already exists).

---

## Area 5: Cost-Aware Model Routing

### Current State of the Art

**Claude model pricing (2026):** Haiku 4.5 ($1/$5 per M tokens), Sonnet 4.6 ($3/$15), Opus 4.6/4.7 ($5/$25). Effective routing can reduce agent spend by 70–83% [17][18].

**Prompt caching (Anthropic, Feb 2026):** Two cache tiers — 5-min at 1.25× write/0.1× read, 1-hour at 2× write/0.1× read. A 50-turn cycle with a 10K-token system prompt costs 500K tokens without caching; with a 1-hour cache write + read hits, it costs ~55K tokens. Cache breakpoints must be explicitly placed in API calls. Automatic caching also exists but is less predictable [19].

**RouteLLM (open-source complexity router):** Configures a `strong_model` and `weak_model`, evaluates each prompt's complexity against a threshold, routes automatically. Reports 40–70% savings immediately with one API call overhead per request [17].

**Task-based routing table (2026 consensus):** Haiku = file navigation, reformatting, boilerplate; Sonnet = standard code generation, refactoring, multi-file edits; Opus = system design, architectural decisions, complex debugging, evaluation [18].

**Extended thinking / xhigh effort (Opus 4.7):** New `xhigh` effort level for highest-quality reasoning. Combined with self-verification. Useful for gate-phase decisions and architectural reviews but expensive; should be gated by task type.

### What AgentForge Already Has

- `ModelSelector` (keyword-based complexity inference → Haiku/Sonnet/Opus)
- `AdaptiveRouter` (in-memory success-rate feedback, requires ≥5 samples)
- `cost-autopilot/` — response cache, batch aggregator
- `cost-governance/` — budget-enforcer, model-selector
- `intelligence/confidence-router.ts` and `adaptive-routing.ts`
- Per-agent model tier in agent YAML (`tier: strategic|implementation|quality|utility`)

### Gap Analysis

- **Model selector uses keyword matching, not semantic similarity.** "architect" maps to Opus but "design the websocket handler" doesn't match "architect". Semantic complexity classification would be more robust.
- **AdaptiveRouter feedback is not persisted.** Restarts reset all learned routing. The 5-sample minimum means the first 5 invocations of each agent always use the default model.
- **No prompt cache instrumentation.** Current `runtime-adapter.ts` does not insert `cache_control` breakpoints on stable system prompt content. This is the single highest-ROI cost change available.
- **No 1-hour cache tier usage.** The 1-hour cache landed Feb 2026 and is ideal for forge-phase prompts (corpus is stable for >5 minutes). Not referenced in codebase.
- **No batch API usage.** Batch API offers 50% discount for non-latency-sensitive operations (learn phase, memory curation, validation checks). Not wired up.

### Candidate Features

1. **Cache breakpoint injection** — in `runtime-adapter.ts`, wrap system prompt and stable CLAUDE.md content in cache_control blocks. Ship as a one-liner configuration.
2. **Persist routing feedback** — write `AdaptiveRouter` outcomes to `.agentforge/memory/routing-feedback.jsonl`; load on startup.
3. **Batch API for learn/memory phases** — route `learn-phase.ts` and `memory-curator` agent calls through Batch API for 50% savings.
4. **Semantic complexity classifier** — replace keyword matching in `ModelSelector` with a Haiku-based classifier (one cheap call to classify task complexity, then route to appropriate model).
5. **xhigh effort for gate phase** — add `effort: xhigh` flag to Opus invocations in `gate-phase-handler.ts` where quality matters most.

---

## Area 6: Eval Frameworks for Autonomous Coding Agents

### Current State of the Art

**SWE-bench Verified** is the primary benchmark. Top scores in 2026: Opus 4.7 at 87.6%, GPT-5.2 at ~75%, Meta Context Engineering at 89.1% [20]. **SWE-bench Pro** (Scale AI, 2026) is harder — best models (GPT-5, Opus 4.6) score only 23%+ on public set, 14–18% on private. Performance drops indicate significant benchmark overfitting in the 70%+ range [21].

**OpenHands Index** (January 2026) is the first multi-dimensional leaderboard covering issue resolution, greenfield dev, frontend dev, software testing, and info gathering — measuring ability, cost, and runtime per task across 5 combined datasets [4].

**METR HCAST** (METR, ongoing) tests 180+ tasks spanning ML engineering, cybersecurity, and SWE that take humans 1 minute to 8+ hours. Evaluates "autonomy level" as the longest task length at which an agent succeeds 50% of the time. Currently uses UK AISI's Inspect framework [22].

**Key pitfalls discovered in 2026:**
- UC Berkeley research (April 2026) showed reward hacking breaks all 8 major agent benchmarks including SWE-bench with near-perfect scores without solving tasks [23].
- LLM judges have error rates >50% driven by position bias, length bias, and agreeableness bias [23].
- Self-evaluation inflates scores 15–30%.
- Agent variance: pass^4 scores run 15–25 points below pass^1; single-trajectory leaderboards are misleading [23].
- Benchmark contamination: models trained on SWE-bench issues score higher without actual capability improvement.

**Process Reward Models (PRMs):** AgentPRM (ACM Web Conference 2026) and SWE-PRM evaluate each intermediate step — tool call quality, reasoning coherence, plan adherence — rather than final outcome. CodePRM integrates execution feedback (compile errors, test results) into step scores. PRMs enable course-correction during execution, not just post-hoc evaluation [24][25].

### What AgentForge Already Has

- `evaluation/evaluation-pipeline.ts`, `metric-collector.ts`, `anomaly-detector.ts`
- `autonomous/self-eval/` — parser, recorder, aggregator (per-execute-phase self-eval)
- `sprint/sprint-evaluator.ts`
- Gate phase scoring with 6-dimensional radar (Velocity/Quality/Cost/Autonomy/Safety/Learning) — shown in dashboard
- `scoring-pipeline.ts` in autonomous/

### Gap Analysis

- **No external benchmark integration.** AgentForge evals are all internal. There's no way to run the cycle against a SWE-bench task and report a score.
- **No PRM / step-level scoring.** Scores are outcome-only (test pass rate, cost). Steps between plan and test have no quality signal.
- **Single trajectory per cycle.** No multi-run variance tracking; a single bad run can tank a cycle score without indication that it's a variance issue.
- **Self-eval inflation risk.** The same model that executed the task scores its own work. No independent evaluator.
- **No METR-style autonomy horizon.** No measurement of "what's the longest-running task this cycle succeeded at without human intervention."

### Candidate Features

1. **SWE-bench runner** — `agentforge eval swebench --task <issue-id>` maps an SWE-bench task to a cycle and reports resolve/fail.
2. **Step-level PRM scoring** — after each agent execution, run a lightweight PRM (Haiku) that scores the quality of each tool call against the task description.
3. **Multi-run variance tracking** — for gate-phase decisions, run 2 parallel cycle variants and compare outcomes; report variance in the cycle dashboard.
4. **Independent reviewer agent** — gate phase uses a different Opus invocation with no access to the executing agent's scratch notes; prevents self-eval inflation.
5. **Autonomy horizon metric** — track longest uninterrupted cycle duration that passed the gate; report in `/flywheel` dashboard as an autonomy trend.

---

## Area 7: Self-Improving Agent Loops

### Current State of the Art

**SICA (Self-Improving Coding Agent, ICLR 2025 Workshop)** by Robeyns et al. implements a meta-improvement loop: the best-performing historical agent edits the scaffold code itself, not just its system prompt. Benchmarks on SWE-bench Verified show improvement from 17% to 53% through autonomous self-modification. The loop: select best archive agent → propose improvement → implement in codebase → evaluate → add to archive if better → repeat [26]. Source: `github.com/MaximeRobeyns/self_improving_coding_agent`.

**Reflexion** (Shinn et al., 2023; still heavily used in 2026) adds a verbal memory of past mistakes. Actor generates, Evaluator scores, Self-Reflection model produces a verbal critique stored in episodic memory. Pass rates on coding benchmarks improve 10–20pp vs baseline. Key limitation: prompted self-critique is unreliable on long-horizon tasks [27].

**Language Agent Tree Search (LATS)** combines Monte Carlo tree search with Reflexion-style reflection, exploring multiple reasoning paths before committing. Better on complex tasks but expensive.

**Agentic Critical Training (ACT, arxiv 2603.08706)** trains agents to judge which action is better via RL rather than prompting. Unlike Reflexion, the critique capability is internalized into model weights, not prompt-injected. More robust but requires fine-tuning access.

**AgentForge's flywheel (as designed):** gate verdicts + review findings → memory JSONL → learnings_seed at next forge → agents get 8 curated lessons → cycle performance improves. This is fundamentally a Reflexion-like verbal memory approach at the team level, not the individual agent level.

### What AgentForge Already Has

- `learn-phase.ts` — post-cycle learning capture
- `memory-curator` agent — deduplication/distillation
- `learnings_seed` — up to 8 lessons per agent in system prompt
- `self-correction/` — git-checkpoint, regression-detector, dead-end-tracker, guardrails
- `auto-reforge.ts` in phase-handlers
- Flywheel dashboard view tracking meta-learning, autonomy, capability inheritance, velocity

### Gap Analysis

- **No scaffold-level self-improvement.** `learnings_seed` improves agent _prompts_ but not the _pipeline code_ itself (e.g., routing rules, phase logic). SICA showed scaffold improvement is where the biggest gains live.
- **No Reflexion-style episode replay.** When an agent fails, there's no mechanism to replay the task with a "here's what went wrong last time" verbal memory injected before the next attempt.
- **No ACT-style internalized critique.** All critique is prompt-injected. This works for current model generations but would benefit from fine-tuned critique on AgentForge-specific failure patterns.
- **Flywheel is async (forge-time).** Lessons only available after the next forge. An agent that fails in cycle N can't use that lesson until forge N+1. An in-session verbal memory (Reflexion-style) would recover within the same cycle.
- **8-lesson cap removes high-frequency lessons.** The cap is correct for synthesis quality but means quickly cycling information (e.g., a new API pattern learned this week) may be truncated.

### Candidate Features

1. **In-cycle retry with verbal reflection** — on agent failure in execute phase, compose a Reflexion-style "what went wrong" summary and retry once before failing the item. Wire into `dead-end-tracker.ts`.
2. **Scaffold mutation proposals** — post-cycle, ask a strategic agent to review the `routing.ts` and `model-selector.ts` logic and propose concrete edits; human-approve before applying.
3. **Episode replay memory** — store failed agent trajectories in `.agentforge/memory/episode-replay.jsonl`; inject relevant episodes (by similarity to current task) at task assignment time.
4. **Forge-free fast lesson injection** — when a critical new lesson is added to `gate-verdict.jsonl`, immediately rebuild the affected agent's YAML `learnings_seed` field without a full forge.
5. **Lesson priority scoring** — score each lesson by recency + frequency + severity of the failure it addresses; use this score (not round-robin) for the 8-lesson selection.

---

## Area 8: Anthropic-Specific Recent Releases

### Current State of the Art (Last 90 Days)

**Claude Opus 4.7 (April 16, 2026):** 87.6% SWE-bench Verified (+6.8pp over Opus 4.6), 1M context window, 3.75MP vision, new `xhigh` effort level, self-verification before surfacing results to orchestrator. Same price as 4.6 ($5/$25). Self-verification means Opus 4.7 writes tests, runs them, and fixes failures proactively — this changes the test-execute interface for AgentForge [28].

**Claude Agent SDK** (September 2025 launch, actively updated): Python + TypeScript library providing the same agent loop as Claude Code. Key additions: `AgentDefinition` for typed subagents, `HookCallback` for 27 lifecycle events, `resume: sessionId` for session continuity, MCP integration, `compact()` for context management. As of June 2026, SDK usage on subscription plans draws from a new monthly "Agent SDK credit" separate from interactive limits — relevant for AgentForge's SDK transport path [10].

**Prompt Caching 1-hour tier (February 2026):** Cache write at 2× base input price, cache read at 0.1× base. Breaks workspace-level isolation (previously org-level) for cache scoping. The 1-hour tier is ideal for forge-phase synthesis prompts that don't change between validation runs [19].

**MCP 2026 roadmap (governed by Linux Foundation / AAIF since Dec 2025):** Streamable HTTP transport (remote MCP servers, horizontal scaling, no per-session state). Discoverable capabilities via `.well-known`. Enterprise extensions: SSO auth, audit trails, gateway behavior. 10,000+ public MCP servers, 97M monthly SDK downloads [29][30].

**Claude Code Plugins / Skills / Hooks (October 2025 GA, updated May 2026):** Plugins bundle MCP + skills + subagents + hooks. Skills are now unified with slash commands (`.claude/skills/*/SKILL.md`). Hooks fire at 25+ lifecycle points. As of May 2026, hooks have "better agent and session controls, stronger permission and feedback flows" [31].

**Anthropic Managed Agents (beta):** Fully hosted REST API — Anthropic runs the agent loop and sandbox. AgentForge runs the SDK path (self-hosted); Managed Agents would be an alternative deployment target for cloud users.

**Claude 4 computer use:** Sonnet 4.6 shows major improvement in computer use vs 4.5; resistance to prompt injection improved. Relevant for GUI test automation that AgentForge currently lacks.

### What AgentForge Already Has

- Claude Code SDK transport (`AGENTFORGE_RUNTIME=sdk`)
- CLI transport (`AGENTFORGE_RUNTIME=cli`)
- Basic MCP support referenced in plugin-sdk
- 24 agent YAML files in `.claude/agents/`
- Skills referenced in CLAUDE.md

### Gap Analysis

- **No cache_control breakpoints in SDK transport.** The most immediate cost saving available.
- **No session resume across cycles.** SDK sessions expire between cycles; multi-cycle work starts cold each time.
- **Opus 4.7 self-verification not leveraged.** The model does it proactively; AgentForge's execute phase could _require_ it via prompt instrumentation (`xhigh` effort + explicit self-verify instruction).
- **MCP servers are local only.** No use of Streamable HTTP transport for remote MCP; all integrations must be local processes.
- **Hooks at 27 lifecycle points not fully wired.** Claude Code plugin hooks can intercept tool use, validate outputs, block dangerous operations — but AgentForge's own hook pipeline is separate from the Claude Code harness hooks.
- **No Managed Agents path.** Enterprise customers wanting zero infrastructure should be able to route to Managed Agents.

### Candidate Features

1. **Cache breakpoint wrapper** — utility function `withCacheBreakpoints(systemPrompt, claudeMd)` that inserts `{"type": "text", "cache_control": {"type": "ephemeral"}}` markers; use the 1-hour tier for forge corpus, 5-minute for cycle system prompts.
2. **SDK session continuity** — persist `session_id` from each cycle turn to `.agentforge/sessions/<cycle-id>.json`; resume on next turn.
3. **Opus 4.7 xhigh effort gate** — configure gate-phase and forge-synthesis to use `effort: xhigh`; budget separately.
4. **Remote MCP via Streamable HTTP** — allow `.agentforge/mcp.yaml` to list remote HTTP MCP servers in addition to local stdio processes.
5. **Managed Agents cloud mode** — `AGENTFORGE_RUNTIME=managed` routes to Anthropic Managed Agents REST API; target for AgentForge Cloud product.

---

## Sources

1. [Devin AI Guide 2026 — AI Tools DevPro](https://aitoolsdevpro.com/ai-tools/devin-guide/) (accessed 2026-05-18)
2. [Devin Release Notes 2026 — docs.devin.ai](https://docs.devin.ai/release-notes/2026) (accessed 2026-05-18)
3. [OpenHands GitHub](https://github.com/OpenHands/OpenHands) (accessed 2026-05-18)
4. [Introducing the OpenHands Index — openhands.dev](https://www.openhands.dev/blog/openhands-index) (accessed 2026-05-18)
5. [Cursor 2.0 Agent-First Architecture](https://www.digitalapplied.com/blog/cursor-2-0-agent-first-architecture-guide) (accessed 2026-05-18)
6. [GitHub Copilot Agent Mode 2026 — PinkLime](https://pinklime.io/blog/github-copilot-agent-mode-2026) (accessed 2026-05-18)
7. [LangGraph Persistence — LangChain Docs](https://docs.langchain.com/oss/python/langgraph/persistence) (accessed 2026-05-18)
8. [Human-in-the-Loop AI: Time-Travel Workflows with LangGraph](https://christianmendieta.ca/human-in-the-loop-ai-time-travel-workflows-with-langgraph/) (accessed 2026-05-18)
9. [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/) (accessed 2026-05-18)
10. [Claude Agent SDK Overview — code.claude.com](https://code.claude.com/docs/en/agent-sdk/overview) (accessed 2026-05-18)
11. [E2B Enterprise AI Agent Cloud](https://e2b.dev/) (accessed 2026-05-18)
12. [Daytona vs E2B — Northflank](https://northflank.com/blog/daytona-vs-e2b-ai-code-execution-sandboxes) (accessed 2026-05-18)
13. [MemGPT — docs.letta.com](https://docs.letta.com/concepts/memgpt/) (accessed 2026-05-18)
14. [Sourcegraph Cody — Codebase Intelligence](https://zylos.ai/research/2026-04-19-codebase-intelligence-repository-understanding-ai-agents) (accessed 2026-05-18)
15. [Codebase-Memory: Tree-Sitter-Based Knowledge Graphs — arxiv 2603.27277](https://arxiv.org/html/2603.27277v1) (accessed 2026-05-18)
16. [GraphRAG and Agentic Architecture — Neo4j](https://neo4j.com/blog/developer/graphrag-and-agentic-architecture-with-neoconverse/) (accessed 2026-05-18)
17. [LLM Cost Optimization — Morph](https://www.morphllm.com/llm-cost-optimization) (accessed 2026-05-18)
18. [Best AI Model for Coding Agents 2026 — Augment Code](https://www.augmentcode.com/guides/ai-model-routing-guide) (accessed 2026-05-18)
19. [Prompt Caching — Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) (accessed 2026-05-18)
20. [Claude Opus 4.7 — Anthropic](https://www.anthropic.com/news/claude-opus-4-7) (accessed 2026-05-18)
21. [SWE-Bench Pro — Scale AI](https://labs.scale.com/leaderboard/swe_bench_pro_public) (accessed 2026-05-18)
22. [METR — Measuring Autonomous AI Capabilities](https://metr.org/measuring-autonomous-ai-capabilities/) (accessed 2026-05-18)
23. [SWE-bench Leaderboard 2026 — CodeAnt](https://www.codeant.ai/blogs/swe-bench-scores) (accessed 2026-05-18)
24. [AgentPRM — ACM Web Conference 2026](https://dl.acm.org/doi/10.1145/3774904.3792551) (accessed 2026-05-18)
25. [Act Like You're Paying for This: PRMs for Code Agents — arxiv 2509.02360](https://arxiv.org/html/2509.02360v1) (accessed 2026-05-18)
26. [SICA: A Self-Improving Coding Agent — arxiv 2504.15228](https://arxiv.org/html/2504.15228v2) (accessed 2026-05-18)
27. [Reflexion: Language Agents with Verbal RL — arxiv 2303.11366](https://arxiv.org/pdf/2303.11366) (accessed 2026-05-18)
28. [Claude Opus 4.7 — Anthropic News](https://www.anthropic.com/news/claude-opus-4-7) (accessed 2026-05-18)
29. [MCP 2026 Roadmap — modelcontextprotocol.io](https://modelcontextprotocol.io/development/roadmap) (accessed 2026-05-18)
30. [The 2026 MCP Roadmap — blog.modelcontextprotocol.io](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/) (accessed 2026-05-18)
31. [Claude Code Updates May 2026 — Releasebot](https://releasebot.io/updates/anthropic/claude-code) (accessed 2026-05-18)
32. [Dive into Claude Code: Design Space — arxiv 2604.14228](https://arxiv.org/html/2604.14228v1) (accessed 2026-05-18)
33. [Effective Harnesses for Long-Running Agents — Anthropic Engineering](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) (accessed 2026-05-18)
34. [Semantic Code Indexing with AST and Tree-sitter — Medium](https://medium.com/@email2dineshkuppan/semantic-code-indexing-with-ast-and-tree-sitter-for-ai-agents-part-1-of-3-eb5237ba687a) (accessed 2026-05-18)
35. [OpenHands arxiv paper 2407.16741](https://arxiv.org/abs/2407.16741) (accessed 2026-05-18)
36. [Memory for Autonomous LLM Agents — arxiv 2603.07670](https://arxiv.org/html/2603.07670v1) (accessed 2026-05-18)
37. [SICA GitHub](https://github.com/MaximeRobeyns/self_improving_coding_agent) (accessed 2026-05-18)
38. [Building Agents with the Claude Agent SDK — Anthropic](https://claude.com/blog/building-agents-with-the-claude-agent-sdk) (accessed 2026-05-18)
39. [Cursor Worktrees Docs](https://cursor.com/docs/configuration/worktrees) (accessed 2026-05-18)
40. [MemMachine — arxiv 2604.04853](https://arxiv.org/html/2604.04853v1) (accessed 2026-05-18)

---

## Wave 2–5 Candidate Themes

Each bullet: **theme · primary file area · estimated wave-sized effort · prerequisite**.

1. **Prompt cache instrumentation** · `packages/core/src/runtime/runtime-adapter.ts` · S (1 wave) · none — highest ROI, ship first.

2. **Routing feedback persistence** · `packages/core/src/intelligence/adaptive-routing.ts` + `.agentforge/memory/` · S · none.

3. **Phase-level cycle checkpointing** · `packages/core/src/autonomous/cycle-runner.ts` + new `cycle-checkpoint.ts` · M · SQLite schema addition in `packages/db/`.

4. **Plan-approval gate** · `packages/core/src/autonomous/phase-handlers/execute-phase.ts` + CLI approval UI · M · cycle checkpointing (prerequisite for reliable pause/resume).

5. **Tree-sitter repo-map in forge recon** · `packages/core/src/scanner/` + `code-archaeologist` agent · M · none; replaces text-scanning in Phase A.

6. **Step-level PRM scoring** · `packages/core/src/evaluation/` new `step-scorer.ts` · M · Haiku invocation budget; independent of existing metric-collector.

7. **In-cycle Reflexion retry** · `packages/core/src/autonomous/phase-handlers/execute-phase.ts` + `self-correction/` · M · verbal-memory format in `episode-replay.jsonl`.

8. **Runtime memory query tool** · `packages/embeddings/src/embedding-store.ts` + tool registration in SDK transport · M · embeddings package already exists; needs wiring.

9. **E2B sandbox adapter** · new `packages/core/src/sandbox/` + `autonomous.yaml` schema · L · E2B API key; network policy design.

10. **SDK session continuity** · `packages/core/src/autonomous/runtime-adapter.ts` + `.agentforge/sessions/` · S · none; session_id already emitted by SDK.

11. **Typed agent handoffs (JSON schema validation)** · `.agentforge/agents/*.yaml` schema + `execute-phase.ts` · M · agent YAML schema extension.

12. **GitHub issue intake adapter** · new `packages/cli/src/commands/intake.ts` · M · GH_TOKEN already required for release phase.

13. **Best-of-N dispatch** · `packages/core/src/autonomous/phase-handlers/execute-phase.ts` · M · requires reliable scoring to pick winner; PRM scoring is prerequisite.

14. **OTel/LangFuse trace export** · `packages/core/src/tracing/` · S · span.ts and trace-collector.ts already exist; just need exporter.

15. **SICA-style scaffold mutation proposals** · new `packages/core/src/autonomous/meta-improvement/` · L · requires human-gate (plan-approval) + sandbox (E2B).

16. **Batch API for learn/memory phases** · `packages/core/src/autonomous/phase-handlers/learn-phase.ts` + `memory-curator` invocation · S · SDK transport; add `batchEligible: true` flag to non-latency phases.

17. **Lesson priority scoring** · `packages/core/src/autonomous/flywheel/` + `memory-curator` agent · S · existing JSONL memory structure.

18. **Managed Agents cloud mode** · `packages/core/src/runtime/` new `managed-agents-transport.ts` + `AGENTFORGE_RUNTIME=managed` · L · Anthropic Managed Agents API access (beta); prerequisite for AgentForge Cloud product.

19. **SWE-bench eval runner** · new `packages/cli/src/commands/eval.ts` · M · Docker required for isolated evaluation; maps cleanly to existing cycle machinery.

20. **Multi-run variance tracking** · `packages/core/src/evaluation/metric-collector.ts` + cycle dashboard · M · gate phase parallelism (prerequisite: checkpointing).
