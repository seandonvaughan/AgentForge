import { describe, it, expect, beforeEach } from 'vitest';
import {
  AdversarialGenerator,
  ChaosInjector,
  RegressionGate,
} from '../../packages/core/src/adversarial/index.js';

describe('AdversarialGenerator', () => {
  let generator: AdversarialGenerator;

  beforeEach(() => {
    generator = new AdversarialGenerator();
  });

  it('generates edge cases', () => {
    const cases = generator.generate();
    expect(cases.length).toBeGreaterThan(0);
  });

  it('each case has required fields', () => {
    const cases = generator.generate();
    for (const c of cases) {
      expect(c.id).toBeTruthy();
      expect(c.name).toBeTruthy();
      expect(c.category).toBeTruthy();
      expect(c.description).toBeTruthy();
      expect(['reject', 'handle_gracefully', 'return_default']).toContain(c.expectedBehavior);
    }
  });

  it('filters by category', () => {
    const cases = generator.generate({ categories: ['boundary'] });
    expect(cases.every(c => c.category === 'boundary')).toBe(true);
    expect(cases.length).toBeGreaterThan(0);
  });

  it('respects count limit', () => {
    const cases = generator.generate({ count: 3 });
    expect(cases.length).toBeLessThanOrEqual(3);
  });

  it('prefixes field name when provided', () => {
    const cases = generator.generate({ categories: ['boundary'], fieldName: 'username' });
    expect(cases.every(c => c.name.startsWith('username.'))).toBe(true);
  });

  it('generates for specific category', () => {
    const cases = generator.generateForCategory('injection');
    expect(cases.every(c => c.category === 'injection')).toBe(true);
    expect(cases.length).toBeGreaterThan(0);
  });

  it('generates null_like cases', () => {
    const cases = generator.generateForCategory('null_like');
    expect(cases.some(c => c.value === null)).toBe(true);
  });

  it('generates injection cases', () => {
    const cases = generator.generateForCategory('injection');
    expect(cases.some(c => c.name.includes('sql'))).toBe(true);
  });

  it('generates unicode cases', () => {
    const cases = generator.generateForCategory('unicode');
    expect(cases.some(c => c.name.includes('emoji'))).toBe(true);
  });

  it('generates overflow cases', () => {
    const cases = generator.generateForCategory('overflow');
    expect(cases.some(c => c.name === 'long_string')).toBe(true);
  });

  it('adds and uses custom cases', () => {
    generator.addCustomCase({
      category: 'custom',
      name: 'my_custom_case',
      value: { custom: true },
      description: 'A custom edge case',
      expectedBehavior: 'handle_gracefully',
    });
    const cases = generator.generate({ categories: ['custom'] });
    expect(cases.some(c => c.name.includes('my_custom_case'))).toBe(true);
  });

  it('returns all available categories', () => {
    const cats = generator.getCategories();
    expect(cats).toContain('boundary');
    expect(cats).toContain('injection');
    expect(cats).toContain('unicode');
    expect(cats).toContain('null_like');
    expect(cats).toContain('overflow');
  });

  it('reports total count', () => {
    const count = generator.count();
    expect(count).toBeGreaterThan(20); // We have 30+ built-in cases
  });

  it('filters by field type string', () => {
    const cases = generator.generate({ fieldType: 'string' });
    // All values should be string-compatible
    expect(cases.length).toBeGreaterThan(0);
  });
});

describe('ChaosInjector', () => {
  let injector: ChaosInjector;

  beforeEach(() => {
    injector = new ChaosInjector();
  });

  it('adds and retrieves a scenario', () => {
    const scenario = injector.addScenario({
      type: 'error',
      targetComponent: 'database',
      probability: 1.0,
      errorMessage: 'Connection refused',
    });
    expect(scenario.id).toBeTruthy();
    expect(injector.getScenario(scenario.id)).toEqual(scenario);
  });

  it('lists scenarios', () => {
    injector.addScenario({ type: 'latency', targetComponent: 'api', probability: 0.5 });
    injector.addScenario({ type: 'error', targetComponent: 'db', probability: 1.0 });
    expect(injector.listScenarios()).toHaveLength(2);
  });

  it('filters scenarios by component', () => {
    injector.addScenario({ type: 'error', targetComponent: 'api', probability: 1.0 });
    injector.addScenario({ type: 'latency', targetComponent: 'db', probability: 1.0 });
    expect(injector.listScenarios('api')).toHaveLength(1);
  });

  it('injects error chaos', async () => {
    injector.addScenario({ type: 'error', targetComponent: 'test', probability: 1.0, errorMessage: 'Forced error' });
    const result = await injector.inject('test', async () => 'should not reach');
    expect(result.kind).toBe('chaos');
    if (result.kind === 'chaos') {
      expect(result.type).toBe('error');
      expect(result.error?.message).toContain('Forced error');
    }
  });

  it('passes through when no scenario matches', async () => {
    const result = await injector.inject('no-match', async () => 42);
    expect(result.kind).toBe('pass');
    if (result.kind === 'pass') {
      expect(result.value).toBe(42);
    }
  });

  it('passes through when scenario is inactive', async () => {
    const scenario = injector.addScenario({ type: 'error', targetComponent: 'test', probability: 1.0 });
    injector.deactivateScenario(scenario.id);
    const result = await injector.inject('test', async () => 'ok');
    expect(result.kind).toBe('pass');
  });

  it('injects synchronously', () => {
    injector.addScenario({ type: 'error', targetComponent: 'sync-comp', probability: 1.0, errorMessage: 'Sync error' });
    const result = injector.injectSync('sync-comp', () => 'value');
    expect(result.kind).toBe('chaos');
  });

  it('syncs pass-through works', () => {
    const result = injector.injectSync('no-scenario', () => 'sync-value');
    expect(result.kind).toBe('pass');
    if (result.kind === 'pass') {
      expect(result.value).toBe('sync-value');
    }
  });

  it('logs injections', async () => {
    injector.addScenario({ type: 'error', targetComponent: 'logger-comp', probability: 1.0 });
    await injector.inject('logger-comp', async () => {});
    expect(injector.injectionCount()).toBe(1);
    expect(injector.getInjectionLog()).toHaveLength(1);
  });

  it('activates and deactivates scenarios', () => {
    const s = injector.addScenario({ type: 'error', targetComponent: 'target', probability: 1.0 });
    injector.deactivateScenario(s.id);
    expect(injector.getScenario(s.id)?.active).toBe(false);
    injector.activateScenario(s.id);
    expect(injector.getScenario(s.id)?.active).toBe(true);
  });

  it('removes a scenario', () => {
    const s = injector.addScenario({ type: 'latency', targetComponent: 'remove-me', probability: 0.5 });
    expect(injector.removeScenario(s.id)).toBe(true);
    expect(injector.getScenario(s.id)).toBeUndefined();
  });

  it('clears all scenarios and log', async () => {
    injector.addScenario({ type: 'error', targetComponent: 'clear-comp', probability: 1.0 });
    await injector.inject('clear-comp', async () => {});
    injector.clearAll();
    expect(injector.listScenarios()).toHaveLength(0);
    expect(injector.injectionCount()).toBe(0);
  });

  it('handles function errors as chaos result', async () => {
    const result = await injector.inject('no-chaos', async () => {
      throw new Error('natural error');
    });
    expect(result.kind).toBe('chaos');
    if (result.kind === 'chaos') {
      expect(result.error?.message).toContain('natural error');
    }
  });
});

describe('RegressionGate', () => {
  let gate: RegressionGate;

  beforeEach(() => {
    gate = new RegressionGate();
  });

  it('records snapshots', () => {
    gate.record(100, 0, 'baseline');
    expect(gate.listSnapshots()).toHaveLength(1);
    expect(gate.latest()?.totalTests).toBe(100);
  });

  it('passes when tests increase and failures stay zero', () => {
    const before = gate.record(100, 0, 'before');
    const after = gate.record(110, 0, 'after');
    const result = gate.evaluate(before, after);
    expect(result.passed).toBe(true);
    expect(result.delta).toBe(10);
  });

  it('blocks when test count decreases', () => {
    const before = gate.record(100, 0, 'before');
    const after = gate.record(90, 0, 'after');
    const result = gate.evaluate(before, after);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('decreased');
    expect(result.blockedAt).toBeTruthy();
  });

  it('blocks when failure count increases', () => {
    const before = gate.record(100, 0, 'before');
    const after = gate.record(100, 5, 'after');
    const result = gate.evaluate(before, after);
    expect(result.passed).toBe(false);
    expect(result.failureDelta).toBe(5);
  });

  it('blocks when new failures introduced', () => {
    const before = gate.record(100, 0, 'before');
    const after = gate.record(110, 3, 'after');
    const result = gate.evaluate(before, after);
    expect(result.passed).toBe(false);
  });

  it('evaluateLatest uses last two snapshots', () => {
    gate.record(100, 0, 'before');
    gate.record(105, 0, 'after');
    const result = gate.evaluateLatest()!;
    expect(result.passed).toBe(true);
    expect(result.delta).toBe(5);
  });

  it('evaluateLatest returns null with fewer than 2 snapshots', () => {
    expect(gate.evaluateLatest()).toBeNull();
    gate.record(100, 0);
    expect(gate.evaluateLatest()).toBeNull();
  });

  it('check creates baseline on first call', () => {
    const result = gate.check(100, 0)!;
    expect(result.passed).toBe(true);
    expect(result.testsAfter).toBe(100);
  });

  it('check compares against previous snapshot', () => {
    gate.record(100, 0, 'baseline');
    const result = gate.check(95, 0)!;
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('decreased');
  });

  it('stores gate history', () => {
    const before = gate.record(100, 0);
    const after = gate.record(110, 0);
    gate.evaluate(before, after);
    expect(gate.getGateHistory()).toHaveLength(1);
  });

  it('resets all state', () => {
    gate.record(100, 0);
    gate.record(110, 0);
    gate.evaluateLatest();
    gate.reset();
    expect(gate.listSnapshots()).toHaveLength(0);
    expect(gate.getGateHistory()).toHaveLength(0);
    expect(gate.latest()).toBeUndefined();
  });

  it('passes when existing failures stay same', () => {
    const before = gate.record(100, 2, 'before');
    const after = gate.record(105, 2, 'after');
    const result = gate.evaluate(before, after);
    expect(result.passed).toBe(true);
  });
});
