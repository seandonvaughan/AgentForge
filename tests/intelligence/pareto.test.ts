import { describe, it, expect } from 'vitest';
import { dominates, paretoFront } from '../../packages/core/src/intelligence/pareto.js';

describe('paretoFront', () => {
  it('dominates: strictly better on all axes', () => {
    const a = { cost: 0.1, quality: 0.9, latency: 1000 };
    const b = { cost: 0.5, quality: 0.6, latency: 5000 };
    expect(dominates(a, b)).toBe(true);
    expect(dominates(b, a)).toBe(false);
  });

  it('dominates: equal on one, better on another', () => {
    const a = { cost: 0.1, quality: 0.9, latency: 1000 };
    const b = { cost: 0.1, quality: 0.8, latency: 1000 };
    expect(dominates(a, b)).toBe(true);
  });

  it('dominates: not strictly better → false', () => {
    const a = { cost: 0.1, quality: 0.9, latency: 1000 };
    const b = { cost: 0.1, quality: 0.9, latency: 1000 };
    expect(dominates(a, b)).toBe(false);
  });

  it('paretoFront filters out strictly dominated options', () => {
    const opts = [
      { id: 'haiku', cost: 0.01, quality: 0.5, latency: 500 },
      { id: 'sonnet', cost: 0.05, quality: 0.85, latency: 2000 },
      { id: 'opus', cost: 0.20, quality: 0.9, latency: 5000 },
      { id: 'dominated', cost: 0.20, quality: 0.4, latency: 10000 }, // strictly worse than haiku
    ];
    const front = paretoFront(opts);
    const ids = front.map(o => o.id).sort();
    expect(ids).toEqual(['haiku', 'opus', 'sonnet']);
    expect(ids).not.toContain('dominated');
  });

  it('paretoFront preserves all options when none dominates', () => {
    const opts = [
      { cost: 0.01, quality: 0.5, latency: 500 },
      { cost: 0.05, quality: 0.85, latency: 2000 },
      { cost: 0.20, quality: 0.95, latency: 5000 },
    ];
    expect(paretoFront(opts).length).toBe(3);
  });

  it('paretoFront on empty input', () => {
    expect(paretoFront([])).toEqual([]);
  });

  it('paretoFront stable ordering', () => {
    const opts = [
      { tag: 'a', cost: 0.1, quality: 0.5, latency: 100 },
      { tag: 'b', cost: 0.2, quality: 0.6, latency: 200 },
      { tag: 'c', cost: 0.3, quality: 0.7, latency: 300 },
    ];
    const front = paretoFront(opts);
    expect(front.map(o => o.tag)).toEqual(['a', 'b', 'c']);
  });
});
