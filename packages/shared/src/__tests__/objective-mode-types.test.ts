import { describe, expect, it } from 'vitest';
import type {
  DecompositionArtifact,
  EpicReviewArtifact,
  SpendReport,
} from '@agentforge/shared';

function parseFixture<T>(fixture: T): T {
  return JSON.parse(JSON.stringify(fixture)) as T;
}

describe('objective-mode artifact types', () => {
  it('parses a representative decomposition.json fixture', () => {
    const fixture = {
      epicId: 'epic-dashboard-api',
      rationale: 'Split the dashboard API objective into shared contracts, server routes, and client wiring.',
      children: [
        {
          id: 'C2',
          title: 'Expose decomposition artifact route',
          description: 'Add a server route that reads decomposition.json and returns the persisted artifact.',
          files: ['packages/server/src/routes/v5/cycles.ts'],
          capabilityTags: ['server', 'objective-mode'],
          suggestedAssignee: 'server-engineer',
          estimatedCostUsd: 4.5,
          estimatedComplexity: 'medium',
          predecessors: ['C1'],
          wave: 1,
        },
      ],
      validationReport: {
        acyclic: true,
        missingPredecessors: [],
        syntheticFileEdges: [
          {
            from: 'C2',
            to: 'C4',
            sharedFiles: ['packages/server/src/routes/v5/cycles.ts'],
          },
        ],
        waveCount: 2,
        budget: {
          budgetUsd: 50,
          spendableUsd: 36.6666666667,
          sumUsd: 31,
          lowerUsd: 25.6666666667,
          upperUsd: 36.6666666667,
          withinBand: true,
        },
      },
    } satisfies DecompositionArtifact;

    const parsed = parseFixture<DecompositionArtifact>(fixture);

    expect(parsed.epicId).toBe('epic-dashboard-api');
    expect(parsed.children[0]?.estimatedComplexity).toBe('medium');
    expect(parsed.children[0]?.wave).toBe(1);
    expect(parsed.validationReport.syntheticFileEdges[0]?.sharedFiles).toEqual([
      'packages/server/src/routes/v5/cycles.ts',
    ]);
    expect(parsed.validationReport.budget?.withinBand).toBe(true);
  });

  it('parses a representative phases/epic-review.json fixture', () => {
    const fixture = {
      phase: 'gate',
      mode: 'epic-review',
      cycleId: 'cycle-123',
      attempt: 1,
      verdict: 'REQUEST_CHANGES',
      rationale: 'The dashboard client route still reads the legacy artifact shape.',
      faultedItems: [
        {
          itemId: 'C9',
          reason: 'Client does not surface faultedItems from the review artifact.',
          files: ['packages/dashboard/src/lib/api/objectives.ts'],
        },
      ],
      schemaValidationOk: true,
      triageUsed: false,
      costUsd: 0.42,
      durationMs: 1234,
      completedAt: '2026-06-01T12:00:00.000Z',
    } satisfies EpicReviewArtifact;

    const parsed = parseFixture<EpicReviewArtifact>(fixture);

    expect(parsed.phase).toBe('gate');
    expect(parsed.mode).toBe('epic-review');
    expect(parsed.verdict).toBe('REQUEST_CHANGES');
    expect(parsed.faultedItems[0]?.itemId).toBe('C9');
    expect(parsed.schemaValidationOk).toBe(true);
  });

  it('parses a representative spend-report.json fixture', () => {
    const fixture = {
      schemaVersion: 1,
      cycleId: 'cycle-123',
      epicId: 'epic-dashboard-api',
      objective: 'Expose objective-mode artifacts to the dashboard',
      budgetUsd: 20,
      totalUsd: 8,
      executionUsd: 6,
      overheadUsd: 2,
      utilization: 0.4,
      perItem: [
        {
          itemId: 'C2',
          title: 'Expose decomposition artifact route',
          plannedUsd: 4.5,
          actualUsd: 3.75,
          status: 'completed',
        },
        {
          itemId: 'C9',
          title: 'Wire dashboard objective API client',
          plannedUsd: null,
          actualUsd: 2.25,
          status: 'failed',
        },
      ],
      generatedAt: '2026-06-01T12:30:00.000Z',
    } satisfies SpendReport;

    const parsed = parseFixture<SpendReport>(fixture);

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.perItem.map((item) => item.itemId)).toEqual(['C2', 'C9']);
    expect(parsed.perItem[1]?.plannedUsd).toBeNull();
    expect(parsed.executionUsd + parsed.overheadUsd).toBe(parsed.totalUsd);
    expect(parsed.utilization).toBe(0.4);
  });
});
