import { render, screen, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';

import EpicTab, {
  buildEpicWaveGroups,
  groupEpicChildrenByWave,
  type EpicChild,
} from '../EpicTab.svelte';

describe('EpicTab wave grouping', () => {
  it('collapses flat children into a single wave', () => {
    const children: EpicChild[] = [
      { id: 'c1', title: 'First child' },
      { id: 'c2', title: 'Second child' },
    ];

    expect(groupEpicChildrenByWave(children)).toEqual([{ wave: 0, children }]);
  });

  it('orders declared waves ascending and defaults missing waves to zero', () => {
    const children: EpicChild[] = [
      { id: 'c2', title: 'Second wave', wave: 1 },
      { id: 'c0', title: 'Implicit first wave' },
      { id: 'c1', title: 'First wave', wave: 0 },
      { id: 'c3', title: 'Third wave', wave: 2 },
    ];

    const groups = groupEpicChildrenByWave(children);

    expect(groups.map((group) => group.wave)).toEqual([0, 1, 2]);
    expect(groups.map((group) => group.children.map((child) => child.id))).toEqual([
      ['c0', 'c1'],
      ['c2'],
      ['c3'],
    ]);
  });

  it('projects live status and cost by child id', () => {
    const groups = buildEpicWaveGroups(
      {
        children: [
          { id: 'c1', title: 'Build parser', wave: 0, estimatedCostUsd: 2.5 },
          { id: 'c2', title: 'Wire UI', wave: 1, estimatedCostUsd: 1.75 },
        ],
      },
      [
        { itemId: 'c1', status: 'completed', costUsd: 1.25 },
        { childId: 'c2', status: 'running', totalCostUsd: 0.75 },
      ],
    );

    expect(groups[0]?.children[0]).toMatchObject({ status: 'completed', liveCostUsd: 1.25 });
    expect(groups[1]?.children[0]).toMatchObject({ status: 'in_progress', liveCostUsd: 0.75 });
  });
});

describe('EpicTab rendering', () => {
  it('renders each child with id, title, declared files, estimated cost, live status, and live cost', () => {
    render(EpicTab, {
      props: {
        decomposition: {
          children: [
            {
              id: 'c1',
              title: 'Build parser',
              files: ['src/parser.ts', 'src/parser.test.ts'],
              estimatedCostUsd: 2.5,
              wave: 0,
            },
            {
              id: 'c2',
              title: 'Wire UI',
              files: ['src/ui.ts'],
              estimatedCostUsd: 1.75,
              wave: 1,
            },
          ],
        },
        executeResults: [
          { itemId: 'c1', status: 'completed', costUsd: 1.25 },
          { childId: 'c2', status: 'running', totalCostUsd: 0.75 },
        ],
      },
    });

    expect(screen.getByTestId('wave-0').textContent).toContain('Wave 1');
    expect(screen.getByTestId('wave-1').textContent).toContain('Wave 2');

    const c1 = within(screen.getByTestId('epic-child-c1'));
    expect(c1.getByText('c1')).toBeTruthy();
    expect(c1.getByText('Build parser')).toBeTruthy();
    expect(c1.getByText('src/parser.ts')).toBeTruthy();
    expect(c1.getByText('src/parser.test.ts')).toBeTruthy();
    expect(c1.getByText('Declared $2.50')).toBeTruthy();
    expect(c1.getByText('Live $1.25')).toBeTruthy();
    expect(c1.getByText('completed')).toBeTruthy();

    const c2 = within(screen.getByTestId('epic-child-c2'));
    expect(c2.getByText('c2')).toBeTruthy();
    expect(c2.getByText('Wire UI')).toBeTruthy();
    expect(c2.getByText('src/ui.ts')).toBeTruthy();
    expect(c2.getByText('Declared $1.75')).toBeTruthy();
    expect(c2.getByText('Live $0.75')).toBeTruthy();
    expect(c2.getByText('in progress')).toBeTruthy();
  });
});
