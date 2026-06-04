import { describe, expect, it } from 'vitest';
import { QueryCache } from '../index.js';

describe('QueryCache', () => {
  it('evicts expired entries and reports live and expired stats', async () => {
    const cache = new QueryCache();
    cache.set('a', 1, 1);
    cache.set('b', 2, 60_000);
    await new Promise(r => setTimeout(r, 5));
    const removed = cache.evictExpired();
    expect(removed).toBe(1);
    expect(cache.size).toBe(1);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    cache.set('c', 3, 1);
    await new Promise(r => setTimeout(r, 5));
    const s = cache.stats();
    expect(s.size).toBe(1);
    expect(s.expiredCount).toBe(1);
  });
});
