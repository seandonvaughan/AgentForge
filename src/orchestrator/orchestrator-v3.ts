/**
 * OrchestratorV3 — The integration point that wires the cost stack and
 * intelligence layer together.
 *
 * Composes all v3 components:
 *   - BudgetEnvelope     — session-level cost gating
 *   - CostAwareRunner    — 6-stage cost-optimized execution pipeline
 *   - ReforgeEngine      — translates feedback into agent mutations
 *   - SpeakerSelector    — conditional delegation graph routing
 *   - ReviewEnforcer     — gates strategic agent outputs
 *   - FeedbackAnalyzer   — detects recurring themes in feedback
 *   - SessionStore       — persists ledger snapshots for cross-session learning
 *   - FeedbackCollector  — loads feedback entries from disk
 *
 * Iron Law 1: v2 Orchestrator is UNMODIFIED — OrchestratorV3 is a new class.
 * Projects that don't opt in fall through to v2.
 *
 * Zero new dependencies.
 */

import { randomUUID } from "node:crypto";

import type { AgentTemplate } from "../types/agent.js";
import type { CostAwareRunResult } from "../types/budget.js";
import type {
  ProgressLedger,
  ConditionalDelegationGraph,
} from "../types/orchestration.js";
import type { FeedbackAnalysis } from "../types/feedback.js";
import type { ReforgePlan } from "../types/reforge.js";

import { BudgetEnvelope } from "../budget/budget-envelope.js";
import { runCostAware } from "./cost-aware-runner.js";
import { ReforgeEngine, type ReforgeEngineOptions } from "../reforge/reforge-engine.js";
import { SpeakerSelector } from "./speaker-selector.js";
import { ReviewEnforcer, type ReviewDecision } from "./review-enforcer.js";
import { FeedbackAnalyzer } from "../feedback/feedback-analyzer.js";
import { FeedbackCollector } from "../feedback/feedback-collector.js";
import { SessionStore } from "./session-store.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Configuration for OrchestratorV3. */
export interface OrchestratorV3Config {
  /** Path to the project root — used to locate .agentforge/ dirs. */
  projectRoot: string;
  /** Maximum USD spend for the entire session. */
  sessionBudgetUsd: number;
  /** Whether to apply ReforgeEngine overrides before each agent run. */
  enableReforge: boolean;
  /** Whether to use CostAwareRunner routing (vs. direct runAgent call). */
  enableCostAwareRouting: boolean;
  /** Whether to gate strategic agent outputs through ReviewEnforcer. */
  enableReviewEnforcement: boolean;
  /** Optional options forwarded to ReforgeEngine constructor. */
  reforgeOptions?: ReforgeEngineOptions;
}

/** Optional per-invocation context for runAgent. */
export interface RunContext {
  /** Ordered list of reviewer names for strategic-agent review gating. */
  reviewers?: string[];
  /** Whether to allow fan-out execution for this run. */
  allowFanOut?: boolean;
}

/**
 * Extended CostAwareRunResult that also carries the review gate decision
 * (only present when review enforcement is enabled).
 */
export interface V3RunResult extends CostAwareRunResult {
  /** Review decision for this run — undefined when enforcement is disabled. */
  reviewDecision?: ReviewDecision;
}

// ---------------------------------------------------------------------------
// OrchestratorV3
// ---------------------------------------------------------------------------

export class OrchestratorV3 {
  /** Shared budget envelope for the entire session. */
  readonly budgetEnvelope: BudgetEnvelope;

  private readonly sessionStore: SessionStore;
  private readonly feedbackCollector: FeedbackCollector;
  private readonly feedbackAnalyzer: FeedbackAnalyzer;
  private readonly reforgeEngine: ReforgeEngine;
  private readonly speakerSelector: SpeakerSelector;
  private readonly reviewEnforcer: ReviewEnforcer;
  private readonly config: OrchestratorV3Config;

  /** Tracks per-agent cumulative spend (USD) across the session. */
  private readonly agentSpend: Map<string, number> = new Map();

  /** Accumulates agent templates encountered during runAgent calls (for analyzeSession). */
  private readonly seenAgents: AgentTemplate[] = [];

  constructor(config: OrchestratorV3Config) {
    this.config = config;

    this.budgetEnvelope = new BudgetEnvelope(config.sessionBudgetUsd);
    this.sessionStore = new SessionStore(config.projectRoot);
    this.feedbackCollector = new FeedbackCollector(config.projectRoot);
    this.feedbackAnalyzer = new FeedbackAnalyzer();
    this.reforgeEngine = new ReforgeEngine(config.projectRoot, config.reforgeOptions);
    this.speakerSelector = new SpeakerSelector();
    this.reviewEnforcer = new ReviewEnforcer();
  }

  // =========================================================================
  // runAgent
  // =========================================================================

  /**
   * The main entry point — replaces direct runAgent calls in v3 projects.
   *
   * Pipeline:
   *   1. Apply reforge overrides to the agent template (if enabled)
   *   2. Run through CostAwareRunner (budget check → route → execute → escalate)
   *   3. Enforce review if strategic agent (if enabled)
   *   4. Save session snapshot
   *   5. Return result (with optional reviewDecision)
   */
  async runAgent(
    agent: AgentTemplate,
    task: string,
    context: RunContext = {},
  ): Promise<V3RunResult> {
    // Track this template for later analyzeSession calls
    if (!this.seenAgents.some((a) => a.name === agent.name)) {
      this.seenAgents.push(agent);
    }

    // ── Stage 1: Apply reforge overrides ──────────────────────────────────
    const resolvedAgent = this.config.enableReforge
      ? await this.reforgeEngine.applyOverride(agent)
      : agent;

    // ── Stage 2: Execute through CostAwareRunner ──────────────────────────
    const runResult = await runCostAware({
      agent: resolvedAgent,
      task,
      envelope: this.budgetEnvelope,
      allowFanOut: context.allowFanOut ?? false,
    });

    // ── Track per-agent spend ─────────────────────────────────────────────
    const prevSpend = this.agentSpend.get(agent.name) ?? 0;
    // Estimate actual cost from the run: use the recorded spend difference
    const spendReport = this.budgetEnvelope.getSpendReport();
    const totalAfter = spendReport.totalSpentUsd;
    // The per-agent spend delta is the session total minus what was spent before
    // We can't get the exact delta from the envelope, so we approximate from
    // MODEL_COSTS applied to actual tokens.
    import("./cost-tracker.js").then(({ MODEL_COSTS }) => {
      const costs = MODEL_COSTS[runResult.modelUsed];
      const delta =
        (runResult.inputTokens / 1_000_000) * costs.input +
        (runResult.outputTokens / 1_000_000) * costs.output;
      this.agentSpend.set(agent.name, prevSpend + delta);
    }).catch(() => {
      // Silently ignore — cost breakdown is best-effort
    });

    // ── Stage 3: Enforce review ───────────────────────────────────────────
    let reviewDecision: ReviewDecision | undefined;
    if (this.config.enableReviewEnforcement) {
      reviewDecision = await this.reviewEnforcer.enforceReview(
        runResult.content,
        resolvedAgent,
        context.reviewers ?? [],
      );
    }

    // ── Stage 4: Save session snapshot ───────────────────────────────────
    const snapshot: ProgressLedger = {
      task_id: randomUUID(),
      objective: task,
      facts: { given: [], to_look_up: [], to_derive: [], educated_guesses: [] },
      plan: [],
      steps_completed: [],
      current_step: null,
      is_request_satisfied: !runResult.escalated,
      is_in_loop: false,
      is_progress_being_made: true,
      confidence: runResult.escalated ? 0.4 : 0.9,
      next_speaker: null,
      instruction: "",
    };
    await this.sessionStore.saveSnapshot(snapshot);

    // ── Stage 5: Return ───────────────────────────────────────────────────
    return {
      ...runResult,
      reviewDecision,
    };
  }

  // =========================================================================
  // analyzeSession
  // =========================================================================

  /**
   * Post-session analysis — call after all work is done.
   *
   * Pipeline:
   *   1. Load all feedback entries from disk
   *   2. Run FeedbackAnalyzer to detect themes
   *   3. If reforge enabled and there are recommended actions, build a ReforgePlan
   *   4. If plan has local mutations, execute them (write overrides)
   *   5. Save session snapshot
   *   6. Return analysis + optional plan
   */
  async analyzeSession(): Promise<{ analysis: FeedbackAnalysis; reforgePlan?: ReforgePlan }> {
    // ── Step 1: Load feedback ─────────────────────────────────────────────
    const entries = await this.feedbackCollector.loadAllFeedback();

    // ── Step 2: Analyze ───────────────────────────────────────────────────
    const analysis = this.feedbackAnalyzer.analyze(entries);

    // ── Step 3-4: Reforge (optional) ──────────────────────────────────────
    let reforgePlan: ReforgePlan | undefined;

    if (this.config.enableReforge && analysis.recommended_actions.length > 0) {
      reforgePlan = await this.reforgeEngine.buildPlan(
        analysis,
        this.seenAgents,
      );

      // Execute local mutations (structural mutations are written as proposals)
      if (reforgePlan.reforgeClass === "local" && reforgePlan.mutations.length > 0) {
        await this.reforgeEngine.executePlan(reforgePlan);
      }
    }

    // ── Step 5: Save session snapshot ─────────────────────────────────────
    const snapshot: ProgressLedger = {
      task_id: `session-analysis-${Date.now()}`,
      objective: "post-session analysis",
      facts: { given: [], to_look_up: [], to_derive: [], educated_guesses: [] },
      plan: [],
      steps_completed: ["analyzeSession"],
      current_step: null,
      is_request_satisfied: true,
      is_in_loop: false,
      is_progress_being_made: true,
      confidence: 1.0,
      next_speaker: null,
      instruction: "",
    };
    await this.sessionStore.saveSnapshot(snapshot);

    return { analysis, reforgePlan };
  }

  // =========================================================================
  // getSessionCostReport
  // =========================================================================

  /**
   * Get cost report for the session.
   *
   * Returns total spend, remaining budget, and a per-agent breakdown
   * computed from recorded MODEL_COSTS * actual token counts.
   */
  getSessionCostReport(): {
    totalSpentUsd: number;
    remainingBudgetUsd: number;
    agentBreakdown: Record<string, number>;
  } {
    const spendReport = this.budgetEnvelope.getSpendReport();
    const agentBreakdown: Record<string, number> = {};
    for (const [agentName, spend] of this.agentSpend.entries()) {
      agentBreakdown[agentName] = spend;
    }
    return {
      totalSpentUsd: spendReport.totalSpentUsd,
      remainingBudgetUsd: spendReport.remainingUsd,
      agentBreakdown,
    };
  }

  // =========================================================================
  // selectNextSpeaker
  // =========================================================================

  /**
   * Select the next speaker based on the conditional delegation graph.
   *
   * Delegates entirely to SpeakerSelector so callers never need to
   * instantiate it themselves.
   */
  selectNextSpeaker(
    ledger: ProgressLedger,
    graph: ConditionalDelegationGraph,
    agents: AgentTemplate[],
  ): string | null {
    return this.speakerSelector.selectNextSpeaker(ledger, graph, agents);
  }
}
