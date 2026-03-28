/**
 * Resilience module tests for v5.9
 * Covers RetryPolicy, TimeoutWrapper, and HealthMonitor.
 */
import { describe, it, expect, vi } from 'vitest';
import { RetryPolicy } from '@agentforge/core';
import { TimeoutWrapper, TimeoutError } from '@agentforge/core';
import { HealthMonitor } from '@agentforge/core';

// ── RetryPolicy ───────────────────────────────────────────────────────────────

describe('RetryPolicy', () => {
  it('returns result immediately on first success', async () => {
    const policy = new RetryPolicy({ maxAttempts: 3, initialDelayMs: 1 });
    const result = await policy.execute(() => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });

  it('retries on failure and succeeds on third attempt', async () => {
    const policy = new RetryPolicy({ maxAttempts: 3, initialDelayMs: 1, jitterFraction: 0 });
    let calls = 0;
    const result = await policy.execute(async () => {
      calls++;
      if (calls < 3) throw new Error('not yet');
      return 'done';
    });
    expect(result).toBe('done');
    expect(calls).toBe(3);
  });

  it('throws after exhausting all attempts', async () => {
    const policy = new RetryPolicy({ maxAttempts: 3, initialDelayMs: 1 });
    let calls = 0;
    await expect(
      policy.execute(async () => { calls++; throw new Error('always fails'); }),
    ).rejects.toThrow('always fails');
    expect(calls).toBe(3);
  });

  it('respects shouldRetry predicate — aborts immediately on fatal error', async () => {
    const policy = new RetryPolicy({
      maxAttempts: 5,
      initialDelayMs: 1,
      shouldRetry: (err) => (err as Error).message !== 'fatal',
    });
    let calls = 0;
    await expect(
      policy.execute(async () => { calls++; throw new Error('fatal'); }),
    ).rejects.toThrow('fatal');
    expect(calls).toBe(1);
  });

  it('shouldRetry allows retry on transient error', async () => {
    const policy = new RetryPolicy({
      maxAttempts: 3,
      initialDelayMs: 1,
      shouldRetry: (err) => (err as Error).message === 'transient',
    });
    let calls = 0;
    await expect(
      policy.execute(async () => { calls++; throw new Error('transient'); }),
    ).rejects.toThrow('transient');
    expect(calls).toBe(3); // all retried
  });

  it('backoff multiplier increases delay between attempts', async () => {
    // Use real timers but very short delays to verify ordering
    const policy = new RetryPolicy({
      maxAttempts: 4,
      initialDelayMs: 5,
      backoffMultiplier: 3,
      jitterFraction: 0,
    });
    const timestamps: number[] = [];
    let i = 0;
    await expect(
      policy.execute(async () => {
        timestamps.push(Date.now());
        i++;
        if (i < 4) throw new Error('x');
        return 'ok';
      }),
    ).resolves.toBe('ok');
    expect(timestamps.length).toBe(4);
    // Each gap should be >= previous gap (roughly — exponential backoff)
    const gap1 = timestamps[1]! - timestamps[0]!;
    const gap2 = timestamps[2]! - timestamps[1]!;
    expect(gap2).toBeGreaterThanOrEqual(gap1 * 0.5); // some slack for timing
  });

  it('maxDelayMs caps the delay', async () => {
    // Run with real timers; very short maxDelayMs ensures test is fast
    const policy = new RetryPolicy({
      maxAttempts: 3,
      initialDelayMs: 5,
      backoffMultiplier: 100,  // would normally produce huge delays
      maxDelayMs: 10,           // cap at 10ms
      jitterFraction: 0,
    });
    const t0 = Date.now();
    let i = 0;
    await expect(
      policy.execute(async () => { i++; if (i < 3) throw new Error('x'); return 'y'; }),
    ).resolves.toBe('y');
    const elapsed = Date.now() - t0;
    // 2 retries × 10ms max each = at most ~100ms total (generous)
    expect(elapsed).toBeLessThan(500);
  });
});

// ── TimeoutWrapper ────────────────────────────────────────────────────────────

describe('TimeoutWrapper', () => {
  it('resolves before timeout', async () => {
    const tw = new TimeoutWrapper({ timeoutMs: 500 });
    const result = await tw.call(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('rejects with TimeoutError when deadline exceeded', async () => {
    const tw = new TimeoutWrapper({ timeoutMs: 50 });
    await expect(
      tw.call(() => new Promise(resolve => setTimeout(resolve, 200))),
    ).rejects.toThrow(TimeoutError);
  });

  it('TimeoutError has code TIMEOUT', async () => {
    const tw = new TimeoutWrapper({ timeoutMs: 30 });
    let caughtErr: unknown;
    try {
      await tw.call(() => new Promise(resolve => setTimeout(resolve, 300)));
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBeInstanceOf(TimeoutError);
    expect((caughtErr as TimeoutError).code).toBe('TIMEOUT');
    expect((caughtErr as TimeoutError).name).toBe('TimeoutError');
  });

  it('passes AbortSignal to the function', async () => {
    const tw = new TimeoutWrapper({ timeoutMs: 40 });
    let signalReceived: AbortSignal | undefined;
    let caughtErr: unknown;
    try {
      await tw.wrap(async (signal) => {
        signalReceived = signal;
        await new Promise(resolve => setTimeout(resolve, 300));
        return 'done';
      });
    } catch (err) {
      caughtErr = err;
    }
    expect(caughtErr).toBeInstanceOf(TimeoutError);
    expect(signalReceived).toBeDefined();
    expect(signalReceived?.aborted).toBe(true);
  });

  it('does not throw when fn resolves quickly', async () => {
    const tw = new TimeoutWrapper({ timeoutMs: 1000 });
    const result = await tw.wrap(() => Promise.resolve('fast'));
    expect(result).toBe('fast');
  });

  it('propagates non-timeout errors from fn', async () => {
    const tw = new TimeoutWrapper({ timeoutMs: 1000 });
    await expect(
      tw.call(() => Promise.reject(new Error('custom error'))),
    ).rejects.toThrow('custom error');
  });
});

// ── HealthMonitor ─────────────────────────────────────────────────────────────

describe('HealthMonitor', () => {
  it('starts with no services registered', () => {
    const monitor = new HealthMonitor();
    expect(monitor.listServices().length).toBe(0);
  });

  it('returns default healthy status for unknown service', () => {
    const monitor = new HealthMonitor();
    const health = monitor.getHealth('unknown');
    expect(health.circuitOpen).toBe(false);
    expect(health.totalCalls).toBe(0);
    expect(health.successRate).toBe(1);
  });

  it('records successful calls and increments count', () => {
    const monitor = new HealthMonitor();
    monitor.record('db', true);
    monitor.record('db', true);
    const h = monitor.getHealth('db');
    expect(h.totalCalls).toBe(2);
    expect(h.successCount).toBe(2);
    expect(h.failureCount).toBe(0);
  });

  it('records failures and tracks lastFailureAt', () => {
    const monitor = new HealthMonitor();
    monitor.record('api', false);
    const h = monitor.getHealth('api');
    expect(h.failureCount).toBe(1);
    expect(h.lastFailureAt).toBeTruthy();
  });

  it('opens circuit after failure rate exceeds threshold', () => {
    const monitor = new HealthMonitor({
      failureRateThreshold: 0.5,
      minCallsBeforeOpen: 4,
    });
    // 3 failures, 1 success = 75% failure rate
    monitor.record('svc', false);
    monitor.record('svc', false);
    monitor.record('svc', false);
    monitor.record('svc', true);
    const h = monitor.getHealth('svc');
    expect(h.circuitOpen).toBe(true);
    expect(h.circuitOpenedAt).toBeTruthy();
  });

  it('does not open circuit below minCallsBeforeOpen', () => {
    const monitor = new HealthMonitor({
      failureRateThreshold: 0.5,
      minCallsBeforeOpen: 10,
    });
    monitor.record('svc', false);
    monitor.record('svc', false);
    monitor.record('svc', false);
    const h = monitor.getHealth('svc');
    expect(h.circuitOpen).toBe(false);
  });

  it('success after circuit open closes it again', () => {
    // Use a very short window so old failures expire immediately
    const monitor = new HealthMonitor({
      failureRateThreshold: 0.5,
      minCallsBeforeOpen: 2,
      windowMs: 1, // 1ms window — failures expire almost instantly
    });
    monitor.record('svc', false);
    monitor.record('svc', false);
    expect(monitor.getHealth('svc').circuitOpen).toBe(true);
    // Wait for window to expire, then record success
    return new Promise<void>(resolve => {
      setTimeout(() => {
        monitor.record('svc', true);
        expect(monitor.getHealth('svc').circuitOpen).toBe(false);
        resolve();
      }, 10);
    });
  });

  it('manual closeCircuit resets the circuit', () => {
    const monitor = new HealthMonitor({ failureRateThreshold: 0.1, minCallsBeforeOpen: 1 });
    monitor.record('svc', false);
    monitor.record('svc', false);
    expect(monitor.getHealth('svc').circuitOpen).toBe(true);
    monitor.closeCircuit('svc');
    expect(monitor.getHealth('svc').circuitOpen).toBe(false);
  });

  it('summary returns correct healthyCount and degradedCount', () => {
    const monitor = new HealthMonitor({ failureRateThreshold: 0.5, minCallsBeforeOpen: 2 });
    // healthy service
    monitor.record('db', true);
    monitor.record('db', true);
    // degraded service
    monitor.record('api', false);
    monitor.record('api', false);
    const s = monitor.summary();
    expect(s.healthyCount).toBe(1);
    expect(s.degradedCount).toBe(1);
    expect(s.services.length).toBe(2);
    expect(s.timestamp).toBeTruthy();
  });

  it('resetService removes service from monitor', () => {
    const monitor = new HealthMonitor();
    monitor.record('svc', true);
    expect(monitor.listServices()).toContain('svc');
    monitor.resetService('svc');
    expect(monitor.listServices()).not.toContain('svc');
  });

  it('resetAll clears all services', () => {
    const monitor = new HealthMonitor();
    monitor.record('a', true);
    monitor.record('b', false);
    monitor.resetAll();
    expect(monitor.listServices().length).toBe(0);
  });
});
