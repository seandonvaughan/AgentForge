---
id: c8efd0d4-2dd0-4445-9b15-c99a06cb2dfe
agent: cto
category: process
priority: critical
timestamp: "2026-03-25T03:45:00.000Z"
---

# CTO Decision: AgentForge v3 Roadmap

## 1. Strategic Vision

AgentForge v3 is built on one thesis: **an AI agent team that cannot improve itself is just a script with a higher API bill.** v2 proved that multi-agent orchestration works -- teams can be designed, composed, delegated to, and monitored. But monitoring without action is surveillance, not intelligence. Every piece of data v2 collects -- cost records, feedback files, confidence scores, loop detection flags -- sits in files that no system component ever reads. v3 turns AgentForge from a system that *records* its failures into one that *corrects* them.

This matters because the competitive landscape has converged on orchestration as a commodity. CrewAI, AutoGen, LangGraph, and Magentic-One all ship agent coordination. None of them ship self-improvement. The gap is not "can you run agents in parallel" -- everyone can do that. The gap is "does your agent team get better at its job over time without a developer rewriting prompts." That is the v3 value proposition: a compounding return on every session run. Session 10 is measurably cheaper and higher-quality than session 1, automatically. This transforms AgentForge from a developer tool into a platform that justifies its own cost.

The economic argument seals it. The cost optimization stack alone projects 50-70% spend reduction. The intelligence stack compounds that with fewer re-runs, self-calibrating routing, and prompt evolution. Combined, we are targeting a system where the marginal cost of the 100th task is a fraction of the 1st -- not because we negotiated a volume discount, but because the system learned what works. That is the pitch to every engineering leader evaluating multi-agent frameworks: AgentForge pays for itself.

## 2. Approved Roadmap

### Phase 1: Foundation -- 2 weeks, starts immediately

Approved exactly as the Feedback Analyst recommended. No changes.

| Work Item | Deliverable | Acceptance Criteria |
|-----------|-------------|---------------------|
| 1a. Type system fixes | Single PR | `MODEL_COSTS` exported; `category` on `AgentTemplate`; `FeedbackTheme`, `RecommendedAction`, `FeedbackAnalysis` in types; `DelegationEdge`, `ConditionalDelegationGraph` in types. All existing tests pass. |
| 1b. TaskComplexityRouter | `src/routing/task-complexity-router.ts` | `routeTask()` returns correct tier for 5 predefined complexity levels. `detectLowConfidence()` identifies hedging language. Unit tests with >90% branch coverage. |
| 1c. FeedbackAnalyzer | `src/feedback/feedback-analyzer.ts` | `analyzeFeedback()` produces `FeedbackAnalysis` from real v2 feedback files in this repo. Keyword clustering groups related entries. `corroborationThreshold` is configurable. Zero new npm dependencies. |
| 1d. SessionStore | `src/orchestrator/session-store.ts` | `saveSnapshot()` writes JSON to `.agentforge/sessions/`. `loadLatest()` and `loadAllSnapshots()` round-trip correctly. Works with existing `ProgressLedger` type. |

**Phase 1 milestone:** All four PRs merged. The `TaskComplexityRouter` can be called standalone to demonstrate routing decisions on sample tasks. The `FeedbackAnalyzer` can be run against this project's own `.agentforge/feedback/` directory and produce a real analysis. These two demos are the Phase 1 gate.

### Phase 2: Core v3 -- 4-6 weeks

Approved with one ordering change and one scope adjustment.

**Ordering change:** 2b (Intelligence Wiring) ships before 2c (MCP Integration). The Feedback Analyst placed them in parallel, but ReforgeEngine is on the critical path to the flagship feature. MCP integration is high product value but not architecturally blocking. If we slip, MCP slips first.

**Scope adjustment on 2c:** MCP Integration ships as Milestone 2 only (IntegrationLayer + mcp-config-generator + CLI subcommand). The AgentForgeSession factory and auto-rules from the Integration Architecture Lead's Milestone 3 are deferred to Phase 3. Reason: the session factory requires MessageBus and KnowledgeStore, which are Phase 3 components. Shipping MCP dispatch without the full session wiring is still valuable -- agents can create Jira tickets and post Slack messages. The structured internal communication layer can come later.

| Work Item | Deliverable | Acceptance Criteria |
|-----------|-------------|---------------------|
| 2a. Cost Optimization Stack | `TokenEstimator`, `BudgetEnvelope`, `ParallelFanOutEngine`, `CostAwareRunner` | The 6-stage pipeline runs end-to-end. A sample task routed to Haiku costs less than the same task on Opus. Budget enforcement blocks a request that exceeds the envelope. Fan-out produces a merged result from 3+ shards. |
| 2b. Intelligence Wiring | `ConditionalDelegationGraph`, `SpeakerSelector`, `ReviewEnforcer`, `ReforgeEngine` | ReforgeEngine reads FeedbackAnalysis, writes agent overrides to `.agentforge/agent-overrides/`. `applyOverride()` prepends a preamble to an agent's system prompt. ReviewEnforcer blocks unreviewed strategic outputs. Conditional edges resolve correctly based on ledger state. |
| 2c. MCP Integration | `IntegrationLayer`, `McpConfigGenerator`, CLI subcommand | `agentforge mcp enable jira` generates correct `.mcp/config.json`. `IntegrationLayer.dispatch()` calls MCP tools. Works with mock MCP dispatch in tests. |
| 2d. OrchestratorV3 | `src/orchestrator/orchestrator-v3.ts` | Wires 2a + 2b. Opt-in per project. v2 orchestrator unmodified. A full session runs through OrchestratorV3 with cost-aware execution + reforge + conditional delegation. |

**Phase 2 milestone:** Run a real project through OrchestratorV3 end-to-end. Measure cost vs. the same project on v2. Target: 40%+ cost reduction. Run a second session on the same project and verify that ReforgeEngine produced at least one agent override that is applied in session 2. This is the Phase 2 gate.

### Phase 3: Structured Communication + Polish -- 6-8 weeks (was 8-10)

| Work Item | Deliverable | Acceptance Criteria |
|-----------|-------------|---------------------|
| 3a. MessageBus | `src/orchestrator/message-bus.ts` | Handler registration, priority queues, wraps existing EventBus. High-priority events processed before low-priority. |
| 3b. KnowledgeStore | `src/orchestrator/knowledge-store.ts` | Session/project/entity scopes. Persists to `.agentforge/knowledge/`. |
| 3c. DecisionLog | `src/orchestrator/decision-log.ts` | Typed entries, external artifact links, persists to `.agentforge/decisions/`. |
| 3d. AgentForgeSession | `src/orchestrator/session.ts` | Factory wires all v3 components. Single-call initialization replaces ad-hoc manager creation. Auto-rules for event-to-action dispatch. |
| 3e. `[REFORGE REQUESTED]` detection | Orchestrator output processing | Agent self-nomination signals are captured and fed to ReforgeEngine without manual intervention. |
| 3f. `agentforge reforge apply` CLI | CLI subcommand | Developers can review and apply structural reforge proposals. |

**Phase 3 milestone:** A 6+ agent team runs through AgentForgeSession with full structured communication. An agent self-nominates for reforge, and the system acts on it in the next session. Decision log persists across sessions.

### Deferred to v4

- LLM-backed orchestrator (3b from Analyst's plan). Too much cost risk, unclear ROI over rule-based conditional edges. Will revisit when we have data from v3 conditional delegation usage.
- ACP/A2A adapter for MessageBus. The standard is not stable enough. We will not design our MessageBus around a moving target. If ACP stabilizes, we adapt in v4.
- Metrics dashboard. Important for adoption but not architecturally interesting. v4 concern.
- Human-in-the-loop budget approval gates. Useful but a product feature, not a v3 architectural requirement.

### Killed

Nothing is killed outright. Every proposal has merit. But the LLM-backed orchestrator is the closest to being cut. If Phase 3 runs long, it does not get prototyped at all.

## 3. The Flagship Feature

**I agree with the Feedback Analyst. The ReforgeEngine is the flagship feature of v3.**

But I want to sharpen why, because the team needs to internalize this.

The cost optimization stack is excellent engineering. It will save real money and it will demo well. But cost optimization is a *table stakes* feature. Every framework will have model routing within 6 months. Budget enforcement is a wrapper around arithmetic. Parallel fan-out is `Promise.allSettled` with a merge step. These are important -- they are the floor of competence for v3 -- but they are not the ceiling.

The ReforgeEngine is different in kind, not degree. It is the only component in the entire proposal set that creates a *temporal advantage*: the longer you use AgentForge, the better it gets. That is a moat. A competitor can copy our routing heuristics on day one. They cannot copy 50 sessions of accumulated prompt evolution and self-calibrated routing tables. The ReforgeEngine turns usage into a compounding asset.

Specifically, the `[REFORGE REQUESTED: reason]` self-nomination convention is the single most novel idea across all 11 proposals. No other framework has agents that participate in their own redesign. This is the demo. This is the blog post. This is the conference talk. When we show an agent saying "I cannot reliably handle TypeScript generics without more examples" and the next session's agent handling TypeScript generics correctly because the system evolved its own prompt -- that is the moment people understand what AgentForge v3 is.

**Directive:** ReforgeEngine ships in Phase 2, not Phase 3. The `[REFORGE REQUESTED]` detection moves from Phase 4 to Phase 3. If we have to cut scope anywhere in Phase 2, we cut fan-out parallelism before we cut ReforgeEngine. The self-improvement loop is the product.

## 4. Architecture Principles

These are non-negotiable. Every PR must comply. Reviewers must check for violations.

### Iron Law 1: Wrap, Never Modify

No v2 interface is changed. `runAgent` is wrapped by `runCostAware`, not modified. `EventBus` is wrapped by `MessageBus`, not replaced. `ContextManager`'s public API stays identical even as the implementation delegates to new stores. Any PR that modifies a v2 public interface signature is rejected. v3 is an additive layer.

### Iron Law 2: Every Observer Gets an Effector

If a component records data, there must be a component that acts on it. `CostTracker` records spend -- `BudgetEnvelope` acts on it. `FeedbackCollector` writes entries -- `FeedbackAnalyzer` reads them. `detectLowConfidence()` detects hedging -- `CostAwareRunner` escalates. No new observer ships without a corresponding effector in the same phase or the next.

### Iron Law 3: Everything Fixed at Authoring Time Becomes Configurable at Runtime

Model tier, delegation graph, team composition, system prompts -- all of these are currently frozen at template creation. v3 makes all of them runtime-adjustable with data driving the adjustment. If a PR introduces a new configuration parameter that can only be set at authoring time, it must justify why runtime configurability is infeasible.

### Iron Law 4: Version and Roll Back Every Mutation

The ReforgeEngine writes prompt preambles. The routing system adjusts tiers. Conditional edges change delegation paths. Every mutation must be versioned, timestamped, and reversible. Agent overrides are versioned JSON. Routing adjustments carry a session ID. If any mutation makes the system worse, reverting to the previous state must be a single operation, not a debugging expedition.

### Iron Law 5: Zero New npm Dependencies

v3 ships with the same dependency footprint as v2. The `FeedbackAnalyzer` uses keyword clustering, not an NLP library. The `TokenEstimator` uses heuristics, not tiktoken. The `SessionStore` writes JSON to disk, not to SQLite. If a contributor believes a dependency is truly necessary, they bring it to the architecture review with a size/security/maintenance analysis. The default answer is no.

## 5. Success Metrics

### Launch Gate (all must be met for v3.0 release)

| Metric | Target | Measurement |
|--------|--------|-------------|
| Cost reduction vs. v2 | >= 40% on a standardized 10-task benchmark | `CostTracker.getReport()` comparison, same tasks, same project |
| Cross-session improvement | Session 5 average cost per task < Session 1 by >= 10% | `CostTracker` reports across `SessionStore` snapshots |
| ReforgeEngine activation | At least 1 agent override auto-generated and applied in the benchmark | Presence of files in `.agentforge/agent-overrides/` after session 2+ |
| Zero breaking changes | All v2 test suites pass without modification | CI green on existing test suite with v3 code merged |
| Phase 1 components standalone-usable | `TaskComplexityRouter` and `FeedbackAnalyzer` work without OrchestratorV3 | Unit tests demonstrate standalone usage |

### North Star (tracked quarterly post-launch)

| Metric | Target | Timeframe |
|--------|--------|-----------|
| Cost per completed task trend | Monotonically decreasing over 10+ sessions per project | Q1 post-launch |
| Agent override adoption rate | 80%+ of generated overrides improve next-session performance | Q2 post-launch |
| MCP integration usage | 50%+ of active projects enable at least one external integration | Q2 post-launch |
| Structural reforge proposals | At least 1 structural proposal generated and applied in dogfood usage | Q1 post-launch |

## 6. Risk Mitigation

### Risk 1: Prompt Evolution Regression (HIGH)

**The risk:** ReforgeEngine writes a bad preamble. Next session is worse. The system generates feedback about the worse session. The preamble gets worse. A vicious cycle.

**Mitigation (mandatory, ships with ReforgeEngine):**
- Every agent override is versioned. `AgentOverride.version` increments on every mutation. Max 5 versions retained.
- A quality gate compares post-reforge confidence scores against the pre-reforge baseline. If confidence drops by more than 0.1 across 2 consecutive sessions after a reforge, the override is automatically rolled back to the previous version.
- Structural proposals (team composition changes) are never auto-applied. They require `agentforge reforge apply` with human approval.
- The rollback mechanism ships in the same PR as the ReforgeEngine. Not a follow-on. Not Phase 3. Same PR.

### Risk 2: Fan-Out Decomposition Quality (MEDIUM)

**The risk:** The `decomposeTask()` function uses a naive shard strategy. For research tasks, shards may be redundant, negating cost savings and producing contradictory outputs that the merge agent cannot reconcile.

**Mitigation:**
- Fan-out is opt-in per agent via `collaboration.parallel: true`. It is not the default.
- Instrument shard result overlap in Phase 2: after merge, compute a simple similarity score between shard outputs. If overlap exceeds 70% on 3+ tasks, emit a warning and disable fan-out for that agent category.
- Revisit decomposition strategy in Phase 3 based on empirical data. An LLM-driven decomposer is explicitly out of scope for Phase 2.

### Risk 3: Scope Creep from Integration Architecture (MEDIUM)

**The risk:** The Integration Architecture Lead's proposal is the broadest in scope -- MessageBus, KnowledgeStore, DecisionLog, IntegrationLayer, AgentForgeSession, auto-rules. If all of this lands in Phase 2, it delays the flagship feature.

**Mitigation:**
- Phase 2 gets only the IntegrationLayer and McpConfigGenerator. No MessageBus, no KnowledgeStore, no session factory.
- Phase 3 gets the full structured communication stack.
- The Integration Architecture Lead is explicitly told: Phase 2 scope is MCP dispatch only. The beautiful session wiring waits. Ship the important thing (ReforgeEngine) before the complete thing (AgentForgeSession).

## 7. Team Assignments

### Phase 1 Assignments (2 weeks)

| Work Item | Team | Lead | Notes |
|-----------|------|------|-------|
| 1a. Type system fixes | Cost Optimization | cost-optimization-lead | First PR merged. Must unblock both squads. Target: day 1. |
| 1b. TaskComplexityRouter | Cost Optimization | model-routing-researcher | Highest standalone ROI. Pair with cost-optimization-lead for review. |
| 1c. FeedbackAnalyzer | Agent Intelligence | feedback-analysis-researcher | Must work against real feedback files in this repo. agent-intelligence-lead reviews. |
| 1d. SessionStore | Agent Intelligence | multi-agent-framework-researcher | Simple disk I/O. Should be done in 1 day. Unblocks ReforgeEngine in Phase 2. |

### Phase 2 Assignments (4-6 weeks)

| Work Item | Team | Lead | Notes |
|-----------|------|------|-------|
| 2a. Cost Optimization Stack | Cost Optimization | cost-optimization-lead | Owns TokenEstimator, BudgetEnvelope, ParallelFanOutEngine, CostAwareRunner. budget-strategy-researcher and parallel-execution-researcher implement components; lead integrates. |
| 2b. Intelligence Wiring | Agent Intelligence | agent-intelligence-lead | Owns ReforgeEngine, ConditionalDelegationGraph, SpeakerSelector, ReviewEnforcer. self-improvement-researcher implements ReforgeEngine; multi-agent-framework-researcher implements conditional edges + review. Lead integrates. |
| 2c. MCP Integration | Integration Architecture | integration-architecture-lead | Owns IntegrationLayer, McpConfigGenerator, CLI subcommand. external-tools-researcher implements. Scoped to Milestone 2 only -- no session factory. |
| 2d. OrchestratorV3 | Joint: Intelligence + Cost | agent-intelligence-lead (primary), cost-optimization-lead (secondary) | This is the integration point. Both leads co-own it. Intelligence lead writes the class; Cost lead validates the CostAwareRunner integration. |

### Cross-Team Coordination

- **Weekly sync:** All three leads meet weekly during Phase 2 to resolve interface conflicts.
- **Type system ownership:** cost-optimization-lead owns `src/types/agent.ts` and `src/types/orchestration.ts` changes. agent-intelligence-lead owns `src/types/feedback.ts`, `src/types/team.ts`, `src/types/reforge.ts`. integration-architecture-lead owns `src/types/integration.ts`, `src/types/events.ts`. No one touches another lead's type files without a review from the owner.
- **Integration test:** Before Phase 2 is declared complete, all three leads run the standardized benchmark together and sign off on the Phase 2 milestone criteria.

---

## Summary

AgentForge v3 is a self-improving agent platform. The ReforgeEngine is the product. The cost optimization stack is the economics. The integration layer is the reach. Ship them in that order of priority.

The team has two weeks to land the foundation. Then six weeks to ship the core. Then six more for the communication layer and polish. Every phase has a concrete gate. Every work item has an owner. Every architectural decision has a principle backing it.

Execute.
