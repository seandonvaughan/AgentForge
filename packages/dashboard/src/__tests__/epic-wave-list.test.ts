// @vitest-environment happy-dom
import { render, screen, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';

import EpicWaveList from '../lib/components/cycles/EpicWaveList.svelte';

describe('EpicWaveList', () => {
  it('renders wave groups and per-child fields from an epic decomposition fixture', () => {
    render(EpicWaveList, {
      props: {
        view: {
          children: [
            {
              id: 'child-18',
              title: 'Mount epic tab component',
              declaredFiles: ['packages/dashboard/src/routes/cycles/[id]/+page.svelte'],
              estimatedCostUsd: 2.5,
              status: 'in_progress',
              actualCostUsd: 1.25,
              wave: 1,
            },
            {
              id: 'child-09',
              title: 'Prepare decomposition data',
              declaredFiles: ['packages/dashboard/src/lib/util/objective-mode.ts'],
              estimatedCostUsd: 1,
              status: 'completed',
              costUsd: 0.75,
              wave: 0,
            },
            {
              id: 'child-20',
              title: 'Verify epic fixture',
              files: ['packages/dashboard/src/__tests__/epic-wave-list.test.ts'],
              estimatedCostUsd: 3.25,
              status: 'planned',
              costUsd: 0,
              wave: 1,
            },
          ],
        },
      },
    });

    const waves = screen.getAllByRole('region');
    expect(waves.map((wave) => within(wave).getByRole('heading').textContent)).toEqual(['Wave 1', 'Wave 2']);
    expect(within(waves[0]!).getByText('child-09')).toBeTruthy();
    expect(within(waves[1]!).getByText('child-18')).toBeTruthy();
    expect(within(waves[1]!).getByText('child-20')).toBeTruthy();

    const child18 = screen.getByLabelText('child-18');
    expect(within(child18).getByText('Mount epic tab component')).toBeTruthy();
    expect(within(child18).getByText('packages/dashboard/src/routes/cycles/[id]/+page.svelte')).toBeTruthy();
    expect(within(child18).getByText('in_progress')).toBeTruthy();
    expect(within(child18).getByText('$2.50')).toBeTruthy();
    expect(within(child18).getByText('$1.25')).toBeTruthy();

    const child20 = screen.getByLabelText('child-20');
    expect(within(child20).getByText('packages/dashboard/src/__tests__/epic-wave-list.test.ts')).toBeTruthy();
  });
});
