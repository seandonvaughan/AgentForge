---
id: a7b8c9d0-e1f2-4a3b-8c4d-5e6f7a8b9c0d
agent: multi-agent-framework-researcher
category: feature
priority: high
timestamp: "2026-03-25T03:00:00.000Z"
---

# Multi-Agent Framework Patterns for AgentForge v3: What CrewAI, AutoGen, Magentic-One, and LangGraph Teach Us

## Problem

AgentForge v2 built its own orchestration primitives — `ProgressLedger`, `LoopGuard`, `EventBus`, `Handoff` — without explicitly codifying which patterns from the broader multi-agent research literature they embody. This leaves gaps:

1. **No DAG execution model**: `AgentCollaboration.parallel: boolean` is a flat flag. Real parallel execution requires a dependency graph that knows which agents can run simultaneously at any moment.
2. **No agent-to-agent learning**: agents never update their behavior based on past interactions. The `ProgressLedger` tracks facts within a session but never persists learnings across sessions.
3. **No adversarial review pattern**: there is no structured mechanism for one agent to challenge another's output before it propagates downstream. `reviews_from` lists exist but are never acted upon by the orchestrator.
4. **Static team topology**: the collaboration topology (flat/hierarchy/hub-and-spoke/matrix) is chosen at genesis time and never adapts during execution.

Each of these gaps maps to a well-studied pattern in the 2023-2025 multi-agent literature. v3 should adopt the most applicable patterns rather than reinventing them.

## Research

### CrewAI (role-based agents, 2023-2025)

**Core pattern**: Each agent has a `role`, `goal`, and `backstory` that are injected into the system prompt. Tasks are assigned to agents based on role match. Output from one task becomes the `context` input to the next task in the crew.

**What AgentForge already has**: `AgentTemplate.description`, `system_prompt`, `triggers.keywords` — these are functional analogues to CrewAI's role/goal/backstory. The key difference: CrewAI makes role-matching **explicit at orchestration time**; AgentForge currently does it implicitly at genesis time.

**Key patterns to adopt:**
- **Task context chaining**: CrewAI's `Task.context = [previous_task]` pattern — the output of task N is automatically injected into the context of task N+1. AgentForge's `Handoff` type covers this, but it requires explicit invocation. A `ContextChainMiddleware` that automatically forwards `AgentRunResult.response` as context to downstream agents in the delegation graph would close this gap.
- **Human-in-the-loop gates**: CrewAI's `human_input: true` on tasks pauses execution for human approval. Relevant for AgentForge when budget thresholds or confidence thresholds are crossed.
- **Memory types**: CrewAI (v0.41+) introduced 4 memory types: short-term (session buffer), long-term (RAG store), entity memory (named entity tracking), contextual memory (task-level). For AgentForge, only short-term (the `ProgressLedger`) and entity memory (the `facts` dict) are currently present.

### AutoGen (conversable agents, 2023-2025)

**Core pattern**: Every agent is a `ConversableAgent` with a `generate_reply` method. Agents exchange messages in a `GroupChat`. The `GroupChatManager` selects the next speaker. This makes agent-to-agent communication the first-class primitive, rather than a side effect of task delegation.

**What AgentForge already has**: `EventBus` is a pub-sub system that handles broadcasts; `DelegationPrimitives.delegate_work` / `ask_coworker` handle directed messages. But these are one-way — there is no structured request-response between agents within a session.

**Key patterns to adopt:**
- **Selector-based routing**: AutoGen's `GroupChatManager` uses a "selector" function to choose the next speaker. This maps to the `ProgressLedger.next_speaker` field — but currently `next_speaker` is set by the orchestrator, not by a selector function that considers agent capabilities and task state. A `SpeakerSelector` function that uses `ProgressLedger` state + agent capability declarations would make this data-driven.
- **Conversation memory as structured state**: AutoGen persists the full conversation history and gives each agent access to it. For AgentForge, this means `ProgressLedger.steps_completed` should be augmented with the actual agent responses, not just step labels.
- **Nested chats / sub-conversations**: AutoGen supports initiating a sub-conversation between two agents without exposing it to the full group. This is the right model for AgentForge's `ask_coworker` — the Q&A between two agents should be isolated from the main orchestration loop.

### Magentic-One (progress ledger, Microsoft 2024)

**Core pattern**: A central `Orchestrator` agent maintains a `ProgressLedger` — a structured assessment of task state updated after every agent action. The ledger drives all orchestration decisions: which agent acts next, whether to escalate, whether the task is complete. This is explicitly the pattern AgentForge v2 adopted.

**What AgentForge already has**: `ProgressLedger`, `ProgressLedgerManager`, `LoopGuard` — these are direct implementations of the Magentic-One pattern. The gap is that AgentForge's ledger is session-local and never persists.

**Key patterns to adopt from Magentic-One beyond what v2 has:**
- **Ledger persistence across sessions**: Magentic-One's ledger is the source of truth for task resumption after interruption. AgentForge should serialize the `ProgressLedger` to `.agentforge/sessions/{task_id}.json` so interrupted sessions can resume.
- **Orchestrator-as-agent**: In Magentic-One, the Orchestrator is itself an LLM agent that reasons about the ledger in natural language. AgentForge's orchestrator is currently code-driven. For complex tasks, an LLM-backed orchestrator that can interpret the ledger and produce the next instruction would be more adaptive.
- **Stall recovery actions**: When `ProgressLedger.is_progress_being_made = false`, Magentic-One's orchestrator has a set of recovery strategies: replanning, agent replacement, task decomposition. AgentForge's `LoopGuard` detects the stall but has no recovery strategy — it only escalates.

### LangGraph (state machines, 2024-2025)

**Core pattern**: Agent execution is modeled as a directed graph where nodes are agents/functions and edges are conditional transitions. State is a typed object that flows through the graph, with reducer functions handling concurrent writes. Graph topology is defined in code, enabling dynamic graph construction.

**What AgentForge already has**: `DelegationGraph` (from `src/types/team.ts`) is a static adjacency list. `AgentCollaboration.can_delegate_to` defines edges. The topology is fixed at genesis time.

**Key patterns to adopt:**
- **Conditional edges as first-class primitives**: LangGraph's `add_conditional_edges` lets you route to different nodes based on the current state. For AgentForge, this means replacing the static `DelegationGraph` with a `ConditionalDelegationGraph` where edges carry predicates: `IF confidence < 0.6 THEN escalate_to: "architect"`.
- **State reducers for parallel writes**: When multiple agents run in parallel and write to shared state, LangGraph's reducers merge their outputs deterministically. For AgentForge's fan-out engine (proposed by the parallel-execution researcher), a typed state reducer prevents lost updates.
- **Checkpointing**: LangGraph persists state at every node transition. Combined with Magentic-One's ledger persistence, this enables full task replay for debugging.
- **Human-in-the-loop as interrupt**: LangGraph's `interrupt_before`/`interrupt_after` pauses the graph at a node boundary and waits for human input. This is the correct model for AgentForge's budget threshold actions (`"approve"` in `BudgetThresholdAction`).

### State of the Art in Multi-Agent Coordination (2025)

The most significant 2024-2025 advances:
1. **Tool use as coordination**: agents increasingly coordinate via shared tool calls (filesystem reads/writes, API calls) rather than message passing. AgentForge's `.agentforge/feedback/` directory is already an example of shared-filesystem coordination.
2. **Reflection agents**: a dedicated reflection/critique agent reviews other agents' outputs before they're accepted. Pattern: `worker_agent → reflection_agent → [approve | revise loop] → downstream`. This is distinct from the `reviews_from` field which is not currently enforced.
3. **Mixture-of-agents (MoA)**: multiple agents independently generate responses; a synthesis agent produces the final answer from the mixture. This is the fan-out pattern applied to final-answer generation, not just intermediate analysis.
4. **Agent personas that update**: DSPy's `BootstrapFewShot` and related optimizers update few-shot examples in agent system prompts based on task performance. The system prompt becomes a learning artifact, not just configuration.

## Findings

**Finding 1: AgentForge's gap is not in primitives but in wiring.** The `ProgressLedger`, `Handoff`, `EventBus`, `LoopGuard`, and `DelegationGraph` are all sound implementations of established patterns. The missing piece is the **orchestration loop** that wires them together at runtime — the equivalent of AutoGen's `GroupChatManager` or LangGraph's graph executor.

**Finding 2: Conditional edges are the highest-impact gap.** Static delegation graphs cannot adapt to runtime state (confidence, budget, failure). Conditional edges — where routing decisions are data-driven — would enable all three self-improvement mechanisms: escalation routing, reforge triggering, and adaptive topology.

**Finding 3: The adversarial review pattern is entirely absent.** No framework pattern is more consistently effective at improving output quality than having a dedicated critic agent review work before it proceeds. AgentForge's `reviews_from` field exists but the orchestrator never enforces it. Enforcing it for high-confidence outputs on `strategic` and `quality` agents is a high-ROI change with minimal implementation cost.

**Finding 4: Session memory is the missing link between sessions.** All current AgentForge state is ephemeral. Persisting `ProgressLedger` snapshots and `FeedbackAnalysis` results creates the longitudinal data that makes self-improvement possible.

**Finding 5: LLM-backed orchestration is premature for v3 but should be architected for.** A fully LLM-backed orchestrator (as in Magentic-One) is powerful but unpredictable and expensive. v3 should keep the code-driven orchestrator but expose an `OrchestratorPlugin` interface so an LLM-backed implementation can be swapped in without restructuring the architecture.

**Trade-offs:**
- Conditional edges vs. static graphs: more powerful but harder to test and reason about; mitigated by requiring predicates to be pure functions of ledger state
- Reflection agents: adds latency (one extra agent call per work product); worth it for `critical` tasks, skip for `utility` agents
- Session persistence: adds disk I/O; trivial overhead given feedback files already write to disk

## Recommendation

Adopt four specific patterns from the literature for v3:

1. **Conditional delegation edges** (from LangGraph) — replace `DelegationGraph: Record<string, string[]>` with `DelegationGraph: Record<string, DelegationEdge[]>` where each edge carries an optional predicate
2. **Enforced adversarial review** (reflection agent pattern) — the orchestrator enforces `reviews_from` for `strategic` and `quality` agents, creating a structured critique loop
3. **Session ledger persistence** (from Magentic-One) — serialize `ProgressLedger` to `.agentforge/sessions/` at each step, enabling resumption and cross-session learning
4. **Speaker selector function** (from AutoGen) — replace the ad-hoc `next_speaker` assignment with a typed `SpeakerSelector` function that uses ledger state + capability declarations to choose the next agent deterministically

## Implementation Sketch

```typescript
// src/types/team.ts — replace DelegationGraph

/** Predicate evaluated against ProgressLedger state to determine if an edge is active. */
export type EdgePredicate = (ledger: ProgressLedger) => boolean;

/** A directed edge in the delegation graph with an optional activation condition. */
export interface DelegationEdge {
  /** Target agent name. */
  to: string;
  /**
   * Optional predicate — if absent, edge is always active.
   * If present, edge is only followed when predicate returns true.
   */
  when?: EdgePredicate;
  /**
   * Human-readable label describing when this edge activates.
   * Required when `when` is provided, for debugging and display.
   */
  label?: string;
}

/**
 * Conditional delegation graph: maps each agent to its list of conditional outgoing edges.
 * Replaces the previous Record<string, string[]> type.
 */
export type ConditionalDelegationGraph = Record<string, DelegationEdge[]>;
```

```typescript
// src/orchestrator/speaker-selector.ts — NEW

import type { ProgressLedger } from "../types/orchestration.js";
import type { ConditionalDelegationGraph } from "../types/team.js";
import type { AgentTemplate } from "../types/agent.js";

export interface SpeakerSelection {
  agentName: string;
  rationale: string;
  activeEdges: string[];  // labels of edges that were active
}

/**
 * Selects the next agent to speak based on ledger state and the conditional
 * delegation graph. Pure function — no side effects.
 *
 * Priority:
 * 1. If ledger.next_speaker is explicitly set, honor it.
 * 2. Find the current agent's outgoing edges whose predicates return true.
 * 3. Among active edges, prefer agents whose capabilities match ledger.instruction.
 * 4. Fall back to the first active edge.
 *
 * Inspired by AutoGen's GroupChatManager selector pattern.
 */
export function selectNextSpeaker(
  currentAgent: string,
  ledger: ProgressLedger,
  graph: ConditionalDelegationGraph,
  agents: Map<string, AgentTemplate>,
): SpeakerSelection | null {
  // Explicit override from orchestrator
  if (ledger.next_speaker && ledger.next_speaker !== currentAgent) {
    return {
      agentName: ledger.next_speaker,
      rationale: "explicit next_speaker in progress ledger",
      activeEdges: [],
    };
  }

  const edges = graph[currentAgent] ?? [];
  const activeEdges = edges.filter((e) => !e.when || e.when(ledger));

  if (activeEdges.length === 0) return null;

  // Prefer agents whose triggers.keywords match the current instruction
  const instruction = ledger.instruction.toLowerCase();
  const scored = activeEdges.map((edge) => {
    const agent = agents.get(edge.to);
    const keywordScore = agent?.triggers.keywords.filter((kw) =>
      instruction.includes(kw.toLowerCase())
    ).length ?? 0;
    return { edge, score: keywordScore };
  });

  scored.sort((a, b) => b.score - a.score);
  const chosen = scored[0].edge;

  return {
    agentName: chosen.to,
    rationale: chosen.label ?? `active edge to ${chosen.to}`,
    activeEdges: activeEdges.map((e) => e.label ?? e.to),
  };
}
```

```typescript
// src/orchestrator/review-enforcer.ts — NEW
// Enforces the reviews_from field for strategic and quality agents

import type { AgentTemplate } from "../types/agent.js";
import type { AgentRunResult } from "../api/agent-runner.js";
import { runAgent } from "../api/agent-runner.js";

export interface ReviewResult {
  approved: boolean;
  reviewer: string;
  critique: string;
  revisionRequired: boolean;
  confidence: number;
}

/**
 * If the producing agent is strategic or quality, runs each reviewer in
 * agent.collaboration.reviews_from against the produced artifact.
 *
 * Returns the first rejection if any reviewer rejects, or approval if all approve.
 * Max 2 review cycles to prevent infinite loops (consistent with LoopGuard defaults).
 *
 * Implements the adversarial review / reflection agent pattern.
 */
export async function enforceReviews(
  producingAgent: AgentTemplate,
  artifact: AgentRunResult,
  reviewers: Map<string, AgentTemplate>,
  maxCycles = 2,
): Promise<ReviewResult> {
  // Only enforce for strategic and quality agents (cost trade-off)
  if (
    producingAgent.name.match(/utility|linter|formatter|watcher|reporter/)
  ) {
    return {
      approved: true,
      reviewer: "skipped",
      critique: "Review skipped for utility agent.",
      revisionRequired: false,
      confidence: 1.0,
    };
  }

  for (const reviewerName of producingAgent.collaboration.reviews_from) {
    const reviewer = reviewers.get(reviewerName);
    if (!reviewer) continue;

    const reviewTask =
      `Review the following output from agent "${producingAgent.name}".\n\n` +
      `Output:\n${artifact.response}\n\n` +
      `Assess: (1) correctness, (2) completeness, (3) alignment with objectives.\n` +
      `End your review with: "APPROVED" or "REVISION REQUIRED: <reason>".\n` +
      `Rate your confidence 1-5.`;

    const reviewResult = await runAgent(reviewer, reviewTask);
    const approved = /APPROVED/i.test(reviewResult.response);
    const revisionMatch = reviewResult.response.match(/REVISION REQUIRED:\s*(.+)/i);
    const confidenceMatch = reviewResult.response.match(/confidence:\s*([1-5])\/5/i);

    return {
      approved,
      reviewer: reviewerName,
      critique: reviewResult.response,
      revisionRequired: !approved,
      confidence: confidenceMatch ? parseInt(confidenceMatch[1]) / 5 : 0.6,
    };
  }

  // No reviewers configured or found
  return {
    approved: true,
    reviewer: "none",
    critique: "No reviewers configured.",
    revisionRequired: false,
    confidence: 0.8,
  };
}
```

```typescript
// src/orchestrator/session-store.ts — NEW
// Persists ProgressLedger snapshots across sessions

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ProgressLedger } from "../types/orchestration.js";

export class SessionStore {
  private sessionsDir: string;

  constructor(projectRoot: string) {
    this.sessionsDir = path.join(projectRoot, ".agentforge", "sessions");
  }

  async saveSnapshot(ledger: ProgressLedger): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    const filePath = path.join(
      this.sessionsDir,
      `${ledger.task_id}-${Date.now()}.json`
    );
    await fs.writeFile(filePath, JSON.stringify(ledger, null, 2), "utf-8");
  }

  async loadLatest(taskId: string): Promise<ProgressLedger | null> {
    try {
      const entries = await fs.readdir(this.sessionsDir);
      const snapshots = entries
        .filter((f) => f.startsWith(taskId) && f.endsWith(".json"))
        .sort()
        .reverse();
      if (snapshots.length === 0) return null;
      const raw = await fs.readFile(
        path.join(this.sessionsDir, snapshots[0]),
        "utf-8"
      );
      return JSON.parse(raw) as ProgressLedger;
    } catch {
      return null;
    }
  }

  /** Load all snapshots for cross-session learning — used by ReforgeEngine. */
  async loadAllSnapshots(): Promise<ProgressLedger[]> {
    try {
      const entries = await fs.readdir(this.sessionsDir);
      const results: ProgressLedger[] = [];
      for (const f of entries.filter((e) => e.endsWith(".json"))) {
        try {
          const raw = await fs.readFile(path.join(this.sessionsDir, f), "utf-8");
          results.push(JSON.parse(raw) as ProgressLedger);
        } catch { /* skip malformed */ }
      }
      return results;
    } catch {
      return [];
    }
  }
}
```

## Impact

Adopting these four patterns transforms AgentForge from a static orchestration engine into an adaptive one:

1. **Conditional edges** mean the delegation graph responds to runtime state — low confidence routes to a stronger agent, budget exhaustion routes to a cheaper one, loop detection routes to a fresh agent. No code changes required for each new routing rule — just add a predicate.

2. **Enforced reviews** catch errors before they propagate through the delegation chain. A single incorrect architectural decision from an Opus agent can cost many downstream agent-hours to repair; a review cycle costs one Sonnet call.

3. **Session ledger persistence** creates the longitudinal data that the `ReforgeEngine` needs to propose team improvements: which agents stalled repeatedly, which tasks exceeded budget, which reviews consistently rejected the first draft.

4. **Speaker selector** makes orchestration decisions auditable. The `SpeakerSelection.rationale` field explains every agent dispatch in human-readable terms, making debugging and tuning tractable.

Together, these four changes implement the core of what Magentic-One, AutoGen, LangGraph, and CrewAI each contribute — without importing any of their dependencies or abandoning AgentForge's existing type-safe architecture.
