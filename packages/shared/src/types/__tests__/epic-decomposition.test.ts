import { describe, expect, it } from 'vitest';

import type { EpicDecomposition } from '../epic-decomposition.js';

describe('EpicDecomposition', () => {
  it('accepts decomposition waves with child file, cost, and status fields', () => {
    const sample: EpicDecomposition = {
      waves: [
        {
          wave: 0,
          children: [
            {
              id: 'child-14',
              title: 'Expose decomposition route',
              files: ['packages/server/src/routes/v5/cycles.ts'],
              estimatedCostUsd: 1.75,
              status: 'planned',
            },
          ],
        },
        {
          wave: 1,
          children: [
            {
              id: 'child-39',
              title: 'Render dashboard epic tab',
              files: ['packages/dashboard/src/lib/EpicTab.svelte'],
              estimatedCostUsd: 2.5,
              status: 'blocked',
            },
          ],
        },
      ],
    };

    expect(sample.waves).toHaveLength(2);
    expect(sample.waves[0]?.children[0]).toEqual({
      id: 'child-14',
      title: 'Expose decomposition route',
      files: ['packages/server/src/routes/v5/cycles.ts'],
      estimatedCostUsd: 1.75,
      status: 'planned',
    });
  });
});
