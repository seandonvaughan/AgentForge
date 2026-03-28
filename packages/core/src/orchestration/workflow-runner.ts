import { generateId, nowIso } from '@agentforge/shared';
import type {
  WorkflowDefinition, WorkflowStep, WorkflowResult, StepResult,
  WorkflowContext, AgentStep, ParallelStep, SequentialStep, ConditionalStep,
} from './types.js';

/** Pluggable agent executor — default simulates dry-run. */
export type AgentExecutor = (agentId: string, task: string, model?: string) => Promise<{ output: string; costUsd: number; durationMs: number }>;

const DRY_RUN_EXECUTOR: AgentExecutor = async (agentId, task, model) => {
  await new Promise(r => setTimeout(r, 10 + Math.random() * 40));
  return {
    output: `[dry-run] ${agentId} completed: ${task.slice(0, 60)}`,
    costUsd: model === 'opus' ? 0.05 : model === 'haiku' ? 0.001 : 0.01,
    durationMs: 20 + Math.floor(Math.random() * 80),
  };
};

export class WorkflowRunner {
  private readonly executor: AgentExecutor;

  constructor(executor: AgentExecutor = DRY_RUN_EXECUTOR) {
    this.executor = executor;
  }

  async run(definition: WorkflowDefinition): Promise<WorkflowResult> {
    const workflowId = generateId();
    const startedAt = nowIso();
    const ctx: WorkflowContext = {
      workflowId,
      variables: {},
      totalCostUsd: 0,
      budgetUsd: definition.budgetUsd ?? Infinity,
    };

    const stepResults: StepResult[] = [];

    for (const step of definition.steps) {
      if (ctx.totalCostUsd >= ctx.budgetUsd) {
        return {
          workflowId,
          definitionId: definition.id,
          status: 'budget_exceeded',
          steps: stepResults,
          totalCostUsd: ctx.totalCostUsd,
          totalDurationMs: Date.now() - new Date(startedAt).getTime(),
          startedAt,
          completedAt: nowIso(),
        };
      }

      const result = await this._runStep(step, ctx);
      stepResults.push(result);
      ctx.totalCostUsd += result.costUsd;

      if (result.status === 'failed' && step.type === 'agent' && !step.optional) {
        return {
          workflowId,
          definitionId: definition.id,
          status: 'failed',
          steps: stepResults,
          totalCostUsd: ctx.totalCostUsd,
          totalDurationMs: Date.now() - new Date(startedAt).getTime(),
          startedAt,
          completedAt: nowIso(),
        };
      }
    }

    return {
      workflowId,
      definitionId: definition.id,
      status: 'completed',
      steps: stepResults,
      totalCostUsd: ctx.totalCostUsd,
      totalDurationMs: Date.now() - new Date(startedAt).getTime(),
      startedAt,
      completedAt: nowIso(),
    };
  }

  private async _runStep(step: WorkflowStep, ctx: WorkflowContext): Promise<StepResult> {
    const t0 = Date.now();

    if (step.type === 'agent') {
      return this._runAgentStep(step, ctx, t0);
    } else if (step.type === 'parallel') {
      return this._runParallelStep(step, ctx, t0);
    } else if (step.type === 'sequential') {
      return this._runSequentialStep(step, ctx, t0);
    } else {
      return this._runConditionalStep(step, ctx, t0);
    }
  }

  private async _runAgentStep(step: AgentStep, _ctx: WorkflowContext, t0: number): Promise<StepResult> {
    try {
      const { output, costUsd, durationMs } = await this.executor(step.agentId, step.task, step.model);
      return { stepId: step.id, agentId: step.agentId, status: 'completed', output, costUsd, durationMs };
    } catch (err) {
      return { stepId: step.id, agentId: step.agentId, status: 'failed', costUsd: 0, durationMs: Date.now() - t0, error: String(err) };
    }
  }

  private async _runParallelStep(step: ParallelStep, ctx: WorkflowContext, t0: number): Promise<StepResult> {
    const concurrency = step.concurrency ?? step.steps.length;
    const children: StepResult[] = [];
    let i = 0;

    while (i < step.steps.length) {
      const batch = step.steps.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map(s => this._runStep(s, ctx)));
      children.push(...batchResults);
      for (const r of batchResults) ctx.totalCostUsd += r.costUsd;
      i += concurrency;
    }

    const failed = children.some(r => r.status === 'failed');
    const totalCost = children.reduce((s, r) => s + r.costUsd, 0);
    return {
      stepId: step.id,
      status: failed ? 'failed' : 'completed',
      costUsd: totalCost,
      durationMs: Date.now() - t0,
      children,
    };
  }

  private async _runSequentialStep(step: SequentialStep, ctx: WorkflowContext, t0: number): Promise<StepResult> {
    const children: StepResult[] = [];

    for (const s of step.steps) {
      const result = await this._runStep(s, ctx);
      children.push(result);
      ctx.totalCostUsd += result.costUsd;
      if (result.status === 'failed') break;
    }

    const failed = children.some(r => r.status === 'failed');
    return {
      stepId: step.id,
      status: failed ? 'failed' : 'completed',
      costUsd: children.reduce((s, r) => s + r.costUsd, 0),
      durationMs: Date.now() - t0,
      children,
    };
  }

  private async _runConditionalStep(step: ConditionalStep, ctx: WorkflowContext, t0: number): Promise<StepResult> {
    // Condition evaluation — supports basic JS expressions on ctx.variables
    let conditionMet = false;
    try {
      const vars = ctx.variables;
      // eslint-disable-next-line no-new-func
      conditionMet = Boolean(new Function('context', `"use strict"; return (${step.condition})`)(vars));
    } catch {
      conditionMet = false;
    }

    const targetStep = conditionMet ? step.ifTrue : step.ifFalse;
    if (!targetStep) {
      return { stepId: step.id, status: 'skipped', costUsd: 0, durationMs: Date.now() - t0 };
    }

    const result = await this._runStep(targetStep, ctx);
    return { ...result, stepId: step.id, children: [result] };
  }
}
