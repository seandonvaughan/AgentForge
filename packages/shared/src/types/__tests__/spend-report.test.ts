import { describe, expect, it } from 'vitest';
import type { SpendReport, SpendReportPerItem } from '../spend-report.js';

describe('SpendReport', () => {
  it('captures per-item planned vs actual spend and cycle totals', () => {
    const completedItem = {
      itemId: 'child-40',
      title: 'Dashboard SpendTab',
      plannedUsd: 5,
      actualUsd: 6,
      status: 'completed',
    } satisfies SpendReportPerItem;

    const report = {
      schemaVersion: 1,
      cycleId: 'cycle-123',
      epicId: 'epic-456',
      objective: 'Ship the dashboard spend tab',
      budgetUsd: 20,
      totalUsd: 8,
      executionUsd: 6,
      overheadUsd: 2,
      utilization: 0.4,
      perItem: [
        completedItem,
        {
          itemId: 'child-16',
          title: 'Server spend-report route',
          plannedUsd: null,
          actualUsd: 0,
          status: 'pending',
        },
      ],
      generatedAt: '2026-06-06T00:00:00.000Z',
    } satisfies SpendReport;

    expect(report).toEqual({
      schemaVersion: 1,
      cycleId: 'cycle-123',
      epicId: 'epic-456',
      objective: 'Ship the dashboard spend tab',
      budgetUsd: 20,
      totalUsd: 8,
      executionUsd: 6,
      overheadUsd: 2,
      utilization: 0.4,
      perItem: [
        {
          itemId: 'child-40',
          title: 'Dashboard SpendTab',
          plannedUsd: 5,
          actualUsd: 6,
          status: 'completed',
        },
        {
          itemId: 'child-16',
          title: 'Server spend-report route',
          plannedUsd: null,
          actualUsd: 0,
          status: 'pending',
        },
      ],
      generatedAt: '2026-06-06T00:00:00.000Z',
    });
  });
});
