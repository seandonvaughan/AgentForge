import { describe, expect, it, vi } from 'vitest';
import { ProposalExecutor, ProposalSprintExecutor } from '../executor.js';
import type { AgentProposal } from '@agentforge/core';

describe('ProposalExecutor execution modes', () => {
  it('keeps dry-run execution as the default', async () => {
    const result = await new ProposalExecutor().execute(buildMediumProposal());

    expect(result.status).toBe('passed');
    expect(result.diff).toContain('Applied: Add runtime-backed execution');
    expect(result.testSummary?.failed).toBe(0);
  });

  it('uses an injected runtime executor when dryRun is false', async () => {
    const stages: string[] = [];
    const models: string[] = [];
    const result = await new ProposalExecutor({
      dryRun: false,
      runtime: {
        async executeStage({ stage, model }) {
          stages.push(stage);
          models.push(model);
          return {
            output: `ran ${stage}`,
            success: true,
            durationMs: 10,
            costUsd: 0.05,
            ...(stage === 'coding' ? { diff: 'diff --git a/file.ts b/file.ts' } : {}),
            ...(stage === 'testing' ? { testSummary: { passed: 3, failed: 0, total: 3 } } : {}),
          };
        },
      },
    }).execute(buildMediumProposal());

    expect(stages).toEqual(['planning', 'coding', 'linting', 'testing']);
    expect(models).toEqual(['haiku', 'sonnet', 'haiku', 'haiku']);
    expect(result.status).toBe('passed');
    expect(result.totalCostUsd).toBeCloseTo(0.2);
    expect(result.diff).toContain('diff --git');
    expect(result.testSummary).toEqual({ passed: 3, failed: 0, total: 3 });
    expect(result.stages.map((stage) => stage.stage)).toEqual(['planning', 'coding', 'linting', 'testing', 'complete']);
  });

  it('routes high-complexity proposals through architecture before coding', async () => {
    const stages: string[] = [];
    const models: string[] = [];
    const result = await new ProposalExecutor({
      dryRun: false,
      runtime: {
        async executeStage({ stage, model }) {
          stages.push(stage);
          models.push(model);
          return {
            output: `ran ${stage}`,
            success: true,
            durationMs: 10,
            costUsd: 0.01,
          };
        },
      },
    }).execute(buildHighComplexityProposal());

    expect(stages).toEqual(['planning', 'architecture', 'coding', 'linting', 'testing']);
    expect(models).toEqual(['sonnet', 'sonnet', 'sonnet', 'haiku', 'haiku']);
    expect(result.status).toBe('passed');
    expect(result.stages.map((stage) => stage.stage)).toEqual([
      'planning',
      'architecture',
      'coding',
      'linting',
      'testing',
      'complete',
    ]);
  });

  it('routes low-complexity proposals without linting stage', async () => {
    const stages: string[] = [];
    const models: string[] = [];
    const result = await new ProposalExecutor({
      dryRun: false,
      runtime: {
        async executeStage({ stage, model }) {
          stages.push(stage);
          models.push(model);
          return {
            output: `ran ${stage}`,
            success: true,
            durationMs: 10,
            costUsd: 0.01,
          };
        },
      },
    }).execute(buildLowComplexityProposal());

    expect(stages).toEqual(['planning', 'coding', 'testing']);
    expect(models).toEqual(['haiku', 'sonnet', 'haiku']);
    expect(result.status).toBe('passed');
    expect(result.stages.map((stage) => stage.stage)).toEqual(['planning', 'coding', 'testing', 'complete']);
  });

  it('runs canary validation for self-mod proposals when enabled', async () => {
    const stages: string[] = [];
    const models: string[] = [];
    const result = await new ProposalExecutor({
      dryRun: false,
      canary: {
        enabledForSelfModification: true,
        trafficPercent: 100,
      },
      runtime: {
        async executeStage({ stage, model }) {
          stages.push(stage);
          models.push(model);
          return {
            output: `ran ${stage}`,
            success: true,
            durationMs: 10,
            costUsd: 0.01,
          };
        },
      },
    }).execute(buildSelfModificationProposal());

    expect(stages).toEqual(['planning', 'coding', 'linting', 'testing', 'canary']);
    expect(models).toEqual(['haiku', 'sonnet', 'haiku', 'haiku', 'haiku']);
    expect(result.status).toBe('passed');
    expect(result.stages.map((stage) => stage.stage)).toEqual(['planning', 'coding', 'linting', 'testing', 'canary', 'complete']);
  });

  it('skips self-mod canary stage when enabledForSelfModification is false', async () => {
    const stages: string[] = [];
    const result = await new ProposalExecutor({
      dryRun: false,
      canary: {
        enabledForSelfModification: false,
        trafficPercent: 100,
      },
      runtime: {
        async executeStage({ stage }) {
          stages.push(stage);
          return {
            output: `ran ${stage}`,
            success: true,
            durationMs: 10,
            costUsd: 0.01,
          };
        },
      },
    }).execute(buildSelfModificationProposal());

    expect(stages).toEqual(['planning', 'coding', 'linting', 'testing']);
    expect(result.status).toBe('passed');
    expect(result.stages.map((stage) => stage.stage)).toEqual(['planning', 'coding', 'linting', 'testing', 'complete']);
  });

  it('routes self-mod proposals to control and rejects without executing runtime when traffic is 0%', async () => {
    const executeStage = vi.fn();
    const result = await new ProposalExecutor({
      dryRun: false,
      canary: {
        enabledForSelfModification: true,
        trafficPercent: 0,
      },
      runtime: {
        executeStage,
      },
    }).execute(buildSelfModificationProposal());

    expect(executeStage).not.toHaveBeenCalled();
    expect(result.status).toBe('rejected');
    expect(result.stages.map((stage) => stage.stage)).toEqual(['canary']);
  });

  it('rolls back self-mod canary execution when testing fails thresholds', async () => {
    const stages: string[] = [];
    const result = await new ProposalExecutor({
      dryRun: false,
      canary: {
        enabledForSelfModification: true,
        trafficPercent: 100,
        maxFailedTests: 0,
        maxFailureRate: 0,
      },
      runtime: {
        async executeStage({ stage }) {
          stages.push(stage);
          if (stage === 'testing') {
            return {
              output: 'tests failed',
              success: true,
              durationMs: 10,
              costUsd: 0.01,
              testSummary: { passed: 2, failed: 1, total: 3 },
            };
          }
          return {
            output: `ran ${stage}`,
            success: true,
            durationMs: 10,
            costUsd: 0.01,
          };
        },
      },
    }).execute(buildSelfModificationProposal());

    expect(stages).toEqual(['planning', 'coding', 'linting', 'testing']);
    expect(result.status).toBe('rejected');
    expect(result.stages.map((stage) => stage.stage)).toEqual(['planning', 'coding', 'linting', 'testing', 'rollback']);
  });

  it('preserves partial cost, test summary, and diff when a stage fails', async () => {
    const stages: string[] = [];
    const result = await new ProposalExecutor({
      dryRun: false,
      runtime: {
        async executeStage({ stage }) {
          stages.push(stage);
          if (stage === 'architecture') {
            return {
              output: 'architecture failed',
              success: false,
              durationMs: 5,
              costUsd: 0.2,
              error: 'invalid architecture plan',
              diff: 'diff --git a/partial.ts b/partial.ts',
              testSummary: { passed: 1, failed: 1, total: 2 },
            };
          }
          return {
            output: `ran ${stage}`,
            success: true,
            durationMs: 10,
            costUsd: 0.1,
            ...(stage === 'planning' ? { diff: 'diff --git a/plan.md b/plan.md' } : {}),
            ...(stage === 'planning' ? { testSummary: { passed: 1, failed: 0, total: 1 } } : {}),
          };
        },
      },
    }).execute(buildHighComplexityProposal());

    expect(stages).toEqual(['planning', 'architecture']);
    expect(result.status).toBe('failed');
    expect(result.totalCostUsd).toBeCloseTo(0.3);
    expect(result.diff).toContain('diff --git a/plan.md b/plan.md');
    expect(result.diff).toContain('diff --git a/partial.ts b/partial.ts');
    expect(result.testSummary).toEqual({ passed: 1, failed: 1, total: 2 });
    expect(result.stages.map((stage) => stage.stage)).toEqual(['planning', 'architecture']);
    expect(result.stages[1]?.success).toBe(false);
    expect(result.stages[1]?.error).toContain('invalid architecture plan');
  });

  it('requires a runtime executor when dryRun is false', async () => {
    await expect(new ProposalExecutor({ dryRun: false }).execute(buildMediumProposal())).rejects.toThrow(
      /requires an injected runtime executor/,
    );
  });

  it('adapts proposal execution to the SprintRunner executor interface', async () => {
    const sprintExecutor = new ProposalSprintExecutor(new ProposalExecutor({
      dryRun: false,
      runtime: {
        async executeStage() {
          return { output: 'ok', success: true, costUsd: 0.01 };
        },
      },
    }));

    const result = await sprintExecutor.executeSprintItem({
      budgetRemainingUsd: 1,
      plan: {
        version: '1.0',
        name: 'Test sprint',
        plannedAt: '2026-04-30T00:00:00.000Z',
        budgetUsd: 1,
        source: 'human',
        items: [],
      },
      item: {
        id: 'item-1',
        priority: 'P2',
        title: 'Patch docs',
        description: 'fix docs typo',
        status: 'pending',
      },
    });

    expect(result.success).toBe(true);
    expect(result.costUsd).toBeGreaterThan(0);
  });
});

function buildMediumProposal(): AgentProposal {
  return {
    id: 'proposal-1',
    agentId: 'coder',
    title: 'Add runtime-backed execution',
    description: 'add runtime-backed execution for proposals',
    priority: 'P1',
    confidence: 0.9,
    estimatedImpact: 'Medium',
    tags: ['runtime'],
    proposedAt: '2026-04-30T00:00:00.000Z',
    status: 'approved',
  };
}

function buildHighComplexityProposal(): AgentProposal {
  return {
    ...buildMediumProposal(),
    id: 'proposal-high-1',
    title: 'Architecture redesign for runtime executor',
    description: 'refactor and migrate runtime orchestration with architecture review',
  };
}

function buildLowComplexityProposal(): AgentProposal {
  return {
    ...buildMediumProposal(),
    id: 'proposal-low-1',
    title: 'Patch runtime typo',
    description: 'fix minor executor log typo',
  };
}

function buildSelfModificationProposal(): AgentProposal {
  return {
    ...buildMediumProposal(),
    id: 'proposal-selfmod-1',
    title: 'Self-modification rollout for agent prompt override',
    description: 'apply self-modification canary controls before promoting override',
    tags: ['runtime', 'self-modification'],
  };
}
