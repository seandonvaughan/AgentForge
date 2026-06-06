import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../circuit-breaker.js';

describe('CircuitBreaker onStateChange', () => {
  it('calls onStateChange when the circuit opens', async () => {
    const transitions: Array<[string, string]> = [];
    const cb = new CircuitBreaker('svc', {
      failureThreshold: 2,
      onStateChange: (n, p) => transitions.push([n, p]),
    });

    await cb.call(() => Promise.reject(new Error('e'))).catch(() => {});
    await cb.call(() => Promise.reject(new Error('e'))).catch(() => {});

    expect(transitions).toEqual([['open', 'closed']]);
  });

  it('calls onStateChange when reset closes the circuit', async () => {
    const transitions: Array<[string, string, string]> = [];
    const cb = new CircuitBreaker('svc', {
      failureThreshold: 1,
      onStateChange: (next, prev, name) => transitions.push([next, prev, name]),
    });

    await cb.call(() => Promise.reject(new Error('e'))).catch(() => {});
    cb.reset();

    expect(transitions).toEqual([
      ['open', 'closed', 'svc'],
      ['closed', 'open', 'svc'],
    ]);
  });

  it('does not let onStateChange errors replace circuit-breaker errors', async () => {
    const failure = new Error('protected failure');
    const cb = new CircuitBreaker('svc', {
      failureThreshold: 1,
      onStateChange: () => {
        throw new Error('observer failure');
      },
    });

    await expect(cb.call(() => Promise.reject(failure))).rejects.toBe(failure);
    expect(cb.currentState).toBe('open');
  });

  it('clears counters before notifying reset listeners', async () => {
    const resetCounters: Array<[string, number, number]> = [];
    let cb: CircuitBreaker;
    cb = new CircuitBreaker('svc', {
      failureThreshold: 1,
      onStateChange: (next) => {
        if (next === 'closed') {
          const stats = cb.stats();
          resetCounters.push([stats.state, stats.failures, stats.successes]);
        }
      },
    });

    await cb.call(() => Promise.reject(new Error('e'))).catch(() => {});
    cb.reset();

    expect(resetCounters).toEqual([['closed', 0, 0]]);
  });
});
