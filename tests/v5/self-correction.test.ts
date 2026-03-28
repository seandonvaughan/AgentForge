import { describe, it, expect } from 'vitest';
import { GitCheckpoint, RegressionDetector, DeadEndTracker, Guardrails, GuardrailError } from '@agentforge/core';

describe('GitCheckpoint', () => {
  it('creates a checkpoint and lists it', () => {
    const gc = new GitCheckpoint(true);
    const cp = gc.create('5.5', 2708, 0);
    expect(cp.sprintVersion).toBe('5.5');
    expect(cp.branch).toContain('5.5');
    expect(gc.list().length).toBe(1);
    expect(gc.latest()?.id).toBe(cp.id);
  });

  it('dry-run rollback returns success message', () => {
    const gc = new GitCheckpoint(true);
    const cp = gc.create('5.5', 2708);
    const result = gc.rollback(cp.id);
    expect(result.success).toBe(true);
    expect(result.message).toContain('dry-run');
  });

  it('rollback with unknown id returns failure', () => {
    const gc = new GitCheckpoint(true);
    const result = gc.rollback('does-not-exist');
    expect(result.success).toBe(false);
  });
});

describe('RegressionDetector', () => {
  it('detects new failures as regression', () => {
    const rd = new RegressionDetector();
    const report = rd.compare({ testCount: 100, failureCount: 0 }, { testCount: 100, failureCount: 2 });
    expect(report.detected).toBe(true);
    expect(report.reason).toContain('failure');
  });

  it('detects removed tests as regression', () => {
    const rd = new RegressionDetector();
    const report = rd.compare({ testCount: 100, failureCount: 0 }, { testCount: 90, failureCount: 0 });
    expect(report.detected).toBe(true);
    expect(report.delta).toBe(-10);
  });

  it('no regression when tests increase and failures stay zero', () => {
    const rd = new RegressionDetector();
    const report = rd.compare({ testCount: 100, failureCount: 0 }, { testCount: 115, failureCount: 0 });
    expect(report.detected).toBe(false);
    expect(report.delta).toBe(15);
  });
});

describe('DeadEndTracker', () => {
  it('deprioritizes after failureThreshold consecutive failures', () => {
    const det = new DeadEndTracker(3);
    expect(det.recordFailure('task-1', 'coder')).toBe(false);
    expect(det.recordFailure('task-1', 'coder')).toBe(false);
    expect(det.recordFailure('task-1', 'coder')).toBe(true);
    expect(det.isDeprioritized('task-1', 'coder')).toBe(true);
  });

  it('reset clears deprioritization', () => {
    const det = new DeadEndTracker(1);
    det.recordFailure('task-2', 'coder');
    det.reset('task-2', 'coder');
    expect(det.isDeprioritized('task-2', 'coder')).toBe(false);
  });

  it('listDeprioritized returns only blocked tasks', () => {
    const det = new DeadEndTracker(2);
    det.recordFailure('t1', 'coder'); det.recordFailure('t1', 'coder');
    det.recordFailure('t2', 'coder');
    expect(det.listDeprioritized().length).toBe(1);
    expect(det.listDeprioritized()[0]?.taskId).toBe('t1');
  });
});

describe('Guardrails', () => {
  it('allows safe operations', () => {
    const g = new Guardrails();
    expect(g.check('implement new authentication endpoint')).toBeNull();
    expect(g.check('add unit tests for the login module')).toBeNull();
  });

  it('blocks package deletion', () => {
    const g = new Guardrails();
    const v = g.check('delete package @agentforge/core');
    expect(v?.blocked).toBe(true);
    expect(v?.rule).toBe('no-package-deletion');
  });

  it('blocks recursive deletion', () => {
    const g = new Guardrails();
    const v = g.check('rm -rf packages/server/dist');
    expect(v?.blocked).toBe(true);
  });

  it('blocks removing tests', () => {
    const g = new Guardrails();
    const v = g.check('remove test files for deprecated modules');
    expect(v?.blocked).toBe(true);
    expect(v?.rule).toBe('no-test-removal');
  });

  it('assert throws GuardrailError for blocked operations', () => {
    const g = new Guardrails();
    expect(() => g.assert('drop table sessions')).toThrow(GuardrailError);
  });

  it('listRules returns all rules', () => {
    const g = new Guardrails();
    expect(g.listRules().length).toBeGreaterThan(0);
  });
});

describe('GitCheckpoint — multiple checkpoints', () => {
  it('latest() returns null when no checkpoints created', () => {
    const gc = new GitCheckpoint(true);
    expect(gc.latest()).toBeNull();
  });

  it('list returns empty array when no checkpoints', () => {
    const gc = new GitCheckpoint(true);
    expect(gc.list()).toEqual([]);
  });

  it('creates multiple checkpoints and lists them all', () => {
    const gc = new GitCheckpoint(true);
    gc.create('5.5', 2708, 0);
    gc.create('5.6', 2720, 0);
    gc.create('5.7', 2735, 0);
    expect(gc.list().length).toBe(3);
  });

  it('latest returns a checkpoint from the existing set', () => {
    const gc = new GitCheckpoint(true);
    const first = gc.create('5.5', 2708, 0);
    const second = gc.create('5.6', 2720, 0);
    const latest = gc.latest();
    expect(latest).not.toBeNull();
    // latest() must return one of the two created checkpoints
    expect([first.id, second.id]).toContain(latest?.id);
  });

  it('checkpoint branch contains the sprint version', () => {
    const gc = new GitCheckpoint(true);
    const cp = gc.create('9.9', 100, 0);
    expect(cp.branch).toContain('9.9');
  });

  it('checkpoint id is unique per create call', () => {
    const gc = new GitCheckpoint(true);
    const cp1 = gc.create('5.5', 100, 0);
    const cp2 = gc.create('5.5', 100, 0);
    expect(cp1.id).not.toBe(cp2.id);
  });

  it('checkpoint stores testCount and failureCount', () => {
    const gc = new GitCheckpoint(true);
    const cp = gc.create('5.5', 2708, 3);
    expect(cp.testCount).toBe(2708);
    expect(cp.failureCount).toBe(3);
  });

  it('checkpoint failureCount defaults to 0 when not provided', () => {
    const gc = new GitCheckpoint(true);
    const cp = gc.create('5.5', 2708);
    expect(cp.failureCount).toBe(0);
  });

  it('rollback returns the checkpoint object on success', () => {
    const gc = new GitCheckpoint(true);
    const cp = gc.create('5.5', 2708, 0);
    const result = gc.rollback(cp.id);
    expect(result.checkpoint?.id).toBe(cp.id);
  });

  it('rollback message contains branch name on success', () => {
    const gc = new GitCheckpoint(true);
    const cp = gc.create('5.5', 2708, 0);
    const result = gc.rollback(cp.id);
    expect(result.message).toContain(cp.branch);
  });

  it('rollback of unknown id returns null checkpoint', () => {
    const gc = new GitCheckpoint(true);
    const result = gc.rollback('nonexistent-id');
    expect(result.checkpoint).toBeNull();
  });

  it('checkpoint stores metadata when provided', () => {
    const gc = new GitCheckpoint(true);
    const cp = gc.create('5.5', 2708, 0, { triggeredBy: 'promoter' });
    expect(cp.metadata?.triggeredBy).toBe('promoter');
  });
});

describe('RegressionDetector — edge cases', () => {
  it('no regression when tests and failures stay identical', () => {
    const rd = new RegressionDetector();
    const report = rd.compare({ testCount: 100, failureCount: 5 }, { testCount: 100, failureCount: 5 });
    expect(report.detected).toBe(false);
    expect(report.reason).toBeUndefined();
  });

  it('regression report includes before/after test counts', () => {
    const rd = new RegressionDetector();
    const report = rd.compare({ testCount: 200, failureCount: 0 }, { testCount: 250, failureCount: 0 });
    expect(report.testCountBefore).toBe(200);
    expect(report.testCountAfter).toBe(250);
  });

  it('regression report includes before/after failure counts', () => {
    const rd = new RegressionDetector();
    const report = rd.compare({ testCount: 100, failureCount: 1 }, { testCount: 100, failureCount: 3 });
    expect(report.failuresBefore).toBe(1);
    expect(report.failuresAfter).toBe(3);
  });

  it('both test removal AND new failures triggers regression with failure reason', () => {
    const rd = new RegressionDetector();
    const report = rd.compare({ testCount: 100, failureCount: 0 }, { testCount: 90, failureCount: 5 });
    expect(report.detected).toBe(true);
    // failure delta fires first in priority
    expect(report.reason).toContain('failure');
  });

  it('reason mentions count of failures when failures introduced', () => {
    const rd = new RegressionDetector();
    const report = rd.compare({ testCount: 100, failureCount: 0 }, { testCount: 100, failureCount: 4 });
    expect(report.reason).toContain('4');
  });

  it('reason mentions count of removed tests when tests removed', () => {
    const rd = new RegressionDetector();
    const report = rd.compare({ testCount: 100, failureCount: 0 }, { testCount: 85, failureCount: 0 });
    expect(report.reason).toContain('15');
  });

  it('delta is positive when tests increase', () => {
    const rd = new RegressionDetector();
    const report = rd.compare({ testCount: 100, failureCount: 0 }, { testCount: 150, failureCount: 0 });
    expect(report.delta).toBe(50);
  });

  it('delta is zero when counts unchanged', () => {
    const rd = new RegressionDetector();
    const report = rd.compare({ testCount: 100, failureCount: 0 }, { testCount: 100, failureCount: 0 });
    expect(report.delta).toBe(0);
  });
});

describe('DeadEndTracker — multi-agent tracking', () => {
  it('different agents on same task are tracked independently', () => {
    const det = new DeadEndTracker(2);
    det.recordFailure('task-x', 'agent-A');
    det.recordFailure('task-x', 'agent-A');
    det.recordFailure('task-x', 'agent-B');
    expect(det.isDeprioritized('task-x', 'agent-A')).toBe(true);
    expect(det.isDeprioritized('task-x', 'agent-B')).toBe(false);
  });

  it('same agent on different tasks tracked independently', () => {
    const det = new DeadEndTracker(2);
    det.recordFailure('task-1', 'coder');
    det.recordFailure('task-1', 'coder');
    det.recordFailure('task-2', 'coder');
    expect(det.isDeprioritized('task-1', 'coder')).toBe(true);
    expect(det.isDeprioritized('task-2', 'coder')).toBe(false);
  });

  it('default threshold is 3', () => {
    const det = new DeadEndTracker(); // default threshold
    det.recordFailure('t', 'a');
    det.recordFailure('t', 'a');
    expect(det.isDeprioritized('t', 'a')).toBe(false);
    det.recordFailure('t', 'a');
    expect(det.isDeprioritized('t', 'a')).toBe(true);
  });

  it('threshold of 1 deprioritizes on first failure', () => {
    const det = new DeadEndTracker(1);
    const result = det.recordFailure('task-1', 'coder');
    expect(result).toBe(true);
    expect(det.isDeprioritized('task-1', 'coder')).toBe(true);
  });

  it('isDeprioritized returns false for unknown task/agent combo', () => {
    const det = new DeadEndTracker(3);
    expect(det.isDeprioritized('unknown-task', 'unknown-agent')).toBe(false);
  });

  it('listDeprioritized returns failure counts', () => {
    const det = new DeadEndTracker(2);
    det.recordFailure('t1', 'a1');
    det.recordFailure('t1', 'a1');
    const list = det.listDeprioritized();
    expect(list[0]?.failures).toBe(2);
  });

  it('listDeprioritized is empty initially', () => {
    const det = new DeadEndTracker(3);
    expect(det.listDeprioritized().length).toBe(0);
  });

  it('reset of non-existent task/agent is a no-op', () => {
    const det = new DeadEndTracker(2);
    det.recordFailure('real', 'agent');
    expect(() => det.reset('fake', 'agent')).not.toThrow();
    expect(det.isDeprioritized('real', 'agent')).toBe(false);
  });

  it('reset allows re-recording failures from zero', () => {
    const det = new DeadEndTracker(2);
    det.recordFailure('t', 'a');
    det.recordFailure('t', 'a');
    det.reset('t', 'a');
    det.recordFailure('t', 'a'); // should not be deprioritized yet
    expect(det.isDeprioritized('t', 'a')).toBe(false);
  });
});

describe('Guardrails — all blocked patterns', () => {
  it('blocks force push', () => {
    const g = new Guardrails();
    const v = g.check('force push to main');
    expect(v?.blocked).toBe(true);
    expect(v?.rule).toBe('no-force-push');
  });

  it('blocks drop table', () => {
    const g = new Guardrails();
    const v = g.check('drop table users');
    expect(v?.blocked).toBe(true);
    expect(v?.rule).toBe('no-table-drop');
  });

  it('blocks modifying circuit breaker', () => {
    const g = new Guardrails();
    const v = g.check('modify circuit breaker thresholds');
    expect(v?.blocked).toBe(true);
    expect(v?.rule).toBe('no-safety-system-modification');
  });

  it('blocks disabling guardrails', () => {
    const g = new Guardrails();
    const v = g.check('disable guardrail for production');
    expect(v?.blocked).toBe(true);
    expect(v?.rule).toBe('no-guardrail-bypass');
  });

  it('check is case-insensitive for rm -rf', () => {
    const g = new Guardrails();
    const v = g.check('RM -RF /tmp/logs');
    expect(v?.blocked).toBe(true);
  });

  it('check is case-insensitive for package deletion', () => {
    const g = new Guardrails();
    const v = g.check('DELETE PACKAGE @agentforge/core');
    expect(v?.blocked).toBe(true);
  });

  it('violation includes the operation text', () => {
    const g = new Guardrails();
    const op = 'drop table sessions';
    const v = g.check(op);
    expect(v?.operation).toBe(op);
  });

  it('violation includes a reason string', () => {
    const g = new Guardrails();
    const v = g.check('remove test coverage files');
    expect(typeof v?.reason).toBe('string');
    expect((v?.reason ?? '').length).toBeGreaterThan(0);
  });

  it('assert throws GuardrailError with violation accessible', () => {
    const g = new Guardrails();
    let caught: any;
    try {
      g.assert('force push origin main');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GuardrailError);
    expect(caught.violation).toBeDefined();
    expect(caught.code).toBe('GUARDRAIL_VIOLATION');
  });

  it('assert does not throw for safe operation', () => {
    const g = new Guardrails();
    expect(() => g.assert('add new endpoint for users')).not.toThrow();
  });

  it('listRules entries have rule and reason properties', () => {
    const g = new Guardrails();
    const rules = g.listRules();
    for (const r of rules) {
      expect(typeof r.rule).toBe('string');
      expect(typeof r.reason).toBe('string');
    }
  });
});
