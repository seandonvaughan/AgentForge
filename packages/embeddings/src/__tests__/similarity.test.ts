import { describe, expect, it } from 'vitest';
import { cosine, topK, topKAsync } from '../similarity.js';

describe('cosine', () => {
  it('returns 0 instead of NaN when either vector has zero norm', () => {
    const zero = new Float32Array([0, 0, 0]);
    const unit = new Float32Array([1, 0, 0]);

    expect(cosine(zero, unit)).toBe(0);
    expect(cosine(unit, zero)).toBe(0);
    expect(cosine(zero, zero)).toBe(0);
  });
});

describe('topKAsync', () => {
  it('returns the same ranking as topK for equivalent inputs', async () => {
    const query = new Float32Array([1, 1, 0]);
    const pool = [
      { id: 'a', vec: new Float32Array([1, 1, 0]), content: 'a' },
      { id: 'b', vec: new Float32Array([1, 0, 0]), content: 'b' },
      { id: 'c', vec: new Float32Array([0, 1, 0]), content: 'c' },
      { id: 'd', vec: new Float32Array([0, 0, 1]), content: 'd' },
    ];

    const sync = topK(query, pool, 3, 0);
    const asyncResult = await topKAsync(query, pool, 3, 0, 2);

    expect(asyncResult).toEqual(sync);
  });
});
