import { describe, it, expect, vi } from 'vitest';
import { CircuitBreaker, CircuitOpenError, withRetry, createRetry } from '@agentforge/shared';

describe('CircuitBreaker', () => {
  it('starts in closed state', () => {
    const cb = new CircuitBreaker('test');
    expect(cb.currentState).toBe('closed');
  });

  it('allows calls when closed', async () => {
    const cb = new CircuitBreaker('test');
    const result = await cb.call(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('opens after failureThreshold consecutive failures', async () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 3 });
    for (let i = 0; i < 3; i++) {
      try { await cb.call(() => Promise.reject(new Error('fail'))); } catch {}
    }
    expect(cb.currentState).toBe('open');
  });

  it('throws CircuitOpenError when open', async () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 1 });
    try { await cb.call(() => Promise.reject(new Error('fail'))); } catch {}
    await expect(cb.call(() => Promise.resolve(1))).rejects.toThrow(CircuitOpenError);
  });

  it('resets to closed on manual reset', async () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 1 });
    try { await cb.call(() => Promise.reject(new Error('fail'))); } catch {}
    cb.reset();
    expect(cb.currentState).toBe('closed');
  });

  it('stats returns correct failure count', async () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 5 });
    try { await cb.call(() => Promise.reject(new Error('fail'))); } catch {}
    try { await cb.call(() => Promise.reject(new Error('fail'))); } catch {}
    expect(cb.stats().failures).toBe(2);
    expect(cb.stats().lastFailureAt).toBeTruthy();
  });
});

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const result = await withRetry(() => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });

  it('retries on failure and eventually succeeds', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new Error('not yet');
      return 'done';
    }, { maxAttempts: 4, initialDelayMs: 1 });
    expect(result).toBe('done');
    expect(calls).toBe(3);
  });

  it('throws after maxAttempts exhausted', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => { calls++; throw new Error('always fails'); }, { maxAttempts: 3, initialDelayMs: 1 })
    ).rejects.toThrow('always fails');
    expect(calls).toBe(3);
  });

  it('respects shouldRetry predicate to abort early', async () => {
    let calls = 0;
    const fatalError = new Error('fatal');
    await expect(
      withRetry(async () => { calls++; throw fatalError; }, {
        maxAttempts: 5,
        initialDelayMs: 1,
        shouldRetry: (err) => (err as Error).message !== 'fatal',
      })
    ).rejects.toThrow('fatal');
    expect(calls).toBe(1); // no retries on fatal errors
  });

  it('createRetry creates a reusable wrapper', async () => {
    const retry = createRetry({ maxAttempts: 2, initialDelayMs: 1 });
    let calls = 0;
    await expect(retry(async () => { calls++; throw new Error('fail'); })).rejects.toThrow();
    expect(calls).toBe(2);
  });
});
