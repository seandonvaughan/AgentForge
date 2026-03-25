/**
 * AgentForge Orchestrator — barrel export and facade class.
 *
 * Re-exports all orchestrator sub-modules and provides a unified
 * {@link Orchestrator} class that composes routing, delegation,
 * execution, cost tracking, and v2 runtime subsystems (progress
 * ledger, loop guard, event bus, handoff manager, context manager).
 */

export { routeTask } from "./task-router.js";
export type { RouteMatch } from "./task-router.js";

export { DelegationManager } from "./delegation-manager.js";
export type { DelegationRequest, DelegationResult } from "./delegation-manager.js";

export { ExecutionEngine } from "./execution-engine.js";
export type { TaskExecution, ExecutionPlan } from "./execution-engine.js";

export { CostTracker } from "./cost-tracker.js";
export type { TokenUsage, CostReport } from "./cost-tracker.js";

export { ProgressLedgerManager } from "./progress-ledger.js";

export { LoopGuard } from "./loop-guard.js";
export type { LimitCheckResult } from "./loop-guard.js";

export { EventBus } from "./event-bus.js";

export { HandoffManager } from "./handoff-manager.js";
export type { HandoffValidation } from "./handoff-manager.js";

export { ContextManager } from "./context-manager.js";
export type { Decision, AssembleOptions, FileReader } from "./context-manager.js";

import type { AgentTemplate, ModelTier } from "../types/agent.js";
import type { TeamManifest } from "../types/team.js";
import type { CollaborationTemplate } from "../types/collaboration.js";
import type { RouteMatch } from "./task-router.js";
import type { DelegationRequest } from "./delegation-manager.js";
import type { TaskExecution } from "./execution-engine.js";
import type { CostReport } from "./cost-tracker.js";
import type { TeamEvent, Handoff } from "../types/orchestration.js";
import type { FeedbackCategory, FeedbackPriority, AgentFeedback } from "../types/feedback.js";

import { routeTask } from "./task-router.js";
import { DelegationManager } from "./delegation-manager.js";
import { ExecutionEngine } from "./execution-engine.js";
import { CostTracker } from "./cost-tracker.js";
import { ProgressLedgerManager } from "./progress-ledger.js";
import { LoopGuard } from "./loop-guard.js";
import { EventBus } from "./event-bus.js";
import { HandoffManager } from "./handoff-manager.js";
import { ContextManager } from "./context-manager.js";
import { FeedbackCollector } from "../feedback/feedback-collector.js";
import { runAgent } from "../api/agent-runner.js";
import type { AgentRunResult } from "../api/agent-runner.js";
import { randomUUID } from "node:crypto";

/** Combined health status returned by {@link Orchestrator.checkHealth}. */
export interface HealthStatus {
  /** Whether the task appears to be looping (same step repeated). */
  is_in_loop: boolean;
  /** Whether forward progress is being made. */
  is_progress_being_made: boolean;
  /** Snapshot of the loop guard counters. */
  loopGuardCounters: Record<string, number>;
}

/** Result of recording progress via {@link Orchestrator.recordProgress}. */
export interface ProgressResult {
  /** Whether the task appears to be looping. */
  is_in_loop: boolean;
  /** Whether forward progress is being made. */
  is_progress_being_made: boolean;
  /** Whether a loop guard limit was exceeded. */
  limitExceeded: boolean;
  /** Human-readable reason when a limit is exceeded. */
  reason?: string;
}

/** Optional parameters for {@link Orchestrator.handoff}. */
export interface HandoffOptions {
  /** Questions the receiving agent should address. */
  openQuestions?: string[];
  /** Decisions already made that must be respected. */
  constraints?: string[];
  /** Completion status of the work being handed off. */
  status?: Handoff["status"];
}

/**
 * Unified facade that combines all orchestrator components.
 *
 * Accepts an optional {@link CollaborationTemplate} to configure loop
 * limits and sets up event subscriptions from agent templates.
 */
export class Orchestrator {
  readonly delegationManager: DelegationManager;
  readonly executionEngine: ExecutionEngine;
  readonly costTracker: CostTracker;
  readonly contextManager: ContextManager;
  readonly feedbackCollector: FeedbackCollector;

  private readonly teamManifest: TeamManifest;
  private readonly agents: Map<string, AgentTemplate>;
  private readonly collaborationTemplate?: CollaborationTemplate;

  private readonly eventBus: EventBus;
  private readonly handoffManager: HandoffManager;
  private readonly loopGuard: LoopGuard;

  /** taskId -> ProgressLedgerManager for active tasks. */
  private readonly ledgers = new Map<string, ProgressLedgerManager>();

  /** Monotonically increasing counter for generating unique task ids. */
  private taskCounter = 0;

  constructor(
    teamManifest: TeamManifest,
    agents: Map<string, AgentTemplate>,
    collaborationTemplate?: CollaborationTemplate,
    projectRoot: string = process.cwd(),
  ) {
    this.teamManifest = teamManifest;
    this.agents = agents;
    this.collaborationTemplate = collaborationTemplate;

    // --- Existing subsystems ---
    this.delegationManager = new DelegationManager(teamManifest.delegation_graph);
    this.executionEngine = new ExecutionEngine(teamManifest);
    this.costTracker = new CostTracker();

    // --- v2 runtime subsystems ---
    this.loopGuard = new LoopGuard(collaborationTemplate?.loop_limits);
    this.eventBus = new EventBus();
    this.handoffManager = new HandoffManager();
    this.contextManager = new ContextManager();
    this.feedbackCollector = new FeedbackCollector(projectRoot);

    // --- Set up event subscriptions from agent templates ---
    for (const [agentName, agentTemplate] of agents) {
      if (agentTemplate.subscriptions && agentTemplate.subscriptions.length > 0) {
        this.eventBus.subscribe(agentName, agentTemplate.subscriptions);
      }
    }
  }

  // ==================================================================
  //  Existing v1 methods
  // ==================================================================

  /**
   * Routes a task to the best-matching agents.
   */
  route(task: string, filePaths: string[] = []): RouteMatch[] {
    return routeTask(task, filePaths, this.teamManifest, this.agents);
  }

  /**
   * Creates a delegation request from one agent to another.
   */
  delegate(from: string, to: string, task: string): DelegationRequest {
    return this.delegationManager.createDelegation(from, to, task);
  }

  /**
   * Creates and registers a task execution for an agent.
   */
  execute(agent: string, task: string): TaskExecution {
    return this.executionEngine.createExecution(agent, task);
  }

  /**
   * Returns the current cost report across all tracked usage.
   */
  getCostReport(): CostReport {
    return this.costTracker.getReport();
  }

  /**
   * Validates that an agent's model assignment matches the team manifest's
   * model routing. Logs a warning if there's a mismatch — this catches
   * the expensive mistake of running a Haiku-tier agent on Opus.
   */
  validateModelRouting(agentName: string): { valid: boolean; expected?: ModelTier; actual?: ModelTier; warning?: string } {
    const agent = this.agents.get(agentName);
    if (!agent) return { valid: false, warning: `Agent "${agentName}" not found` };

    const routing = this.teamManifest.model_routing;
    let expectedTier: ModelTier | undefined;

    for (const tier of ['opus', 'sonnet', 'haiku'] as ModelTier[]) {
      if (routing[tier].includes(agentName)) {
        expectedTier = tier;
        break;
      }
    }

    if (!expectedTier) return { valid: true }; // Agent not in routing table, trust template

    if (agent.model !== expectedTier) {
      return {
        valid: false,
        expected: expectedTier,
        actual: agent.model,
        warning: `Model routing mismatch for "${agentName}": manifest routes to ${expectedTier} but template uses ${agent.model}. ` +
          `This may waste tokens — ${agent.model} costs ${this.getModelCostMultiplier(agent.model, expectedTier)}x more than ${expectedTier}.`,
      };
    }

    return { valid: true, expected: expectedTier, actual: agent.model };
  }

  /**
   * Returns the approximate cost multiplier between two model tiers.
   */
  private getModelCostMultiplier(actual: ModelTier, expected: ModelTier): string {
    const costs: Record<ModelTier, number> = { opus: 15, sonnet: 3, haiku: 0.25 };
    const ratio = costs[actual] / costs[expected];
    return ratio.toFixed(0);
  }

  /**
   * Validates model routing for all agents in the team and returns
   * any mismatches. Use this after forging to catch configuration errors.
   */
  validateAllModelRouting(): { agent: string; expected: ModelTier; actual: ModelTier; warning: string }[] {
    const mismatches: { agent: string; expected: ModelTier; actual: ModelTier; warning: string }[] = [];
    for (const agentName of this.agents.keys()) {
      const result = this.validateModelRouting(agentName);
      if (!result.valid && result.expected && result.actual && result.warning) {
        mismatches.push({
          agent: agentName,
          expected: result.expected,
          actual: result.actual,
          warning: result.warning,
        });
      }
    }
    return mismatches;
  }

  /**
   * Invokes an agent by name, sending the task to the Anthropic API.
   *
   * Uses the agent's configured model tier — never overrides it.
   * This ensures model routing is respected: Opus for strategic,
   * Sonnet for implementation, Haiku for utility. Running agents
   * on a more expensive model than configured wastes tokens.
   *
   * Validates model routing before invocation and logs warnings
   * for any mismatches.
   */
  async invokeAgent(
    agentName: string,
    task: string,
    context?: { files?: string[] },
  ): Promise<AgentRunResult> {
    const agent = this.agents.get(agentName);
    if (!agent) {
      throw new Error(
        `Agent "${agentName}" not found. Available agents: ${[...this.agents.keys()].join(", ")}`,
      );
    }

    // Validate model routing before invocation.
    const routingCheck = this.validateModelRouting(agentName);
    if (!routingCheck.valid && routingCheck.warning) {
      console.warn(`[AgentForge] ${routingCheck.warning}`);
    }

    // Create an execution record and mark it as running.
    const execution = this.executionEngine.createExecution(agentName, task);
    execution.status = "running";
    execution.started_at = new Date().toISOString();

    try {
      // Agent.model is the source of truth — never override it.
      const result = await runAgent(agent, task, context);

      // Record token usage in the cost tracker.
      this.costTracker.recordUsage(
        agentName,
        agent.model,
        result.inputTokens,
        result.outputTokens,
      );

      // Mark execution as completed.
      execution.status = "completed";
      execution.completed_at = new Date().toISOString();
      execution.result = result.response;

      return result;
    } catch (error) {
      execution.status = "failed";
      execution.completed_at = new Date().toISOString();
      throw error;
    }
  }

  // ==================================================================
  //  v2 runtime methods
  // ==================================================================

  /**
   * Creates a progress ledger for a new task and returns a unique task id.
   *
   * The loop guard is shared across all tasks but the ledger is per-task.
   */
  startTask(agent: string, task: string): string {
    this.taskCounter += 1;
    const taskId = `task-${this.taskCounter}-${Date.now()}`;

    const ledger = new ProgressLedgerManager(taskId, task);
    ledger.setNextSpeaker(agent, task);
    this.ledgers.set(taskId, ledger);

    return taskId;
  }

  /**
   * Records a completed step for the given task.
   *
   * Updates the progress ledger, runs a health check, and increments
   * the loop guard's `total_actions` counter.
   *
   * @returns Combined health and limit status.
   */
  recordProgress(taskId: string, step: string): ProgressResult {
    const ledger = this.getLedgerOrThrow(taskId);
    ledger.recordStep(step);

    const health = ledger.checkHealth();
    const limitCheck = this.loopGuard.increment("total_actions");

    return {
      is_in_loop: health.is_in_loop,
      is_progress_being_made: health.is_progress_being_made,
      limitExceeded: !limitCheck.allowed,
      reason: limitCheck.reason,
    };
  }

  /**
   * Publishes a {@link TeamEvent} to all subscribed agents via the event bus.
   *
   * @returns Names of agents that were notified.
   */
  broadcast(event: TeamEvent): string[] {
    return this.eventBus.publish(event);
  }

  /**
   * Creates a structured handoff between agents.
   *
   * @param from   Agent handing off work.
   * @param to     Agent receiving work.
   * @param artifact  The artifact being handed off.
   * @param options   Optional open questions, constraints, and status.
   * @returns The created {@link Handoff} record.
   */
  handoff(
    from: string,
    to: string,
    artifact: Handoff["artifact"],
    options?: HandoffOptions,
  ): Handoff {
    return this.handoffManager.createHandoff(
      from,
      to,
      artifact,
      options?.openQuestions ?? [],
      options?.constraints ?? [],
      options?.status ?? "needs_review",
    );
  }

  /**
   * Returns the combined health status for a task.
   *
   * Includes the progress ledger health check results and a snapshot
   * of the loop guard counters.
   *
   * @throws Error if the task id is not found.
   */
  checkHealth(taskId: string): HealthStatus {
    const ledger = this.getLedgerOrThrow(taskId);
    const health = ledger.checkHealth();

    return {
      is_in_loop: health.is_in_loop,
      is_progress_being_made: health.is_progress_being_made,
      loopGuardCounters: this.loopGuard.getCounters(),
    };
  }

  /**
   * Assembles a scoped context string for an agent invocation using
   * the {@link ContextManager}.
   *
   * @param agentName  Name of the agent to assemble context for.
   * @param task       The task description.
   * @param options    Optional additional files to include.
   * @returns The assembled context string.
   * @throws Error if the agent is not found.
   */
  assembleContext(
    agentName: string,
    task: string,
    options?: { files?: string[] },
  ): string {
    const agent = this.agents.get(agentName);
    if (!agent) {
      throw new Error(
        `Agent "${agentName}" not found. Available agents: ${[...this.agents.keys()].join(", ")}`,
      );
    }

    return this.contextManager.assembleTaskContext(agent, task, options);
  }

  // ==================================================================
  //  Feedback
  // ==================================================================

  /**
   * Convenience method for an agent to submit a feedback entry.
   *
   * Generates a UUID for the entry, stamps it with the current ISO
   * timestamp, and delegates to the {@link FeedbackCollector}.
   *
   * @returns The file path of the written feedback markdown file.
   */
  async submitFeedback(
    agentName: string,
    category: FeedbackCategory,
    priority: FeedbackPriority,
    title: string,
    description: string,
    suggestion: string,
    context?: AgentFeedback["context"],
  ): Promise<string> {
    const feedback: AgentFeedback = {
      id: randomUUID(),
      agent: agentName,
      category,
      priority,
      title,
      description,
      context: context ?? {},
      suggestion,
      timestamp: new Date().toISOString(),
    };
    return this.feedbackCollector.submitFeedback(feedback);
  }

  // ==================================================================
  //  Private helpers
  // ==================================================================

  /**
   * Retrieves the progress ledger for a task or throws if not found.
   */
  private getLedgerOrThrow(taskId: string): ProgressLedgerManager {
    const ledger = this.ledgers.get(taskId);
    if (!ledger) {
      throw new Error(
        `No progress ledger found for task "${taskId}". Call startTask() first.`,
      );
    }
    return ledger;
  }
}
