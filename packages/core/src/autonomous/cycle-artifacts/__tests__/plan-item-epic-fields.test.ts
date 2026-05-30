import { describe, it, expect } from 'vitest';
import { PlanJsonSchema } from '../schemas.js';
import type { SprintPlanItem } from '../../sprint-generator.js';

describe('PlanItemSchema epic fields', () => {
  it('parses and preserves parentEpicId, wave, and predecessors as typed fields', () => {
    const plan = {
      items: [
        {
          id: 'child-1',
          title: 'Add shared RBAC type',
          parentEpicId: 'epic-abc12345',
          wave: 0,
          predecessors: [],
        },
        {
          id: 'child-2',
          title: 'Consume RBAC type in API',
          parentEpicId: 'epic-abc12345',
          wave: 1,
          predecessors: ['child-1'],
        },
      ],
    };

    const parsed = PlanJsonSchema.parse(plan);

    expect(parsed.items[0]!.wave).toBe(0);
    expect(parsed.items[0]!.parentEpicId).toBe('epic-abc12345');
    expect(parsed.items[0]!.predecessors).toEqual([]);
    expect(parsed.items[1]!.wave).toBe(1);
    expect(parsed.items[1]!.predecessors).toEqual(['child-1']);
  });

  it('accepts plan items with no epic fields (signal-cycle back-compat)', () => {
    const parsed = PlanJsonSchema.parse({ items: [{ id: 'i1', title: 'fix bug' }] });
    expect(parsed.items[0]!.wave).toBeUndefined();
    expect(parsed.items[0]!.parentEpicId).toBeUndefined();
  });
});

describe('SprintPlanItem epic fields', () => {
  it('allows constructing an item with epic fields (compile + runtime)', () => {
    const item: SprintPlanItem = {
      id: 'child-1',
      title: 'Add shared type',
      description: 'd',
      priority: 'P1',
      assignee: 'coder',
      status: 'planned',
      estimatedCostUsd: 5,
      tags: ['feature'],
      parentEpicId: 'epic-abc12345',
      wave: 0,
      predecessors: [],
    };
    expect(item.wave).toBe(0);
    expect(item.predecessors).toEqual([]);
  });
});
