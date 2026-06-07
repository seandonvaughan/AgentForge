// @vitest-environment happy-dom
import { render, screen, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';

import SpendReportTable, {
  type SpendReportView,
} from '../lib/components/cycles/SpendReportTable.svelte';

const reportFixture: SpendReportView = {
  schemaVersion: 1,
  cycleId: 'cycle-spend-1',
  epicId: 'epic-1',
  budgetUsd: 50,
  totalUsd: 13,
  executionUsd: 10.5,
  overheadUsd: 2.5,
  utilization: 0.26,
  perItem: [
    {
      itemId: 'child-1',
      title: 'Build the summary panel',
      plannedUsd: 4,
      actualUsd: 4.75,
      status: 'completed',
    },
    {
      itemId: 'child-zero',
      title: 'Wire the spend tab',
      plannedUsd: 6,
      actualUsd: 0,
      status: 'running',
    },
    {
      itemId: 'child-3',
      title: 'Add route integration tests',
      plannedUsd: null,
      actualUsd: 5.75,
      status: 'completed',
    },
  ],
  generatedAt: '2026-06-06T12:00:00.000Z',
};

describe('SpendReportTable', () => {
  it('renders planned-vs-actual item rows and spend totals from a report', async () => {
    render(SpendReportTable, {
      props: {
        report: reportFixture,
        class: 'external-class',
      },
    });

    const table = await screen.findByRole('table', { name: 'Spend report items' });
    expect(table).toBeTruthy();
    expect(screen.getByText('cycle-spend-1')).toBeTruthy();

    const firstRow = screen.getByTestId('spend-report-row-child-1');
    expect(within(firstRow).getByText('child-1')).toBeTruthy();
    expect(within(firstRow).getByText('Build the summary panel')).toBeTruthy();
    expect(within(firstRow).getByText('$4.00')).toBeTruthy();
    expect(within(firstRow).getByText('$4.75')).toBeTruthy();
    expect(within(firstRow).getByText('+$0.75')).toBeTruthy();

    const zeroActualRow = screen.getByTestId('spend-report-row-child-zero');
    expect(within(zeroActualRow).getByText('Wire the spend tab')).toBeTruthy();
    expect(within(zeroActualRow).getByText('$6.00')).toBeTruthy();
    expect(within(zeroActualRow).getByText('$0.00')).toBeTruthy();
    expect(within(zeroActualRow).getByText('-$6.00')).toBeTruthy();
    expect(within(zeroActualRow).getByText('running')).toBeTruthy();

    const totals = screen.getByLabelText('Spend totals');
    expect(within(totals).getByText('Planned')).toBeTruthy();
    expect(within(totals).getByText('$10.00')).toBeTruthy();
    expect(within(totals).getByText('Total')).toBeTruthy();
    expect(within(totals).getByText('$13.00')).toBeTruthy();
    expect(within(totals).getByText('Execution')).toBeTruthy();
    expect(within(totals).getByText('$10.50')).toBeTruthy();
    expect(within(totals).getByText('Overhead')).toBeTruthy();
    expect(within(totals).getByText('$2.50')).toBeTruthy();
    expect(within(totals).getByText('Utilization')).toBeTruthy();
    expect(within(totals).getByText('26%')).toBeTruthy();
  });
});
