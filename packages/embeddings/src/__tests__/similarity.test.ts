import { describe, expect, it } from 'vitest';
import { cosine, topK, topKAsync } from '../similarity.js';

describe('cosine', () => {
  it('returns 0 for zero-norm vectors (never NaN)', () => {
    expect(cosine(new Float32Array([0, 0]), new Float32Array([0, 0]))).toBe(0);
  });

  it('returns 0 for mismatched dimensions', () => {
    expect(cosine(new Float32Array([1, 2]), new Float32Array([1]))).toBe(0);
  });
});

describe('topKAsync', () => {
  it('matches sync topK for small pools', async () => {
    const query = new Float32Array([1, 0]);
    const pool = [
      { id: 'a', vec: new Float32Array([1, 0]), content: 'a' },
      { id: 'b', vec: new Float32Array([0.8, 0.2]), content: 'b' },
      { id: 'c', vec: new Float32Array([0, 1]), content: 'c' },
    ];

    const expected = topK(query, pool, 2, 0);
    const actual = await topKAsync(query, pool, 2, 0);
    expect(actual).toEqual(expected);
  });

  it('handles pools larger than 10k and keeps top-k ordering', async () => {
    const query = new Float32Array([1, 0]);
    const pool = Array.from({ length: 10_100 }, (_, i) => ({
      id: `doc-${i}`,
      vec: new Float32Array([i % 2 === 0 ? 1 : 0, i % 2 === 0 ? 0 : 1]),
      content: `doc ${i}`,
    }));

    const results = await topKAsync(query, pool, 5, 0.1);
    expect(results).toHaveLength(5);

    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.score).toBeLessThanOrEqual(results[i - 1]!.score);
    }
  });
});
