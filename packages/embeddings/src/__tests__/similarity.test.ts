import { describe, expect, it } from 'vitest';
import { cosine, topKAsync } from '../similarity.js';

describe('cosine', () => {
  it('returns 0 for zero-norm vectors', () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosine(a, b)).toBe(0);
  });
});

describe('topKAsync', () => {
  it('handles large pools without changing ranking semantics', async () => {
    const query = new Float32Array([1, 0]);
    const pool = Array.from({ length: 10_001 }, (_, i) => ({
      id: `doc-${i}`,
      vec: new Float32Array([i % 2 === 0 ? 1 : 0.8, 0]),
      content: `content-${i}`,
    }));

    const results = await topKAsync(query, pool, 5, 0);
    expect(results).toHaveLength(5);
    expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score);
  });
});
