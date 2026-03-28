import { describe, it, expect } from 'vitest';
import { ProposalExecutor, buildPlan } from '@agentforge/executor';

const mockProposal = {
  id: 'prop-test-1',
  agentId: 'cto',
  title: 'Fix login reliability',
  description: 'Fix recurring login failures affecting 20% of sessions.',
  priority: 'P0' as const,
  confidence: 0.85,
  estimatedImpact: 'High',
  tags: ['reliability', 'auth'],
  proposedAt: new Date().toISOString(),
  status: 'approved' as const,
};

describe('executor — ProposalExecutor', () => {
  it('buildPlan infers complexity correctly', () => {
    const plan = buildPlan(mockProposal);
    expect(plan.proposalId).toBe('prop-test-1');
    expect(['low', 'medium', 'high']).toContain(plan.estimatedComplexity);
    expect(plan.stages.length).toBeGreaterThan(0);
    expect(plan.sandboxed).toBe(true);
  });

  it('execute produces a passed result in dry-run mode', async () => {
    const executor = new ProposalExecutor({ dryRun: true });
    const result = await executor.execute(mockProposal);
    expect(result.status).toBe('passed');
    expect(result.executionId).toBeTruthy();
    expect(result.stages.length).toBeGreaterThan(0);
    expect(result.testSummary?.failed).toBe(0);
    expect(result.diff).toContain('Applied:');
  });

  it('execute generates a diff and test summary', async () => {
    const executor = new ProposalExecutor({ dryRun: true });
    const result = await executor.execute(mockProposal);
    expect(result.diff).toBeTruthy();
    expect(result.testSummary?.total).toBeGreaterThan(0);
    expect(result.completedAt).toBeTruthy();
  });

  it('list() returns all executions', async () => {
    const executor = new ProposalExecutor({ dryRun: true });
    await executor.execute(mockProposal);
    await executor.execute({ ...mockProposal, id: 'prop-test-2' });
    expect(executor.list().length).toBe(2);
  });

  it('get() retrieves an execution by id', async () => {
    const executor = new ProposalExecutor({ dryRun: true });
    const result = await executor.execute(mockProposal);
    const retrieved = executor.get(result.executionId);
    expect(retrieved?.executionId).toBe(result.executionId);
  });

  it('high-complexity proposals include architecture stage', () => {
    const complexProposal = { ...mockProposal, title: 'Refactor architecture', description: 'Full refactor of the core architecture layer.' };
    const plan = buildPlan(complexProposal);
    expect(plan.estimatedComplexity).toBe('high');
    expect(plan.stages).toContain('architecture');
  });
});
