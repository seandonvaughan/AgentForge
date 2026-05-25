import { generateId, nowIso } from '@agentforge/shared';
import type { AgentProposal, SprintItemExecutionRequest, SprintItemExecutionResult } from '@agentforge/core';
import { buildPlan, isSelfModificationProposal, modelForStage } from './planner.js';
import type {
  CanaryOptions,
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
  canary: NormalizedCanaryOptions;
  runtime?: ProposalRuntimeExecutor;
}

type CanaryRoute = 'canary' | 'control' | 'disabled' | 'not-applicable';

interface CanaryDecision {
  route: CanaryRoute;
  reason: string;
}

interface NormalizedCanaryOptions {
  enabled: boolean;
  enabledForSelfModification: boolean;
  trafficPercent: number;
  rollbackOnStageFailure: boolean;
  rollbackOnTestFailure: boolean;
  maxFailedTests: number;
  maxFailureRate: number;
  selfModificationMarkers: string[] | undefined;
}

const DEFAULT_OPTS = {
  dryRun: true,
  stageTimeoutMs: 30_000,
  budgetUsd: 1.00,
  canary: {
    enabled: true,
    enabledForSelfModification: false,
    trafficPercent: 10,
    rollbackOnStageFailure: true,
    rollbackOnTestFailure: true,
    maxFailedTests: 0,
    maxFailureRate: 0,
    selfModificationMarkers: undefined,
  },
} satisfies Omit<NormalizedExecutorOptions, 'runtime'>;

/** Simulates a stage result in dry-run mode. */
function simulateStage(stage: ExecutionStage, agentId: string): StageResult {
  const outputs: Record<ExecutionStage, string> = {
    planning: `Plan generated: breaking proposal into ${Math.ceil(Math.random() * 4) + 1} implementation tasks.`,
    architecture: `Architecture reviewed: identified ${Math.ceil(Math.random() * 3) + 1} affected modules.`,
    coding: `Implementation drafted: ${Math.ceil(Math.random() * 6) + 2} files modified.`,
    linting: `Linting passed: 0 errors, ${Math.floor(Math.random() * 3)} warnings.`,
    testing: `Tests executed: ${Math.ceil(Math.random() * 20) + 5} passing, 0 failing.`,
    canary: 'Canary validation passed for staged self-modification rollout.',
    rollback: 'Canary rollback executed to restore stable behavior.',
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
  private readonly opts: NormalizedExecutorOptions;
  private executions: Map<string, ExecutionResult> = new Map();

  constructor(opts: ExecutorOptions = {}) {
    this.opts = {
      ...DEFAULT_OPTS,
      dryRun: opts.dryRun ?? DEFAULT_OPTS.dryRun,
      stageTimeoutMs: opts.stageTimeoutMs ?? DEFAULT_OPTS.stageTimeoutMs,
      budgetUsd: opts.budgetUsd ?? DEFAULT_OPTS.budgetUsd,
      canary: {
        ...DEFAULT_OPTS.canary,
        ...(opts.canary ?? {}),
        trafficPercent: clampPercent(opts.canary?.trafficPercent ?? DEFAULT_OPTS.canary.trafficPercent),
        maxFailedTests: Math.max(opts.canary?.maxFailedTests ?? DEFAULT_OPTS.canary.maxFailedTests, 0),
        maxFailureRate: clampFailureRate(opts.canary?.maxFailureRate ?? DEFAULT_OPTS.canary.maxFailureRate),
      },
      ...(opts.runtime ? { runtime: opts.runtime } : {}),
    };
  }

  /** Execute a proposal through the agent pipeline. Returns an ExecutionResult. */
  async execute(proposal: AgentProposal): Promise<ExecutionResult> {
    const executionId = generateId();
    const startedAt = nowIso();
    const plan = buildPlan(proposal, toCanaryPlanOptions(this.opts.canary));
    const isSelfModification = isSelfModificationProposal(proposal, this.opts.canary.selfModificationMarkers);
    const canaryDecision = resolveCanaryDecision(proposal, isSelfModification, this.opts.canary);

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

    if (canaryDecision.route === 'control') {
      execution.stages.push({
        stage: 'canary',
        agentId: 'safety-auditor',
        output: `Self-modification held in control cohort (${this.opts.canary.trafficPercent}% canary split). ${canaryDecision.reason}`,
        durationMs: 0,
        success: true,
      });
      execution.status = 'rejected';
      execution.completedAt = nowIso();
      execution.totalDurationMs = 0;
      return execution;
    }

    const stagesToRun = plan.stages.filter((stage) => (
      stage !== 'complete'
      && stage !== 'failed'
      && shouldExecuteStage(stage, canaryDecision, isSelfModification, this.opts.canary)
    ));
    let totalMs = 0;
    let totalCostUsd = 0;
    const diffs: string[] = [];
    let testSummary: ExecutionResult['testSummary'];

    for (let i = 0; i < stagesToRun.length; i++) {
      const stage = stagesToRun[i]!;
      const agentId = resolveAgentForStage(plan.estimatedAgents, stage, i);

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
            model: modelForStage(plan.estimatedComplexity, stage),
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

        stageResult = normalizeRuntimeStage(stage, agentId, response);
        totalCostUsd += response.costUsd ?? 0;
        if (response.diff) diffs.push(response.diff);
        if (response.testSummary) testSummary = response.testSummary;
      }

      execution.stages.push(stageResult);
      totalMs += stageResult.durationMs;

      if (!stageResult.success) {
        if (canaryDecision.route === 'canary' && this.opts.canary.rollbackOnStageFailure) {
          appendRollbackStage(execution, `Canary rollback after ${stage} stage failure.`);
          if (!this.opts.dryRun) {
            if (diffs.length > 0) execution.diff = diffs.join('\n');
            if (testSummary) execution.testSummary = testSummary;
          }
          execution.status = 'rejected';
          execution.completedAt = nowIso();
          execution.totalDurationMs = totalMs;
          if (totalCostUsd > 0) execution.totalCostUsd = totalCostUsd;
          return execution;
        }

        if (!this.opts.dryRun) {
          if (diffs.length > 0) execution.diff = diffs.join('\n');
          if (testSummary) execution.testSummary = testSummary;
        }
        execution.status = 'failed';
        execution.completedAt = nowIso();
        execution.totalDurationMs = totalMs;
        if (totalCostUsd > 0) execution.totalCostUsd = totalCostUsd;
        return execution;
      }

      if (
        canaryDecision.route === 'canary'
        && this.opts.canary.rollbackOnTestFailure
        && stage === 'testing'
        && testSummary
        && exceedsCanaryTestThreshold(testSummary, this.opts.canary)
      ) {
        const failRate = testSummary.total > 0 ? testSummary.failed / testSummary.total : 0;
        appendRollbackStage(
          execution,
          `Canary rollback after testing threshold breach (failed=${testSummary.failed}, rate=${(failRate * 100).toFixed(1)}%).`,
        );
        if (!this.opts.dryRun) {
          if (diffs.length > 0) execution.diff = diffs.join('\n');
          execution.testSummary = testSummary;
          if (totalCostUsd > 0) execution.totalCostUsd = totalCostUsd;
        }
        execution.status = 'rejected';
        execution.completedAt = nowIso();
        execution.totalDurationMs = totalMs;
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

function shouldExecuteStage(
  stage: ExecutionStage,
  canaryDecision: CanaryDecision,
  isSelfModification: boolean,
  canary: NormalizedCanaryOptions,
): boolean {
  if (stage !== 'canary') return true;
  if (!canary.enabled) return false;
  if (!isSelfModification) return true;
  if (!canary.enabledForSelfModification) return false;
  return canaryDecision.route === 'canary';
}

function resolveCanaryDecision(
  proposal: AgentProposal,
  isSelfModification: boolean,
  canary: NormalizedCanaryOptions,
): CanaryDecision {
  if (!canary.enabled) {
    return { route: 'disabled', reason: 'canary feature flag is disabled' };
  }

  if (!isSelfModification) {
    return { route: 'not-applicable', reason: 'proposal is not self-modifying' };
  }

  if (!canary.enabledForSelfModification) {
    return {
      route: 'disabled',
      reason: 'self-modification canary feature flag is disabled',
    };
  }

  if (canary.trafficPercent <= 0) {
    return { route: 'control', reason: 'traffic split set to 0%' };
  }

  if (canary.trafficPercent >= 100) {
    return { route: 'canary', reason: 'traffic split set to 100%' };
  }

  const bucket = deterministicPercent(proposal.id);
  if (bucket < canary.trafficPercent) {
    return { route: 'canary', reason: `proposal bucket ${bucket} < ${canary.trafficPercent}` };
  }
  return { route: 'control', reason: `proposal bucket ${bucket} >= ${canary.trafficPercent}` };
}

function deterministicPercent(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash % 100);
}

function appendRollbackStage(execution: ExecutionResult, reason: string): void {
  execution.stages.push({
    stage: 'rollback',
    agentId: 'safety-auditor',
    output: reason,
    durationMs: 0,
    success: true,
  });
}

function exceedsCanaryTestThreshold(
  summary: NonNullable<ExecutionResult['testSummary']>,
  canary: NormalizedCanaryOptions,
): boolean {
  if (summary.failed > canary.maxFailedTests) return true;
  if (summary.total <= 0) return summary.failed > 0;
  const failureRate = summary.failed / summary.total;
  return failureRate > canary.maxFailureRate;
}

function resolveAgentForStage(estimatedAgents: string[], stage: ExecutionStage, stageIndex: number): string {
  const preferredAgent = preferredAgentForStage(stage);
  if (preferredAgent && estimatedAgents.includes(preferredAgent)) {
    return preferredAgent;
  }
  return estimatedAgents[stageIndex] ?? estimatedAgents[estimatedAgents.length - 1] ?? preferredAgent ?? 'coder';
}

function preferredAgentForStage(stage: ExecutionStage): string | null {
  switch (stage) {
    case 'planning':
      return 'project-manager';
    case 'architecture':
      return 'architect';
    case 'coding':
      return 'coder';
    case 'linting':
      return 'linter';
    case 'testing':
      return 'debugger';
    case 'canary':
    case 'rollback':
      return 'safety-auditor';
    default:
      return null;
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value) || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, Math.floor(value)));
}

function clampFailureRate(value: number): number {
  if (!Number.isFinite(value) || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function toCanaryPlanOptions(canary: NormalizedCanaryOptions): CanaryOptions {
  return {
    enabled: canary.enabled,
    enabledForSelfModification: canary.enabledForSelfModification,
    trafficPercent: canary.trafficPercent,
    rollbackOnStageFailure: canary.rollbackOnStageFailure,
    rollbackOnTestFailure: canary.rollbackOnTestFailure,
    maxFailedTests: canary.maxFailedTests,
    maxFailureRate: canary.maxFailureRate,
    ...(canary.selfModificationMarkers ? { selfModificationMarkers: canary.selfModificationMarkers } : {}),
  };
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
