import { describe, it, expect } from 'vitest';
import { EpicObjectiveSchema, type EpicObjective, type EpicPlan } from '../types.js';
import { buildEpicPlannerPrompt, computeSpendableUsd } from '../decompose-objective.js';
import { validateAndLayerEpicPlan } from '../validate-and-layer.js';

const baseObjective: EpicObjective = {
  id: 'epic-abc12345',
  title: 'RBAC',
  description: 'Add multi-tenant RBAC',
  createdAt: '2026-05-30T00:00:00.000Z',
};

// ---- EpicObjectiveSchema.budgetUsd ----------------------------------------

describe('EpicObjectiveSchema budgetUsd', () => {
  it('accepts a positive budgetUsd', () => {
    const o = EpicObjectiveSchema.parse({ ...baseObjective, budgetUsd: 150 });
    expect(o.budgetUsd).toBe(150);
  });

  it('leaves budgetUsd undefined when absent (back-compat)', () => {
    const o = EpicObjectiveSchema.parse(baseObjective);
    expect(o.budgetUsd).toBeUndefined();
  });

  it('rejects a zero budgetUsd', () => {
    expect(() => EpicObjectiveSchema.parse({ ...baseObjective, budgetUsd: 0 })).toThrow();
  });

  it('rejects a negative budgetUsd', () => {
    expect(() => EpicObjectiveSchema.parse({ ...baseObjective, budgetUsd: -10 })).toThrow();
  });
});

// ---- computeSpendableUsd ---------------------------------------------------

describe('computeSpendableUsd', () => {
  it('computes (budget - 6) / 1.2', () => {
    // (150 - 6) / 1.2 = 144 / 1.2 = 120
    expect(computeSpendableUsd(150)).toBe(120);
  });

  it('computes spendable for a $30 cycle budget', () => {
    // (30 - 6) / 1.2 = 24 / 1.2 = 20
    expect(computeSpendableUsd(30)).toBe(20);
  });

  it('never returns a negative spendable when budget is below overhead', () => {
    expect(computeSpendableUsd(6)).toBe(0);
    expect(computeSpendableUsd(1)).toBe(0);
  });
});

// ---- buildEpicPlannerPrompt: budget block ---------------------------------

describe('buildEpicPlannerPrompt with budgetUsd', () => {
  const prompt = buildEpicPlannerPrompt({ ...baseObjective, budgetUsd: 150 });

  it('shows the cycle budget and the computed spendable number', () => {
    expect(prompt).toContain('$150.00');
    expect(prompt).toContain('$120.00'); // spendable
  });

  it('shows the spendable math', () => {
    expect(prompt).toContain('(budget − 6 judgment overhead) / 1.2');
  });

  it('shows the calibrated child cost table', () => {
    expect(prompt).toContain('$1.65');
    expect(prompt).toContain('$7.30');
    expect(prompt).toContain('$15–30');
  });

  it('instructs the sum to land in the [0.7, 1.0] x spendable band', () => {
    expect(prompt).toContain('$84.00'); // 0.7 * 120
    expect(prompt).toContain('$120.00'); // 1.0 * 120
    expect(prompt).toMatch(/0\.7 × spendable/);
    expect(prompt).toMatch(/1\.0 × spendable/);
  });

  it('requires every child description to name a concrete consumer', () => {
    expect(prompt).toContain('concrete CONSUMER');
    expect(prompt).toContain('No API nothing calls, no class nothing instantiates.');
  });
});

// ---- buildEpicPlannerPrompt: byte-identical without budget ----------------

describe('buildEpicPlannerPrompt without budgetUsd', () => {
  it('the budget block is the ONLY difference vs the budgeted prompt (regression guard)', () => {
    // The original guard pinned the full pre-budget prompt text; the prompt now
    // inlines the JSON contract (acceptance-run fix, cycle 441c037f), so the
    // invariant is asserted directly instead: a budgeted prompt must be the
    // no-budget prompt with ONLY the budget block appended.
    const noBudget = buildEpicPlannerPrompt(baseObjective);
    const budgeted = buildEpicPlannerPrompt({ ...baseObjective, budgetUsd: 150 });
    expect(budgeted.startsWith(noBudget)).toBe(true);
    const appended = budgeted.slice(noBudget.length);
    expect(appended).toContain('BUDGET — size this plan to fill the money it is given.');
    expect(noBudget).not.toContain('BUDGET');
  });

  it('does not mention budget, spendable, or the cost table', () => {
    const prompt = buildEpicPlannerPrompt(baseObjective);
    expect(prompt).not.toContain('BUDGET');
    expect(prompt).not.toContain('spendable');
    expect(prompt).not.toContain('$1.65');
  });
});

// ---- validateAndLayerEpicPlan: budget band --------------------------------

function plan(children: EpicPlan['children']): EpicPlan {
  return { epicId: 'epic-abc12345', rationale: 'r', children };
}
function child(id: string, costUsd: number, predecessors: string[] = []) {
  return {
    id,
    title: id,
    description: '',
    files: [`${id}.ts`],
    capabilityTags: [],
    suggestedAssignee: 'eng',
    estimatedCostUsd: costUsd,
    estimatedComplexity: 'low' as const,
    predecessors,
  };
}

describe('validateAndLayerEpicPlan budget band', () => {
  // budget 150 -> spendable 120, band [84, 120].
  const budgetUsd = 150;

  it('rejects an UNDERSIZED plan (~0.5 x spendable) naming the sum and band', () => {
    // 0.5 * 120 = 60, split across two children to keep them in separate files.
    const r = validateAndLayerEpicPlan(plan([child('a', 30), child('b', 30, ['a'])]), budgetUsd);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('budget');
    expect(r.message).toContain('$60.00'); // the sum
    expect(r.message).toContain('$84.00'); // lower band
    expect(r.message).toContain('$120.00'); // upper band
    expect(r.message).toContain('$150.00'); // budget
    expect(r.message).toMatch(/UNDERSIZED/);
    expect(r.report.budget?.withinBand).toBe(false);
    expect(r.report.budget?.sumUsd).toBe(60);
  });

  it('passes a plan at ~0.85 x spendable', () => {
    // 0.85 * 120 = 102, split as 60 + 42.
    const r = validateAndLayerEpicPlan(plan([child('a', 60), child('b', 42, ['a'])]), budgetUsd);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.budget?.withinBand).toBe(true);
    expect(r.report.budget?.sumUsd).toBe(102);
    expect(r.report.budget?.spendableUsd).toBe(120);
    expect(r.report.budget?.lowerUsd).toBe(84);
    expect(r.report.budget?.upperUsd).toBe(120);
  });

  it('rejects an OVERSIZED plan (~1.2 x spendable) naming the sum and band', () => {
    // 1.2 * 120 = 144, split as 72 + 72.
    const r = validateAndLayerEpicPlan(plan([child('a', 72), child('b', 72, ['a'])]), budgetUsd);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('budget');
    expect(r.message).toContain('$144.00'); // the sum
    expect(r.message).toContain('$84.00'); // lower band
    expect(r.message).toContain('$120.00'); // upper band
    expect(r.message).toMatch(/OVERSIZED/);
    expect(r.report.budget?.withinBand).toBe(false);
  });

  it('applies NO cost validation when budgetUsd is absent', () => {
    // Same undersized children, but with no budget — must pass and carry no budget report.
    const r = validateAndLayerEpicPlan(plan([child('a', 30), child('b', 30, ['a'])]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.budget).toBeUndefined();
  });
});
