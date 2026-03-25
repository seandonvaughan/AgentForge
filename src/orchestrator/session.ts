/**
 * AgentForgeSession — The Phase 3 factory that wires all v3 components
 * into a single entry point.
 *
 * Replaces ad-hoc OrchestratorV3 + store creation with a one-call factory:
 *   AgentForgeSession.create(config) -> fully wired session.
 *
 * Composes:
 *   - OrchestratorV3    (Phase 2d)
 *   - MessageBus        (Phase 3a)
 *   - KnowledgeStore    (Phase 3b)
 *   - DecisionLog       (Phase 3c)
 *   - EventBus          (v2, wrapped by MessageBus)
 *
 * Also implements [REFORGE REQUESTED] detection (Phase 3e).
 *
 * Iron Law 1: OrchestratorV3 is composed, not modified.
 * Iron Law 5: Zero new npm dependencies.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { AgentTemplate } from "../types/agent.js";
import type {
  ProgressLedger,
  ConditionalDelegationGraph,
} from "../types/orchestration.js";
import type { FeedbackAnalysis } from "../types/feedback.js";
import type { ReforgePlan } from "../types/reforge.js";
import type { AutoRule, SessionSummary } from "../types/session.js";

import { EventBus } from "./event-bus.js";
import { MessageBus } from "./message-bus.js";
import { KnowledgeStore } from "./knowledge-store.js";
import { DecisionLog } from "./decision-log.js";
import {
  OrchestratorV3,
  type OrchestratorV3Config,
  type RunContext,
  type V3RunResult,
} from "./orchestrator-v3.js";
import { ReforgeEngine, type ReforgeEngineOptions } from "../reforge/reforge-engine.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Regex to detect agent self-nomination for reforge.
 * Pattern: [REFORGE REQUESTED: <reason>]
 */
const REFORGE_REQUESTED_PATTERN = /\[REFORGE REQUESTED:\s*(.+?)\]/g;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Configuration for creating an AgentForgeSession. */
export interface SessionConfig {
  /** Path to the project root. */
  projectRoot: string;
  /** Maximum USD spend for the entire session. */
  sessionBudgetUsd: number;
  /** Whether to apply ReforgeEngine overrides. Default: true. */
  enableReforge?: boolean;
  /** Whether to use CostAwareRunner routing. Default: true. */
  enableCostAwareRouting?: boolean;
  /** Whether to gate strategic outputs through ReviewEnforcer. Default: true. */
  enableReviewEnforcement?: boolean;
  /** Conditional delegation graph for speaker selection. */
  delegationGraph?: ConditionalDelegationGraph;
  /** Auto-rules to register on the MessageBus at session start. */
  autoRules?: AutoRule[];
  /** Options forwarded to ReforgeEngine. */
  reforgeOptions?: ReforgeEngineOptions;
}

// ---------------------------------------------------------------------------
// AgentForgeSession
// ---------------------------------------------------------------------------

export class AgentForgeSession {
  readonly orchestrator: OrchestratorV3;
  readonly messageBus: MessageBus;
  readonly knowledgeStore: KnowledgeStore;
  readonly decisionLog: DecisionLog;
  readonly eventBus: EventBus;

  private readonly sessionId: string;
  private readonly startedAt: string;
  private readonly config: SessionConfig;
  private readonly reforgeEngine: ReforgeEngine;
  private readonly delegationGraph: ConditionalDelegationGraph;
  private totalAgentRuns = 0;
  private reforgeActionsApplied = 0;

  private constructor(
    config: SessionConfig,
    orchestrator: OrchestratorV3,
    messageBus: MessageBus,
    knowledgeStore: KnowledgeStore,
    decisionLog: DecisionLog,
    eventBus: EventBus,
    reforgeEngine: ReforgeEngine,
  ) {
    this.config = config;
    this.orchestrator = orchestrator;
    this.messageBus = messageBus;
    this.knowledgeStore = knowledgeStore;
    this.decisionLog = decisionLog;
    this.eventBus = eventBus;
    this.reforgeEngine = reforgeEngine;
    this.sessionId = randomUUID();
    this.startedAt = new Date().toISOString();
    this.delegationGraph = config.delegationGraph ?? {};
  }

  // =========================================================================
  // Factory
  // =========================================================================

  static async create(config: SessionConfig): Promise<AgentForgeSession> {
    const eventBus = new EventBus();
    const messageBus = new MessageBus(eventBus);
    const knowledgeStore = new KnowledgeStore(config.projectRoot);
    const decisionLog = new DecisionLog(config.projectRoot);

    const orchConfig: OrchestratorV3Config = {
      projectRoot: config.projectRoot,
      sessionBudgetUsd: config.sessionBudgetUsd,
      enableReforge: config.enableReforge ?? true,
      enableCostAwareRouting: config.enableCostAwareRouting ?? true,
      enableReviewEnforcement: config.enableReviewEnforcement ?? true,
      reforgeOptions: config.reforgeOptions,
    };
    const orchestrator = new OrchestratorV3(orchConfig);

    const reforgeEngine = new ReforgeEngine(
      config.projectRoot,
      config.reforgeOptions,
    );

    const session = new AgentForgeSession(
      config,
      orchestrator,
      messageBus,
      knowledgeStore,
      decisionLog,
      eventBus,
      reforgeEngine,
    );

    // Register auto-rules
    if (config.autoRules) {
      for (const rule of config.autoRules) {
        messageBus.addAutoRuleFromDefinition(rule, async (event) => {
          await decisionLog.record({
            type: "delegation",
            agent: rule.attributedTo,
            description: 'Auto-rule "' + rule.id + '" dispatched "' + rule.dispatchAction + '" on event "' + event.type + '"',
            alternatives: [],
            rationale: 'Triggered by auto-rule matching event type "' + rule.onEvent + '"',
            artifacts: [],
            confidence: 1.0,
            sessionId: session.sessionId,
          });
        });
      }
    }

    return session;
  }

  // =========================================================================
  // Agent Execution
  // =========================================================================

  async runAgent(
    agent: AgentTemplate,
    task: string,
    context: RunContext = {},
  ): Promise<V3RunResult> {
    this.totalAgentRuns++;

    // Step 1: Execute through OrchestratorV3
    const result = await this.orchestrator.runAgent(agent, task, context);

    // Step 2: [REFORGE REQUESTED] detection (Phase 3e)
    const reforgeSignals = this.detectReforgeRequested(result.content);
    if (reforgeSignals.length > 0) {
      await this.handleReforgeRequested(agent, reforgeSignals);
    }

    // Step 3: Record routing decision
    await this.decisionLog.record({
      type: "routing",
      agent: agent.name,
      description: "Routed task to " + result.modelUsed + " tier" + (result.escalated ? " (escalated)" : ""),
      alternatives: ["opus", "sonnet", "haiku"].filter(
        (t) => t !== result.modelUsed,
      ),
      rationale: result.escalated
        ? "Low confidence detected — escalated to higher tier"
        : "TaskComplexityRouter selected " + result.modelUsed + " based on task signals",
      artifacts: [],
      confidence: result.escalated ? 0.4 : 0.9,
      sessionId: this.sessionId,
    });

    // Step 4: Publish event
    await this.messageBus.publish(
      {
        type: "agent_completed",
        source: agent.name,
        payload: {
          task,
          modelUsed: result.modelUsed,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          escalated: result.escalated,
          hadReforgeSignal: reforgeSignals.length > 0,
        },
        notify: ["*"],
      },
      "normal",
    );

    // Step 5: Store result in session knowledge
    await this.knowledgeStore.set(
      "session",
      "run:" + agent.name + ":" + this.totalAgentRuns,
      {
        task,
        modelUsed: result.modelUsed,
        tokens: result.inputTokens + result.outputTokens,
        escalated: result.escalated,
        reforgeSignals: reforgeSignals.length,
      },
      agent.name,
      ["agent-run"],
    );

    return result;
  }

  // =========================================================================
  // Session Analysis
  // =========================================================================

  async analyzeSession(): Promise<{
    analysis: FeedbackAnalysis;
    reforgePlan?: ReforgePlan;
  }> {
    return this.orchestrator.analyzeSession();
  }

  // =========================================================================
  // Session Lifecycle
  // =========================================================================

  async end(): Promise<SessionSummary> {
    await this.messageBus.drain();
    this.knowledgeStore.clearSession();

    const costReport = this.orchestrator.getSessionCostReport();
    const endedAt = new Date().toISOString();

    const summary: SessionSummary = {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      endedAt,
      totalAgentRuns: this.totalAgentRuns,
      totalSpentUsd: costReport.totalSpentUsd,
      decisionsRecorded: this.decisionLog.getDecisionsRecordedCount(),
      knowledgeEntriesCreated: this.knowledgeStore.getEntriesCreatedCount(),
      reforgeActionsApplied: this.reforgeActionsApplied,
      eventsProcessed: this.messageBus.getEventsProcessedCount(),
    };

    // Write cost artifact
    const sessionsDir = path.join(this.config.projectRoot, ".agentforge", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const costEntry = {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      endedAt,
      totalSpentUsd: costReport.totalSpentUsd,
      totalAgentRuns: this.totalAgentRuns,
      agentBreakdown: costReport.agentBreakdown,
    };
    const filename = `cost-entry-${this.sessionId}-${Date.now()}.json`;
    await fs.writeFile(
      path.join(sessionsDir, filename),
      JSON.stringify(costEntry, null, 2),
    );

    return summary;
  }

  // =========================================================================
  // Speaker Selection
  // =========================================================================

  selectNextSpeaker(
    ledger: ProgressLedger,
    agents: AgentTemplate[],
  ): string | null {
    return this.orchestrator.selectNextSpeaker(
      ledger,
      this.delegationGraph,
      agents,
    );
  }

  // =========================================================================
  // Accessors
  // =========================================================================

  getSessionId(): string {
    return this.sessionId;
  }

  getCostReport(): ReturnType<OrchestratorV3["getSessionCostReport"]> {
    return this.orchestrator.getSessionCostReport();
  }

  // =========================================================================
  // [REFORGE REQUESTED] Detection (Phase 3e)
  // =========================================================================

  private detectReforgeRequested(content: string): string[] {
    const reasons: string[] = [];
    let match: RegExpExecArray | null;

    REFORGE_REQUESTED_PATTERN.lastIndex = 0;

    while ((match = REFORGE_REQUESTED_PATTERN.exec(content)) !== null) {
      reasons.push(match[1].trim());
    }

    return reasons;
  }

  private async handleReforgeRequested(
    agent: AgentTemplate,
    reasons: string[],
  ): Promise<void> {
    for (const reason of reasons) {
      await this.decisionLog.record({
        type: "reforge",
        agent: agent.name,
        description: 'Agent self-nominated for reforge: "' + reason + '"',
        alternatives: ["ignore signal", "defer to next session"],
        rationale: "[REFORGE REQUESTED] detected in agent output",
        artifacts: [],
        confidence: 0.8,
        sessionId: this.sessionId,
      });

      const plan = await this.reforgeEngine.buildPlan(
        {
          analyzed_at: new Date().toISOString(),
          total_entries: 1,
          date_range: {
            earliest: new Date().toISOString(),
            latest: new Date().toISOString(),
          },
          themes: [
            {
              label: reason,
              keywords: reason.toLowerCase().split(/\s+/).slice(0, 5),
              corroborating_agents: [agent.name],
              entry_count: 1,
              peak_priority: "high",
              signal_strength: 0.85,
              entry_ids: [randomUUID()],
            },
          ],
          recommended_actions: [
            {
              action: "update-system-prompt",
              rationale: "Agent " + agent.name + " self-nominated: " + reason,
              urgency: "high",
              theme_label: reason,
              confidence: 0.85,
            },
          ],
          requires_escalation: false,
          summary: {
            total: 1,
            by_category: {
              optimization: 0,
              bug: 0,
              feature: 1,
              process: 0,
              cost: 0,
              quality: 0,
            },
            by_priority: { critical: 0, high: 1, medium: 0, low: 0 },
            by_agent: { [agent.name]: 1 },
            entries: [],
          },
        },
        [agent],
      );

      if (plan.mutations.length > 0) {
        const result = await this.reforgeEngine.executePlan(plan);
        if (result.applied) {
          this.reforgeActionsApplied += result.appliedMutations.length;
        }
      }

      await this.messageBus.publish(
        {
          type: "reforge_requested",
          source: agent.name,
          payload: { reason, planId: plan.id },
          notify: ["*"],
        },
        "high",
      );
    }
  }
}
