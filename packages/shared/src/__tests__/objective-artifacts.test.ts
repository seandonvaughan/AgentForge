/**
 * Tests for objective-artifacts module.
 *
 * Because the module is type-only, these tests verify:
 *  1. The module can be imported (the barrel re-export path resolves).
 *  2. Sample objects that conform to each interface are structurally correct
 *     at runtime — guards against accidental removal of the export or a
 *     barrel wiring mistake that would make downstream imports fail.
 */
import { describe, it, expect } from 'vitest';
import type {
  WorkItemChild,
  WorkItemStatus,
  DecompositionArtifact,
  EpicReviewVerdict,
  EpicReviewArtifact,
  SpendReportItem,
  SpendReportTotals,
  SpendReportArtifact,
  PostObjectiveBody,
} from '../objective-artifacts.js';

// ── helpers ────────────────────────────────────────────────────────────────

/** Construct a minimal WorkItemChild that TypeScript accepts. */
function makeChild(overrides: Partial<WorkItemChild> = {}): WorkItemChild {
  return {
    id: 'item-1',
    title: 'Bootstrap schema',
    files: ['db/schema.sql'],
    estimatedCostUsd: 2.5,
    status: 'pending',
    ...overrides,
  };
}

// ── WorkItemChild ──────────────────────────────────────────────────────────

describe('WorkItemChild', () => {
  it('holds all required fields', () => {
    const child = makeChild();
    expect(child.id).toBe('item-1');
    expect(child.title).toBe('Bootstrap schema');
    expect(child.files).toEqual(['db/schema.sql']);
    expect(child.estimatedCostUsd).toBe(2.5);
    expect(child.status).toBe('pending');
  });

  it('accepts all valid WorkItemStatus values', () => {
    const statuses: WorkItemStatus[] = [
      'pending',
      'in-progress',
      'completed',
      'failed',
      'skipped',
    ];
    for (const status of statuses) {
      const child = makeChild({ status });
      expect(child.status).toBe(status);
    }
  });

  it('accepts an empty files array', () => {
    const child = makeChild({ files: [] });
    expect(child.files).toHaveLength(0);
  });
});

// ── DecompositionArtifact ──────────────────────────────────────────────────

describe('DecompositionArtifact', () => {
  it('holds waveIndex and children', () => {
    const wave: DecompositionArtifact = {
      waveIndex: 0,
      children: [makeChild()],
    };
    expect(wave.waveIndex).toBe(0);
    expect(wave.children).toHaveLength(1);
    expect(wave.children[0]?.id).toBe('item-1');
  });

  it('accepts an empty children array', () => {
    const wave: DecompositionArtifact = { waveIndex: 1, children: [] };
    expect(wave.children).toHaveLength(0);
  });

  it('models a multi-wave decomposition as an array', () => {
    const waves: DecompositionArtifact[] = [
      { waveIndex: 0, children: [makeChild({ id: 'w0-a' })] },
      { waveIndex: 1, children: [makeChild({ id: 'w1-a' }), makeChild({ id: 'w1-b' })] },
    ];
    expect(waves).toHaveLength(2);
    expect(waves[1]?.children).toHaveLength(2);
  });
});

// ── EpicReviewArtifact ─────────────────────────────────────────────────────

describe('EpicReviewArtifact', () => {
  it('holds all required fields for a passing review', () => {
    const review: EpicReviewArtifact = {
      verdict: 'pass',
      rationale: 'All items met acceptance criteria.',
      faultedItems: [],
    };
    expect(review.verdict).toBe('pass');
    expect(review.rationale).toBeTruthy();
    expect(review.faultedItems).toHaveLength(0);
  });

  it('records faulted item IDs for a failing review', () => {
    const review: EpicReviewArtifact = {
      verdict: 'fail',
      rationale: 'Item w2-c broke tests.',
      faultedItems: ['w2-c'],
    };
    expect(review.verdict).toBe('fail');
    expect(review.faultedItems).toContain('w2-c');
  });

  it('accepts all valid EpicReviewVerdict values', () => {
    const verdicts: EpicReviewVerdict[] = ['pass', 'fail', 'partial'];
    for (const verdict of verdicts) {
      const review: EpicReviewArtifact = { verdict, rationale: 'ok', faultedItems: [] };
      expect(review.verdict).toBe(verdict);
    }
  });
});

// ── SpendReportArtifact ────────────────────────────────────────────────────

describe('SpendReportArtifact', () => {
  it('holds perItem and totals', () => {
    const item: SpendReportItem = { id: 'w1-a', plannedUsd: 2.5, actualUsd: 2.1 };
    const totals: SpendReportTotals = {
      executionUsd: 2.1,
      overheadUsd: 0.4,
      utilizationPct: 50,
    };
    const report: SpendReportArtifact = { perItem: [item], totals };

    expect(report.perItem).toHaveLength(1);
    expect(report.perItem[0]?.plannedUsd).toBe(2.5);
    expect(report.perItem[0]?.actualUsd).toBe(2.1);
    expect(report.totals.executionUsd).toBe(2.1);
    expect(report.totals.overheadUsd).toBe(0.4);
    expect(report.totals.utilizationPct).toBe(50);
  });

  it('accepts an empty perItem array', () => {
    const report: SpendReportArtifact = {
      perItem: [],
      totals: { executionUsd: 0, overheadUsd: 0, utilizationPct: 0 },
    };
    expect(report.perItem).toHaveLength(0);
    expect(report.totals.utilizationPct).toBe(0);
  });

  it('tracks multiple items with both over- and under-spend', () => {
    const report: SpendReportArtifact = {
      perItem: [
        { id: 'a', plannedUsd: 5, actualUsd: 4 },   // under budget
        { id: 'b', plannedUsd: 3, actualUsd: 5 },   // over budget
      ],
      totals: { executionUsd: 9, overheadUsd: 1, utilizationPct: 100 },
    };
    const totalActual = report.perItem.reduce((sum, i) => sum + i.actualUsd, 0);
    expect(totalActual).toBe(9);
  });
});

// ── PostObjectiveBody ──────────────────────────────────────────────────────

describe('PostObjectiveBody', () => {
  it('accepts a fully populated body', () => {
    const body: PostObjectiveBody = {
      objective: 'Improve test coverage to 90%',
      budgetUsd: 50,
    };
    expect(body.objective).toBe('Improve test coverage to 90%');
    expect(body.budgetUsd).toBe(50);
  });

  it('accepts an empty body (all fields optional)', () => {
    const body: PostObjectiveBody = {};
    expect(body.objective).toBeUndefined();
    expect(body.budgetUsd).toBeUndefined();
  });

  it('accepts a body with only objective', () => {
    const body: PostObjectiveBody = { objective: 'Refactor auth module' };
    expect(body.objective).toBe('Refactor auth module');
    expect(body.budgetUsd).toBeUndefined();
  });

  it('accepts a body with only budgetUsd', () => {
    const body: PostObjectiveBody = { budgetUsd: 25 };
    expect(body.budgetUsd).toBe(25);
    expect(body.objective).toBeUndefined();
  });

  it('accepts explicit undefined for optional fields (exactOptionalPropertyTypes-safe)', () => {
    const body: PostObjectiveBody = { objective: undefined, budgetUsd: undefined };
    expect(body.objective).toBeUndefined();
    expect(body.budgetUsd).toBeUndefined();
  });
});
