---
id: e9c4a7b2-1f3d-4e85-9c6a-7b2d0f8e1a3c
agent: self-improvement-researcher
category: feature
priority: high
timestamp: "2026-03-25T03:00:00.000Z"
---

# ReforgeEngine: Automatic Team Evolution via Feedback-Driven Self-Improvement

## Problem

AgentForge v2's teams are static. A team is designed once by `genesis/team-designer.ts`, composed by `builder/team-composer.ts`, and then runs unchanged for the duration of the project. There is no mechanism to:

1. Detect when a team is structurally underperforming (not just a single-session failure)
2. Automatically propose team changes based on accumulated performance data
3. Apply those changes without human intervention for low-risk adjustments (model tier swaps, prompt updates)
4. Allow agents to propose their own replacement or modification
5. Close the loop between `FeedbackCollector` (writes feedback) and `designTeam` (designs teams)

The feedback loop exists at the file layer: agents write to `.agentforge/feedback/`. The analysis layer is proposed by the `feedback-analysis-researcher`. But nothing converts a `RecommendedAction` into an actual team mutation. Without a `ReforgeEngine`, the self-improvement system is a reporting dashboard — observations with no effectors.

## Research

### DSPy (Stanford, 2023-2025) — Prompt Optimization as the Feedback Loop

DSPy's core insight is that system prompts are parameters, not constants. Its `BootstrapFewShot` optimizer generates few-shot examples from successful runs and injects them into the system prompt, effectively making the agent learn from its own successes. `MIPROv2` goes further: it proposes alternative system prompt variants, evaluates them against a metric, and selects the best.

**Applicable pattern for AgentForge:** Agent system prompts should be versioned artifacts, not hardcoded strings. A `PromptEvolver` can propose modified system prompts based on: (a) recurring failure patterns in feedback, (b) successful task completions (use those as implicit few-shot examples), and (c) review critique content from `review-enforcer.ts`. The evolved prompt is A/B tested on low-stakes tasks before being promoted to production.

**Key finding:** DSPy shows that 10-30% quality improvement is achievable through systematic prompt optimization on the same model tier — no model upgrade required.

### AutoGen's Agent Selection and Replacement (2024)

AutoGen's `GroupChat` supports dynamic agent replacement: if an agent fails N times consecutively, it can be removed from the group and replaced by a different agent type. The replacement logic is currently manual (developer-configured), but the pattern is clear: **agents should have a replacement policy**.

**Applicable pattern:** Each `AgentTemplate` should carry a `replacement_policy` that specifies: after how many failures, with what signal (low confidence, timeout, loop detection), with which alternative agent. The `ReforgeEngine` enforces this policy based on session history from `SessionStore`.

### Self-Referential Feedback in LLM Systems (2024 research literature)

"Constitutional AI" (Anthropic, 2022) established that LLMs can critique and revise their own outputs using a set of principles. "Self-Refine" (Madaan et al., 2023) extended this to multi-step iterative self-improvement. "Reflexion" (Shinn et al., 2023) is the most directly applicable: agents maintain a "verbal reinforcement learning" signal (a text summary of past failures and what to try differently), which is prepended to future runs.

**Reflexion's core mechanism:**
1. Agent attempts a task
2. If the attempt fails (by some evaluator), the evaluator writes a natural-language "reflection" explaining what went wrong
3. The reflection is stored in an episodic memory buffer
4. On the next attempt, the buffer is prepended to the agent's context
5. Repeat until success or max attempts exceeded

**Applicable pattern for AgentForge:** The `FeedbackAnalysis.recommended_actions` from the `FeedbackAnalyzer` are already a structured form of "verbal RL signal." The `ReforgeEngine` should use them to generate updated system prompt preambles: brief, high-signal summaries of what to do differently, prepended to the agent's system prompt for the next session.

### Reinforcement Learning from AI Feedback (RLAIF) vs. Heuristic Triggers

RLAIF uses an AI model to score agent outputs and generate preference pairs for RL. This is powerful but expensive (requires a reward model) and inappropriate for a CLI tool. The applicable subset is **heuristic-based triggering**: instead of a learned reward signal, use observable metrics as proxies.

**Reforge trigger metrics that are already observable in AgentForge v2:**

| Metric | Where it lives | Reforge trigger |
|--------|---------------|-----------------|
| Repeated loop detection | `LoopGuard.getCounters()` | `retry_same_agent > 2` in same session |
| Stall detection | `ProgressLedger.is_progress_being_made` | False for 3+ consecutive checks |
| Budget overrun | `CostTracker.getReport()` | Actual > 150% of estimated |
| Low confidence output | `detectLowConfidence()` in routing module | 3+ escalations in one session |
| Review rejection rate | `ReviewResult.approved` | Rejected on first draft > 50% of artifacts |
| Feedback volume spike | `FeedbackAnalysis.total_entries` | > 5 new entries in one session |
| Cross-agent theme corroboration | `FeedbackTheme.corroborating_agents` | 2+ agents, signal_strength > 0.7 |

### Agent Self-Nomination for Replacement

The most novel pattern from the 2024 literature: agents explicitly flag when they are the wrong tool for a task. In "Gorilla" (UC Berkeley) and "ToolBench" research, tool-calling agents output a special token when they determine they cannot accomplish the task with available tools, triggering escalation to a more capable model.

**For AgentForge:** A lightweight convention: agents include a `[REFORGE REQUESTED: reason]` marker in their response when they determine they cannot succeed at the task within their current configuration. The orchestrator detects this marker and routes it to the `ReforgeEngine` as an immediate reforge trigger, bypassing the threshold-based detection.

## Findings

**Finding 1: Two classes of reforge — local and structural.**
- **Local reforge**: update a single agent's system prompt preamble, swap its model tier, adjust its `LoopGuard` limit. Low risk, can be applied automatically without human approval.
- **Structural reforge**: add/remove agents from the team, change the collaboration topology, introduce a new domain pack. Higher risk, requires human approval or a high-confidence signal from the analyzer.

The `ReforgeEngine` should implement local reforges autonomously and structural reforges as proposals that are written to `.agentforge/reforge-proposals/` for human review or explicit CLI approval (`agentforge reforge apply`).

**Finding 2: Prompt evolution is the highest-ROI local reforge.**
Swapping model tiers is blunt (Opus → Sonnet may break quality). Prompt evolution is precise: add a preamble like "In previous sessions, you tended to produce overly verbose responses. Be concise. Aim for 200-400 tokens." This costs nothing at inference time and measurably changes agent behavior.

**Finding 3: The reforge must be versioned.**
Agent system prompts that are mutated by the `ReforgeEngine` must be versioned so mutations can be rolled back if they degrade performance. `.agentforge/agent-versions/{agent-name}/v{n}.json` is the natural storage location.

**Finding 4: Trigger debouncing prevents thrashing.**
A team should not be reforged every session. Minimum reforge interval: 3 sessions or 24 hours, whichever is longer. Emergency override: a `critical` priority feedback entry bypasses the debounce.

**Finding 5: The `designTeam` function in `genesis/team-designer.ts` is the natural reforge target.**
A full structural reforge is just calling `designTeam` again with an augmented `ProjectBrief` that incorporates lessons from the feedback analysis. The `ReforgeEngine` does not need to implement team design logic — it prepares a modified brief and calls the existing function.

**Trade-offs:**
- Autonomous reforge vs. human approval: Autonomous is more powerful but risks compounding errors. Mitigation: only automate local reforges; always require approval for structural changes.
- Prompt evolution vs. model tier changes: Prompts are free to iterate; tier changes affect cost. Default to prompt evolution first, tier changes only when prompt evolution fails after 3 attempts.
- Versioning overhead: Each reforge writes a new file. Mitigated by a pruning policy (keep last 5 versions per agent).

## Recommendation

Implement a `ReforgeEngine` in `src/reforge/reforge-engine.ts` that:
1. Consumes `FeedbackAnalysis.recommended_actions` from the `FeedbackAnalyzer`
2. Consumes `ProgressLedger` snapshots from the `SessionStore` (proposed by multi-agent-framework-researcher)
3. Classifies each recommended action as local or structural
4. For local reforges: executes immediately — writes updated agent configuration to `.agentforge/agent-overrides/`
5. For structural reforges: writes a proposal to `.agentforge/reforge-proposals/` and emits a `reforge_proposed` event on the `EventBus`
6. Publishes `reforge_applied` or `reforge_proposed` events for downstream consumers

## Implementation Sketch

```typescript
// src/types/reforge.ts — new file

import type { RecommendedAction, FeedbackAnalysis } from "./feedback.js";
import type { AgentTemplate } from "./agent.js";
import type { TeamManifest } from "./team.js";

/** Classification of a reforge operation by risk level. */
export type ReforgeClass = "local" | "structural";

/** A single mutation to apply to one agent's configuration. */
export interface AgentMutation {
  /** Agent being mutated. */
  agentName: string;
  /** What changed. */
  mutationType: "prompt-preamble" | "model-tier-downgrade" | "model-tier-upgrade"
              | "loop-limit-adjust" | "add-keyword-trigger" | "remove-agent" | "add-agent";
  /** Previous value (for rollback). */
  previousValue: unknown;
  /** New value. */
  newValue: unknown;
  /** Human-readable reason. */
  rationale: string;
}

/** A reforge plan produced by the engine before execution. */
export interface ReforgePlan {
  id: string;
  timestamp: string;
  reforgeClass: ReforgeClass;
  triggeredBy: RecommendedAction[];
  mutations: AgentMutation[];
  /** For structural reforges: the proposed new team manifest. */
  proposedManifest?: TeamManifest;
  /** Requires human approval before application. */
  requiresApproval: boolean;
  /** Summary for display in CLI output. */
  summary: string;
}

/** Result after a reforge plan is applied. */
export interface ReforgeResult {
  plan: ReforgePlan;
  applied: boolean;
  appliedMutations: AgentMutation[];
  skippedMutations: AgentMutation[];
  errors: string[];
  newAgentVersions: Record<string, number>;  // agent name → new version number
}

/** Persisted agent configuration override — what the engine writes to disk. */
export interface AgentOverride {
  agentName: string;
  version: number;
  appliedAt: string;
  systemPromptPreamble?: string;  // prepended to base system_prompt at runtime
  modelTierOverride?: "opus" | "sonnet" | "haiku";
  loopLimitOverrides?: Partial<import("./collaboration.js").LoopLimits>;
  additionalKeywordTriggers?: string[];
  reforgeHistory: Array<{
    version: number;
    timestamp: string;
    mutationType: AgentMutation["mutationType"];
    rationale: string;
  }>;
}
```

```typescript
// src/reforge/reforge-engine.ts

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FeedbackAnalysis, RecommendedAction } from "../types/feedback.js";
import type { AgentTemplate } from "../types/agent.js";
import type { ProgressLedger } from "../types/orchestration.js";
import type {
  ReforgeClass,
  AgentMutation,
  ReforgePlan,
  ReforgeResult,
  AgentOverride,
} from "../types/reforge.js";
import { EventBus } from "../orchestrator/event-bus.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum sessions between automatic reforges to prevent thrashing. */
const MIN_SESSIONS_BETWEEN_REFORGE = 3;

/** Signal strength above which an action triggers a structural reforge proposal. */
const STRUCTURAL_REFORGE_THRESHOLD = 0.75;

/** Signal strength above which an action triggers an autonomous local reforge. */
const LOCAL_REFORGE_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function classifyAction(action: RecommendedAction): ReforgeClass {
  switch (action.action) {
    case "adjust-model-routing":
    case "update-system-prompt":
    case "increase-budget-ceiling":
      return "local";
    case "reforge-team":
    case "add-agent":
    case "remove-agent":
      return "structural";
    case "review-manually":
    default:
      return action.confidence > STRUCTURAL_REFORGE_THRESHOLD ? "structural" : "local";
  }
}

// ---------------------------------------------------------------------------
// Mutation builders
// ---------------------------------------------------------------------------

/**
 * Builds a prompt preamble mutation from a feedback analysis action.
 * The preamble is prepended to the agent's system_prompt at runtime.
 */
function buildPromptPreambleMutation(
  agentName: string,
  action: RecommendedAction,
  currentPreamble?: string,
): AgentMutation {
  const lessons = [
    `[Session learning — ${new Date().toISOString().slice(0, 10)}]`,
    `Based on feedback analysis: ${action.rationale}`,
    `Confidence: ${(action.confidence * 100).toFixed(0)}%.`,
    `Adjust your approach accordingly.`,
  ].join(" ");

  return {
    agentName,
    mutationType: "prompt-preamble",
    previousValue: currentPreamble ?? "",
    newValue: lessons,
    rationale: action.rationale,
  };
}

function buildModelTierMutation(
  agentName: string,
  currentTier: "opus" | "sonnet" | "haiku",
  targetTier: "opus" | "sonnet" | "haiku",
  rationale: string,
): AgentMutation {
  const isUpgrade = ["haiku", "sonnet", "opus"].indexOf(targetTier) >
                    ["haiku", "sonnet", "opus"].indexOf(currentTier);
  return {
    agentName,
    mutationType: isUpgrade ? "model-tier-upgrade" : "model-tier-downgrade",
    previousValue: currentTier,
    newValue: targetTier,
    rationale,
  };
}

// ---------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------

export interface ReforgeEngineOptions {
  projectRoot: string;
  eventBus?: EventBus;
  /** Override minimum sessions between reforges (for testing). */
  minSessionsBetweenReforge?: number;
}

export class ReforgeEngine {
  private overridesDir: string;
  private proposalsDir: string;
  private eventBus?: EventBus;
  private minSessions: number;

  constructor(options: ReforgeEngineOptions) {
    this.overridesDir = path.join(options.projectRoot, ".agentforge", "agent-overrides");
    this.proposalsDir = path.join(options.projectRoot, ".agentforge", "reforge-proposals");
    this.eventBus = options.eventBus;
    this.minSessions = options.minSessionsBetweenReforge ?? MIN_SESSIONS_BETWEEN_REFORGE;
  }

  /**
   * Load the current override for an agent, or return a default.
   */
  async loadOverride(agentName: string): Promise<AgentOverride> {
    const filePath = path.join(this.overridesDir, `${agentName}.json`);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return JSON.parse(raw) as AgentOverride;
    } catch {
      return {
        agentName,
        version: 0,
        appliedAt: new Date().toISOString(),
        reforgeHistory: [],
      };
    }
  }

  /**
   * Persist an updated agent override to disk.
   */
  async saveOverride(override: AgentOverride): Promise<void> {
    await fs.mkdir(this.overridesDir, { recursive: true });
    const filePath = path.join(this.overridesDir, `${override.agentName}.json`);
    await fs.writeFile(filePath, JSON.stringify(override, null, 2), "utf-8");
  }

  /**
   * Apply an agent override at runtime — returns a modified AgentTemplate
   * with the override preamble prepended and model tier applied.
   *
   * Call this in the orchestrator before each agent invocation.
   */
  async applyOverride(agent: AgentTemplate): Promise<AgentTemplate> {
    const override = await this.loadOverride(agent.name);
    let mutated = { ...agent };

    if (override.systemPromptPreamble) {
      mutated = {
        ...mutated,
        system_prompt: `${override.systemPromptPreamble}\n\n---\n\n${agent.system_prompt}`,
      };
    }

    if (override.modelTierOverride) {
      mutated = { ...mutated, model: override.modelTierOverride };
    }

    return mutated;
  }

  /**
   * Build a reforge plan from a feedback analysis.
   *
   * Actions below the LOCAL_REFORGE_THRESHOLD are skipped.
   * Actions at or above STRUCTURAL_REFORGE_THRESHOLD become structural proposals.
   * Actions in between become local autonomous mutations.
   */
  async buildPlan(
    analysis: FeedbackAnalysis,
    teamAgents: Map<string, AgentTemplate>,
    sessionCount: number,
  ): Promise<ReforgePlan | null> {
    // Debounce check
    if (sessionCount < this.minSessions) {
      return null;
    }

    const actionableActions = analysis.recommended_actions.filter(
      (a) => a.confidence >= LOCAL_REFORGE_THRESHOLD,
    );

    if (actionableActions.length === 0) return null;

    const mutations: AgentMutation[] = [];
    let reforgeClass: ReforgeClass = "local";

    for (const action of actionableActions) {
      const actionClass = classifyAction(action);
      if (actionClass === "structural") {
        reforgeClass = "structural";
        // Structural mutations are represented as metadata — actual design
        // is deferred to designTeam() call with the modified brief
        continue;
      }

      // Local mutations: apply to the most relevant agents
      // For now, apply to all agents mentioned in the corroborating themes
      const affectedTheme = analysis.themes.find((t) =>
        t.label === action.theme_label
      );
      const affectedAgents = affectedTheme?.corroborating_agents ?? [...teamAgents.keys()].slice(0, 1);

      for (const agentName of affectedAgents) {
        const agent = teamAgents.get(agentName);
        if (!agent) continue;

        if (action.action === "update-system-prompt" || action.action === "review-manually") {
          const currentOverride = await this.loadOverride(agentName);
          mutations.push(buildPromptPreambleMutation(
            agentName,
            action,
            currentOverride.systemPromptPreamble,
          ));
        }

        if (action.action === "adjust-model-routing" && agent.model === "opus") {
          // Propose downgrade to Sonnet for cost reduction (local reforge)
          mutations.push(buildModelTierMutation(
            agentName,
            agent.model,
            "sonnet",
            `Cost feedback indicates ${agentName} may be over-tiered. Downgrading to Sonnet.`,
          ));
        }
      }
    }

    if (mutations.length === 0 && reforgeClass === "local") return null;

    const requiresApproval = reforgeClass === "structural";
    const summary = reforgeClass === "structural"
      ? `Structural reforge proposed: ${actionableActions.filter(a => classifyAction(a) === "structural").map(a => a.action).join(", ")}`
      : `Local reforge: ${mutations.length} agent mutation(s) — ${mutations.map(m => m.mutationType).join(", ")}`;

    return {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      reforgeClass,
      triggeredBy: actionableActions,
      mutations,
      requiresApproval,
      summary,
    };
  }

  /**
   * Execute a reforge plan.
   *
   * For local plans: applies mutations immediately to .agentforge/agent-overrides/.
   * For structural plans: writes to .agentforge/reforge-proposals/ and emits event.
   */
  async executePlan(plan: ReforgePlan): Promise<ReforgeResult> {
    const appliedMutations: AgentMutation[] = [];
    const skippedMutations: AgentMutation[] = [];
    const errors: string[] = [];
    const newVersions: Record<string, number> = {};

    if (plan.requiresApproval) {
      // Write proposal to disk for human review
      await fs.mkdir(this.proposalsDir, { recursive: true });
      const proposalPath = path.join(this.proposalsDir, `${plan.id}.json`);
      await fs.writeFile(proposalPath, JSON.stringify(plan, null, 2), "utf-8");

      this.eventBus?.publish({
        type: "reforge_proposed",
        source: "reforge-engine",
        payload: { planId: plan.id, summary: plan.summary, proposalPath },
        notify: ["*"],
      });

      return {
        plan,
        applied: false,
        appliedMutations: [],
        skippedMutations: plan.mutations,
        errors: [],
        newAgentVersions: {},
      };
    }

    // Apply local mutations
    for (const mutation of plan.mutations) {
      try {
        const override = await this.loadOverride(mutation.agentName);
        const newVersion = override.version + 1;

        switch (mutation.mutationType) {
          case "prompt-preamble":
            override.systemPromptPreamble = mutation.newValue as string;
            break;
          case "model-tier-downgrade":
          case "model-tier-upgrade":
            override.modelTierOverride = mutation.newValue as "opus" | "sonnet" | "haiku";
            break;
          case "loop-limit-adjust":
            override.loopLimitOverrides = mutation.newValue as Record<string, number>;
            break;
        }

        override.version = newVersion;
        override.appliedAt = new Date().toISOString();
        override.reforgeHistory.push({
          version: newVersion,
          timestamp: new Date().toISOString(),
          mutationType: mutation.mutationType,
          rationale: mutation.rationale,
        });

        // Keep last 10 history entries
        if (override.reforgeHistory.length > 10) {
          override.reforgeHistory = override.reforgeHistory.slice(-10);
        }

        await this.saveOverride(override);
        appliedMutations.push(mutation);
        newVersions[mutation.agentName] = newVersion;
      } catch (err) {
        errors.push(`Failed to apply mutation to ${mutation.agentName}: ${String(err)}`);
        skippedMutations.push(mutation);
      }
    }

    this.eventBus?.publish({
      type: "reforge_applied",
      source: "reforge-engine",
      payload: {
        planId: plan.id,
        appliedCount: appliedMutations.length,
        summary: plan.summary,
        newVersions,
      },
      notify: ["*"],
    });

    return {
      plan,
      applied: true,
      appliedMutations,
      skippedMutations,
      errors,
      newAgentVersions: newVersions,
    };
  }
}
```

```typescript
// Integration: post-session reforge trigger in orchestrator teardown
// (adds to the runPostSessionAnalysis function from feedback-analysis-researcher proposal)

import { ReforgeEngine } from "../reforge/reforge-engine.js";
import { FeedbackCollector } from "../feedback/feedback-collector.js";
import { EventBus } from "../orchestrator/event-bus.js";

export async function runPostSessionReforge(
  projectRoot: string,
  teamAgents: Map<string, AgentTemplate>,
  sessionCount: number,
  eventBus: EventBus,
): Promise<ReforgeResult | null> {
  // Step 1: Analyze feedback
  const collector = new FeedbackCollector(projectRoot);
  const analysis = await collector.analyze({ corroborationThreshold: 2 });

  if (!analysis.requires_escalation && analysis.recommended_actions.length === 0) {
    return null;
  }

  // Step 2: Build reforge plan
  const engine = new ReforgeEngine({ projectRoot, eventBus });
  const plan = await engine.buildPlan(analysis, teamAgents, sessionCount);

  if (!plan) return null;

  // Step 3: Execute plan (local immediately, structural → proposal)
  return engine.executePlan(plan);
}
```

```typescript
// Integration: apply agent overrides before each invocation in orchestrator
// Replace the direct agent reference with the override-applied version:

import { ReforgeEngine } from "../reforge/reforge-engine.js";

const engine = new ReforgeEngine({ projectRoot, eventBus });

// Before:
const result = await runCostAware({ agent, task, envelope, costTracker, context });

// After:
const evolvedAgent = await engine.applyOverride(agent);
const result = await runCostAware({ agent: evolvedAgent, task, envelope, costTracker, context });
```

## Impact

The `ReforgeEngine` completes the self-improvement loop that v2 leaves open. Concretely:

1. **The feedback-to-action gap closes.** `FeedbackAnalyzer` produces `RecommendedAction[]`. `ReforgeEngine` consumes them and produces real file-system mutations. The pipeline is: `agent runs → writes feedback → session ends → analyzer detects themes → engine builds plan → mutations applied → next session uses evolved agents`.

2. **Agents learn across sessions.** System prompt preambles persist across sessions in `.agentforge/agent-overrides/`. An agent that was repeatedly verbose gets a preamble reminding it to be concise. An agent that produced low-confidence output gets a preamble noting which domains it struggled with. This is lightweight Reflexion without requiring an LLM to generate the reflection — the human-readable `RecommendedAction.rationale` IS the reflection.

3. **Self-nomination for replacement works.** When an agent outputs `[REFORGE REQUESTED: ...]`, the orchestrator detects it and immediately triggers `buildPlan()` with a high-confidence structural action, bypassing the debounce timer.

4. **Model tier mutations are conservative and reversible.** The versioning system means every mutation can be rolled back by restoring the previous override version. Downgrade-first policy (try Sonnet before removing the agent) ensures graceful degradation.

5. **Structural reforges get human oversight.** Writing proposals to `.agentforge/reforge-proposals/` and requiring `agentforge reforge apply` means no autonomous agent can restructure the team without a human in the loop — appropriate given the high cost of wrong structural decisions.

6. **The `CostAwareRunner` (from cost optimization squad's synthesis) and `ReforgeEngine` compose cleanly.** The `CostAwareRunner` handles per-invocation cost optimization. The `ReforgeEngine` handles cross-session structural optimization. They operate on different timescales and don't conflict.
