import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';

import ObjectivePage, {
  buildBudgetBandPreview,
  BUDGET_PREVIEW_FLOOR_USD,
} from '../routes/objective/+page.svelte';

describe('objective budget-band preview', () => {
  it('computes spendable and the 0.7-1.0 band for sample budgets', () => {
    expect(buildBudgetBandPreview(66)).toMatchObject({
      spendableUsd: 50,
      lowerUsd: 35,
      upperUsd: 50,
      formatted: {
        spendable: '$50.00',
        band: '$35.00-$50.00',
      },
      warning: null,
    });

    expect(buildBudgetBandPreview(30)).toMatchObject({
      spendableUsd: 20,
      lowerUsd: 14,
      upperUsd: 20,
      formatted: {
        spendable: '$20.00',
        band: '$14.00-$20.00',
      },
      warning: null,
    });

    const lowPreview = buildBudgetBandPreview(BUDGET_PREVIEW_FLOOR_USD - 1);
    expect(lowPreview.warning).toContain('$12.00');
    expect(lowPreview.belowFloor).toBe(true);
  });

  it('recomputes the rendered preview as the budget input changes', async () => {
    render(ObjectivePage);

    const budgetInput = screen.getByLabelText('Objective budget in USD');

    await waitFor(() => {
      expect(screen.getByTestId('budget-preview').textContent).toContain('$35.00-$50.00');
    });

    await fireEvent.input(budgetInput, { target: { value: '30' } });
    expect(screen.getByTestId('budget-preview').textContent).toContain('$20.00');
    expect(screen.getByTestId('budget-preview').textContent).toContain('$14.00-$20.00');

    await fireEvent.input(budgetInput, { target: { value: '9' } });
    expect(screen.getByTestId('budget-preview').textContent).toContain('$1.75-$2.50');
    expect(screen.getByTestId('budget-floor-warning').textContent).toContain('$12.00');
  });
});
