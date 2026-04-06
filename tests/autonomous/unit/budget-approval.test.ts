import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetApproval } from '../../../packages/core/src/autonomous/budget-approval.js';
import { CycleLogger } from '../../../packages/core/src/autonomous/cycle-logger.js';
import type { RankedItem } from '../../../packages/core/src/autonomous/types.js';

describe('BudgetApproval', () => {
  let tmpDir: string;
  const cycleId = 'test-ba';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-ba-'));
    mkdirSync(join(tmpDir, '.agentforge/cycles', cycleId), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const withinBudget: RankedItem[] = [
    { itemId: 'i1', title: 'Fix', rank: 1, score: 0.9, confidence: 0.9, estimatedCostUsd: 30, estimatedDurationMinutes: 30, rationale: 'r', dependencies: [], suggestedAssignee: 'coder', suggestedTags: ['fix'], withinBudget: true },
  ];
  const overflow: RankedItem[] = [
    { itemId: 'i2', title: 'Feature', rank: 2, score: 0.8, confidence: 0.85, estimatedCostUsd: 25, estimatedDurationMinutes: 30, rationale: 'r', dependencies: [], suggestedAssignee: 'coder', suggestedTags: ['feature'], withinBudget: false },
  ];

  it('returns all items when overflow is empty', async () => {
    const logger = new CycleLogger(tmpDir, cycleId);
    const approval = new BudgetApproval(tmpDir, cycleId, logger);
    const result = await approval.collect({
      withinBudget,
      requiresApproval: [],
      budgetUsd: 50,
      summary: 'ok',
    });
    expect(result.approvedItems).toEqual(withinBudget);
    expect(result.rejectedItems).toEqual([]);
    expect(result.decision).toBe('auto-approved');
  });

  it('writes approval-pending.json when overflow exists', async () => {
    const logger = new CycleLogger(tmpDir, cycleId);
    const approval = new BudgetApproval(tmpDir, cycleId, logger);

    // Force file-based mode by pre-writing decision
    writeFileSync(
      join(tmpDir, '.agentforge/cycles', cycleId, 'approval-decision.json'),
      JSON.stringify({
        decision: 'approved',
        approvedItemIds: ['i1', 'i2'],
        rejectedItemIds: [],
        decidedAt: new Date().toISOString(),
        decidedBy: 'test',
      }),
    );

    const result = await approval.collect({
      withinBudget,
      requiresApproval: overflow,
      budgetUsd: 50,
      summary: 'overflow',
    }, { mode: 'file' });

    expect(
      existsSync(join(tmpDir, '.agentforge/cycles', cycleId, 'approval-pending.json')),
    ).toBe(true);
    expect(result.approvedItems).toHaveLength(2);
  });

  it('file mode honors rejection of overflow items', async () => {
    const logger = new CycleLogger(tmpDir, cycleId);
    const approval = new BudgetApproval(tmpDir, cycleId, logger);

    writeFileSync(
      join(tmpDir, '.agentforge/cycles', cycleId, 'approval-decision.json'),
      JSON.stringify({
        decision: 'rejected',
        approvedItemIds: ['i1'],
        rejectedItemIds: ['i2'],
        decidedAt: new Date().toISOString(),
        decidedBy: 'test',
      }),
    );

    const result = await approval.collect({
      withinBudget,
      requiresApproval: overflow,
      budgetUsd: 50,
      summary: 'overflow',
    }, { mode: 'file' });

    expect(result.approvedItems).toHaveLength(1);
    expect(result.approvedItems[0]!.itemId).toBe('i1');
    expect(result.rejectedItems).toHaveLength(1);
    expect(result.rejectedItems[0]!.itemId).toBe('i2');
  });

  it('throws when all items are rejected', async () => {
    const logger = new CycleLogger(tmpDir, cycleId);
    const approval = new BudgetApproval(tmpDir, cycleId, logger);

    writeFileSync(
      join(tmpDir, '.agentforge/cycles', cycleId, 'approval-decision.json'),
      JSON.stringify({
        decision: 'rejected',
        approvedItemIds: [],
        rejectedItemIds: ['i1', 'i2'],
        decidedAt: new Date().toISOString(),
        decidedBy: 'test',
      }),
    );

    const approval2 = new BudgetApproval(tmpDir, cycleId, logger);
    await expect(
      approval2.collect({
        withinBudget: [],
        requiresApproval: overflow,
        budgetUsd: 50,
        summary: '',
      }, { mode: 'file' }),
    ).rejects.toThrow(/no items approved/i);
  });

  it('writes approval-decision.json after collection', async () => {
    const logger = new CycleLogger(tmpDir, cycleId);
    const approval = new BudgetApproval(tmpDir, cycleId, logger);

    writeFileSync(
      join(tmpDir, '.agentforge/cycles', cycleId, 'approval-decision.json'),
      JSON.stringify({
        decision: 'approved',
        approvedItemIds: ['i1', 'i2'],
        rejectedItemIds: [],
        decidedAt: new Date().toISOString(),
        decidedBy: 'test',
      }),
    );

    const approval2 = new BudgetApproval(tmpDir, cycleId, logger);
    await approval2.collect({
      withinBudget,
      requiresApproval: overflow,
      budgetUsd: 50,
      summary: 'overflow',
    }, { mode: 'file' });

    const decisionPath = join(tmpDir, '.agentforge/cycles', cycleId, 'approval-decision.json');
    expect(existsSync(decisionPath)).toBe(true);
  });
});
