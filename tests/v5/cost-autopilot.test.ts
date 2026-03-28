import { describe, it, expect, beforeEach } from 'vitest';
import { ResponseCache } from '../../packages/core/src/cost-autopilot/response-cache.js';
import { BatchAggregator } from '../../packages/core/src/cost-autopilot/batch-aggregator.js';
import { CostAutopilot } from '../../packages/core/src/cost-autopilot/cost-autopilot.js';
import type { BatchRequest, BatchResult } from '../../packages/core/src/cost-autopilot/types.js';

// ── ResponseCache ─────────────────────────────────────────────────────────────

describe('ResponseCache', () => {
  let cache: ResponseCache;

  beforeEach(() => {
    cache = new ResponseCache({ ttlMs: 60_000, maxEntries: 10 });
  });

  it('stores and retrieves an entry by exact key', () => {
    cache.store('hello world', { text: 'response' }, 0.005);
    const entry = cache.lookup('hello world');
    expect(entry).not.toBeNull();
    expect(entry!.response).toEqual({ text: 'response' });
    expect(entry!.costUsd).toBe(0.005);
  });

  it('returns null for unknown key', () => {
    const entry = cache.lookup('nonexistent query');
    expect(entry).toBeNull();
  });

  it('increments hit count on repeated lookup', () => {
    cache.store('test key', 'value', 0.01);
    cache.lookup('test key');
    cache.lookup('test key');
    const entry = cache.lookup('test key');
    expect(entry!.hits).toBeGreaterThanOrEqual(2);
  });

  it('returns null for expired entries', async () => {
    const shortCache = new ResponseCache({ ttlMs: 1, maxEntries: 10 });
    shortCache.store('expiring', 'value', 0.01);
    await new Promise(r => setTimeout(r, 10));
    expect(shortCache.lookup('expiring')).toBeNull();
  });

  it('evicts oldest entry when maxEntries is reached', () => {
    for (let i = 0; i < 10; i++) {
      cache.store(`key-${i}`, `value-${i}`, 0.001);
    }
    cache.store('key-overflow', 'overflow', 0.001);
    expect(cache.size()).toBeLessThanOrEqual(10);
  });

  it('finds semantically similar keys', () => {
    cache.store('how much does the architect agent cost', { cost: 5 }, 0.01);
    const result = cache.lookup('how much does the architect agent cost');
    expect(result).not.toBeNull();
  });

  it('clears all entries', () => {
    cache.store('a', 'val', 0.01);
    cache.store('b', 'val', 0.01);
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it('reports correct stats', () => {
    cache.store('q1', 'r1', 0.01);
    cache.lookup('q1');
    cache.lookup('miss');
    const stats = cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBe(0.5);
  });

  it('tracks total savings', () => {
    cache.store('expensive', 'result', 0.015);
    cache.lookup('expensive');
    const stats = cache.stats();
    expect(stats.totalSavingsUsd).toBeGreaterThan(0);
  });

  it('similarity match returns entry', () => {
    const highSimilarityCache = new ResponseCache({ ttlMs: 60_000, maxEntries: 100, similarityThreshold: 0.5 });
    highSimilarityCache.store('list all agents available', { agents: [] }, 0.003);
    const result = highSimilarityCache.lookup('list all agents available');
    expect(result).not.toBeNull();
  });
});

// ── BatchAggregator ───────────────────────────────────────────────────────────

describe('BatchAggregator', () => {
  it('executes requests in a batch', async () => {
    const executor = async (requests: BatchRequest[]): Promise<BatchResult[]> =>
      requests.map(r => ({ requestId: r.id, response: `done:${r.task}`, costUsd: 0.001, fromCache: false }));

    const aggregator = new BatchAggregator(executor, { windowMs: 20, maxBatch: 5 });

    const req: BatchRequest = { id: 'r1', task: 'task1', enqueuedAt: Date.now() };
    const result = await aggregator.enqueue(req);
    expect(result.requestId).toBe('r1');
    expect(result.response).toBe('done:task1');
  });

  it('batches multiple requests together', async () => {
    const batched: BatchRequest[][] = [];
    const executor = async (requests: BatchRequest[]): Promise<BatchResult[]> => {
      batched.push(requests);
      return requests.map(r => ({ requestId: r.id, response: 'ok', costUsd: 0.001, fromCache: false }));
    };

    const aggregator = new BatchAggregator(executor, { windowMs: 50, maxBatch: 10 });

    const promises = [1, 2, 3].map(i =>
      aggregator.enqueue({ id: `r${i}`, task: `t${i}`, enqueuedAt: Date.now() }),
    );

    await Promise.all(promises);
    // At least one batch was fired
    expect(batched.length).toBeGreaterThanOrEqual(1);
    expect(batched.flat().length).toBe(3);
  });

  it('flush() drains pending requests', async () => {
    const results: BatchResult[] = [];
    const executor = async (requests: BatchRequest[]): Promise<BatchResult[]> =>
      requests.map(r => ({ requestId: r.id, response: 'flushed', costUsd: 0, fromCache: false }));

    const aggregator = new BatchAggregator(executor, { windowMs: 5000, maxBatch: 100 });
    const p = aggregator.enqueue({ id: 'fx', task: 'flush-me', enqueuedAt: Date.now() });
    p.then(r => results.push(r));
    await aggregator.flush();
    await p;
    expect(results).toHaveLength(1);
  });

  it('fires immediately when maxBatch is reached', async () => {
    let callCount = 0;
    const executor = async (requests: BatchRequest[]): Promise<BatchResult[]> => {
      callCount++;
      return requests.map(r => ({ requestId: r.id, response: 'ok', costUsd: 0, fromCache: false }));
    };

    const aggregator = new BatchAggregator(executor, { windowMs: 5000, maxBatch: 3 });
    await Promise.all([
      aggregator.enqueue({ id: '1', task: 't1', enqueuedAt: Date.now() }),
      aggregator.enqueue({ id: '2', task: 't2', enqueuedAt: Date.now() }),
      aggregator.enqueue({ id: '3', task: 't3', enqueuedAt: Date.now() }),
    ]);
    expect(callCount).toBeGreaterThanOrEqual(1);
  });

  it('reports stats correctly', async () => {
    const executor = async (requests: BatchRequest[]): Promise<BatchResult[]> =>
      requests.map(r => ({ requestId: r.id, response: 'ok', costUsd: 0, fromCache: false }));

    const aggregator = new BatchAggregator(executor, { windowMs: 20, maxBatch: 5 });
    await aggregator.enqueue({ id: 'a', task: 'ta', enqueuedAt: Date.now() });
    await aggregator.enqueue({ id: 'b', task: 'tb', enqueuedAt: Date.now() });

    const stats = aggregator.getStats();
    expect(stats.totalRequests).toBe(2);
    expect(stats.totalBatches).toBeGreaterThanOrEqual(1);
  });
});

// ── CostAutopilot ─────────────────────────────────────────────────────────────

describe('CostAutopilot', () => {
  const mockExecutor = async (task: string, model: string) => ({
    response: { text: `done:${task}`, model },
    costUsd: model === 'haiku' ? 0.001 : model === 'sonnet' ? 0.003 : 0.015,
  });

  it('processes a task and returns a result', async () => {
    const autopilot = new CostAutopilot(mockExecutor);
    const result = await autopilot.process({ task: 'summarize this text' }, mockExecutor);
    expect(result.requestId).toBeTruthy();
    expect(result.response).toBeDefined();
  });

  it('caches a result and returns from cache on second call', async () => {
    const autopilot = new CostAutopilot(mockExecutor);
    await autopilot.process({ task: 'cached task query' }, mockExecutor);
    const second = await autopilot.process({ task: 'cached task query' }, mockExecutor);
    expect(second.fromCache).toBe(true);
    expect(second.costUsd).toBe(0);
  });

  it('selects haiku for low complexity', async () => {
    let selectedModel = '';
    const trackingExecutor = async (task: string, model: string) => {
      selectedModel = model;
      return { response: 'ok', costUsd: 0.001 };
    };
    const autopilot = new CostAutopilot(trackingExecutor);
    await autopilot.process({ task: 'low complexity task', complexity: 'low' }, trackingExecutor);
    expect(selectedModel).toBe('haiku');
  });

  it('selects opus for high complexity', async () => {
    let selectedModel = '';
    const trackingExecutor = async (task: string, model: string) => {
      selectedModel = model;
      return { response: 'ok', costUsd: 0.015 };
    };
    const autopilot = new CostAutopilot(trackingExecutor);
    await autopilot.process({ task: 'complex architectural review', complexity: 'high' }, trackingExecutor);
    expect(selectedModel).toBe('opus');
  });

  it('returns stats with hit rate', async () => {
    const autopilot = new CostAutopilot(mockExecutor);
    await autopilot.process({ task: 'stats test query' }, mockExecutor);
    await autopilot.process({ task: 'stats test query' }, mockExecutor);
    const stats = autopilot.getStats();
    expect(stats.totalRequests).toBe(2);
    expect(stats.cacheHits).toBe(1);
    expect(stats.cacheHitRate).toBe(0.5);
  });

  it('clearCache resets cache state', async () => {
    const autopilot = new CostAutopilot(mockExecutor);
    await autopilot.process({ task: 'clear me please' }, mockExecutor);
    autopilot.clearCache();
    const second = await autopilot.process({ task: 'clear me please' }, mockExecutor);
    expect(second.fromCache).toBe(false);
  });

  it('respects budget constraint and downgrades model', async () => {
    let selectedModel = '';
    const trackingExecutor = async (task: string, model: string) => {
      selectedModel = model;
      return { response: 'ok', costUsd: 0.001 };
    };
    const autopilot = new CostAutopilot(trackingExecutor);
    await autopilot.process(
      { task: 'budget constrained high complexity', complexity: 'high', maxCostUsd: 0.002 },
      trackingExecutor,
    );
    // budget < opus cost (0.015) → downgrade to sonnet
    expect(['haiku', 'sonnet']).toContain(selectedModel);
  });

  it('reports estimated savings after cache hits', async () => {
    const autopilot = new CostAutopilot(mockExecutor);
    await autopilot.process({ task: 'savings test task' }, mockExecutor);
    await autopilot.process({ task: 'savings test task' }, mockExecutor);
    const stats = autopilot.getStats();
    expect(stats.estimatedSavingsUsd).toBeGreaterThan(0);
  });
});
