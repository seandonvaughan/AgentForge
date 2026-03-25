---
id: f2e5d8c1-4a7b-4f93-b0e2-6c1d9a3f7e5b
agent: agent-intelligence-lead
category: feature
priority: critical
timestamp: "2026-03-25T03:00:00.000Z"
---

# AgentForge v3 Self-Improving System: Intelligence Squad Synthesis

## Problem

AgentForge v2 is smart at design time and blind at runtime. Teams are carefully composed by `genesis/team-designer.ts` and `builder/team-composer.ts`, model tiers are set by heuristics in `resolveModelTier()`, and the feedback system faithfully writes observations to `.agentforge/feedback/`. Then nothing happens.

The result is a system that accumulates evidence of its own underperformance and never acts on it. The cost optimization squad (in their 4 proposals already in this directory) identified 3-5x cost waste from static model routing, sequential execution, and no budget enforcement. Those are real problems. But the deeper issue is structural: **AgentForge has no self-improvement pathway**. Every inefficiency must be discovered and corrected by a human developer reading output files.

v3 must close this loop. The three researchers on this squad have each identified one third of the solution. This synthesis integrates all three into a coherent architecture — and shows how intelligence compounds with the cost optimization squad's work to make the combined system dramatically more capable than either squad's proposals alone.

## Research

This synthesis draws from three companion proposals:

- `2026-03-25-feedback-analysis-researcher-pattern-detection.md` — `FeedbackAnalyzer`, keyword clustering, signal extraction, `RecommendedAction` types
- `2026-03-25-multi-agent-framework-researcher-coordination-patterns.md` — conditional delegation edges, enforced reviews, session ledger persistence, speaker selector
- `2026-03-25-self-improvement-researcher-reforge-engine.md` — `ReforgeEngine`, prompt evolution, agent overrides, versioned mutations, structural proposals

And four proposals from the cost optimization squad:

- `2026-03-25-model-routing-researcher-dynamic-model-selection.md` — `TaskComplexityRouter`, `RoutingDecision`, `detectLowConfidence()`
- `2026-03-25-parallel-execution-researcher-fanout-engine.md` — `ParallelFanOutEngine`, `Promise.allSettled` fan-out, merge agents
- `2026-03-25-budget-strategy-researcher-budget-enforcement.md` — `TokenEstimator`, `BudgetEnvelope`, `BudgetCheckResult`
- `2026-03-25-cost-optimization-lead-synthesis.md` — `CostAwareRunner`, 6-stage execution pipeline, 50-70% cost reduction projection

## Findings

### The Two-Squad Architecture: Cost Control + Intelligence

The cost optimization squad's `CostAwareRunner` operates at **invocation time**: budget check → routing → fan-out → execution → post-execution recording → escalation check. It is per-request, synchronous in the orchestration loop, and focused on cost.

The intelligence squad's `FeedbackAnalyzer` + `ReforgeEngine` operates at **session time**: after a session ends, analyze accumulated feedback, detect patterns, propose or apply team mutations. It is asynchronous to execution, cross-session, and focused on structural improvement.

These two timescales do not conflict — they compose. The `CostAwareRunner` generates data (cost records, confidence flags, routing decisions). The `FeedbackAnalyzer` reads that data and extracts patterns. The `ReforgeEngine` acts on those patterns. Together they form a feedback-driven control system operating at two frequencies:

```
HIGH FREQUENCY (per-invocation, synchronous):
  FeedbackCollector.submitFeedback()
    ↓
  CostAwareRunner: budget check → route → fan-out → run → record
    ↓
  EventBus.publish("agent_completed")

LOW FREQUENCY (post-session, asynchronous):
  FeedbackCollector.loadAllFeedback()
    ↓
  FeedbackAnalyzer.analyzeFeedback() → FeedbackAnalysis
    ↓
  ReforgeEngine.buildPlan() → ReforgePlan
    ↓
  ReforgeEngine.executePlan() → AgentOverride files
    ↓
  Next session: applyOverride() prepends learnings to system_prompt
```

### How Each Intelligence Component Multiplies the Cost Optimization

**Finding 1: `FeedbackAnalyzer` makes cost routing self-calibrating.**

The cost optimization squad's `TaskComplexityRouter` uses static keyword lists to score task complexity. These lists were designed at authoring time and will drift from actual task distributions. Without feedback, there is no way to know when the routing is wrong.

The `FeedbackAnalyzer` closes this loop. When 2+ agents report low-confidence outputs from Haiku-routed tasks (via `detectLowConfidence()` in the routing module), the analyzer detects a `model-routing` theme and generates an `adjust-model-routing` recommendation. The `ReforgeEngine` then adds a `systemPromptPreamble` to the affected agents that signals to the `TaskComplexityRouter` to score those tasks higher (via injected context) — or directly adjusts the `modelTierOverride` in the agent override.

The routing table becomes empirical rather than heuristic.

**Finding 2: Conditional edges (`multi-agent-framework-researcher`) are the runtime analog of the cost router.**

The `TaskComplexityRouter` handles model tier decisions. LangGraph-style `ConditionalDelegationGraph` handles agent routing decisions. Both are about routing — at different levels of granularity.

Concretely: a `ConditionalDelegationEdge` with `when: (ledger) => detectLowConfidence(ledger.steps_completed.at(-1) ?? "")` automatically routes low-confidence outputs to a review agent, without requiring the orchestrator to hard-code this logic. This is the per-invocation intelligence complement to the per-session `ReforgeEngine`.

**Finding 3: Session ledger persistence (`SessionStore`) creates the learning corpus.**

The `ReforgeEngine` needs cross-session data to detect underperformance trends. Without persisted ledgers, it can only see the current session's feedback. With `SessionStore.loadAllSnapshots()`, it can query: which agents have had `is_in_loop = true` across 3+ sessions? Which tasks consistently produce `is_request_satisfied = false`? These are structural team problems that local reforge cannot fix — they trigger structural proposals.

The `ProgressLedger.steps_completed` history, combined with `FeedbackAnalysis.themes`, creates a two-dimensional view of team health:
- **Task dimension**: which task types consistently fail or underperform
- **Agent dimension**: which agents consistently produce low-confidence or rejected outputs

Both dimensions feed the `ReforgeEngine`'s `buildPlan()` mutation logic.

**Finding 4: Enforced reviews generate a quality signal that cost routing cannot.**

The cost optimization squad's `detectLowConfidence()` is a heuristic — it detects hedging language in the output. The `review-enforcer.ts`'s `ReviewResult.approved` is a structured quality signal: a peer agent explicitly assessed the output. These are complementary.

When `ReviewResult.approved = false`, this becomes a `FeedbackTheme` data point. When an agent's work is rejected on first draft >50% of the time across sessions, the `ReforgeEngine` generates an `update-system-prompt` mutation with specific critique context. This is DSPy's `BootstrapFewShot` without the ML infrastructure — using the review critique text directly as the prompt preamble.

**Finding 5: The `[REFORGE REQUESTED: reason]` convention is the missing agent-to-agent learning signal.**

All other mechanisms are observational: the system infers that an agent is underperforming from indirect signals. The self-nomination convention makes underperformance explicit. When an agent outputs `[REFORGE REQUESTED: I cannot reliably handle tasks involving TypeScript generics without more context]`, this is high-fidelity signal that bypasses all threshold debouncing and goes directly to the `ReforgeEngine`.

This is the only mechanism that enables agents to propose their own modification — closing the loop from agent → feedback → reforge without human mediation for the signal generation step (though structural changes still require human approval).

### The Complete v3 Self-Improvement Stack

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        AGENTFORGE v3 INTELLIGENCE STACK                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  DESIGN TIME                                                                │
│  genesis/team-designer.ts  ──→  TeamManifest                               │
│  builder/team-composer.ts  ──→  TeamComposition                            │
│                ↑                                                            │
│                └─── ReforgeEngine.executePlan() (structural proposals)      │
│                     reads .agentforge/reforge-proposals/                   │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  SESSION SETUP                                                              │
│  ReforgeEngine.applyOverride(agent)   ←── .agentforge/agent-overrides/    │
│  → mutated AgentTemplate (preamble + model tier override)                  │
│  SessionStore.loadLatest(taskId)       ←── .agentforge/sessions/           │
│  → restored ProgressLedger (for task resumption)                           │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  INVOCATION (PER AGENT CALL)                    [Cost Optimization Squad]  │
│  CostAwareRunner:                                                           │
│    1. BudgetEnvelope.checkBefore()  ← TokenEstimator.heuristic()           │
│    2. TaskComplexityRouter.routeTask()                                      │
│    3. ConditionalDelegationGraph edge resolution  [Intelligence Squad]     │
│    4. ParallelFanOutEngine || single runAgent()                             │
│    5. BudgetEnvelope.recordActual() + CostTracker.recordUsage()            │
│    6. detectLowConfidence() → escalation OR agent self-nomination check     │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  POST-INVOCATION                                [Intelligence Squad]       │
│  ReviewEnforcer.enforceReviews()  (strategic + quality agents only)        │
│  → ReviewResult → FeedbackCollector.submitFeedback() if rejected           │
│  SessionStore.saveSnapshot(ledger)                                          │
│  EventBus.publish("agent_completed")                                        │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  POST-SESSION                                   [Intelligence Squad]       │
│  FeedbackCollector.loadAllFeedback()                                        │
│    → FeedbackAnalyzer.analyzeFeedback()                                     │
│    → FeedbackAnalysis { themes, recommended_actions, requires_escalation } │
│    → EventBus.publish("feedback_analysis_complete")                         │
│                                                                             │
│  ReforgeEngine.buildPlan(analysis, teamAgents, sessionCount)                │
│    → ReforgePlan { local mutations || structural proposal }                 │
│  ReforgeEngine.executePlan(plan)                                            │
│    → local: writes .agentforge/agent-overrides/{agent}.json               │
│    → structural: writes .agentforge/reforge-proposals/{plan-id}.json      │
│    → EventBus.publish("reforge_applied" || "reforge_proposed")             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Recommendation

Implement the intelligence stack as a coherent v3 feature set, prioritized as follows:

### Priority 1 (unblocked, highest ROI)
- `FeedbackAnalyzer` in `src/feedback/feedback-analyzer.ts` — pure function, no dependencies on other new work
- `SessionStore` in `src/orchestrator/session-store.ts` — simple disk I/O, enables all cross-session learning

### Priority 2 (depends on Priority 1)
- `ReforgeEngine` in `src/reforge/reforge-engine.ts` — depends on `FeedbackAnalysis` output
- `ConditionalDelegationGraph` type and `SpeakerSelector` in `src/orchestrator/speaker-selector.ts`

### Priority 3 (depends on Cost Optimization Squad's work)
- Integration of `ReforgeEngine.applyOverride()` into `CostAwareRunner` call sites
- `ReviewEnforcer` in `src/orchestrator/review-enforcer.ts`
- Post-session analysis trigger in orchestrator teardown

### Priority 4 (polish)
- `[REFORGE REQUESTED: reason]` detection in orchestrator output processing
- CLI command `agentforge reforge apply <proposal-id>`
- Proposal pruning (auto-expire proposals older than 30 days)

## Implementation Sketch

```typescript
// src/orchestrator/orchestrator-v3.ts — the wiring that ties all squads together

import { CostAwareRunner, createCostAwareSession } from "./cost-aware-runner.js";
import { ReforgeEngine } from "../reforge/reforge-engine.js";
import { FeedbackCollector } from "../feedback/feedback-collector.js";
import { SessionStore } from "./session-store.js";
import { EventBus } from "./event-bus.js";
import { ReviewEnforcer } from "./review-enforcer.js";
import { selectNextSpeaker } from "./speaker-selector.js";
import type { ConditionalDelegationGraph } from "../types/team.js";
import type { AgentTemplate } from "../types/agent.js";
import type { ProgressLedger } from "../types/orchestration.js";

export interface OrchestratorV3Config {
  projectRoot: string;
  teamAgents: Map<string, AgentTemplate>;
  delegationGraph: ConditionalDelegationGraph;
  sessionBudgetUsd: number;
  sessionCount: number;       // how many sessions have run for this project (for reforge debounce)
}

export class OrchestratorV3 {
  private config: OrchestratorV3Config;
  private eventBus: EventBus;
  private sessionStore: SessionStore;
  private reforgeEngine: ReforgeEngine;
  private feedbackCollector: FeedbackCollector;

  constructor(config: OrchestratorV3Config) {
    this.config = config;
    this.eventBus = new EventBus();
    this.sessionStore = new SessionStore(config.projectRoot);
    this.reforgeEngine = new ReforgeEngine({
      projectRoot: config.projectRoot,
      eventBus: this.eventBus,
    });
    this.feedbackCollector = new FeedbackCollector(config.projectRoot);
  }

  /**
   * Run one agent invocation with full v3 intelligence stack applied:
   * - Override (evolved prompt + model tier) from ReforgeEngine
   * - Cost-aware execution (budget + routing + fan-out)
   * - Review enforcement for strategic/quality agents
   * - Ledger snapshot persisted after each step
   */
  async runAgent(
    agentName: string,
    task: string,
    ledger: ProgressLedger,
    { costTracker, envelope }: ReturnType<typeof createCostAwareSession>,
  ) {
    const baseAgent = this.config.teamAgents.get(agentName);
    if (!baseAgent) throw new Error(`Agent "${agentName}" not in team`);

    // Apply any evolved overrides from ReforgeEngine
    const agent = await this.reforgeEngine.applyOverride(baseAgent);

    // Execute with full cost-aware pipeline
    const result = await runCostAware({ agent, task, envelope, costTracker });

    // Detect self-nomination for reforge
    if (result.response.includes("[REFORGE REQUESTED:")) {
      const reason = result.response.match(/\[REFORGE REQUESTED:\s*(.+?)\]/)?.[1] ?? "agent self-nominated";
      await this.feedbackCollector.submitFeedback({
        id: randomUUID(),
        agent: agentName,
        category: "process",
        priority: "high",
        title: `${agentName} self-nominated for reforge`,
        description: reason,
        context: { task, model_used: agent.model },
        suggestion: "Review agent capabilities and consider prompt evolution or replacement.",
        timestamp: new Date().toISOString(),
      });
    }

    // Enforce reviews for non-utility agents
    const reviewers = new Map(
      [...this.config.teamAgents.entries()].filter(
        ([, a]) => baseAgent.collaboration.reviews_from?.includes(a.name)
      )
    );
    if (reviewers.size > 0) {
      const reviewResult = await ReviewEnforcer.enforceReviews(agent, result, reviewers);
      if (reviewResult.revisionRequired) {
        await this.feedbackCollector.submitFeedback({
          id: randomUUID(),
          agent: agentName,
          category: "quality",
          priority: "medium",
          title: `${agentName} output rejected by ${reviewResult.reviewer}`,
          description: reviewResult.critique.slice(0, 500),
          context: { task, model_used: agent.model },
          suggestion: "Improve output quality for this task type.",
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Persist ledger snapshot
    await this.sessionStore.saveSnapshot({ ...ledger, current_step: task });

    return result;
  }

  /**
   * Select the next agent to run using the conditional delegation graph.
   * Replaces ad-hoc next_speaker assignment in v2 orchestrator.
   */
  selectNext(currentAgent: string, ledger: ProgressLedger) {
    return selectNextSpeaker(
      currentAgent,
      ledger,
      this.config.delegationGraph,
      this.config.teamAgents,
    );
  }

  /**
   * Run post-session analysis and trigger reforge if warranted.
   * Call this in orchestrator teardown after all agents have run.
   */
  async postSession(): Promise<void> {
    const analysis = await this.feedbackCollector.analyze({ corroborationThreshold: 2 });

    this.eventBus.publish({
      type: "feedback_analysis_complete",
      source: "orchestrator-v3",
      payload: analysis,
      notify: ["*"],
    });

    const plan = await this.reforgeEngine.buildPlan(
      analysis,
      this.config.teamAgents,
      this.config.sessionCount,
    );

    if (plan) {
      await this.reforgeEngine.executePlan(plan);
    }
  }
}
```

```typescript
// New file additions summary — what v3 ships:

// INTELLIGENCE SQUAD (this proposal set):
// src/feedback/feedback-analyzer.ts          — FeedbackAnalyzer, analyzeFeedback()
// src/reforge/reforge-engine.ts              — ReforgeEngine, buildPlan(), executePlan(), applyOverride()
// src/reforge/reforge-types.ts               → src/types/reforge.ts  — ReforgePlan, AgentOverride, AgentMutation
// src/orchestrator/speaker-selector.ts       — selectNextSpeaker(), SpeakerSelector
// src/orchestrator/review-enforcer.ts        — enforceReviews(), ReviewResult
// src/orchestrator/session-store.ts          — SessionStore, saveSnapshot(), loadAllSnapshots()
// src/orchestrator/orchestrator-v3.ts        — OrchestratorV3 (wiring class)

// COST OPTIMIZATION SQUAD (companion proposals):
// src/routing/task-complexity-router.ts      — routeTask(), detectLowConfidence()
// src/budget/token-estimator.ts              — estimateTokensHeuristic()
// src/budget/budget-envelope.ts              — BudgetEnvelope
// src/budget/budget-aware-runner.ts          — runAgentWithBudget()
// src/orchestrator/cost-aware-runner.ts      — runCostAware() [6-stage pipeline]
// src/orchestrator/parallel-fan-out.ts       — runParallelFanOut()

// TYPE ADDITIONS (both squads):
// src/types/feedback.ts                      — FeedbackTheme, RecommendedAction, FeedbackAnalysis (intelligence squad)
// src/types/team.ts                          — DelegationEdge, ConditionalDelegationGraph (intelligence squad)
// src/types/agent.ts                         — category, budget, confidenceEscalationThreshold (cost squad)
// src/types/orchestration.ts                 — CostAwareRunDirective, CostAwareRunResult, FanOutDirective (cost squad)
// src/types/reforge.ts                       — ReforgeClass, AgentMutation, ReforgePlan, ReforgeResult, AgentOverride (intelligence squad)
```

## Impact

### What becomes possible in v3 that is impossible in v2

**1. Cross-session learning without a vector database.**
Agent system prompts evolve based on accumulated feedback. The `AgentOverride.systemPromptPreamble` is the memory system. It is stored in plain JSON, readable by humans, versioned, rollback-able. DSPy-style prompt optimization without DSPy's infrastructure.

**2. Cost routing that improves itself.**
The `TaskComplexityRouter` starts with static heuristics. As feedback accumulates and the `ReforgeEngine` adjusts model tier overrides based on empirical confidence data, the effective routing becomes data-driven. After 10 sessions, the Haiku/Sonnet/Opus splits reflect actual task complexity distributions — not the developer's initial guesses.

**3. Structural team evolution triggered by evidence.**
When 3 sessions in a row produce loop detection for the same agent (`LoopGuard.counters.retry_same_agent > 2`), and the `FeedbackAnalyzer` corroborates with a `stall` theme, the `ReforgeEngine` writes a structural proposal. A developer running `agentforge reforge apply <id>` gets a team designed around the evidence — not from scratch.

**4. Agent self-awareness.**
The `[REFORGE REQUESTED: reason]` convention gives agents a voice in their own evolution. An agent that knows it is struggling can say so explicitly, generating high-quality signal that bypasses statistical threshold requirements. This is the only mechanism in any of the major multi-agent frameworks (CrewAI, AutoGen, LangGraph, Magentic-One) where agents actively participate in their own redesign.

**5. Compounded cost savings beyond the cost squad's projections.**
The cost optimization squad projected 50-70% cost reduction from dynamic routing + fan-out + budget enforcement. The intelligence squad adds:
- Prompt evolution → 10-30% quality improvement at same cost (DSPy empirical result), meaning fewer re-runs
- Enforced reviews → fewer downstream errors from bad strategic agent outputs, reducing total work
- Self-calibrating routing → as the router learns from feedback, the 35-55% routing savings compound over sessions

Conservative additional saving: **15-25% on top of the cost squad's 50-70% base**, primarily from fewer re-runs and better first-pass quality.

### Files affected across both squads

| Existing file | Change | Squad |
|---|---|---|
| `src/types/agent.ts` | Add `category`, `budget`, `confidenceEscalationThreshold` | Cost |
| `src/types/feedback.ts` | Add `FeedbackTheme`, `RecommendedAction`, `FeedbackAnalysis` | Intelligence |
| `src/types/team.ts` | Add `DelegationEdge`, `ConditionalDelegationGraph` | Intelligence |
| `src/types/orchestration.ts` | Add `CostAwareRunDirective`, `FanOutDirective`, `CostAwareRunResult` | Cost |
| `src/feedback/feedback-collector.ts` | Add `analyze()` method | Intelligence |
| `src/orchestrator/cost-tracker.ts` | Export `MODEL_COSTS` | Cost |

All other changes are net-new files. No breaking changes to v2 interfaces. Migration path: adopt new files incrementally, replace `runAgent()` call sites with `OrchestratorV3.runAgent()`.

### The metric that proves v3 is self-improving

A self-improving system must show that it performs better over time without explicit developer intervention. For AgentForge v3, the measurable proxy is:

> **Average cost per completed task should decrease 10%+ between session 1 and session 10 of a project, holding task difficulty constant.**

This metric captures: routing improving (cheaper tier for same task), prompt evolution reducing re-runs, fan-out being triggered where appropriate. It is measurable from `CostTracker.getReport()` across sessions persisted in `SessionStore`. If this metric does not improve, the intelligence stack is not working — and the feedback about that failure would itself be captured and analyzed.

That circularity — the system generating feedback about its own feedback system — is what makes it genuinely self-improving, not just self-monitoring.
