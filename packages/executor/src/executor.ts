import { generateId, nowIso } from '@agentforge/shared';
import type { AgentProposal, SprintItemExecutionRequest, SprintItemExecutionResult } from '@agentforge/core';
import { buildPlan } from './planner.js';
import type {
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
  canary: {
    enabledForSelfModification: boolean;
    rollbackOnFailure: boolean;
    minCanarySampleSize: number;
    maxCanaryErrorRate: number;
    requireCanarySignal: boolean;
  };
  runtime?: ProposalRuntimeExecutor;
}

const DEFAULT_OPTS = {
  dryRun: true,
  stageTimeoutMs: 30_000,
  budgetUsd: 1.0,
  canary: {
    enabledForSelfModification: true,
    rollbackOnFailure: true,
    minCanarySampleSize: 5,
    maxCanaryErrorRate: 0.05,
    requireCanarySignal: true,
  },
} satisfies Omit<NormalizedExecutorOptions, 'runtime'>;

/** Simulates a stage result in dry-run mode. */
function simulateStage(stage: ExecutionStage, agentId: string, model: 'opus' | 'sonnet' | 'haiku'): StageResult {
  const outputs: Record<ExecutionStage, string> = {
    planning: `Plan generated: breaking proposal into ${Math.ceil(Math.random() * 4) + 1} implementation tasks.`,
    architecture: `Architecture reviewed: identified ${Math.ceil(Math.random() * 3) + 1} affected modules.`,
    coding: `Implementation drafted: ${Math.ceil(Math.random() * 6) + 2} files modified.`,
    linting: `Linting passed: 0 errors, ${Math.floor(Math.random() * 3)} warnings.`,
    testing: `Tests executed: ${Math.ceil(Math.random() * 20) + 5} passing, 0 failing.`,
    canary: 'Canary rollout healthy: sample stable, no regression detected.',
    rollback: 'Rollback completed: canary changes reverted safely.',
    complete: 'Execution complete — diff ready for review.',
    failed: 'Stage failed during execution.',
  };
  return {
    stage,
    agentId,
    model,
    output: outputs[stage] ?? `Stage ${stage} complete.`,
    durationMs: Math.floor(Math.random() * 2000) + 200,
    success: true,
  };
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
      canary: {
        enabledForSelfModification:
          opts.canary?.enabledForSelfModification ?? DEFAULT_OPTS.canary.enabledForSelfModification,
        rollbackOnFailure: opts.canary?.rollbackOnFailure ?? DEFAULT_OPTS.canary.rollbackOnFailure,
        minCanarySampleSize: opts.canary?.minCanarySampleSize ?? DEFAULT_OPTS.canary.minCanarySampleSize,
        maxCanaryErrorRate: opts.canary?.maxCanaryErrorRate ?? DEFAULT_OPTS.canary.maxCanaryErrorRate,
        requireCanarySignal: opts.canary?.requireCanarySignal ?? DEFAULT_OPTS.canary.requireCanarySignal,
      },
      ...(opts.runtime ? { runtime: opts.runtime } : {}),
    };
  }

  /** Execute a proposal through the agent pipeline. Returns an ExecutionResult. */
  async execute(proposal: AgentProposal): Promise<ExecutionResult> {
    const executionId = generateId();
    const startedAt = nowIso();
    const plan = buildPlan(proposal);

    const execution: ExecutionResult = {
      executionId,
      proposalId: proposal.id,
      proposal,
      plan,
      stages: [],
      status: 'running',
      totalDurationMs: 0,
      startedAt,
    };

    this.executions.set(executionId, execution);

    const stagesToRun = plan.stages.filter((s) => s !== 'complete' && s !== 'failed' && s !== 'rollback');
    const canaryEnabled = Boolean(plan.canary?.enabled && this.opts.canary.enabledForSelfModification);
    let totalMs = 0;
    let totalCostUsd = 0;
    const diffs: string[] = [];
    let testSummary: ExecutionResult['testSummary'];
    const completedStages: ExecutionStage[] = [];
    let rollbackAttempted = false;

    const maybeRollback = async (failedStage: ExecutionStage, reason: string): Promise<void> => {
      if (this.opts.dryRun || rollbackAttempted || !canaryEnabled || !this.opts.canary.rollbackOnFailure) return;
      if (!this.opts.runtime) return;
      if (completedStages.length < (plan.canary?.minSuccessfulStages ?? 1)) return;

      rollbackAttempted = true;
      let response: StageExecutionResponse;
      try {
        response = await this.opts.runtime.executeStage({
          executionId,
          proposal,
          plan,
          stage: 'rollback',
          agentId: 'executor',
          model: modelForStage('rollback'),
          stageIndex: stagesToRun.length,
          timeoutMs: this.opts.stageTimeoutMs,
          budgetRemainingUsd: Math.max(this.opts.budgetUsd - totalCostUsd, 0),
          rollbackContext: {
            failedStage,
            reason,
            completedStages: [...completedStages],
          },
        });
      } catch (error) {
        response = {
          output: '',
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      const rollbackStage = normalizeRuntimeStage('rollback', 'executor', modelForStage('rollback'), response);
      execution.stages.push(rollbackStage);
      totalMs += rollbackStage.durationMs;
      totalCostUsd += response.costUsd ?? 0;
    };

    for (let i = 0; i < stagesToRun.length; i++) {
      const stage = stagesToRun[i]!;
      const model = modelForStage(stage);
      const agentId = plan.estimatedAgents[i] ?? plan.estimatedAgents[plan.estimatedAgents.length - 1] ?? 'coder';

      let stageResult: StageResult;
      let runtimeResponse: StageExecutionResponse | undefined;
      if (this.opts.dryRun) {
        stageResult = simulateStage(stage, agentId, model);
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
            model,
            stageIndex: i,
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

        runtimeResponse = response;
        stageResult = normalizeRuntimeStage(stage, agentId, model, response);
        totalCostUsd += response.costUsd ?? 0;
        if (response.diff) diffs.push(response.diff);
        if (response.testSummary) testSummary = response.testSummary;
      }

      execution.stages.push(stageResult);
      totalMs += stageResult.durationMs;

      if (!stageResult.success) {
        await maybeRollback(stage, stageResult.error ?? `Stage ${stage} failed`);
        execution.status = 'failed';
        execution.completedAt = nowIso();
        execution.totalDurationMs = totalMs;
        if (totalCostUsd > 0) execution.totalCostUsd = totalCostUsd;
        return execution;
      }

      completedStages.push(stage);

      if (!this.opts.dryRun && stage === 'canary') {
        const canaryFailure = evaluateCanaryFailure(runtimeResponse, this.opts);
        if (canaryFailure) {
          execution.stages.push({
            stage: 'failed',
            agentId: 'executor',
            model: modelForStage('rollback'),
            output: canaryFailure,
            durationMs: 0,
            success: false,
            error: canaryFailure,
          });
          await maybeRollback(stage, canaryFailure);
          execution.status = 'failed';
          execution.completedAt = nowIso();
          execution.totalDurationMs = totalMs;
          if (totalCostUsd > 0) execution.totalCostUsd = totalCostUsd;
          return execution;
        }
      }

      if (!this.opts.dryRun && totalCostUsd > this.opts.budgetUsd) {
        const message = `Execution budget exceeded: $${totalCostUsd.toFixed(4)} > $${this.opts.budgetUsd.toFixed(4)}`;
        execution.stages.push({
          stage: 'failed',
          agentId: 'executor',
          model: modelForStage('rollback'),
          output: message,
          durationMs: 0,
          success: false,
          error: message,
        });
        await maybeRollback(stage, message);
        execution.status = 'failed';
        execution.completedAt = nowIso();
        execution.totalDurationMs = totalMs;
        execution.totalCostUsd = totalCostUsd;
        return execution;
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
    execution.status = 'passed';
    execution.completedAt = nowIso();
    execution.totalDurationMs = totalMs;

    execution.stages.push({
      stage: 'complete',
      agentId: 'executor',
      model: modelForStage('rollback'),
      output: 'All stages passed.',
      durationMs: 0,
      success: true,
    });

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
  model: 'opus' | 'sonnet' | 'haiku',
  response: StageExecutionResponse,
): StageResult {
  return {
    stage,
    agentId,
    model,
    output: response.output,
    durationMs: response.durationMs ?? 0,
    success: response.success,
    ...(response.error ? { error: response.error } : {}),
  };
}

function evaluateCanaryFailure(
  response: StageExecutionResponse | undefined,
  opts: NormalizedExecutorOptions,
): string | null {
  const canary = response?.canary;
  if (!canary) {
    return opts.canary.requireCanarySignal ? 'Canary validation missing: runtime did not return canary metrics.' : null;
  }

  if (!canary.approved) {
    return canary.reason ?? 'Canary rollout rejected by runtime validator.';
  }

  if (canary.sampleSize !== undefined && canary.sampleSize < opts.canary.minCanarySampleSize) {
    return `Canary sample too small: ${canary.sampleSize} < ${opts.canary.minCanarySampleSize}.`;
  }

  if (canary.observedErrorRate !== undefined) {
    const threshold = canary.threshold ?? opts.canary.maxCanaryErrorRate;
    if (canary.observedErrorRate > threshold) {
      return `Canary regression detected: error rate ${(canary.observedErrorRate * 100).toFixed(2)}% exceeded ${(threshold * 100).toFixed(2)}%.`;
    }
  }

  return null;
}

function modelForStage(stage: ExecutionStage): 'opus' | 'sonnet' | 'haiku' {
  if (stage === 'architecture' || stage === 'canary') return 'opus';
  if (stage === 'testing' || stage === 'rollback') return 'sonnet';
  return 'haiku';
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
