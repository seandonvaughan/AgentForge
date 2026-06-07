import { describe, expect, it } from 'vitest';
import { EpicDecompositionSchema } from '../epic-decomposition.schema.js';

const validDecomposition = {
  epicId: 'epic-abc12345',
  rationale: 'Split the objective into schema and route work.',
  children: [
    {
      id: 'child-1',
      title: 'Add shared schema',
      description: 'Create the shared runtime validator.',
      files: ['packages/shared/src/schemas/epic-decomposition.schema.ts'],
      capabilityTags: ['shared-validation', 'zod-schema'],
      suggestedAssignee: 'shared-utils-engineer',
      estimatedCostUsd: 2.5,
      estimatedComplexity: 'low',
      predecessors: [],
      wave: 0,
    },
    {
      id: 'child-2',
      title: 'Use schema in route',
      description: 'Parse decomposition.json before returning it.',
      files: ['packages/core/src/autonomous/routes/cycles.ts'],
      capabilityTags: ['api', 'validation'],
      suggestedAssignee: 'fastify-v5-engineer',
      estimatedCostUsd: 3,
      estimatedComplexity: 'medium',
      predecessors: ['child-1'],
      wave: 1,
    },
  ],
  validationReport: {
    acyclic: true,
    missingPredecessors: [],
    syntheticFileEdges: [
      {
        from: 'child-1',
        to: 'child-2',
        sharedFiles: ['packages/shared/src/index.ts'],
      },
    ],
    waveCount: 2,
    budget: {
      budgetUsd: 12.5,
      spendableUsd: 5.4167,
      sumUsd: 5.5,
      lowerUsd: 3.7917,
      upperUsd: 5.4167,
      withinBand: false,
    },
  },
};

describe('EpicDecompositionSchema', () => {
  it('validates a well-formed decomposition artifact', () => {
    const parsed = EpicDecompositionSchema.parse(validDecomposition);

    expect(parsed.epicId).toBe('epic-abc12345');
    expect(parsed.children).toHaveLength(2);
    expect(parsed.validationReport.waveCount).toBe(2);
  });

  it('rejects a malformed decomposition artifact', () => {
    const malformed = {
      ...validDecomposition,
      children: [
        {
          ...validDecomposition.children[0],
          estimatedCostUsd: -1,
          estimatedComplexity: 'huge',
          wave: -1,
        },
      ],
      validationReport: {
        ...validDecomposition.validationReport,
        waveCount: 1.5,
      },
    };

    const result = EpicDecompositionSchema.safeParse(malformed);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual(
        expect.arrayContaining([
          'children.0.estimatedCostUsd',
          'children.0.estimatedComplexity',
          'children.0.wave',
          'validationReport.waveCount',
        ]),
      );
    }
  });
});
