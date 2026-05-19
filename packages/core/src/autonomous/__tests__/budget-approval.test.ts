import { describe, expect, it, vi } from 'vitest';
import { BudgetApproval } from '../budget-approval.js';
import type { RankedItem } from '../types.js';
import type { CycleLogger } from '../cycle-logger.js';

function item(overrides: Partial<RankedItem>): RankedItem {
  return {
    itemId: overrides.itemId ?? 'item-1',
    title: overrides.title ?? 'Item',
    rank: overrides.rank ?? 1,
    score: overrides.score ?? 1,
    confidence: overrides.confidence ?? 1,
    estimatedCostUsd: overrides.estimatedCostUsd ?? 1,
    estimatedDurationMinutes: overrides.estimatedDurationMinutes ?? 10,
    rationale: overrides.rationale ?? 'test',
    dependencies: overrides.dependencies ?? [],
    suggestedAssignee: overrides.suggestedAssignee ?? 'test-engineer',
    suggestedTags: overrides.suggestedTags ?? [],
    withinBudget: overrides.withinBudget ?? true,
  };
}

function logger(): CycleLogger {
  return {
    logApprovalPending: vi.fn(),
    logApprovalDecision: vi.fn(),
  } as unknown as CycleLogger;
}

describe('BudgetApproval', () => {
  it('auto-approves selected within-budget items and rejects deferred items', async () => {
    const approval = new BudgetApproval('.', 'cycle-1', logger());

    const result = await approval.collect({
      withinBudget: [item({ itemId: 'selected', estimatedCostUsd: 1 })],
      requiresApproval: [item({ itemId: 'deferred', estimatedCostUsd: 2, withinBudget: false })],
      budgetUsd: 1,
      summary: 'selected one item within cap',
    });

    expect(result.decision).toBe('auto-approved');
    expect(result.approvedItems.map(i => i.itemId)).toEqual(['selected']);
    expect(result.rejectedItems.map(i => i.itemId)).toEqual(['deferred']);
    expect(result.finalBudgetUsd).toBe(1);
  });
});
