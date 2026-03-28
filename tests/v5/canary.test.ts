import { describe, it, expect, beforeEach } from 'vitest';
import {
  CanaryManager,
  FeatureFlagManager,
  TrafficSplitter,
} from '../../packages/core/src/canary/index.js';

describe('FeatureFlagManager', () => {
  let manager: FeatureFlagManager;

  beforeEach(() => {
    manager = new FeatureFlagManager();
  });

  it('creates a flag with defaults', () => {
    const flag = manager.create({ name: 'new-router' });
    expect(flag.id).toBeTruthy();
    expect(flag.name).toBe('new-router');
    expect(flag.status).toBe('inactive');
    expect(flag.trafficPercent).toBe(0);
    expect(flag.rollbackThreshold).toBe(0.05);
    expect(flag.errorRate).toBe(0);
  });

  it('creates flag with custom options', () => {
    const flag = manager.create({
      name: 'ml-routing',
      trafficPercent: 25,
      rollbackThreshold: 0.1,
      strategy: 'hash',
    });
    expect(flag.trafficPercent).toBe(25);
    expect(flag.rollbackThreshold).toBe(0.1);
    expect(flag.strategy).toBe('hash');
  });

  it('retrieves flag by id', () => {
    const flag = manager.create({ name: 'test-flag' });
    expect(manager.get(flag.id)).toEqual(flag);
  });

  it('retrieves flag by name', () => {
    manager.create({ name: 'my-feature' });
    expect(manager.getByName('my-feature')).toBeTruthy();
    expect(manager.getByName('nonexistent')).toBeUndefined();
  });

  it('lists all flags', () => {
    manager.create({ name: 'flag-a' });
    manager.create({ name: 'flag-b' });
    expect(manager.list()).toHaveLength(2);
  });

  it('filters list by status', () => {
    const f1 = manager.create({ name: 'flag-a' });
    manager.create({ name: 'flag-b' });
    manager.activate(f1.id);
    expect(manager.list('active')).toHaveLength(1);
    expect(manager.list('inactive')).toHaveLength(1);
  });

  it('activates and deactivates a flag', () => {
    const flag = manager.create({ name: 'toggle-flag' });
    manager.activate(flag.id);
    expect(manager.get(flag.id)?.status).toBe('active');
    manager.deactivate(flag.id);
    expect(manager.get(flag.id)?.status).toBe('inactive');
  });

  it('clamps trafficPercent to 0-100', () => {
    const flag = manager.create({ name: 'bound-flag' });
    manager.update(flag.id, { trafficPercent: 150 });
    expect(manager.get(flag.id)?.trafficPercent).toBe(100);
    manager.update(flag.id, { trafficPercent: -10 });
    expect(manager.get(flag.id)?.trafficPercent).toBe(0);
  });

  it('records canary requests and updates error rate', () => {
    const flag = manager.create({ name: 'error-flag' });
    manager.recordCanaryRequest(flag.id, false);
    manager.recordCanaryRequest(flag.id, true);
    const updated = manager.get(flag.id)!;
    expect(updated.canaryRequests).toBe(2);
    expect(updated.canaryErrors).toBe(1);
    expect(updated.errorRate).toBeCloseTo(0.5);
  });

  it('marks flag as rolled back', () => {
    const flag = manager.create({ name: 'rollback-flag' });
    manager.activate(flag.id);
    manager.markRolledBack(flag.id, 'Too many errors');
    const updated = manager.get(flag.id)!;
    expect(updated.status).toBe('rolled_back');
    expect(updated.trafficPercent).toBe(0);
    expect(updated.rollbackReason).toBe('Too many errors');
    expect(updated.rolledBackAt).toBeTruthy();
  });

  it('deletes a flag', () => {
    const flag = manager.create({ name: 'delete-me' });
    expect(manager.delete(flag.id)).toBe(true);
    expect(manager.get(flag.id)).toBeUndefined();
    expect(manager.delete('missing')).toBe(false);
  });
});

describe('TrafficSplitter', () => {
  const splitter = new TrafficSplitter();

  it('routes to control when flag is inactive', () => {
    const flag: any = { id: 'f1', status: 'inactive', trafficPercent: 50, strategy: 'percentage' };
    const result = splitter.split(flag, 'req-1');
    expect(result.variant).toBe('control');
  });

  it('routes to control when trafficPercent is 0', () => {
    const flag: any = { id: 'f1', status: 'active', trafficPercent: 0, strategy: 'percentage' };
    const result = splitter.split(flag, 'req-1');
    expect(result.variant).toBe('control');
  });

  it('routes to canary when trafficPercent is 100', () => {
    const flag: any = { id: 'f1', status: 'active', trafficPercent: 100, strategy: 'percentage' };
    const result = splitter.split(flag, 'req-1');
    expect(result.variant).toBe('canary');
  });

  it('uses hash strategy for deterministic routing', () => {
    const flag: any = { id: 'f1', status: 'active', trafficPercent: 50, strategy: 'hash' };
    const r1 = splitter.split(flag, 'stable-id-1');
    const r2 = splitter.split(flag, 'stable-id-1');
    // Same request ID always gets same variant with hash strategy
    expect(r1.variant).toBe(r2.variant);
  });

  it('computes consistent bucket for same requestId', () => {
    const bucket1 = splitter.getBucket('user-abc');
    const bucket2 = splitter.getBucket('user-abc');
    expect(bucket1).toBe(bucket2);
    expect(bucket1).toBeGreaterThanOrEqual(0);
    expect(bucket1).toBeLessThan(100);
  });

  it('returns result with correct structure', () => {
    const flag: any = { id: 'flag-id', status: 'active', trafficPercent: 50, strategy: 'hash' };
    const result = splitter.split(flag, 'my-request');
    expect(result.flagId).toBe('flag-id');
    expect(result.requestId).toBe('my-request');
    expect(['canary', 'control']).toContain(result.variant);
    expect(result.reason).toBeTruthy();
  });
});

describe('CanaryManager', () => {
  let manager: CanaryManager;

  beforeEach(() => {
    manager = new CanaryManager();
  });

  it('creates and retrieves flags', () => {
    const flag = manager.createFlag({ name: 'new-algo', trafficPercent: 10 });
    expect(manager.getFlag(flag.id)).toBeTruthy();
    expect(manager.getFlagByName('new-algo')).toBeTruthy();
  });

  it('activates a flag', () => {
    const flag = manager.createFlag({ name: 'test' });
    manager.activateFlag(flag.id);
    expect(manager.getFlag(flag.id)?.status).toBe('active');
  });

  it('routes to control for unknown flag', () => {
    const result = manager.route('nonexistent', 'req-1');
    expect(result.variant).toBe('control');
    expect(result.reason).toContain('not found');
  });

  it('routes to control for inactive flag', () => {
    const flag = manager.createFlag({ name: 'inactive-flag', trafficPercent: 100 });
    const result = manager.route(flag.id, 'req-1');
    expect(result.variant).toBe('control');
  });

  it('routes to canary for active 100% flag', () => {
    const flag = manager.createFlag({ name: 'full-canary', trafficPercent: 100 });
    manager.activateFlag(flag.id);
    const result = manager.route(flag.id, 'req-1');
    expect(result.variant).toBe('canary');
  });

  it('auto-rolls back when error rate exceeds threshold', () => {
    const flag = manager.createFlag({
      name: 'fragile-feature',
      trafficPercent: 100,
      rollbackThreshold: 0.1, // 10% threshold
    });
    manager.activateFlag(flag.id);

    // Send 5 requests with 60% error rate
    for (let i = 0; i < 5; i++) {
      manager.recordOutcome(flag.id, i < 3); // 3 errors, 2 successes
    }

    const updated = manager.getFlag(flag.id)!;
    expect(updated.status).toBe('rolled_back');
    expect(manager.getRollbackLog()).toHaveLength(1);
  });

  it('does not roll back when error rate is below threshold', () => {
    const flag = manager.createFlag({
      name: 'healthy-feature',
      trafficPercent: 100,
      rollbackThreshold: 0.5, // 50% threshold
    });
    manager.activateFlag(flag.id);

    // 20% error rate — below threshold
    for (let i = 0; i < 5; i++) {
      manager.recordOutcome(flag.id, i === 0); // 1 error
    }

    expect(manager.getFlag(flag.id)?.status).toBe('active');
  });

  it('manual rollback', () => {
    const flag = manager.createFlag({ name: 'manual-rb', trafficPercent: 50 });
    manager.activateFlag(flag.id);
    const result = manager.performRollback(flag.id, 'Manual rollback by operator');
    expect(result?.success).toBe(true);
    expect(manager.getFlag(flag.id)?.status).toBe('rolled_back');
  });

  it('returns null for rollback of nonexistent flag', () => {
    expect(manager.performRollback('missing', 'reason')).toBeNull();
  });

  it('reports metrics for a flag', () => {
    const flag = manager.createFlag({ name: 'metrics-flag', trafficPercent: 25 });
    manager.activateFlag(flag.id);
    manager.recordOutcome(flag.id, false);
    const metrics = manager.getMetrics(flag.id)!;
    expect(metrics.flagName).toBe('metrics-flag');
    expect(metrics.canaryRequests).toBe(1);
    expect(metrics.isHealthy).toBe(true);
  });

  it('returns undefined metrics for nonexistent flag', () => {
    expect(manager.getMetrics('missing')).toBeUndefined();
  });

  it('lists all metrics', () => {
    manager.createFlag({ name: 'flag-1' });
    manager.createFlag({ name: 'flag-2' });
    expect(manager.getAllMetrics()).toHaveLength(2);
  });

  it('updates flag configuration', () => {
    const flag = manager.createFlag({ name: 'updatable', trafficPercent: 10 });
    manager.updateFlag(flag.id, { trafficPercent: 30 });
    expect(manager.getFlag(flag.id)?.trafficPercent).toBe(30);
  });

  it('deletes a flag', () => {
    const flag = manager.createFlag({ name: 'deletable' });
    expect(manager.deleteFlag(flag.id)).toBe(true);
    expect(manager.getFlag(flag.id)).toBeUndefined();
  });

  it('tracks flag count', () => {
    expect(manager.flagCount()).toBe(0);
    manager.createFlag({ name: 'f1' });
    manager.createFlag({ name: 'f2' });
    expect(manager.flagCount()).toBe(2);
  });
});
