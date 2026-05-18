import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CycleLogger, CycleStage } from '@agentforge/core';

describe('CycleLogger', () => {
  let tmpDir: string;
  let logger: CycleLogger;
  const cycleId = 'test-cycle-abc123';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-logger-'));
    logger = new CycleLogger(tmpDir, cycleId);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the cycle directory on init', () => {
    const dir = join(tmpDir, '.agentforge/cycles', cycleId);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, 'phases'))).toBe(true);
  });

  it('logPhaseStart writes to events.jsonl', () => {
    logger.logPhaseStart('audit');
    const events = readEvents(tmpDir, cycleId);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('phase.start');
    expect(events[0].phase).toBe('audit');
    expect(events[0].at).toBeDefined();
  });

  it('logPhaseResult writes phase json and events', () => {
    logger.logPhaseResult('audit', {
      phase: 'audit',
      status: 'completed',
      durationMs: 12345,
      costUsd: 0.50,
      agentRuns: [],
    } as any);

    const phasePath = join(tmpDir, '.agentforge/cycles', cycleId, 'phases', 'audit.json');
    expect(existsSync(phasePath)).toBe(true);
    const phaseData = JSON.parse(readFileSync(phasePath, 'utf8'));
    expect(phaseData.status).toBe('completed');

    const events = readEvents(tmpDir, cycleId);
    expect(events.some(e => e.type === 'phase.result')).toBe(true);
  });

  it('logTestRun writes tests.json', () => {
    logger.logTestRun({
      passed: 100,
      failed: 2,
      skipped: 0,
      total: 102,
      passRate: 100 / 102,
      durationMs: 5000,
      failedTests: [],
      newFailures: [],
      rawOutputPath: '/tmp/raw.log',
      exitCode: 1,
    });
    const testsPath = join(tmpDir, '.agentforge/cycles', cycleId, 'tests.json');
    expect(existsSync(testsPath)).toBe(true);
    const data = JSON.parse(readFileSync(testsPath, 'utf8'));
    expect(data.passed).toBe(100);
    expect(data.failed).toBe(2);
  });

  it('logGitEvent appends to git.json', () => {
    logger.logGitEvent({ type: 'branch-created', branch: 'autonomous/v6.4.0' });
    logger.logGitEvent({ type: 'committed', sha: 'abc123def456', message: 'test' });

    const gitPath = join(tmpDir, '.agentforge/cycles', cycleId, 'git.json');
    const data = JSON.parse(readFileSync(gitPath, 'utf8'));
    expect(data.events).toHaveLength(2);
    expect(data.events[0].type).toBe('branch-created');
    expect(data.events[1].type).toBe('committed');
  });

  it('logCycleResult writes a cycle-outcome memory entry', () => {
    logger.logCycleResult({
      cycleId,
      sprintVersion: '6.4.0',
      stage: CycleStage.COMPLETED,
      startedAt: '2026-04-06T15:00:00Z',
      completedAt: '2026-04-06T15:30:00Z',
      durationMs: 1800000,
      cost: { totalUsd: 42.50, budgetUsd: 50, byAgent: {}, byPhase: {} },
      tests: { passed: 100, failed: 0, skipped: 0, total: 100, passRate: 1.0, newFailures: [] },
      git: { branch: 'autonomous/v6.4.0', commitSha: 'abc123', filesChanged: [] },
      pr: { url: 'https://github.com/x/y/pull/1', number: 1, draft: false },
      gateVerdict: 'APPROVE',
    });

    const memoryPath = join(tmpDir, '.agentforge/memory/cycle-outcome.jsonl');
    expect(existsSync(memoryPath)).toBe(true);
    const entries = readFileSync(memoryPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.type).toBe('cycle-outcome');
    expect(entry.source).toBe(cycleId);
    expect(entry.tags).toContain('cycle');
    const value = JSON.parse(entry.value);
    expect(value.cycleId).toBe(cycleId);
    expect(value.sprintVersion).toBe('6.4.0');
    expect(value.stage).toBe('completed');
    expect(value.costUsd).toBe(42.50);
    expect(value.testsPassed).toBe(100);
    expect(value.gateVerdict).toBe('APPROVE');
    expect(value.prUrl).toBe('https://github.com/x/y/pull/1');
  });

  it('logCycleResult includes gateVerdict=REJECT for gate-rejected cycles', () => {
    logger.logCycleResult({
      cycleId,
      sprintVersion: '6.4.0',
      stage: CycleStage.FAILED,
      startedAt: '2026-04-06T15:00:00Z',
      completedAt: '2026-04-06T15:10:00Z',
      durationMs: 600000,
      cost: { totalUsd: 12.00, budgetUsd: 50, byAgent: {}, byPhase: {} },
      tests: { passed: 80, failed: 5, skipped: 0, total: 85, passRate: 80 / 85, newFailures: [] },
      git: { branch: 'autonomous/v6.4.0', commitSha: null, filesChanged: [] },
      pr: { url: null, number: null, draft: false },
      gateVerdict: 'REJECT',
      error: 'gate: Code quality insufficient — 3 CRITICAL findings',
    });

    const memoryPath = join(tmpDir, '.agentforge/memory/cycle-outcome.jsonl');
    const entries = readFileSync(memoryPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const value = JSON.parse(entries[0].value);
    expect(value.gateVerdict).toBe('REJECT');
    expect(value.stage).toBe('failed');
  });

  it('logCycleResult includes gateVerdict=null when verdict not yet determined', () => {
    logger.logCycleResult({
      cycleId,
      sprintVersion: '6.4.0',
      stage: CycleStage.KILLED,
      startedAt: '2026-04-06T15:00:00Z',
      completedAt: '2026-04-06T15:05:00Z',
      durationMs: 300000,
      cost: { totalUsd: 5.00, budgetUsd: 50, byAgent: {}, byPhase: {} },
      tests: { passed: 0, failed: 0, skipped: 0, total: 0, passRate: 0, newFailures: [] },
      git: { branch: '', commitSha: null, filesChanged: [] },
      pr: { url: null, number: null, draft: false },
    });

    const memoryPath = join(tmpDir, '.agentforge/memory/cycle-outcome.jsonl');
    const entries = readFileSync(memoryPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const value = JSON.parse(entries[0].value);
    // gateVerdict is absent from CycleResult → serialised as null in the value payload
    expect(value.gateVerdict).toBeNull();
  });

  it('logCycleResult writes cycle.json with terminal state', () => {
    logger.logCycleResult({
      cycleId,
      sprintVersion: '6.4.0',
      stage: CycleStage.COMPLETED,
      startedAt: '2026-04-06T15:00:00Z',
      completedAt: '2026-04-06T15:30:00Z',
      durationMs: 1800000,
      cost: { totalUsd: 42.50, budgetUsd: 50, byAgent: {}, byPhase: {} },
      tests: { passed: 100, failed: 0, skipped: 0, total: 100, passRate: 1.0, newFailures: [] },
      git: { branch: 'autonomous/v6.4.0', commitSha: 'abc123', filesChanged: [] },
      pr: { url: 'https://github.com/x/y/pull/1', number: 1, draft: false },
    });

    const cyclePath = join(tmpDir, '.agentforge/cycles', cycleId, 'cycle.json');
    const data = JSON.parse(readFileSync(cyclePath, 'utf8'));
    expect(data.stage).toBe('completed');
    expect(data.cost.totalUsd).toBe(42.50);
  });

  it('flushCycleCost writes cycle.json with incremental cost', () => {
    logger.flushCycleCost(12.34);

    const cyclePath = join(tmpDir, '.agentforge/cycles', cycleId, 'cycle.json');
    expect(existsSync(cyclePath)).toBe(true);
    const data = JSON.parse(readFileSync(cyclePath, 'utf8'));
    expect(data.cycleId).toBe(cycleId);
    expect(data.stage).toBe('run');
    expect(data.cost.totalUsd).toBe(12.34);
  });

  it('flushCycleCost updates cost on repeated calls', () => {
    logger.flushCycleCost(5.00);
    logger.flushCycleCost(10.00);
    logger.flushCycleCost(17.50);

    const cyclePath = join(tmpDir, '.agentforge/cycles', cycleId, 'cycle.json');
    const data = JSON.parse(readFileSync(cyclePath, 'utf8'));
    expect(data.cost.totalUsd).toBe(17.50);
  });

  it('flushCycleCost preserves existing cycle.json fields (no clobber)', () => {
    // Simulate a partial cycle.json already written (e.g. by a prior flush)
    const cyclePath = join(tmpDir, '.agentforge/cycles', cycleId, 'cycle.json');
    writeFileSync(cyclePath, JSON.stringify({
      cycleId,
      sprintVersion: '15.0.0',
      stage: 'run',
      cost: { totalUsd: 3.00, budgetUsd: 50 },
    }, null, 2));

    logger.flushCycleCost(8.00);

    const data = JSON.parse(readFileSync(cyclePath, 'utf8'));
    expect(data.sprintVersion).toBe('15.0.0');
    expect(data.cost.totalUsd).toBe(8.00);
    // budgetUsd that was already in cost should be preserved
    expect(data.cost.budgetUsd).toBe(50);
  });

  it('flushCycleCost does not overwrite a terminal stage', () => {
    const cyclePath = join(tmpDir, '.agentforge/cycles', cycleId, 'cycle.json');
    writeFileSync(cyclePath, JSON.stringify({
      cycleId,
      stage: 'completed',
      cost: { totalUsd: 42.50, budgetUsd: 50 },
    }, null, 2));

    // Calling flushCycleCost after logCycleResult should not downgrade the stage
    logger.flushCycleCost(42.50);

    const data = JSON.parse(readFileSync(cyclePath, 'utf8'));
    expect(data.stage).toBe('completed');
  });

  it('flushHeartbeat stamps lastHeartbeatAt without touching stage or cost', () => {
    const cyclePath = join(tmpDir, '.agentforge/cycles', cycleId, 'cycle.json');
    writeFileSync(cyclePath, JSON.stringify({
      cycleId, stage: 'run', cost: { totalUsd: 4.20 },
    }));
    logger.flushHeartbeat();
    const data = JSON.parse(readFileSync(cyclePath, 'utf8'));
    expect(data.lastHeartbeatAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data.stage).toBe('run');
    expect(data.cost.totalUsd).toBe(4.20);
  });

  it('flushHeartbeat does not downgrade a terminal stage', () => {
    const cyclePath = join(tmpDir, '.agentforge/cycles', cycleId, 'cycle.json');
    writeFileSync(cyclePath, JSON.stringify({ cycleId, stage: 'completed' }));
    logger.flushHeartbeat();
    const data = JSON.parse(readFileSync(cyclePath, 'utf8'));
    expect(data.stage).toBe('completed');
    expect(data.lastHeartbeatAt).toBeDefined();
  });

  it('flushHeartbeat does not invent a stage when cycle.json does not yet exist', () => {
    const cyclePath = join(tmpDir, '.agentforge/cycles', cycleId, 'cycle.json');
    expect(existsSync(cyclePath)).toBe(false);
    logger.flushHeartbeat();
    expect(existsSync(cyclePath)).toBe(true);
    const data = JSON.parse(readFileSync(cyclePath, 'utf8'));
    expect(data.cycleId).toBe(cycleId);
    expect(data.lastHeartbeatAt).toMatch(/^\d{4}/);
    // Heartbeat must not pretend the cycle has reached the RUN stage just
    // because the heartbeat fired. flushCycleCost() owns that transition.
    expect(data.stage).toBeUndefined();
  });

  it('flushHeartbeat preserves an existing run stage', () => {
    const cyclePath = join(tmpDir, '.agentforge/cycles', cycleId, 'cycle.json');
    writeFileSync(cyclePath, JSON.stringify({ cycleId, stage: 'run', cost: { totalUsd: 4.20 } }));
    logger.flushHeartbeat();
    const data = JSON.parse(readFileSync(cyclePath, 'utf8'));
    expect(data.stage).toBe('run');
  });

  it('events.jsonl is append-only (each line is one JSON object)', () => {
    logger.logPhaseStart('audit');
    logger.logPhaseStart('plan');
    logger.logPhaseStart('execute');

    const raw = readFileSync(join(tmpDir, '.agentforge/cycles', cycleId, 'events.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

function readEvents(cwd: string, cycleId: string): any[] {
  const path = join(cwd, '.agentforge/cycles', cycleId, 'events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l));
}
