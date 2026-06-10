// G2 — objective-cycle MCP tools: epic decomposition / epic review /
// spend report readers + the pure af_objective_preview sizing helper.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afEpicDecomposition,
  afEpicReview,
  afObjectivePreview,
  afSpendReport,
} from '../af-objective-cycle.js';

const CYCLE_ID = 'cycle-aaaa1111';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'af-mcp-objective-cycle-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeCycleArtifact(relPath: string[], value: unknown): void {
  const filePath = join(root, '.agentforge', 'cycles', CYCLE_ID, ...relPath);
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// af_epic_decomposition
// ---------------------------------------------------------------------------

describe('afEpicDecomposition', () => {
  it('returns the child DAG summary plus the validation-report budget block', () => {
    writeCycleArtifact(['decomposition.json'], {
      epicId: 'epic-cycleaaa',
      rationale: 'split by subsystem',
      children: [
        {
          id: 'child-1',
          title: 'Server routes',
          description: 'long description omitted from summary',
          files: ['packages/server/src/routes/v5/cycles.ts'],
          capabilityTags: ['fastify'],
          suggestedAssignee: 'fastify-v5-engineer',
          estimatedCostUsd: 12.5,
          estimatedComplexity: 'medium',
          predecessors: [],
          wave: 0,
        },
        {
          id: 'child-2',
          title: 'Dashboard page',
          description: 'long description',
          files: ['packages/dashboard/src/routes/objective/+page.svelte'],
          capabilityTags: ['svelte'],
          suggestedAssignee: 'svelte-cycles-engineer',
          estimatedCostUsd: 8,
          estimatedComplexity: 'low',
          predecessors: ['child-1'],
          wave: 1,
        },
      ],
      validationReport: {
        acyclic: true,
        missingPredecessors: [],
        syntheticFileEdges: [],
        waveCount: 2,
        budget: {
          budgetUsd: 50,
          spendableUsd: 36.67,
          sumUsd: 20.5,
          lowerUsd: 25.67,
          upperUsd: 36.67,
          withinBand: false,
        },
      },
    });

    const result = afEpicDecomposition({ cycleId: CYCLE_ID }, root);
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data['cycleId']).toBe(CYCLE_ID);
    expect(data['epicId']).toBe('epic-cycleaaa');
    expect(data['childCount']).toBe(2);
    expect(data['waveCount']).toBe(2);
    expect(data['totalEstimatedUsd']).toBe(20.5);

    const children = data['children'] as Array<Record<string, unknown>>;
    expect(children).toEqual([
      {
        id: 'child-1',
        title: 'Server routes',
        files: ['packages/server/src/routes/v5/cycles.ts'],
        estimatedCostUsd: 12.5,
        wave: 0,
        predecessors: [],
      },
      {
        id: 'child-2',
        title: 'Dashboard page',
        files: ['packages/dashboard/src/routes/objective/+page.svelte'],
        estimatedCostUsd: 8,
        wave: 1,
        predecessors: ['child-1'],
      },
    ]);

    const budget = data['budget'] as Record<string, unknown>;
    expect(budget['budgetUsd']).toBe(50);
    expect(budget['withinBand']).toBe(false);
  });

  it('returns a null budget block when the objective carried no budgetUsd', () => {
    writeCycleArtifact(['decomposition.json'], {
      epicId: 'epic-cycleaaa',
      children: [
        { id: 'c1', title: 't', files: [], estimatedCostUsd: 1, predecessors: [], wave: 0 },
      ],
      validationReport: { acyclic: true, missingPredecessors: [], syntheticFileEdges: [], waveCount: 1 },
    });

    const result = afEpicDecomposition({ cycleId: CYCLE_ID }, root);
    expect(result.ok).toBe(true);
    expect((result.data as Record<string, unknown>)['budget']).toBeNull();
  });

  it('returns a clean error when decomposition.json is missing', () => {
    const result = afEpicDecomposition({ cycleId: CYCLE_ID }, root);
    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe('ARTIFACT_NOT_FOUND');
    expect(result.error!.message).toBe(`No decomposition.json recorded for cycle ${CYCLE_ID}`);
  });

  it('rejects a traversal cycleId before touching the filesystem', () => {
    const result = afEpicDecomposition({ cycleId: '../../../../etc/passwd' }, root);
    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe('INVALID_CYCLE_ID');
  });

  it('returns a parse error for corrupt JSON', () => {
    const filePath = join(root, '.agentforge', 'cycles', CYCLE_ID, 'decomposition.json');
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, '{not json', 'utf8');

    const result = afEpicDecomposition({ cycleId: CYCLE_ID }, root);
    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe('ARTIFACT_PARSE_FAILED');
  });
});

// ---------------------------------------------------------------------------
// af_epic_review
// ---------------------------------------------------------------------------

describe('afEpicReview', () => {
  it('returns verdict, rationale, faultedItems, triageUsed, and costUsd', () => {
    writeCycleArtifact(['phases', 'epic-review.json'], {
      phase: 'gate',
      mode: 'epic-review',
      cycleId: CYCLE_ID,
      attempt: 1,
      verdict: 'REQUEST_CHANGES',
      rationale: 'child-2 page does not render the verdict card',
      faultedItems: [
        { itemId: 'child-2', reason: 'missing verdict card', files: ['packages/dashboard/src/routes/objective/+page.svelte'] },
      ],
      schemaValidationOk: true,
      triageUsed: false,
      costUsd: 1.25,
      durationMs: 30_000,
      completedAt: '2026-06-09T12:00:00Z',
    });

    const result = afEpicReview({ cycleId: CYCLE_ID }, root);
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data['verdict']).toBe('REQUEST_CHANGES');
    expect(data['rationale']).toContain('verdict card');
    expect(data['faultedItems']).toEqual([
      {
        itemId: 'child-2',
        reason: 'missing verdict card',
        files: ['packages/dashboard/src/routes/objective/+page.svelte'],
      },
    ]);
    expect(data['triageUsed']).toBe(false);
    expect(data['costUsd']).toBe(1.25);
    expect(data['attempt']).toBe(1);
    expect(data['completedAt']).toBe('2026-06-09T12:00:00Z');
  });

  it('returns a clean error when epic-review.json is missing', () => {
    const result = afEpicReview({ cycleId: CYCLE_ID }, root);
    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe('ARTIFACT_NOT_FOUND');
    expect(result.error!.message).toBe(`No epic-review.json recorded for cycle ${CYCLE_ID}`);
  });

  it('rejects a traversal cycleId', () => {
    const result = afEpicReview({ cycleId: '....//....//secrets' }, root);
    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe('INVALID_CYCLE_ID');
  });
});

// ---------------------------------------------------------------------------
// af_spend_report
// ---------------------------------------------------------------------------

describe('afSpendReport', () => {
  it('returns the report plus a compact totals line', () => {
    writeCycleArtifact(['spend-report.json'], {
      schemaVersion: 1,
      cycleId: CYCLE_ID,
      epicId: 'epic-cycleaaa',
      objective: 'objective-mode operator console',
      budgetUsd: 50,
      totalUsd: 12.34,
      executionUsd: 10,
      overheadUsd: 2.34,
      utilization: 0.2468,
      perItem: [
        { itemId: 'child-1', title: 'Server routes', plannedUsd: 12.5, actualUsd: 8, status: 'completed' },
        { itemId: 'child-2', title: 'Dashboard page', plannedUsd: 8, actualUsd: 2, status: 'completed' },
      ],
      generatedAt: '2026-06-09T12:00:00Z',
    });

    const result = afSpendReport({ cycleId: CYCLE_ID }, root);
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data['totals']).toBe(
      'total $12.34 of $50.00 budget (24.7% utilization) — execution $10.00 + overhead $2.34 across 2 item(s)',
    );
    const report = data['report'] as Record<string, unknown>;
    expect(report['cycleId']).toBe(CYCLE_ID);
    expect((report['perItem'] as unknown[]).length).toBe(2);
  });

  it('returns a clean error when spend-report.json is missing', () => {
    const result = afSpendReport({ cycleId: CYCLE_ID }, root);
    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe('ARTIFACT_NOT_FOUND');
    expect(result.error!.message).toBe(`No spend-report.json recorded for cycle ${CYCLE_ID}`);
  });

  it('rejects a traversal cycleId', () => {
    const result = afSpendReport({ cycleId: 'a/../../../b-c-d-e' }, root);
    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe('INVALID_CYCLE_ID');
  });
});

// ---------------------------------------------------------------------------
// af_objective_preview — pure band math, no subprocess
// ---------------------------------------------------------------------------

describe('afObjectivePreview', () => {
  it('computes spendable=(budget−6)/1.2 and the 0.7–1.0× band for $300', () => {
    const result = afObjectivePreview({ objective: 'Build the operator console', budgetUsd: 300 });
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    const budget = data['budget'] as Record<string, number | string>;
    expect(budget['budgetUsd']).toBe(300);
    expect(budget['fixedOverheadUsd']).toBe(6);
    expect(budget['fixupReserveMultiplier']).toBe(1.2);
    expect(budget['spendableUsd']).toBe(245);
    expect(budget['lowerUsd']).toBe(171.5);
    expect(budget['upperUsd']).toBe(245);
    expect(String(budget['bandNote'])).toContain('$171.50–$245.00');
  });

  it('rounds the $50 band to cents', () => {
    const result = afObjectivePreview({ objective: 'A fifty dollar epic', budgetUsd: 50 });
    const budget = (result.data as Record<string, unknown>)['budget'] as Record<string, number>;
    expect(budget['spendableUsd']).toBeCloseTo(36.67, 2);
    expect(budget['lowerUsd']).toBeCloseTo(25.67, 2);
    expect(budget['upperUsd']).toBeCloseTo(36.67, 2);
  });

  it('clamps spendable to zero when the budget does not cover fixed overhead', () => {
    const result = afObjectivePreview({ objective: 'Tiny budget epic', budgetUsd: 5 });
    const budget = (result.data as Record<string, unknown>)['budget'] as Record<string, number>;
    expect(budget['spendableUsd']).toBe(0);
    expect(budget['lowerUsd']).toBe(0);
    expect(budget['upperUsd']).toBe(0);
  });

  it('returns the exact CLI command with the budget flag', () => {
    const result = afObjectivePreview({ objective: 'Build the operator console', budgetUsd: 300 });
    const data = result.data as Record<string, unknown>;
    expect(data['command']).toBe(
      "agentforge cycle preview --objective 'Build the operator console' --budget-usd 300 --json",
    );
    expect(data['argv']).toEqual([
      'agentforge', 'cycle', 'preview',
      '--objective', 'Build the operator console',
      '--budget-usd', '300',
      '--json',
    ]);
  });

  it('omits the budget flag and math when budgetUsd is absent', () => {
    const result = afObjectivePreview({ objective: 'Build the operator console' });
    const data = result.data as Record<string, unknown>;
    expect(data['command']).toBe(
      "agentforge cycle preview --objective 'Build the operator console' --json",
    );
    expect(data['budget']).toBeNull();
  });

  it('shell-quotes objectives containing single quotes', () => {
    const result = afObjectivePreview({ objective: "Ship the operator's console" });
    const data = result.data as Record<string, unknown>;
    expect(data['command']).toBe(
      `agentforge cycle preview --objective 'Ship the operator'\\''s console' --json`,
    );
  });

  it('rejects whitespace-padded objectives that trim below 8 characters', () => {
    const result = afObjectivePreview({ objective: '   hi   ' });
    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe('OBJECTIVE_TOO_SHORT');
  });

  it('never executes anything — the notes say so explicitly', () => {
    const result = afObjectivePreview({ objective: 'Build the operator console' });
    const notes = (result.data as Record<string, unknown>)['notes'] as string[];
    expect(notes.some((n) => n.includes('never executes a cycle'))).toBe(true);
  });
});
