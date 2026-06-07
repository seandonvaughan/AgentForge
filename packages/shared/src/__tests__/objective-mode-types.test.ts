import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  EpicDecompositionChildView,
  EpicDecompositionView,
  EpicReviewFaultedItemView,
  EpicReviewVerdict,
  EpicReviewView,
  ObjectiveModeItemStatus,
  SpendReportItemView,
  SpendReportTotalsView,
  SpendReportView,
} from '../index.js';

describe('objective-mode shared view types', () => {
  it('exports the epic decomposition view shape from the shared barrel', () => {
    const view = {
      epicId: 'epic-cycle1',
      waves: [
        {
          wave: 0,
          children: [
            {
              id: 'child-5',
              title: 'Add observability endpoint',
              files: ['packages/server/src/routes/v5/cycles.ts'],
              estimatedCostUsd: 2,
              status: 'completed',
              actualCostUsd: 1.75,
            },
          ],
        },
      ],
    } satisfies EpicDecompositionView;

    expect(view.waves[0]?.children[0]).toMatchObject({
      id: 'child-5',
      status: 'completed',
      actualCostUsd: 1.75,
    });
    expectTypeOf<EpicDecompositionView['waves'][number]['children'][number]>()
      .toEqualTypeOf<EpicDecompositionChildView>();
    expectTypeOf<EpicDecompositionChildView['estimatedCostUsd']>()
      .toEqualTypeOf<number | null>();
    expectTypeOf<EpicDecompositionChildView['status']>()
      .toEqualTypeOf<ObjectiveModeItemStatus>();
  });

  it('exports the spend report planned-vs-actual shape from the shared barrel', () => {
    const view = {
      cycleId: 'cycle-123',
      epicId: 'epic-cycle1',
      objective: 'Ship objective-mode views',
      perItem: [
        {
          itemId: 'child-6',
          title: 'Build spend report endpoint',
          plannedUsd: null,
          actualUsd: 3.25,
          status: 'completed',
        },
      ],
      totals: {
        budgetUsd: 10,
        totalUsd: 4.5,
        executionUsd: 3.25,
        overheadUsd: 1.25,
        utilization: 0.45,
      },
      generatedAt: '2026-06-06T12:00:00.000Z',
    } satisfies SpendReportView;

    expect(view.totals).toMatchObject({
      executionUsd: 3.25,
      overheadUsd: 1.25,
      utilization: 0.45,
    });
    expectTypeOf<SpendReportView['perItem'][number]>().toEqualTypeOf<SpendReportItemView>();
    expectTypeOf<SpendReportView['totals']>().toEqualTypeOf<SpendReportTotalsView>();
  });

  it('exports the epic review verdict shape from the shared barrel', () => {
    const verdict: EpicReviewVerdict = 'REQUEST_CHANGES';
    const view = {
      verdict,
      rationale: 'One child missed the required API field.',
      faultedItems: [
        {
          itemId: 'child-7',
          reason: 'actualCostUsd was not surfaced',
          files: ['packages/server/src/routes/v5/cycles.ts'],
        },
      ],
    } satisfies EpicReviewView;

    expect(view.faultedItems[0]?.itemId).toBe('child-7');
    expectTypeOf<EpicReviewView['faultedItems'][number]>()
      .toEqualTypeOf<EpicReviewFaultedItemView>();
  });
});
