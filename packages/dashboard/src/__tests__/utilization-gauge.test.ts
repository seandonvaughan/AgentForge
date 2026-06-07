import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';

import UtilizationGauge from '../lib/components/cycles/UtilizationGauge.svelte';

afterEach(() => {
  cleanup();
});

function renderGauge(actualUsd: number, budgetUsd: number) {
  render(UtilizationGauge, {
    props: {
      actualUsd,
      budgetUsd,
    },
  });

  return {
    root: screen.getByTestId('utilization-gauge'),
    fill: screen.getByTestId('utilization-gauge-fill'),
  };
}

describe('UtilizationGauge', () => {
  it('fills and colors the gauge for under-band spend', () => {
    const { root, fill } = renderGauge(40, 100);

    expect(root.dataset['band']).toBe('under');
    expect(root.dataset['fillPct']).toBe('40.0');
    expect(fill.dataset['band']).toBe('under');
    expect(fill.dataset['fillPct']).toBe('40.0');
    expect(fill.getAttribute('style')).toContain('--color-success');
  });

  it('fills and colors the gauge for in-band spend', () => {
    const { root, fill } = renderGauge(90, 100);

    expect(root.dataset['band']).toBe('in');
    expect(root.dataset['fillPct']).toBe('90.0');
    expect(fill.dataset['band']).toBe('in');
    expect(fill.dataset['fillPct']).toBe('90.0');
    expect(fill.getAttribute('style')).toContain('--color-warning');
  });

  it('clamps the fill and colors the gauge for over-band spend', () => {
    const { root, fill } = renderGauge(125, 100);

    expect(root.dataset['band']).toBe('over');
    expect(root.dataset['fillPct']).toBe('100.0');
    expect(root.dataset['utilizationPct']).toBe('125.0');
    expect(fill.dataset['band']).toBe('over');
    expect(fill.dataset['fillPct']).toBe('100.0');
    expect(fill.getAttribute('style')).toContain('--color-danger');
  });
});
