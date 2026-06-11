import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatWorkerSizingLogFields,
  resolveAvailableMemoryGb,
  resolveMinWorkers,
  resolveWorkerSizing,
} from '../../scripts/run-verify-tests.mjs';

const cfg = {
  reserveGb: 1,
  perWorkerGb: 2,
};

describe('run-verify-tests worker sizing', () => {
  it('sizes workers from AGENTFORGE_VERIFY_AVAILABLE_GB when provided', () => {
    const sizing = resolveWorkerSizing({
      cfg,
      env: { AGENTFORGE_VERIFY_AVAILABLE_GB: '8' },
      readMeminfo: () => 'MemAvailable: 2097152 kB\n',
      fallbackFreeBytes: 1e9,
      cores: 8,
    });

    assert.equal(sizing.availableGb, 8);
    assert.equal(sizing.availableSource, 'env');
    assert.equal(sizing.workers, 3);
  });

  it('uses MemAvailable before falling back to os.freemem', () => {
    const memory = resolveAvailableMemoryGb({
      env: {},
      readMeminfo: () => 'MemTotal: 4096000 kB\nMemAvailable: 3145728 kB\n',
      fallbackFreeBytes: 1e9,
    });

    assert.equal(memory.availableSource, 'meminfo');
    assert.ok(Math.abs(memory.availableGb - 3.221) < 0.001);
  });

  it('clamps worker count to the default floor of two', () => {
    const sizing = resolveWorkerSizing({
      cfg,
      env: {},
      readMeminfo: () => {
        throw new Error('missing meminfo');
      },
      fallbackFreeBytes: 1e9,
      cores: 8,
    });

    assert.equal(sizing.workers, 2);
    assert.equal(resolveMinWorkers({ AGENTFORGE_VERIFY_MIN_WORKERS: '1' }), 2);
  });

  it('honors a valid AGENTFORGE_VERIFY_MIN_WORKERS override', () => {
    const sizing = resolveWorkerSizing({
      cfg,
      env: { AGENTFORGE_VERIFY_MIN_WORKERS: '4' },
      readMeminfo: () => {
        throw new Error('missing meminfo');
      },
      fallbackFreeBytes: 1e9,
      cores: 8,
    });

    assert.equal(sizing.minWorkers, 4);
    assert.equal(sizing.workers, 4);
  });

  it('formats worker sizing inputs for verify gate logs', () => {
    const fields = formatWorkerSizingLogFields({
      availableGb: 8,
      availableSource: 'env',
      cores: 8,
      reserveGb: 1,
      perWorkerGb: 2,
      minWorkers: 2,
    });

    assert.ok(fields.includes('availableGb=8.0'));
    assert.ok(fields.includes('availableSource=env'));
    assert.ok(fields.includes('cores=8'));
    assert.ok(fields.includes('reserveGb=1'));
    assert.ok(fields.includes('perWorkerGb=2'));
    assert.ok(fields.includes('minWorkers=2'));
  });
});
