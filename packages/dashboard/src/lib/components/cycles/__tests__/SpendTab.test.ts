import { render, screen, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';

import SpendTab from '../SpendTab.svelte';
import type { SpendReport } from '../SpendTab.svelte';

const report: SpendReport = {
  schemaVersion: 1,
  cycleId: 'cycle-123',
  epicId: 'EPIC-9',
  budgetUsd: 100,
  totalUsd: 25,
  executionUsd: 20,
  overheadUsd: 5,
  utilization: 0.25,
  generatedAt: '2026-06-06T12:00:00.000Z',
  perItem: [
    {
      itemId: 'C9',
      title: 'Build getSpendReport',
      plannedUsd: 10,
      actualUsd: 12,
      status: 'completed',
    },
    {
      itemId: 'C20',
      title: 'Formatting helpers',
      plannedUsd: null,
      actualUsd: 8,
      status: 'failed',
    },
  ],
};

describe('SpendTab', () => {
  it('renders planned vs actual rows for each spend-report item', () => {
    render(SpendTab, { props: { report } });

    const c9 = screen.getByText('C9').closest('tr');
    expect(c9).not.toBeNull();
    expect(within(c9!).getByText('Build getSpendReport')).toBeTruthy();
    expect(within(c9!).getByText('$10.00')).toBeTruthy();
    expect(within(c9!).getByText('$12.00')).toBeTruthy();
    expect(within(c9!).getByText('+$2.00')).toBeTruthy();
    expect(within(c9!).getByText('completed')).toBeTruthy();

    const c20 = screen.getByText('C20').closest('tr');
    expect(c20).not.toBeNull();
    expect(within(c20!).getByText('Formatting helpers')).toBeTruthy();
    expect(within(c20!).getAllByText('-')).toHaveLength(2);
    expect(within(c20!).getByText('$8.00')).toBeTruthy();
    expect(within(c20!).getByText('failed')).toBeTruthy();
  });

  it('renders execution, overhead, and utilization totals', () => {
    render(SpendTab, { props: { report } });

    const totals = screen.getByLabelText('Spend totals');
    expect(within(totals).getByText('Total')).toBeTruthy();
    expect(within(totals).getByText('$25.00')).toBeTruthy();
    expect(within(totals).getByText('of $100.00 budget')).toBeTruthy();
    expect(within(totals).getByText('Execution')).toBeTruthy();
    expect(within(totals).getByText('$20.00')).toBeTruthy();
    expect(within(totals).getByText('Overhead')).toBeTruthy();
    expect(within(totals).getByText('$5.00')).toBeTruthy();
    expect(within(totals).getByText('Utilization')).toBeTruthy();
    expect(within(totals).getByText('25%')).toBeTruthy();
  });

  it('handles an absent report gracefully', () => {
    render(SpendTab, { props: { report: null } });

    expect(screen.getByTestId('spend-empty')).toBeTruthy();
    expect(screen.getByText('No spend report')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
