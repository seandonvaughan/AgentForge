---
id: 3a7f1c82-e94d-4b56-a201-8d0f3c5e9b7a
agent: feedback-analyst
category: process
priority: critical
timestamp: "2026-03-25T03:30:00.000Z"
---

# Executive Synthesis: AgentForge v3 R&D Proposals

## Overview

Ten proposals from two squads — Cost Optimization and Intelligence — converge on a single thesis: AgentForge v2 is an observation machine that cannot act on what it observes. Costs are recorded but never controlled. Feedback is written but never read. Agents run, fail, and run the same way again next session. v3 fixes this by closing three loops simultaneously: a cost loop (budget-aware execution with dynamic routing and parallelism), a quality loop (adversarial review with conditional delegation), and a learning loop (cross-session feedback analysis driving autonomous team evolution). The combined system projects 50–70% cost reduction and measurably improving performance over time — properties that no competing framework (CrewAI, AutoGen, LangGraph) currently ships as a unified, self-improving package.

---

## Cross-Squad Themes

### Theme 1: The Observation-Without-Action Problem (9 of 10 proposals)
Every proposal independently diagnoses the same root failure: v2 gathers data and does nothing with it. `CostTracker` records spend; no one blocks on it. `FeedbackCollector` writes files; nothing reads them. `reviews_from` lists reviewers; the orchestrator ignores the list. This is not a feature gap — it is an architectural posture. v3's defining architectural shift is adding effectors to every existing observer.

### Theme 2: Static Configurations That Should Be Dynamic (8 of 10 proposals)
Model tier is fixed at template time (model-routing-researcher, cost-optimization-lead). Delegation graph is fixed at genesis time (multi-agent-framework-researcher). Team composition is fixed after the first `designTeam` call (self-improvement-researcher, agent-intelligence-lead). Agent system prompts never change (self-improvement-researcher). The v3 pattern is consistent: everything fixed at authoring time should become configurable at runtime, with data driving the configuration.

### Theme 3: Compounding Feedback Loops (agent-intelligence-lead, feedback-analysis-researcher, self-improvement-researcher)
Three proposals from the Intelligence Squad explicitly describe feedback loops that improve themselves. The `FeedbackAnalyzer` makes routing self-calibrating. The `ReforgeEngine` updates prompts based on what previous prompts got wrong. The `TaskComplexityRouter` starts with static heuristics but learns from escalation patterns. Each loop compounds the others' effects.

### Theme 4: The Missing Integration Layer (external-tools-researcher, agent-protocol-researcher)
Both proposals in this theme are about the gap between AgentForge's internal coordination and where engineering work actually lives — Jira, GitHub, Confluence, Slack. These are not cost proposals or intelligence proposals; they are product proposals. They transform AgentForge from a developer tool into a team automation platform.

### Theme 5: Backward Compatibility as a Design Constraint (all 10 proposals)
Every single proposal explicitly preserves v2 interfaces. `runAgent` is wrapped, not modified. `EventBus` is extended, not replaced. `ContextManager` gets new delegates, not a rewrite. This is a strong signal: the v2 API surface is worth preserving, and v3 should ship as an opt-in upgrade path.

---

## Dependency Map

```
LAYER 0 — No dependencies (ship first):
┌─────────────────────────────────────────────────────────────┐
│ [A] TaskComplexityRouter     (model-routing-researcher)     │
│ [B] TokenEstimator           (budget-strategy-researcher)   │
│ [C] FeedbackAnalyzer         (feedback-analysis-researcher) │
│ [D] SessionStore             (multi-agent-framework)        │
│ [E] export MODEL_COSTS       (cost-optimization-lead)       │
│ [F] add category to Agent    (cost-optimization-lead)       │
└─────────────────────────────────────────────────────────────┘

LAYER 1 — Depends on Layer 0:
┌─────────────────────────────────────────────────────────────┐
│ [G] BudgetEnvelope           (B → G)                        │
│ [H] ParallelFanOutEngine     (E, F → H)                     │
│ [I] ConditionalDelegationGraph + SpeakerSelector  (D → I)   │
│ [J] ReviewEnforcer           (F → J)                        │
└─────────────────────────────────────────────────────────────┘

LAYER 2 — Depends on Layer 1:
┌─────────────────────────────────────────────────────────────┐
│ [K] CostAwareRunner          (A, G, H → K)                  │
│ [L] ReforgeEngine            (C, D → L)                     │
└─────────────────────────────────────────────────────────────┘

LAYER 3 — Depends on Layer 2:
┌─────────────────────────────────────────────────────────────┐
│ [M] OrchestratorV3           (K, L, I, J → M)               │
└─────────────────────────────────────────────────────────────┘

LAYER 4 — Depends on Layer 3 (or parallel to it):
┌─────────────────────────────────────────────────────────────┐
│ [N] IntegrationLayer/MCP     (M → N, or standalone)         │
│ [O] MessageBus / KnowledgeStore / DecisionLog  (M → O)      │
└─────────────────────────────────────────────────────────────┘

CRITICAL PATH: E → F → A → G → K → M
                           B → G
                     C → L → M
                     D → I → M
```

**Blocking items:** `MODEL_COSTS` export [E] and `category` field on `AgentTemplate` [F] are 5-minute changes that unblock the entire cost optimization stack. They should be the first PR merged.

**Parallelizable:** Layers 0 and 1 can be built by two teams simultaneously. The Intelligence Squad owns [C], [D], [I], [J], [L]. The Cost Squad owns [A], [B], [E], [F], [G], [H], [K].

---

## Ranked Proposals

| Rank | Proposal | Squad | Impact (1–5) | Feasibility (1–5) | Risk (1=low) | Score |
|------|----------|-------|--------------|-------------------|--------------|-------|
| 1 | Dynamic Model Routing (TaskComplexityRouter) | Cost | 5 | 5 | 1 | 25.0 |
| 2 | Cost-Aware Architecture Synthesis (CostAwareRunner) | Cost | 5 | 4 | 2 | 10.0 |
| 3 | FeedbackAnalyzer — Pattern Detection | Intelligence | 5 | 5 | 1 | 25.0 |
| 4 | Self-Improving System Synthesis (OrchestratorV3) | Intelligence | 5 | 3 | 3 | 5.0 |
| 5 | ReforgeEngine — Team Evolution | Intelligence | 4 | 4 | 2 | 8.0 |
| 6 | Budget Enforcement (BudgetEnvelope) | Cost | 4 | 5 | 1 | 20.0 |
| 7 | Multi-Agent Framework Patterns (Conditional Edges + ReviewEnforcer + SessionStore) | Intelligence | 4 | 4 | 2 | 8.0 |
| 8 | Parallel Fan-Out Engine | Cost | 4 | 4 | 2 | 8.0 |
| 9 | Native MCP Integration (Jira/GitHub/Confluence/Slack) | External | 5 | 4 | 2 | 10.0 |
| 10 | Structured Agent Communication (MessageBus/KnowledgeStore/DecisionLog) | Protocol | 3 | 4 | 2 | 6.0 |

**Scoring methodology:** Impact × Feasibility / Risk. Ties broken by implementation order dependency.

**Notes on rankings:**
- Dynamic Model Routing and FeedbackAnalyzer tie for first: both are pure-function, no-dependency additions with the highest immediate ROI. Ship them together.
- MCP Integration (#9) ranks higher on product impact than its engineering score suggests. It is the proposal most likely to change user acquisition and retention. Its demotion to Phase 2 is a sequencing choice, not a value judgment.
- Structured Agent Communication (#10) is well-designed but solves a problem that manifests at larger scale than most v3 users will encounter initially. Phase 3 is correct for it.
- The Synthesis proposals (Cost-Aware Architecture, Self-Improving System) are integration work that depends on the atomic proposals above them. Their feasibility score reflects integration complexity, not individual component difficulty.

---

## Recommended Roadmap

### Phase 1: Foundation (unblocks everything) — Target: 2 weeks

These are the smallest, highest-ROI changes. Each is independently deployable and creates the scaffolding all later work depends on.

**1a. Type system fixes (1 PR, 1 day)**
- Export `MODEL_COSTS` from `src/orchestrator/cost-tracker.ts`
- Add `category: AgentCategory` to `AgentTemplate` in `src/types/agent.ts`
- Add optional `budget` and `confidenceEscalationThreshold` to `AgentTemplate`
- Add `FeedbackTheme`, `RecommendedAction`, `FeedbackAnalysis` to `src/types/feedback.ts`
- Add `DelegationEdge`, `ConditionalDelegationGraph` to `src/types/team.ts`

**1b. TaskComplexityRouter (1 PR, 2–3 days)**
- New file: `src/routing/task-complexity-router.ts`
- `routeTask()`, `detectLowConfidence()`, `extractTaskSignals()`, `scoreComplexity()`
- No dependencies on other new work; wraps existing `runAgent` call sites
- **Expected impact: 35–55% cost reduction on model spend once wired in**

**1c. FeedbackAnalyzer (1 PR, 2–3 days)**
- New file: `src/feedback/feedback-analyzer.ts`
- Pure function: `analyzeFeedback(entries, options) → FeedbackAnalysis`
- Add `analyze()` method to `FeedbackCollector`
- Zero new npm dependencies
- **Expected impact: first time v2 feedback data becomes actionable**

**1d. SessionStore (1 PR, 1 day)**
- New file: `src/orchestrator/session-store.ts`
- `saveSnapshot()`, `loadLatest()`, `loadAllSnapshots()`
- Simple disk I/O; enables all cross-session learning
- **Expected impact: unlocks ReforgeEngine in Phase 2**

### Phase 2: Core v3 — Target: 4–6 weeks

**2a. Cost Optimization Stack (1–2 PRs, 1 week)**
- `TokenEstimator` + `BudgetEnvelope` (`src/budget/`)
- `ParallelFanOutEngine` (`src/orchestrator/parallel-fan-out.ts`)
- `CostAwareRunner` (`src/orchestrator/cost-aware-runner.ts`) — the 6-stage pipeline integrating routing + budget + fan-out
- Replace `runAgent` call sites in orchestrator with `runCostAware`
- **Expected impact: 50–70% total cost reduction; 20–40% wall-clock improvement**

**2b. Intelligence Wiring (1–2 PRs, 1 week)**
- `ConditionalDelegationGraph` + `SpeakerSelector` (`src/orchestrator/speaker-selector.ts`)
- `ReviewEnforcer` (`src/orchestrator/review-enforcer.ts`)
- `ReforgeEngine` (`src/reforge/reforge-engine.ts` + `src/types/reforge.ts`)
- Post-session analysis trigger in orchestrator teardown
- **Expected impact: agents learn across sessions; strategic outputs get adversarial review**

**2c. MCP Integration Layer (1–2 PRs, 1 week)**
- `IntegrationLayer` (`src/integrations/integration-layer.ts`)
- `src/types/integration.ts` — typed action dispatch
- `McpConfigGenerator` (`src/scanner/mcp-config-generator.ts`)
- `agentforge mcp enable <tool>` CLI subcommand
- Add `integrations?: AgentIntegrationConfig` to `AgentTemplate`
- **Expected impact: agents can file Jira tickets, post Slack messages, create Confluence pages — AgentForge becomes a team automation platform**

**2d. OrchestratorV3 (1 PR, 1 week)**
- `src/orchestrator/orchestrator-v3.ts` — wires all Phase 1 and Phase 2 components
- Replaces ad-hoc orchestration with the full v3 intelligence stack
- Migration: opt-in per project; v2 orchestrator still works

### Phase 3: Advanced Capabilities — Target: 8–10 weeks

**3a. Structured Agent Communication**
- `MessageBus` with handler registration + priority queues (`src/orchestrator/message-bus.ts`)
- `KnowledgeStore` with session/project/entity scopes (`src/orchestrator/knowledge-store.ts`)
- `DecisionLog` with external artifact links (`src/orchestrator/decision-log.ts`)
- Typed event payloads (`src/types/events.ts`)
- **Required when:** team size exceeds 6 agents or cross-session knowledge retention becomes a measurable problem

**3b. LLM-Backed Orchestrator (optional)**
- `OrchestratorPlugin` interface enabling swap-in of LLM-driven orchestration
- Prototype only; production readiness gated on cost analysis

### Phase 4: Polish and Optimization — Target: 12+ weeks

- `[REFORGE REQUESTED: reason]` detection in orchestrator output processing
- `agentforge reforge apply <proposal-id>` CLI command
- Proposal pruning (auto-expire proposals older than 30 days)
- Agent version pruning (keep last 5 overrides per agent)
- ACP-compatible adapter for `MessageBus` (cross-framework federation)
- Metrics dashboard: average cost per task over time, self-improvement trend line
- Human-in-the-loop gate integration (budget threshold `"approve"` action)

---

## The Big Idea

**The ReforgeEngine — specifically, the `[REFORGE REQUESTED: reason]` self-nomination convention combined with cross-session prompt evolution.**

Here is why this is the single most transformative thing in all 10 proposals:

Every other proposal optimizes the current session. Routing makes this invocation cheaper. Fan-out makes this task faster. Budget enforcement prevents this session from running over. MCP integration makes this handoff actionable. Even the FeedbackAnalyzer, for all its elegance, only describes what has already happened.

The ReforgeEngine is the only proposal that makes the *next* session better than the current one — automatically, without developer intervention, using the agents' own failures as the training signal. An agent that outputs `[REFORGE REQUESTED: I cannot reliably handle TypeScript generics without more examples]` is doing something no other multi-agent framework supports: it is actively participating in its own improvement. The orchestrator picks up that signal, the ReforgeEngine writes a prompt preamble, and the next session's agent is measurably better at TypeScript generics.

This is not a dashboard. It is not a report. It is an effector. And it is the mechanism that makes AgentForge v3 genuinely self-improving rather than self-monitoring.

If only one thing ships in v3, ship the ReforgeEngine — even if the FeedbackAnalyzer must be simplified and the trigger conditions hardcoded at first. The loop from agent → failure signal → prompt evolution → improved next session is the product differentiator that none of the competition has.

The cost-saving proposals are excellent and should ship in Phase 2 as described. But they are optimizations. The ReforgeEngine is a new capability class.

---

## Risks and Open Questions

### Risk 1: Prompt Evolution Regression (HIGH)
If the ReforgeEngine writes a bad preamble, the next session could be *worse* than the current one, and the ReforgeEngine would generate more feedback about the worse session, potentially making the preamble worse again. Mitigation: version every mutation with rollback capability; add a quality gate that compares post-reforge session confidence scores against pre-reforge baseline before promoting a preamble beyond version 1.

### Risk 2: Fan-Out Task Decomposition Quality (MEDIUM)
The `decomposeTask()` function in `parallel-fan-out.ts` uses a trivially simple shard strategy (round-robin with a "[Shard N of M]" directive). For research tasks this may produce redundant shards, negating the cost benefit. Open question: when does a decomposer agent (LLM-driven task splitting) become worth the added cost and latency? Recommendation: instrument shard result overlap in Phase 2 and revisit in Phase 3.

### Risk 3: MCP Server Process Management (MEDIUM)
MCP servers are separate processes that must be running for the IntegrationLayer to function. In CI/CD environments, managing process lifetimes alongside the Claude Code session is an operational burden. Open question: should AgentForge manage MCP server startup/shutdown, or require them to be pre-started? Recommendation: require pre-start for v3; add lifecycle management in Phase 4.

### Risk 4: Conditional Edge Predicate Debuggability (MEDIUM)
Replacing static delegation graphs with predicate-bearing edges makes routing more powerful but harder to reason about when things go wrong. A predicate that always returns `true` (e.g., a closure that captured a stale ledger reference) could cause routing loops that `LoopGuard` catches but developers cannot diagnose. Recommendation: require all conditional edges to declare a human-readable `label` (already in the type); add a debug mode that logs every predicate evaluation.

### Risk 5: Model Routing Heuristics Calibration (LOW-MEDIUM)
The `scoreComplexity()` function uses static keyword lists and token thresholds. These were designed for a general case. For domain-specific projects (e.g., a team focused exclusively on security auditing, where all tasks involve "analyze" keywords), the complexity score will systematically over-estimate and under-use Haiku. Mitigation: the `ReforgeEngine`'s self-calibrating routing loop (from the agent-intelligence-lead synthesis) corrects this over sessions — but only after 3+ sessions of calibration data.

### Risk 6: ACP/A2A Standard Lock-In (LOW)
The agent-protocol-researcher recommends designing `MessageBus.sendDirect()` to mirror ACP semantics. ACP is an emerging standard (IBM/BeeAI, early 2025) and may not stabilize in its current form. If ACP changes significantly before Phase 4's ACP adapter is built, the MessageBus semantics may need to change. Mitigation: the ACP adapter is explicitly a Phase 4 concern; Phase 3's MessageBus is internal-only and can be refactored independently.

### Open Question 1: What is the right corroboration threshold for small teams?
The FeedbackAnalyzer defaults to `corroborationThreshold: 2` — a theme must appear in 2+ independent agents' feedback to be considered signal. For a 3-agent team, this is a 67% consensus requirement. For an 8-agent team, it is a 25% requirement. Both teams deserve the same signal quality. Recommendation: make the threshold a fraction of team size, not an absolute count.

### Open Question 2: Should OrchestratorV3 be the default or opt-in?
The intelligence squad synthesis writes OrchestratorV3 as a new class that replaces orchestrator call sites. If it is opt-in, v2 teams get no v3 benefits until they migrate. If it is the default, teams that relied on v2 behavior may see unexpected changes. Recommendation: opt-in per project in v3.0; make it the default in v3.1 once migration tooling exists.

### Open Question 3: How should structural reforge proposals interact with genesis?
The ReforgeEngine writes structural proposals to `.agentforge/reforge-proposals/` and stops. The `agentforge reforge apply` CLI command is described but not designed. Does applying a structural proposal call `designTeam()` with a modified brief, or does it directly mutate the team manifest? The agent-intelligence-lead synthesis says "prepares a modified brief and calls the existing function" — but that design is not yet specified at the interface level. This must be resolved before ReforgeEngine ships structural proposals.
