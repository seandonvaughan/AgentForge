import { describe, it, expect } from 'vitest';
import { groupItemsByWave } from '../wave-order.js';

const flat = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('groupItemsByWave', () => {
  it('collapses items with no wave into a single wave (flat / signal-cycle behavior)', () => {
    const groups = groupItemsByWave(flat);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns [] for an empty input', () => {
    expect(groupItemsByWave([])).toEqual([]);
  });

  it('groups by ascending wave, preserving within-wave order', () => {
    const items = [
      { id: 'c2', wave: 1 },
      { id: 'a1', wave: 0 },
      { id: 'c1', wave: 1 },
      { id: 'd', wave: 2 },
      { id: 'a2', wave: 0 },
    ];
    const groups = groupItemsByWave(items);
    expect(groups.map((g) => g.map((i) => i.id))).toEqual([
      ['a1', 'a2'],
      ['c2', 'c1'],
      ['d'],
    ]);
  });

  it('treats a missing wave as wave 0 when other items are layered', () => {
    const items = [{ id: 'x', wave: 1 }, { id: 'y' }];
    const groups = groupItemsByWave(items);
    expect(groups[0]!.map((i) => i.id)).toEqual(['y']); // wave 0 (defaulted)
    expect(groups[1]!.map((i) => i.id)).toEqual(['x']);
  });
});
