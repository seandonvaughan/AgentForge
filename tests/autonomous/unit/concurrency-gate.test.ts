// tests/autonomous/unit/concurrency-gate.test.ts
//
// Unit tests for ConcurrencyGate free-memory admission floor (opt-in feature).
// The default-disabled behaviour is the critical no-regression proof: when
// AGENTFORGE_MIN_FREE_MEM_GB is unset, acquire() must behave byte-identically
// to the count-only baseline even when freeMemBytes returns a tiny value.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConcurrencyGate } from '@agentforge/core';

// ---- helpers ----------------------------------------------------------------

/** Flush all micro-tasks and timers in the event loop. */
async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// ---- floor DISABLED by default (no-regression proof) ----------------------

describe('ConcurrencyGate — floor DISABLED by default', () => {
  beforeEach(() => {
    // Guarantee the env var is absent for all tests in this block.
    delete process.env['AGENTFORGE_MIN_FREE_MEM_GB'];
  });

  it('admits up to maxParallel slots even when freeMemBytes returns a tiny value', async () => {
    // Inject a freeMemBytes returning 1 byte (effectively 0 free memory).
    // With the floor DISABLED this must NOT block admission.
    const gate = new ConcurrencyGate({
      maxParallel: 3,
      staleAcquireTimeoutMs: 0,
      freeMemBytes: () => 1,
    });

    const r1 = await gate.acquire();
    const r2 = await gate.acquire();
    const r3 = await gate.acquire();

    // All three slots admitted — count-only cap reached, not mem floor.
    expect(gate.getStats().active).toBe(3);
    expect(gate.getStats().queued).toBe(0);

    r1(); r2(); r3();
  });

  it('queues the (maxParallel+1)th caller on count cap, not on mem floor', async () => {
    const gate = new ConcurrencyGate({
      maxParallel: 2,
      staleAcquireTimeoutMs: 0,
      freeMemBytes: () => 1,
    });

    const r1 = await gate.acquire();
    const r2 = await gate.acquire();

    // Third acquire must queue (count-saturated).
    let r3: (() => void) | undefined;
    gate.acquire().then((r) => { r3 = r; });

    await flushPromises();
    expect(gate.getStats().active).toBe(2);
    expect(gate.getStats().queued).toBe(1);
    expect(r3).toBeUndefined(); // not yet resolved

    // Release one slot → third caller unblocks.
    r1();
    await flushPromises();
    expect(gate.getStats().active).toBe(2);
    expect(r3).toBeDefined();

    r2(); r3!();
  });
});

// ---- floor ENABLED: active>0, below floor → queues -------------------------

describe('ConcurrencyGate — floor ENABLED, below floor, active > 0', () => {
  beforeEach(() => {
    delete process.env['AGENTFORGE_MIN_FREE_MEM_GB'];
  });

  it('queues the second acquire when freeMemBytes is below floor and active > 0', async () => {
    const lowMem = 512 * 1024 * 1024;  // 0.5 GB
    const floorGb = 1;                  // 1 GB floor

    const gate = new ConcurrencyGate({
      maxParallel: 4,
      staleAcquireTimeoutMs: 0,
      minFreeMemGb: floorGb,
      freeMemBytes: () => lowMem,
    });

    // First acquire — active===0 before check, so must always admit.
    const r1 = await gate.acquire();
    expect(gate.getStats().active).toBe(1);

    // Second acquire — active===1 > 0, mem below floor → must queue.
    let r2: (() => void) | undefined;
    gate.acquire().then((r) => { r2 = r; });

    await flushPromises();
    expect(gate.getStats().active).toBe(1);
    expect(gate.getStats().queued).toBe(1);
    expect(r2).toBeUndefined();

    r1();
  });

  it('active stays flat and queue depth rises with multiple below-floor acquires', async () => {
    const gate = new ConcurrencyGate({
      maxParallel: 5,
      staleAcquireTimeoutMs: 0,
      minFreeMemGb: 2,
      freeMemBytes: () => 100, // well below floor
    });

    // Admit the first (active===0 bypass).
    const r1 = await gate.acquire();
    expect(gate.getStats().active).toBe(1);

    // Queue two more.
    gate.acquire();
    gate.acquire();

    await flushPromises();
    expect(gate.getStats().active).toBe(1);
    expect(gate.getStats().queued).toBe(2);

    r1();
  });
});

// ---- floor ENABLED: active===0 → always admit (no deadlock) ---------------

describe('ConcurrencyGate — floor ENABLED, active === 0, below floor', () => {
  beforeEach(() => {
    delete process.env['AGENTFORGE_MIN_FREE_MEM_GB'];
  });

  it('admits the very first acquire even when freeMemBytes is well below floor', async () => {
    const gate = new ConcurrencyGate({
      maxParallel: 4,
      staleAcquireTimeoutMs: 0,
      minFreeMemGb: 99, // absurdly high floor
      freeMemBytes: () => 1,  // 1 byte free
    });

    // active===0 → bypass must fire regardless of memory.
    const release = await gate.acquire();
    expect(gate.getStats().active).toBe(1);
    release();
  });
});

// ---- floor ENABLED: above floor → admits normally up to cap ---------------

describe('ConcurrencyGate — floor ENABLED, freeMemBytes above floor', () => {
  beforeEach(() => {
    delete process.env['AGENTFORGE_MIN_FREE_MEM_GB'];
  });

  it('admits up to maxParallel slots when freeMemBytes exceeds the floor', async () => {
    const abundantMem = 8 * 1024 * 1024 * 1024; // 8 GB
    const gate = new ConcurrencyGate({
      maxParallel: 3,
      staleAcquireTimeoutMs: 0,
      minFreeMemGb: 2,
      freeMemBytes: () => abundantMem,
    });

    const r1 = await gate.acquire();
    const r2 = await gate.acquire();
    const r3 = await gate.acquire();

    expect(gate.getStats().active).toBe(3);
    expect(gate.getStats().queued).toBe(0);

    r1(); r2(); r3();
  });

  it('unblocks queued caller when a slot is released and memory is above floor', async () => {
    const abundantMem = 8 * 1024 * 1024 * 1024;
    const gate = new ConcurrencyGate({
      maxParallel: 2,
      staleAcquireTimeoutMs: 0,
      minFreeMemGb: 1,
      freeMemBytes: () => abundantMem,
    });

    const r1 = await gate.acquire();
    const r2 = await gate.acquire();

    let r3: (() => void) | undefined;
    gate.acquire().then((r) => { r3 = r; });

    await flushPromises();
    expect(gate.getStats().queued).toBe(1);

    r1();
    await flushPromises();

    expect(r3).toBeDefined();
    expect(gate.getStats().active).toBe(2);

    r2(); r3!();
  });
});

// ---- env var parsing -------------------------------------------------------

describe('ConcurrencyGate — AGENTFORGE_MIN_FREE_MEM_GB env var parsing', () => {
  afterEach(() => {
    delete process.env['AGENTFORGE_MIN_FREE_MEM_GB'];
  });

  it('parses "2" as a 2 GB floor (2e9 bytes)', async () => {
    process.env['AGENTFORGE_MIN_FREE_MEM_GB'] = '2';

    const gate = new ConcurrencyGate({
      maxParallel: 4,
      staleAcquireTimeoutMs: 0,
      freeMemBytes: () => 100, // well below 2 GB
    });

    // First admit (active===0 bypass).
    const r1 = await gate.acquire();
    expect(gate.getStats().active).toBe(1);

    // Second blocked by floor.
    let r2: (() => void) | undefined;
    gate.acquire().then((r) => { r2 = r; });
    await flushPromises();
    expect(gate.getStats().queued).toBe(1);
    expect(r2).toBeUndefined();

    r1();
  });

  it('treats invalid env value as disabled (floor 0)', async () => {
    process.env['AGENTFORGE_MIN_FREE_MEM_GB'] = 'not-a-number';

    const gate = new ConcurrencyGate({
      maxParallel: 3,
      staleAcquireTimeoutMs: 0,
      freeMemBytes: () => 1, // floor disabled → still admits
    });

    const r1 = await gate.acquire();
    const r2 = await gate.acquire();
    const r3 = await gate.acquire();

    expect(gate.getStats().active).toBe(3);
    r1(); r2(); r3();
  });

  it('treats empty string env value as disabled', async () => {
    process.env['AGENTFORGE_MIN_FREE_MEM_GB'] = '';

    const gate = new ConcurrencyGate({
      maxParallel: 2,
      staleAcquireTimeoutMs: 0,
      freeMemBytes: () => 1,
    });

    const r1 = await gate.acquire();
    const r2 = await gate.acquire();
    expect(gate.getStats().active).toBe(2);
    r1(); r2();
  });

  it('treats "0" as disabled', async () => {
    process.env['AGENTFORGE_MIN_FREE_MEM_GB'] = '0';

    const gate = new ConcurrencyGate({
      maxParallel: 2,
      staleAcquireTimeoutMs: 0,
      freeMemBytes: () => 1,
    });

    const r1 = await gate.acquire();
    const r2 = await gate.acquire();
    expect(gate.getStats().active).toBe(2);
    r1(); r2();
  });

  it('treats negative value as disabled', async () => {
    process.env['AGENTFORGE_MIN_FREE_MEM_GB'] = '-1';

    const gate = new ConcurrencyGate({
      maxParallel: 2,
      staleAcquireTimeoutMs: 0,
      freeMemBytes: () => 1,
    });

    const r1 = await gate.acquire();
    const r2 = await gate.acquire();
    expect(gate.getStats().active).toBe(2);
    r1(); r2();
  });

  it('explicit minFreeMemGb option takes precedence over env var', async () => {
    // Env says "10" GB floor but explicit option says 0 (disabled).
    process.env['AGENTFORGE_MIN_FREE_MEM_GB'] = '10';

    const gate = new ConcurrencyGate({
      maxParallel: 2,
      staleAcquireTimeoutMs: 0,
      minFreeMemGb: 0,         // explicit disable
      freeMemBytes: () => 1,   // would fail a 10 GB floor
    });

    const r1 = await gate.acquire();
    const r2 = await gate.acquire();
    expect(gate.getStats().active).toBe(2);
    r1(); r2();
  });
});
