// packages/core/src/autonomous/budget-approval.ts
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { RankedItem } from './types.js';
import type { CycleLogger } from './cycle-logger.js';

export interface ApprovalRequest {
  withinBudget: RankedItem[];
  requiresApproval: RankedItem[];
  budgetUsd: number;
  summary: string;
}

export interface ApprovalResult {
  approvedItems: RankedItem[];
  rejectedItems: RankedItem[];
  finalBudgetUsd: number;
  decision: 'auto-approved' | 'approved' | 'partial' | 'rejected';
  decidedAt: string;
  decidedBy: string;
}

export interface ApprovalOptions {
  mode?: 'tty' | 'file' | 'auto';
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export class BudgetApprovalError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'BudgetApprovalError';
  }
}

export class BudgetApproval {
  constructor(
    private readonly cwd: string,
    private readonly cycleId: string,
    private readonly logger: CycleLogger,
  ) {}

  async collect(req: ApprovalRequest, options: ApprovalOptions = {}): Promise<ApprovalResult> {
    if (req.requiresApproval.length === 0) {
      return {
        approvedItems: req.withinBudget,
        rejectedItems: [],
        finalBudgetUsd: this.sumCosts(req.withinBudget),
        decision: 'auto-approved',
        decidedAt: new Date().toISOString(),
        decidedBy: 'system',
      };
    }

    // Write pending
    const overflowCost = this.sumCosts(req.requiresApproval);
    const newTotal = this.sumCosts(req.withinBudget) + overflowCost;

    this.logger.logApprovalPending({
      cycleId: this.cycleId,
      requestedAt: new Date().toISOString(),
      withinBudget: { items: req.withinBudget, totalCostUsd: this.sumCosts(req.withinBudget) },
      overflow: { items: req.requiresApproval, additionalCostUsd: overflowCost },
      newTotalUsd: newTotal,
      budgetUsd: req.budgetUsd,
      agentSummary: req.summary,
    });

    const mode = options.mode ?? (process.stdin.isTTY ? 'tty' : 'file');

    let decision: {
      decision: 'approved' | 'rejected';
      approvedItemIds: string[];
      rejectedItemIds: string[];
      decidedBy: string;
    };

    if (mode === 'tty') {
      decision = await this.promptTty(req, newTotal);
    } else {
      decision = await this.pollDecisionFile(
        options.pollTimeoutMs ?? 30 * 60 * 1000,
        options.pollIntervalMs ?? 2000,
      );
    }

    const decidedAt = new Date().toISOString();
    this.logger.logApprovalDecision({
      ...decision,
      decidedAt,
      cycleId: this.cycleId,
    });

    const approvedIds = new Set(decision.approvedItemIds);
    const allItems = [...req.withinBudget, ...req.requiresApproval];
    const approvedItems = allItems.filter(i => approvedIds.has(i.itemId));
    const rejectedItems = allItems.filter(i => !approvedIds.has(i.itemId));

    if (approvedItems.length === 0) {
      throw new BudgetApprovalError('No items approved — cycle cannot proceed');
    }

    return {
      approvedItems,
      rejectedItems,
      finalBudgetUsd: this.sumCosts(approvedItems),
      decision: rejectedItems.length === 0 ? 'approved' : 'partial',
      decidedAt,
      decidedBy: decision.decidedBy,
    };
  }

  private async promptTty(req: ApprovalRequest, newTotal: number): Promise<{
    decision: 'approved' | 'rejected';
    approvedItemIds: string[];
    rejectedItemIds: string[];
    decidedBy: string;
  }> {
    const overflowCost = this.sumCosts(req.requiresApproval);
    const overflowList = req.requiresApproval
      .map(i => `  - ${i.title} ($${i.estimatedCostUsd.toFixed(2)})`)
      .join('\n');

    const message = `
Budget overrun requested:
  Within budget: $${this.sumCosts(req.withinBudget).toFixed(2)} for ${req.withinBudget.length} items
  Overflow:      $${overflowCost.toFixed(2)} for ${req.requiresApproval.length} item(s)
${overflowList}
  New total:     $${newTotal.toFixed(2)} / $${req.budgetUsd.toFixed(2)} budget

Summary: ${req.summary}

Approve overage? [y/N]: `;

    const answer = await this.readLine(message);
    const approved = answer.trim().toLowerCase() === 'y';

    return {
      decision: approved ? 'approved' : 'rejected',
      approvedItemIds: approved
        ? [...req.withinBudget, ...req.requiresApproval].map(i => i.itemId)
        : req.withinBudget.map(i => i.itemId),
      rejectedItemIds: approved
        ? []
        : req.requiresApproval.map(i => i.itemId),
      decidedBy: process.env.USER ?? 'unknown',
    };
  }

  private async pollDecisionFile(timeoutMs: number, intervalMs: number): Promise<{
    decision: 'approved' | 'rejected';
    approvedItemIds: string[];
    rejectedItemIds: string[];
    decidedBy: string;
  }> {
    const decisionPath = join(this.cwd, '.agentforge/cycles', this.cycleId, 'approval-decision.json');
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (existsSync(decisionPath)) {
        const data = JSON.parse(readFileSync(decisionPath, 'utf8'));
        return data;
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }

    throw new BudgetApprovalError(`Approval timeout after ${timeoutMs}ms`);
  }

  private readLine(prompt: string): Promise<string> {
    return new Promise(resolve => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(prompt, answer => {
        rl.close();
        resolve(answer);
      });
    });
  }

  private sumCosts(items: RankedItem[]): number {
    return items.reduce((sum, i) => sum + i.estimatedCostUsd, 0);
  }
}
