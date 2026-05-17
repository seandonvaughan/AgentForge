// packages/core/src/runtime/__tests__/concurrency-gate.test.ts
//
// T4.5 — Tests for ConcurrencyGate (async semaphore with priority backpressure).

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ConcurrencyGate } from '../concurrency-gate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a "task" that holds a gate slot for `holdMs` ms. */
async function holdSlot(gate: ConcurrencyGate, holdMs: number, priority = 0): Promise<() => void> {
  const release = await gate.acquire(priority);
  if (holdMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, holdMs));
  }
  return release;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConcurrencyGate', () => {
  // 1. Three acquires with maxParallel=2: first two succeed immediately
  it('first two acquires are immediate when maxParallel=2', async () => {
    const gate = new ConcurrencyGate({ maxParallel: 2 });

    const r1 = await gate.acquire();
    const r2 = await gate.acquire();

    const stats = gate.getStats();
    expect(stats.active).toBe(2);
    expect(stats.queued).toBe(0);

    r1();
    r2();
  });

  // 2. Third acquire waits when maxParallel=2 and both slots taken
  it('third acquire waits until a slot is released', async () => {
    const gate = new ConcurrencyGate({ maxParallel: 2 });

    const r1 = await gate.acquire();
    const r2 = await gate.acquire();

    // Third acquire should be pending.
    let r3Released = false;
    let r3: () => void = () => { /* noop */ };
    const p3 = gate.acquire().then((release) => {
      r3 = release;
    });

    // Yield so the Promise microtask queue can process.
    await Promise.resolve();
    expect(gate.getStats().queued).toBe(1);
    expect(gate.getStats().active).toBe(2);

    // Release one slot — p3 should now resolve.
    r1();
    await p3;

    expect(gate.getStats().active).toBe(2); // r2 + r3
    expect(gate.getStats().queued).toBe(0);

    r2();
    r3();
    expect(gate.getStats().active).toBe(0);
    r3Released = true;
    expect(r3Released).toBe(true);
  });

  // 3. Higher-priority queued callers unblock before lower-priority
  it('higher-priority queued acquires resolve before lower-priority', async () => {
    const gate = new ConcurrencyGate({ maxParallel: 1 });

    // Saturate the gate.
    const r1 = await gate.acquire();

    const order: number[] = [];

    const pLow  = gate.acquire(10).then((r) => { order.push(10); r(); });
    const pHigh = gate.acquire(100).then((r) => { order.push(100); r(); });
    const pMid  = gate.acquire(50).then((r) => { order.push(50); r(); });

    // Yield to allow all three to be queued.
    await Promise.resolve();
    expect(gate.getStats().queued).toBe(3);

    // Release the initial slot and drain all.
    r1();
    await Promise.all([pLow, pHigh, pMid]);

    // Expected order: highest priority first → 100, 50, 10.
    expect(order).toEqual([100, 50, 10]);
  });

  // 4. Release function is idempotent
  it('release is idempotent — calling twice does not over-release', async () => {
    const gate = new ConcurrencyGate({ maxParallel: 2 });

    const r1 = await gate.acquire();
    expect(gate.getStats().active).toBe(1);

    r1(); // first release
    expect(gate.getStats().active).toBe(0);
    expect(gate.getStats().totalReleases).toBe(1);

    r1(); // second release — should be a no-op
    expect(gate.getStats().active).toBe(0);
    expect(gate.getStats().totalReleases).toBe(1); // unchanged
  });

  // 5. Stale timeout force-releases the slot
  it('stale timeout force-releases a held slot after deadline', async () => {
    vi.useFakeTimers();

    const TIMEOUT = 100; // ms
    const gate = new ConcurrencyGate({
      maxParallel: 1,
      staleAcquireTimeoutMs: TIMEOUT,
    });

    // Acquire and intentionally never release.
    await gate.acquire();
    expect(gate.getStats().active).toBe(1);

    // A second acquire should be queued.
    let secondResolved = false;
    const p = gate.acquire().then(() => {
      secondResolved = true;
    });

    // Advance fake timers past the stale timeout.
    vi.advanceTimersByTime(TIMEOUT + 10);
    // Let the microtask queue drain.
    await Promise.resolve();
    await p;

    expect(secondResolved).toBe(true);
    expect(gate.getStats().active).toBe(1); // second caller holds the slot now

    vi.useRealTimers();
  });

  // 6. getStats reports correctly
  it('getStats tracks active/queued/totalAcquires/totalReleases accurately', async () => {
    const gate = new ConcurrencyGate({ maxParallel: 3 });

    expect(gate.getStats()).toEqual({
      active: 0,
      queued: 0,
      totalAcquires: 0,
      totalReleases: 0,
    });

    const r1 = await gate.acquire();
    const r2 = await gate.acquire();
    expect(gate.getStats().active).toBe(2);
    expect(gate.getStats().totalAcquires).toBe(2);

    r1();
    expect(gate.getStats().active).toBe(1);
    expect(gate.getStats().totalReleases).toBe(1);

    r2();
    expect(gate.getStats().active).toBe(0);
    expect(gate.getStats().totalReleases).toBe(2);
  });

  // 7. Env var sets the cap
  it('reads maxParallel from env var', async () => {
    process.env['TEST_GATE_CAP'] = '5';
    const gate = new ConcurrencyGate({ envVar: 'TEST_GATE_CAP' });

    const releases: Array<() => void> = [];
    for (let i = 0; i < 5; i++) {
      releases.push(await gate.acquire());
    }
    expect(gate.getStats().active).toBe(5);

    // 6th should queue.
    let queued = false;
    const p6 = gate.acquire().then(() => { queued = true; });
    await Promise.resolve();
    expect(gate.getStats().queued).toBe(1);

    releases[0]!();
    await p6;
    expect(queued).toBe(true);

    for (const r of releases.slice(1)) r();
    delete process.env['TEST_GATE_CAP'];
  });

  // 8. Cap clamps to [1, 40]
  it('clamps maxParallel: values outside [1,40] are clamped', async () => {
    const low  = new ConcurrencyGate({ maxParallel: 0 });
    const high = new ConcurrencyGate({ maxParallel: 999 });

    // Acquire 40 from high — should all succeed immediately.
    const highReleases: Array<() => void> = [];
    for (let i = 0; i < 40; i++) {
      highReleases.push(await high.acquire());
    }
    expect(high.getStats().active).toBe(40);

    // 41st should queue.
    let queued41 = false;
    const p41 = high.acquire().then(() => { queued41 = true; });
    await Promise.resolve();
    expect(high.getStats().queued).toBe(1);

    highReleases[0]!();
    await p41;
    expect(queued41).toBe(true);
    for (const r of highReleases.slice(1)) r();

    // Low clamped to 1.
    const rLow = await low.acquire();
    expect(low.getStats().active).toBe(1);
    rLow();
  });

  // 9. FIFO within same priority
  it('same-priority queued callers are served FIFO', async () => {
    const gate = new ConcurrencyGate({ maxParallel: 1 });
    const r0 = await gate.acquire();

    const order: number[] = [];
    const p1 = gate.acquire(50).then((r) => { order.push(1); r(); });
    const p2 = gate.acquire(50).then((r) => { order.push(2); r(); });
    const p3 = gate.acquire(50).then((r) => { order.push(3); r(); });

    await Promise.resolve();

    r0();
    await Promise.all([p1, p2, p3]);

    expect(order).toEqual([1, 2, 3]);
  });

  // 10. Default env var name (MAX_PARALLEL_AGENTS)
  it('reads from MAX_PARALLEL_AGENTS env var by default', async () => {
    const prev = process.env['MAX_PARALLEL_AGENTS'];
    process.env['MAX_PARALLEL_AGENTS'] = '3';

    const gate = new ConcurrencyGate();
    const releases: Array<() => void> = [];
    for (let i = 0; i < 3; i++) {
      releases.push(await gate.acquire());
    }
    expect(gate.getStats().active).toBe(3);

    let queued = false;
    const p = gate.acquire().then(() => { queued = true; });
    await Promise.resolve();
    expect(gate.getStats().queued).toBe(1);
    releases[0]!();
    await p;
    expect(queued).toBe(true);
    for (const r of releases.slice(1)) r();

    if (prev === undefined) delete process.env['MAX_PARALLEL_AGENTS'];
    else process.env['MAX_PARALLEL_AGENTS'] = prev;
  });

  // 11. Default max is 8 when no env var is set
  it('defaults to maxParallel=8 when no env or option provided', async () => {
    const prev = process.env['MAX_PARALLEL_AGENTS'];
    delete process.env['MAX_PARALLEL_AGENTS'];

    const gate = new ConcurrencyGate();
    const releases: Array<() => void> = [];
    for (let i = 0; i < 8; i++) {
      releases.push(await gate.acquire());
    }
    expect(gate.getStats().active).toBe(8);

    let queued = false;
    const p = gate.acquire().then(() => { queued = true; });
    await Promise.resolve();
    expect(gate.getStats().queued).toBe(1);
    releases[0]!();
    await p;
    expect(queued).toBe(true);
    for (const r of releases.slice(1)) r();

    if (prev !== undefined) process.env['MAX_PARALLEL_AGENTS'] = prev;
  });

  // 12. STRESS: 50 acquires with maxParallel=8 — all complete; active never exceeds 8
  it('stress: 50 acquires with maxParallel=8 — all complete, active never > 8', async () => {
    const gate = new ConcurrencyGate({ maxParallel: 8 });
    const COUNT = 50;
    let maxActive = 0;
    const completed: number[] = [];

    const start = Date.now();

    const tasks = Array.from({ length: COUNT }, (_, i) =>
      (async () => {
        const release = await gate.acquire();
        const cur = gate.getStats().active;
        if (cur > maxActive) maxActive = cur;
        // Simulate a tiny bit of async work.
        await Promise.resolve();
        completed.push(i);
        release();
      })(),
    );

    await Promise.all(tasks);
    const elapsed = Date.now() - start;

    expect(completed).toHaveLength(COUNT);
    expect(maxActive).toBeLessThanOrEqual(8);
    expect(gate.getStats().active).toBe(0);
    expect(gate.getStats().totalAcquires).toBe(COUNT);
    expect(gate.getStats().totalReleases).toBe(COUNT);
    // Stress test should complete well within 2 seconds.
    expect(elapsed).toBeLessThan(2000);

    // eslint-disable-next-line no-console
    console.log(`[stress] 50 acquires, maxParallel=8 completed in ${elapsed}ms`);
  });

  // 13. acquire + release cycle matches stats
  it('totalAcquires and totalReleases always track each acquire/release pair', async () => {
    const gate = new ConcurrencyGate({ maxParallel: 5 });

    const releases: Array<() => void> = [];
    for (let i = 0; i < 5; i++) {
      releases.push(await gate.acquire());
    }

    // Queue 3 more.
    const pending = [gate.acquire(), gate.acquire(), gate.acquire()];
    await Promise.resolve();
    expect(gate.getStats().queued).toBe(3);

    // Release all 5 initial slots.
    for (const r of releases) r();

    // Wait for all pending.
    const pendingReleases = await Promise.all(pending);
    expect(gate.getStats().totalAcquires).toBe(8);
    expect(gate.getStats().active).toBe(3);

    for (const r of pendingReleases) r();
    expect(gate.getStats().active).toBe(0);
    expect(gate.getStats().totalReleases).toBe(8);
  });
});
