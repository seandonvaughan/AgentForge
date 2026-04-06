import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KillSwitch } from '../../../packages/core/src/autonomous/kill-switch.js';
import { DEFAULT_CYCLE_CONFIG } from '../../../packages/core/src/autonomous/config-loader.js';
import { CycleStage } from '../../../packages/core/src/autonomous/types.js';

describe('KillSwitch', () => {
  let tmpDir: string;
  const cycleId = 'test-ks-cycle';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-ks-'));
    mkdirSync(join(tmpDir, '.agentforge/cycles', cycleId), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  function makeKS(overrides: any = {}) {
    const config = {
      ...DEFAULT_CYCLE_CONFIG,
      ...overrides,
      budget: { ...DEFAULT_CYCLE_CONFIG.budget, ...overrides.budget },
      limits: { ...DEFAULT_CYCLE_CONFIG.limits, ...overrides.limits },
      quality: { ...DEFAULT_CYCLE_CONFIG.quality, ...overrides.quality },
      safety: { ...DEFAULT_CYCLE_CONFIG.safety, ...overrides.safety },
    };
    return new KillSwitch(config, cycleId, Date.now(), tmpDir);
  }

  it('does not trip when all metrics are within limits', () => {
    const ks = makeKS();
    const trip = ks.checkBetweenPhases({ cumulativeCostUsd: 10, consecutiveFailures: 0 });
    expect(trip).toBeNull();
    expect(ks.isTripped()).toBe(false);
  });

  it('trips on budget overrun', () => {
    const ks = makeKS({ budget: { perCycleUsd: 50 } });
    const trip = ks.checkBetweenPhases({ cumulativeCostUsd: 51, consecutiveFailures: 0 });
    expect(trip?.reason).toBe('budget');
    expect(trip?.detail).toContain('51');
    expect(trip?.detail).toContain('50');
  });

  it('trips on duration overrun', () => {
    const ks = new KillSwitch(
      { ...DEFAULT_CYCLE_CONFIG, limits: { ...DEFAULT_CYCLE_CONFIG.limits, maxDurationMinutes: 1 } },
      cycleId,
      Date.now() - 2 * 60_000,
      tmpDir,
    );
    const trip = ks.checkBetweenPhases({ cumulativeCostUsd: 0, consecutiveFailures: 0 });
    expect(trip?.reason).toBe('duration');
  });

  it('trips on consecutive failures', () => {
    const ks = makeKS({ limits: { maxConsecutiveFailures: 3 } });
    const trip = ks.checkBetweenPhases({ cumulativeCostUsd: 0, consecutiveFailures: 3 });
    expect(trip?.reason).toBe('consecutiveFailures');
  });

  it('trips on STOP file presence', () => {
    const ks = makeKS();
    writeFileSync(join(tmpDir, '.agentforge/cycles', cycleId, 'STOP'), '');
    const trip = ks.checkBetweenPhases({ cumulativeCostUsd: 0, consecutiveFailures: 0 });
    expect(trip?.reason).toBe('manualStopFile');
  });

  it('trips on testFloor violation', () => {
    const ks = makeKS({ quality: { testPassRateFloor: 0.95 } });
    const trip = ks.checkPostVerify(
      {
        passed: 90, failed: 10, skipped: 0, total: 100,
        passRate: 0.90, durationMs: 1000, failedTests: [],
        newFailures: [], rawOutputPath: '', exitCode: 1,
      },
      { detected: false, reason: '' },
    );
    expect(trip?.reason).toBe('testFloor');
    expect(trip?.detail).toContain('90.0%');
  });

  it('trips on regression when allowRegression=false', () => {
    const ks = makeKS({ quality: { allowRegression: false } });
    const trip = ks.checkPostVerify(
      {
        passed: 100, failed: 0, skipped: 0, total: 100, passRate: 1.0,
        durationMs: 1000, failedTests: [], newFailures: [], rawOutputPath: '', exitCode: 0,
      },
      { detected: true, reason: '2 previously-passing tests now fail' },
    );
    expect(trip?.reason).toBe('regression');
    expect(trip?.detail).toBe('2 previously-passing tests now fail');
  });

  it('does NOT trip on regression when allowRegression=true', () => {
    const ks = makeKS({ quality: { allowRegression: true } });
    const trip = ks.checkPostVerify(
      {
        passed: 100, failed: 0, skipped: 0, total: 100, passRate: 1.0,
        durationMs: 1000, failedTests: [], newFailures: [], rawOutputPath: '', exitCode: 0,
      },
      { detected: true, reason: 'regression' },
    );
    expect(trip).toBeNull();
  });

  it('trips on build failure when requireBuildSuccess=true', () => {
    const ks = makeKS({ quality: { requireBuildSuccess: true } });
    const trip = ks.checkBuildResult({ success: false, error: 'tsc exited 1' });
    expect(trip?.reason).toBe('buildFailure');
    expect(trip?.detail).toBe('tsc exited 1');
  });

  it('does NOT trip on build failure when requireBuildSuccess=false', () => {
    const ks = makeKS({ quality: { requireBuildSuccess: false } });
    const trip = ks.checkBuildResult({ success: false, error: 'tsc exited 1' });
    expect(trip).toBeNull();
  });

  it('trips on typecheck failure when requireTypeCheckSuccess=true', () => {
    const ks = makeKS({ quality: { requireTypeCheckSuccess: true } });
    const trip = ks.checkTypeCheckResult({ success: false, error: 'TS2304' });
    expect(trip?.reason).toBe('typeCheckFailure');
    expect(trip?.detail).toBe('TS2304');
  });

  it('trip is sticky — subsequent checks return same trip', () => {
    const ks = makeKS({ budget: { perCycleUsd: 50 } });
    const trip1 = ks.checkBetweenPhases({ cumulativeCostUsd: 100, consecutiveFailures: 0 });
    const trip2 = ks.checkBetweenPhases({ cumulativeCostUsd: 10, consecutiveFailures: 0 });
    expect(trip1).toBe(trip2);
    expect(ks.isTripped()).toBe(true);
  });

  it('first trip wins when multiple conditions exceed simultaneously', () => {
    const ks = makeKS({
      budget: { perCycleUsd: 10 },
      limits: { maxConsecutiveFailures: 1 },
    });
    const trip = ks.checkBetweenPhases({ cumulativeCostUsd: 50, consecutiveFailures: 5 });
    // Budget should win since STOP file does not exist (STOP file check is first, then budget)
    expect(trip?.reason).toBe('budget');
  });

  it('trip() can be called manually', () => {
    const ks = makeKS();
    const trip = ks.trip('manualStop', 'test reason', CycleStage.RUN);
    expect(trip.reason).toBe('manualStop');
    expect(trip.detail).toBe('test reason');
    expect(ks.isTripped()).toBe(true);
  });

  it('trip() is idempotent — second call returns first trip', () => {
    const ks = makeKS();
    const first = ks.trip('manualStop', 'first call', CycleStage.RUN);
    const second = ks.trip('budget', 'should be ignored', CycleStage.VERIFY);
    expect(second).toBe(first);
    expect(second.reason).toBe('manualStop');
    expect(second.detail).toBe('first call');
  });

  it('getTrip returns null when not tripped', () => {
    const ks = makeKS();
    expect(ks.getTrip()).toBeNull();
  });

  it('stageAtTrip is preserved in trip data', () => {
    const ks = makeKS();
    const trip = ks.trip('manualStop', 'test', CycleStage.VERIFY);
    expect(trip.stageAtTrip).toBe(CycleStage.VERIFY);
  });

  it('triggeredAt is ISO 8601 formatted', () => {
    const ks = makeKS();
    const trip = ks.trip('manualStop', 'test', CycleStage.RUN);
    expect(trip.triggeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('SIGINT handler trips with manualStop reason', () => {
    const ks = makeKS();
    expect(ks.isTripped()).toBe(false);
    process.emit('SIGINT');
    expect(ks.isTripped()).toBe(true);
    const trip = ks.getTrip();
    expect(trip?.reason).toBe('manualStop');
    expect(trip?.detail).toContain('SIGINT');
  });

  it('SIGTERM handler trips with manualStop reason', () => {
    const ks = makeKS();
    expect(ks.isTripped()).toBe(false);
    process.emit('SIGTERM');
    expect(ks.isTripped()).toBe(true);
    const trip = ks.getTrip();
    expect(trip?.reason).toBe('manualStop');
    expect(trip?.detail).toContain('SIGTERM');
  });
});
