import { generateId, nowIso } from '@agentforge/shared';
import type { AgentProposal, SprintItemExecutionRequest, SprintItemExecutionResult } from '@agentforge/core';
import { buildPlan } from './planner.js';
import type {
  CanaryDeploymentPlan,
  CanaryMetrics,
  ExecutionResult,
  ExecutorOptions,
  ProposalRuntimeExecutor,
  StageExecutionResponse,
  StageResult,
  ExecutionStage,
} from './types.js';

interface NormalizedExecutorOptions {
  dryRun: boolean;
  stageTimeoutMs: number;
  budgetUsd: number;
  runtime?: ProposalRuntimeExecutor;
}

const DEFAULT_OPTS = {
  dryRun: true,
  stageTimeoutMs: 30_000,
  budgetUsd: 1.00,
} satisfies Omit<NormalizedExecutorOptions, 'runtime'>;

/** Simulates a stage result in dry-run mode. */
function simulateStage(stage: ExecutionStage, agentId: string): StageResult {
  const outputs: Record<ExecutionStage, string> = {
    planning: `Plan generated: breaking proposal into ${Math.ceil(Math.random() * 4) + 1} implementation tasks.`,
    architecture: `Architecture reviewed: identified ${Math.ceil(Math.random() * 3) + 1} affected modules.`,
    coding: `Implementation drafted: ${Math.ceil(Math.random() * 6) + 2} files modified.`,
    linting: `Linting passed: 0 errors, ${Math.floor(Math.random() * 3)} warnings.`,
    testing: `Tests executed: ${Math.ceil(Math.random() * 20) + 5} passing, 0 failing.`,
    complete: 'Execution complete — diff ready for review.',
    failed: 'Stage failed during execution.',
  };
  return {
    stage,
    agentId,
    output: outputs[stage] ?? `Stage ${stage} complete.`,
    durationMs: Math.floor(Math.random() * 2000) + 200,
    success: true,
  };
}

function simpleHash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash &= hash;
  }
  return Math.abs(hash);
}

function routeDeploymentVariant(
  deployment: CanaryDeploymentPlan,
  proposalId: string,
  stage: ExecutionStage,
  stageIndex: number,
): 'control' | 'canary' {
  if (deployment.mode !== 'canary') return 'control';
  if (deployment.trafficPercent >= 100) return 'canary';
  if (deployment.trafficPercent <= 0) return 'control';

  const bucket = simpleHash(`${proposalId}:${stage}:${stageIndex}`) % 100;
  return bucket < deployment.trafficPercent ? 'canary' : 'control';
}

function defaultCanaryMetrics(): CanaryMetrics {
  return { canaryRequests: 0, canaryErrors: 0, errorRate: 0 };
}

function advanceCanaryMetrics(
  current: CanaryMetrics,
  response: StageExecutionResponse,
  variant: 'control' | 'canary',
): CanaryMetrics {
  if (response.canaryMetrics) {
    return response.canaryMetrics;
  }

  if (variant !== 'canary') {
    return current;
  }

  const canaryRequests = current.canaryRequests + 1;
  const canaryErrors = current.canaryErrors + (response.success ? 0 : 1);
  return {
    canaryRequests,
    canaryErrors,
    errorRate: canaryRequests > 0 ? canaryErrors / canaryRequests : 0,
  };
}

function shouldRollbackCanary(deployment: CanaryDeploymentPlan, metrics: CanaryMetrics): boolean {
  return deployment.mode === 'canary'
    && metrics.canaryRequests >= deployment.minimumSampleSize
    && metrics.errorRate > deployment.rollbackThreshold;
}

function canaryRollbackReason(
  deployment: CanaryDeploymentPlan,
  metrics: CanaryMetrics,
): string {
  return `Canary rollout rolled back: error rate ${(metrics.errorRate * 100).toFixed(1)}% exceeds threshold ${(deployment.rollbackThreshold * 100).toFixed(1)}%`;
}

export class ProposalExecutor {
  private readonly opts: NormalizedExecutorOptions;
  private executions: Map<string, ExecutionResult> = new Map();

  constructor(opts: ExecutorOptions = {}) {
    this.opts = {
      ...DEFAULT_OPTS,
      dryRun: opts.dryRun ?? DEFAULT_OPTS.dryRun,
      stageTimeoutMs: opts.stageTimeoutMs ?? DEFAULT_OPTS.stageTimeoutMs,
      budgetUsd: opts.budgetUsd ?? DEFAULT_OPTS.budgetUsd,
      ...(opts.runtime ? { runtime: opts.runtime } : {}),
    };
  }

  /** Execute a proposal through the agent pipeline. Returns an ExecutionResult. */
  async execute(proposal: AgentProposal): Promise<ExecutionResult> {
    const executionId = generateId();
    const startedAt = nowIso();
    const plan = buildPlan(proposal);
    const deployment = plan.deployment ?? {
      mode: 'standard',
      trafficPercent: 100,
      rollbackThreshold: 1,
      minimumSampleSize: 0,
      reason: 'Standard proposal execution does not require canary traffic splitting.',
    };

    const execution: ExecutionResult = {
      executionId,
      proposalId: proposal.id,
      proposal,
      plan,
      stages: [],
      status: 'running',
      totalDurationMs: 0,
      startedAt,
      deployment,
    };

    this.executions.set(executionId, execution);

    const stagesToRun = plan.stages.filter(s => s !== 'complete' && s !== 'failed');
    let totalMs = 0;
    let totalCostUsd = 0;
    const diffs: string[] = [];
    let testSummary: ExecutionResult['testSummary'];
    let canaryMetrics = deployment.mode === 'canary' ? defaultCanaryMetrics() : undefined;

    for (let i = 0; i < stagesToRun.length; i++) {
      const stage = stagesToRun[i]!;
      const agentId = plan.estimatedAgents[i] ?? plan.estimatedAgents[plan.estimatedAgents.length - 1] ?? 'coder';
      const deploymentVariant = routeDeploymentVariant(deployment, proposal.id, stage, i);

      let stageResult: StageResult;
      if (this.opts.dryRun) {
        stageResult = simulateStage(stage, agentId);
      } else {
        if (!this.opts.runtime) {
          throw new Error('ProposalExecutor dryRun:false requires an injected runtime executor');
        }

        let response: StageExecutionResponse;
        try {
          response = await this.opts.runtime.executeStage({
            executionId,
            proposal,
            plan,
            stage,
            agentId,
            stageIndex: i,
            deployment,
            deploymentVariant,
            timeoutMs: this.opts.stageTimeoutMs,
            budgetRemainingUsd: Math.max(this.opts.budgetUsd - totalCostUsd, 0),
          });
        } catch (error) {
          response = {
            output: '',
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }

        stageResult = normalizeRuntimeStage(stage, agentId, response);
        totalCostUsd += response.costUsd ?? 0;
        if (response.diff) diffs.push(response.diff);
        if (response.testSummary) testSummary = response.testSummary;
        if (deployment.mode === 'canary') {
          canaryMetrics = advanceCanaryMetrics(canaryMetrics ?? defaultCanaryMetrics(), response, deploymentVariant);
          if (canaryMetrics && shouldRollbackCanary(deployment, canaryMetrics)) {
            const rollbackReason = response.rollbackReason ?? canaryRollbackReason(deployment, canaryMetrics);
            return finalizeRollback(execution, totalMs + stageResult.durationMs, totalCostUsd, canaryMetrics, rollbackReason, stageResult);
          }
        }
      }

      execution.stages.push(stageResult);
      totalMs += stageResult.durationMs;

      if (!stageResult.success) {
        execution.status = 'failed';
        execution.completedAt = nowIso();
        execution.totalDurationMs = totalMs;
        if (totalCostUsd > 0) execution.totalCostUsd = totalCostUsd;
        return execution;
      }

      if (!this.opts.dryRun && totalCostUsd > this.opts.budgetUsd) {
        const message = `Execution budget exceeded: $${totalCostUsd.toFixed(4)} > $${this.opts.budgetUsd.toFixed(4)}`;
        execution.stages.push({
          stage: 'failed',
          agentId: 'executor',
          output: message,
          durationMs: 0,
          success: false,
          error: message,
        });
        execution.status = 'failed';
        execution.completedAt = nowIso();
        execution.totalDurationMs = totalMs;
        execution.totalCostUsd = totalCostUsd;
        return execution;
      }

      if (deployment.mode === 'canary') {
        const currentMetrics = canaryMetrics ?? defaultCanaryMetrics();
        if (shouldRollbackCanary(deployment, currentMetrics)) {
          const rollbackReason = canaryRollbackReason(deployment, currentMetrics);
          return finalizeRollback(execution, totalMs, totalCostUsd, currentMetrics, rollbackReason);
        }
      }
    }

    if (this.opts.dryRun) {
      const passed = Math.ceil(Math.random() * 15) + 5;
      execution.diff = `--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,3 +1,4 @@\n+// Applied: ${proposal.title}\n export function example() {\n-  // TODO\n+  // Implemented\n }`;
      execution.testSummary = { passed, failed: 0, total: passed };
    } else {
      if (diffs.length > 0) execution.diff = diffs.join('\n');
      if (testSummary) execution.testSummary = testSummary;
      if (totalCostUsd > 0) execution.totalCostUsd = totalCostUsd;
    }
    if (canaryMetrics) execution.canaryMetrics = canaryMetrics;
    execution.status = 'passed';
    execution.completedAt = nowIso();
    execution.totalDurationMs = totalMs;

    execution.stages.push({ stage: 'complete', agentId: 'executor', output: 'All stages passed.', durationMs: 0, success: true });

    return execution;
  }

  /** Get a stored execution result by ID. */
  get(executionId: string): ExecutionResult | undefined {
    return this.executions.get(executionId);
  }

  /** List all execution results. */
  list(): ExecutionResult[] {
    return [...this.executions.values()];
  }
}

export class ProposalSprintExecutor {
  private readonly proposalExecutor: ProposalExecutor;

  constructor(proposalExecutor: ProposalExecutor = new ProposalExecutor()) {
    this.proposalExecutor = proposalExecutor;
  }

  async executeSprintItem(request: SprintItemExecutionRequest): Promise<SprintItemExecutionResult> {
    const result = await this.proposalExecutor.execute(sprintItemToProposal(request.item));
    const errorStage = result.stages.find((stage) => !stage.success);
    const response: SprintItemExecutionResult = {
      success: result.status === 'passed',
      costUsd: result.totalCostUsd ?? 0,
    };

    if (result.stages.length > 0) {
      response.output = result.stages.map((stage) => stage.output).join('\n');
    }
    if (errorStage?.error) {
      response.error = errorStage.error;
    }

    return response;
  }
}

function normalizeRuntimeStage(
  stage: ExecutionStage,
  agentId: string,
  response: StageExecutionResponse,
): StageResult {
  return {
    stage,
    agentId,
    output: response.output,
    durationMs: response.durationMs ?? 0,
    success: response.success,
    ...(response.error ? { error: response.error } : {}),
  };
}

function finalizeRollback(
  execution: ExecutionResult,
  totalMs: number,
  totalCostUsd: number,
  canaryMetrics: CanaryMetrics,
  rollbackReason: string,
  lastStage?: StageResult,
): ExecutionResult {
  if (lastStage) {
    execution.stages.push(lastStage);
  }

  execution.stages.push({
    stage: 'failed',
    agentId: 'executor',
    output: rollbackReason,
    durationMs: 0,
    success: false,
    error: rollbackReason,
  });
  execution.status = 'rolled_back';
  execution.rollbackTriggered = true;
  execution.rollbackReason = rollbackReason;
  execution.canaryMetrics = canaryMetrics;
  execution.completedAt = nowIso();
  execution.totalDurationMs = totalMs;
  if (totalCostUsd > 0) execution.totalCostUsd = totalCostUsd;
  return execution;
}

function sprintItemToProposal(item: SprintItemExecutionRequest['item']): AgentProposal {
  return {
    id: item.id,
    agentId: 'sprint-runner',
    title: item.title,
    description: item.description,
    priority: item.priority,
    confidence: 1,
    estimatedImpact: 'Sprint item',
    tags: ['sprint'],
    proposedAt: nowIso(),
    status: 'approved',
  };
}
