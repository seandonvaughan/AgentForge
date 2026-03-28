import { generateId, nowIso } from '@agentforge/shared';
import type { AgentProposal } from '@agentforge/core';
import { buildPlan } from './planner.js';
import type { ExecutionResult, ExecutorOptions, StageResult, ExecutionStage } from './types.js';

const DEFAULT_OPTS: Required<ExecutorOptions> = {
  dryRun: true,
  stageTimeoutMs: 30_000,
  budgetUsd: 1.00,
};

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

export class ProposalExecutor {
  private readonly opts: Required<ExecutorOptions>;
  private executions: Map<string, ExecutionResult> = new Map();

  constructor(opts: ExecutorOptions = {}) {
    this.opts = { ...DEFAULT_OPTS, ...opts };
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

    const stagesToRun = plan.stages.filter(s => s !== 'complete' && s !== 'failed');
    let totalMs = 0;

    for (let i = 0; i < stagesToRun.length; i++) {
      const stage = stagesToRun[i]!;
      const agentId = plan.estimatedAgents[i] ?? plan.estimatedAgents[plan.estimatedAgents.length - 1] ?? 'coder';

      let stageResult: StageResult;
      if (this.opts.dryRun) {
        stageResult = simulateStage(stage, agentId);
      } else {
        // Production: delegate to AgentRuntime via MessageBus (P1 — not yet wired)
        stageResult = simulateStage(stage, agentId);
      }

      execution.stages.push(stageResult);
      totalMs += stageResult.durationMs;

      if (!stageResult.success) {
        execution.status = 'failed';
        execution.completedAt = nowIso();
        execution.totalDurationMs = totalMs;
        return execution;
      }
    }

    // Build synthetic diff and test summary
    const passed = Math.ceil(Math.random() * 15) + 5;
    execution.diff = `--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,3 +1,4 @@\n+// Applied: ${proposal.title}\n export function example() {\n-  // TODO\n+  // Implemented\n }`;
    execution.testSummary = { passed, failed: 0, total: passed };
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
