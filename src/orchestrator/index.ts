/**
 * AgentForge Orchestrator — barrel export and facade class.
 *
 * Re-exports all orchestrator sub-modules and provides a unified
 * {@link Orchestrator} class that composes routing, delegation,
 * execution, and cost tracking.
 */

export { routeTask } from "./task-router.js";
export type { RouteMatch } from "./task-router.js";

export { DelegationManager } from "./delegation-manager.js";
export type { DelegationRequest, DelegationResult } from "./delegation-manager.js";

export { ExecutionEngine } from "./execution-engine.js";
export type { TaskExecution, ExecutionPlan } from "./execution-engine.js";

export { CostTracker } from "./cost-tracker.js";
export type { TokenUsage, CostReport } from "./cost-tracker.js";

import type { AgentTemplate } from "../types/agent.js";
import type { TeamManifest } from "../types/team.js";
import type { RouteMatch } from "./task-router.js";
import type { DelegationRequest } from "./delegation-manager.js";
import type { TaskExecution } from "./execution-engine.js";
import type { CostReport } from "./cost-tracker.js";

import { routeTask } from "./task-router.js";
import { DelegationManager } from "./delegation-manager.js";
import { ExecutionEngine } from "./execution-engine.js";
import { CostTracker } from "./cost-tracker.js";
import { runAgent } from "../api/agent-runner.js";
import type { AgentRunResult } from "../api/agent-runner.js";

/**
 * Unified facade that combines all orchestrator components.
 */
export class Orchestrator {
  readonly delegationManager: DelegationManager;
  readonly executionEngine: ExecutionEngine;
  readonly costTracker: CostTracker;

  private readonly teamManifest: TeamManifest;
  private readonly agents: Map<string, AgentTemplate>;

  constructor(teamManifest: TeamManifest, agents: Map<string, AgentTemplate>) {
    this.teamManifest = teamManifest;
    this.agents = agents;
    this.delegationManager = new DelegationManager(teamManifest.delegation_graph);
    this.executionEngine = new ExecutionEngine(teamManifest);
    this.costTracker = new CostTracker();
  }

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
   * Invokes an agent by name, sending the task to the Anthropic API.
   *
   * Looks up the agent template, calls the API via `runAgent`,
   * records token usage in the cost tracker, and updates execution state.
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

    // Create an execution record and mark it as running.
    const execution = this.executionEngine.createExecution(agentName, task);
    execution.status = "running";
    execution.started_at = new Date().toISOString();

    try {
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
}
