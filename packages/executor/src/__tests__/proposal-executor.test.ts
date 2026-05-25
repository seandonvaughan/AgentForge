import { describe, expect, it, vi } from 'vitest';
import { ProposalExecutor, ProposalSprintExecutor } from '../executor.js';
import * as planner from '../planner.js';
import type { AgentProposal } from '@agentforge/core';

describe('ProposalExecutor execution modes', () => {
  it('keeps dry-run execution as the default', async () => {
    const result = await new ProposalExecutor().execute(buildProposal());

    expect(result.status).toBe('passed');
    expect(result.diff).toContain('Applied: Add runtime-backed execution');
    expect(result.testSummary?.failed).toBe(0);
  });

  it('uses an injected runtime executor when dryRun is false', async () => {
    const stages: string[] = [];
    const result = await new ProposalExecutor({
      dryRun: false,
      runtime: {
        async executeStage({ stage }) {
          stages.push(stage);
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
    }).execute(buildProposal());

    expect(stages).toEqual(['planning', 'coding', 'linting', 'testing']);
    expect(result.status).toBe('passed');
    expect(result.totalCostUsd).toBeCloseTo(0.2);
    expect(result.diff).toContain('diff --git');
    expect(result.testSummary).toEqual({ passed: 3, failed: 0, total: 3 });
  });

  it('requires a runtime executor when dryRun is false', async () => {
    await expect(new ProposalExecutor({ dryRun: false }).execute(buildProposal())).rejects.toThrow(
      /requires an injected runtime executor/,
    );
  });

  it('plans and executes a canary stage for self-modification proposals by default', async () => {
    const stages: string[] = [];
    const result = await new ProposalExecutor({
      dryRun: false,
      runtime: {
        async executeStage({ stage }) {
          stages.push(stage);
          return { output: `ran ${stage}`, success: true };
        },
      },
    }).execute(buildSelfModificationProposal());

    expect(stages).toEqual(['planning', 'coding', 'linting', 'testing', 'canary']);
    expect(result.plan.stages).toEqual(['planning', 'coding', 'linting', 'testing', 'canary', 'complete']);
  });

  it('skips planned canary stage when self-modification canary is disabled', async () => {
    const stages: string[] = [];
    const result = await new ProposalExecutor({
      dryRun: false,
      canary: { enabledForSelfModification: false },
      runtime: {
        async executeStage({ stage }) {
          stages.push(stage);
          return { output: `ran ${stage}`, success: true };
        },
      },
    }).execute(buildSelfModificationProposal());

    expect(result.plan.stages).toContain('canary');
    expect(stages).toEqual(['planning', 'coding', 'linting', 'testing']);
  });

  it('does not skip canary stage for non-self-mod plans when self-mod canary is disabled', async () => {
    const stages: string[] = [];
    const buildPlanSpy = vi.spyOn(planner, 'buildPlan').mockReturnValue({
      proposalId: 'proposal-1',
      stages: ['planning', 'coding', 'canary', 'complete'],
      estimatedAgents: ['project-manager', 'coder', 'qa-manager'],
      estimatedComplexity: 'medium',
      sandboxed: true,
      createdAt: '2026-04-30T00:00:00.000Z',
    });

    try {
      const result = await new ProposalExecutor({
        dryRun: false,
        canary: { enabledForSelfModification: false },
        runtime: {
          async executeStage({ stage }) {
            stages.push(stage);
            return { output: `ran ${stage}`, success: true };
          },
        },
      }).execute(buildProposal());

      expect(result.plan.stages).toContain('canary');
      expect(stages).toEqual(['planning', 'coding', 'canary']);
    } finally {
      buildPlanSpy.mockRestore();
    }
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

function buildProposal(): AgentProposal {
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

function buildSelfModificationProposal(): AgentProposal {
  return {
    id: 'proposal-self-mod-1',
    agentId: 'coder',
    title: 'Canary self-modification rollout',
    description: 'stage and validate self-modification before full promotion',
    priority: 'P0',
    confidence: 0.95,
    estimatedImpact: 'High',
    tags: ['self-modification', 'safety'],
    proposedAt: '2026-04-30T00:00:00.000Z',
    status: 'approved',
  };
}
