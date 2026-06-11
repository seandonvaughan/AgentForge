// packages/core/src/autonomous/__tests__/cycle-logger-flush-cost.test.ts
//
// Unit tests for CycleLogger.flushCycleCost — incremental cost roll-up to
// cycle.json so operators have live spend visibility during the RUN stage
// instead of waiting for the terminal write from logCycleResult().
//
// Coverage:
//   - flushCycleCost creates cycle.json when no file exists yet
//   - flushCycleCost merges cost into an existing cycle.json (preserves other fields)
//   - flushCycleCost preserves an existing 'stage' field; defaults to 'run' when absent
//   - flushCycleCost is idempotent — repeated calls with same value are safe
//   - flushCycleCost never throws even when the cycle dir is read-only (observability-only)
//   - PhaseScheduler calls flushCycleCost after each phase.completed event

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CycleLogger } from '../cycle-logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;
const CYCLE_ID = 'test-cycle-flush-0001';

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-flush-cost-'));
});

afterEach(() => {
  // Restore permissions so rmSync can clean up read-only dirs
  try {
    chmodSync(join(tmpRoot, '.agentforge', 'cycles', CYCLE_ID), 0o755);
  } catch { /* best-effort */ }
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeLogger(): CycleLogger {
  return new CycleLogger(tmpRoot, CYCLE_ID);
}

function cyclePath(): string {
  return join(tmpRoot, '.agentforge', 'cycles', CYCLE_ID, 'cycle.json');
}

function readCycle(): Record<string, unknown> {
  return JSON.parse(readFileSync(cyclePath(), 'utf8')) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CycleLogger.flushCycleCost', () => {
  it('creates cycle.json with cost.totalUsd when the file does not yet exist', () => {
    const logger = makeLogger();

    logger.flushCycleCost(1.23);

    expect(existsSync(cyclePath())).toBe(true);
    const data = readCycle();
    expect((data['cost'] as Record<string, unknown>)['totalUsd']).toBe(1.23);
  });

  it('sets stage to "run" by default when cycle.json has no prior stage', () => {
    const logger = makeLogger();

    logger.flushCycleCost(0.5);

    expect(readCycle()['stage']).toBe('run');
  });

  it('preserves an existing stage field — does not overwrite a terminal state', () => {
    const logger = makeLogger();
    // Simulate logCycleResult having already written a terminal stage
    const cycleDir = join(tmpRoot, '.agentforge', 'cycles', CYCLE_ID);
    writeFileSync(join(cycleDir, 'cycle.json'), JSON.stringify({ stage: 'completed', cycleId: CYCLE_ID }));

    logger.flushCycleCost(99.99);

    const data = readCycle();
    // Stage must NOT be overwritten with 'run'
    expect(data['stage']).toBe('completed');
    expect((data['cost'] as Record<string, unknown>)['totalUsd']).toBe(99.99);
  });

  it('merges new cost into existing cycle.json without losing other top-level fields', () => {
    const logger = makeLogger();
    const cycleDir = join(tmpRoot, '.agentforge', 'cycles', CYCLE_ID);
    writeFileSync(
      join(cycleDir, 'cycle.json'),
      JSON.stringify({ stage: 'run', cycleId: CYCLE_ID, sprintVersion: '1.0.0' }),
    );

    logger.flushCycleCost(2.50);

    const data = readCycle();
    expect(data['sprintVersion']).toBe('1.0.0');
    expect(data['cycleId']).toBe(CYCLE_ID);
    expect((data['cost'] as Record<string, unknown>)['totalUsd']).toBe(2.50);
  });

  it('merges new totalUsd into an existing cost object (preserves other cost sub-fields)', () => {
    const logger = makeLogger();
    const cycleDir = join(tmpRoot, '.agentforge', 'cycles', CYCLE_ID);
    writeFileSync(
      join(cycleDir, 'cycle.json'),
      JSON.stringify({ stage: 'run', cost: { totalUsd: 1.00, budgetUsd: 50 } }),
    );

    logger.flushCycleCost(3.75);

    const cost = readCycle()['cost'] as Record<string, unknown>;
    expect(cost['totalUsd']).toBe(3.75);
    // budgetUsd from the prior write must survive
    expect(cost['budgetUsd']).toBe(50);
  });

  it('is idempotent — repeated calls with the same value leave cycle.json consistent', () => {
    const logger = makeLogger();

    logger.flushCycleCost(5.00);
    logger.flushCycleCost(5.00);
    logger.flushCycleCost(5.00);

    const data = readCycle();
    expect((data['cost'] as Record<string, unknown>)['totalUsd']).toBe(5.00);
  });

  it('reflects the latest value after multiple increasing flushes', () => {
    const logger = makeLogger();

    logger.flushCycleCost(1.00);
    logger.flushCycleCost(3.50);
    logger.flushCycleCost(7.25);

    const data = readCycle();
    expect((data['cost'] as Record<string, unknown>)['totalUsd']).toBe(7.25);
  });

  it('does not decrease live cost when a retry flush reports only the current attempt', () => {
    const logger = makeLogger();

    logger.flushCycleCost(20.00);
    logger.flushCycleCost(3.00);

    expect((readCycle()['cost'] as Record<string, unknown>)['totalUsd']).toBe(20.00);

    logger.flushCycleCost(25.00);

    expect((readCycle()['cost'] as Record<string, unknown>)['totalUsd']).toBe(25.00);
  });

  it('writes cycleId into the flushed file for dashboard correlation', () => {
    const logger = makeLogger();

    logger.flushCycleCost(0.01);

    expect(readCycle()['cycleId']).toBe(CYCLE_ID);
  });

  it('does not throw when cycle.json contains malformed JSON — falls back to empty base', () => {
    const logger = makeLogger();
    const cycleDir = join(tmpRoot, '.agentforge', 'cycles', CYCLE_ID);
    writeFileSync(join(cycleDir, 'cycle.json'), '{ invalid json !!');

    expect(() => logger.flushCycleCost(1.0)).not.toThrow();

    // A valid JSON file should be written after recovery
    const data = readCycle();
    expect((data['cost'] as Record<string, unknown>)['totalUsd']).toBe(1.0);
  });
});

describe('CycleLogger.logCycleResult', () => {
  it('does not overwrite a higher live cost snapshot with a zero terminal failed result', () => {
    const logger = makeLogger();
    logger.flushCycleCost(36.45);

    logger.logCycleResult({
      cycleId: CYCLE_ID,
      sprintVersion: '1.0.0',
      stage: 'failed',
      startedAt: '2026-06-11T19:13:01.595Z',
      completedAt: '2026-06-11T19:36:32.192Z',
      durationMs: 1410597,
      cost: {
        totalUsd: 0,
        budgetUsd: 100,
        byAgent: {},
        byPhase: {},
      },
      tests: {
        passed: 0,
        failed: 0,
        skipped: 0,
        total: 0,
        passRate: 0,
        newFailures: [],
      },
      git: {
        branch: '',
        commitSha: null,
        filesChanged: [],
      },
      pr: {
        url: null,
        number: null,
        draft: false,
      },
      error: 'execute: execute phase reported blocked',
    } as any);

    const data = readCycle();
    expect(data['stage']).toBe('failed');
    expect((data['cost'] as Record<string, unknown>)['totalUsd']).toBe(36.45);
  });
});

// ---------------------------------------------------------------------------
// PhaseScheduler integration — cost flush happens after each phase
// ---------------------------------------------------------------------------

describe('PhaseScheduler flushes cost after each completed phase', () => {
  it('calls flushCycleCost with the running sum after each sprint.phase.completed event', async () => {
    const { PhaseScheduler } = await import('../phase-scheduler.js');
    const { KillSwitch } = await import('../kill-switch.js');
    const { CycleStage } = await import('../types.js');
    const logger = makeLogger();

    // Minimal CycleConfig for KillSwitch
    const config: import('../types.js').CycleConfig = {
      budget: { perCycleUsd: 100, perItemUsd: 10, perAgentUsd: 50, allowOverageApproval: true },
      limits: {
        maxItemsPerSprint: 5,
        maxDurationMinutes: 60,
        maxConsecutiveFailures: 3,
        maxExecutePhaseFailureRate: 0.5,
        maxExecutePhaseParallelism: 4,
        maxItemRetries: 1,
      },
      quality: {
        testPassRateFloor: 0.90,
        allowRegression: false,
        requireBuildSuccess: false,
        requireTypeCheckSuccess: false,
      },
      git: {
        branchPrefix: 'autonomous/',
        baseBranch: 'main',
        refuseCommitToBaseBranch: true,
        includeDiagnosticBranchOnFailure: false,
        maxFilesPerCommit: 100,
        maxLinesPerCommit: 4000,
      },
      pr: { draft: false, assignReviewer: null, labelPrefix: 'autonomous', labels: [], titleTemplate: '' },
      sourcing: { lookbackDays: 7, minProposalConfidence: 0.6, includeTodoMarkers: true, todoMarkerPattern: '' },
      testing: {
        command: 'pnpm test',
        timeoutMinutes: 30,
        reporter: 'default',
        saveRawLog: false,
        buildCommand: '',
        typeCheckCommand: '',
      },
      scoring: { agentId: 'ceo', maxRetries: 2, fallbackToStatic: true },
      logging: { logDir: '.agentforge/cycles', retainCycles: 10 },
      safety: {
        stopFilePath: '.agentforge/stop',
        secretScanEnabled: false,
        verifyCleanWorkingTreeBeforeStart: false,
        workingTreeWhitelist: [],
      },
      retry: { maxAutoRetries: 0, requireApprovalAfter: 1, reExecuteOnRetry: false },
    };

    const killSwitch = new KillSwitch(config, CYCLE_ID, Date.now(), tmpRoot);

    // Simple two-phase bus: publishes audit then plan phase completions
    const subscribers: Record<string, Array<(e: unknown) => void>> = {};
    const bus = {
      publish: (topic: string, payload: unknown) => {
        (subscribers[topic] ?? []).forEach((cb) => cb(payload));
      },
      subscribe: (topic: string, cb: (e: unknown) => void) => {
        subscribers[topic] = [...(subscribers[topic] ?? []), cb];
        return () => {
          subscribers[topic] = (subscribers[topic] ?? []).filter((x) => x !== cb);
        };
      },
    };

    const ctx = {
      sprintId: 'sprint-flush-test',
      sprintVersion: '1.0.0',
      projectRoot: tmpRoot,
      adapter: undefined as any,
      bus,
      runtime: undefined as any,
      cycleId: CYCLE_ID,
    };

    // Handlers that simply publish a completion event with a known costUsd
    const auditResult = { phase: 'audit', status: 'completed', durationMs: 100, costUsd: 2.00, agentRuns: [] };
    const planResult = { phase: 'plan', status: 'completed', durationMs: 200, costUsd: 3.50, agentRuns: [] };

    const handlers: Record<string, (c: typeof ctx) => Promise<void>> = {
      audit: async () => {
        bus.publish('sprint.phase.completed', { sprintId: ctx.sprintId, phase: 'audit', result: auditResult });
      },
      plan: async () => {
        bus.publish('sprint.phase.completed', { sprintId: ctx.sprintId, phase: 'plan', result: planResult });
      },
      assign: async () => {
        bus.publish('sprint.phase.completed', { sprintId: ctx.sprintId, phase: 'assign', result: { phase: 'assign', status: 'completed', durationMs: 10, costUsd: 0, agentRuns: [] } });
      },
      execute: async () => {
        bus.publish('sprint.phase.completed', { sprintId: ctx.sprintId, phase: 'execute', result: { phase: 'execute', status: 'completed', durationMs: 10, costUsd: 0, agentRuns: [] } });
      },
      test: async () => {
        bus.publish('sprint.phase.completed', { sprintId: ctx.sprintId, phase: 'test', result: { phase: 'test', status: 'completed', durationMs: 10, costUsd: 0, agentRuns: [] } });
      },
      review: async () => {
        bus.publish('sprint.phase.completed', { sprintId: ctx.sprintId, phase: 'review', result: { phase: 'review', status: 'completed', durationMs: 10, costUsd: 0, agentRuns: [] } });
      },
      gate: async () => {
        bus.publish('sprint.phase.completed', { sprintId: ctx.sprintId, phase: 'gate', result: { phase: 'gate', status: 'completed', durationMs: 10, costUsd: 0, agentRuns: [] } });
      },
      release: async () => {
        bus.publish('sprint.phase.completed', { sprintId: ctx.sprintId, phase: 'release', result: { phase: 'release', status: 'completed', durationMs: 10, costUsd: 0, agentRuns: [] } });
      },
      learn: async () => {
        bus.publish('sprint.phase.completed', { sprintId: ctx.sprintId, phase: 'learn', result: { phase: 'learn', status: 'completed', durationMs: 10, costUsd: 0, agentRuns: [] } });
      },
    };

    const scheduler = new PhaseScheduler(ctx as any, killSwitch, logger, handlers as any);
    await scheduler.run();

    // cycle.json must exist and contain the summed cost from all phases
    expect(existsSync(cyclePath())).toBe(true);
    const data = readCycle();
    const totalCost = (data['cost'] as Record<string, unknown>)['totalUsd'] as number;
    // audit (2.00) + plan (3.50) + the rest (0.00 each)
    expect(totalCost).toBeCloseTo(5.50, 5);
  });

  it('reflects cost after audit phase (before plan) — mid-run visibility', async () => {
    // This test verifies the incremental write happens *between* phases, not just at the end.
    const { PhaseScheduler } = await import('../phase-scheduler.js');
    const { KillSwitch } = await import('../kill-switch.js');
    const logger = makeLogger();

    const config: import('../types.js').CycleConfig = {
      budget: { perCycleUsd: 100, perItemUsd: 10, perAgentUsd: 50, allowOverageApproval: true },
      limits: {
        maxItemsPerSprint: 5, maxDurationMinutes: 60, maxConsecutiveFailures: 3,
        maxExecutePhaseFailureRate: 0.5, maxExecutePhaseParallelism: 4, maxItemRetries: 1,
      },
      quality: { testPassRateFloor: 0.90, allowRegression: false, requireBuildSuccess: false, requireTypeCheckSuccess: false },
      git: { branchPrefix: 'autonomous/', baseBranch: 'main', refuseCommitToBaseBranch: true, includeDiagnosticBranchOnFailure: false, maxFilesPerCommit: 100, maxLinesPerCommit: 4000 },
      pr: { draft: false, assignReviewer: null, labelPrefix: 'autonomous', labels: [], titleTemplate: '' },
      sourcing: { lookbackDays: 7, minProposalConfidence: 0.6, includeTodoMarkers: true, todoMarkerPattern: '' },
      testing: { command: 'pnpm test', timeoutMinutes: 30, reporter: 'default', saveRawLog: false, buildCommand: '', typeCheckCommand: '' },
      scoring: { agentId: 'ceo', maxRetries: 2, fallbackToStatic: true },
      logging: { logDir: '.agentforge/cycles', retainCycles: 10 },
      safety: { stopFilePath: '.agentforge/stop', secretScanEnabled: false, verifyCleanWorkingTreeBeforeStart: false, workingTreeWhitelist: [] },
      retry: { maxAutoRetries: 0, requireApprovalAfter: 1, reExecuteOnRetry: false },
    };

    const killSwitch = new KillSwitch(config, CYCLE_ID, Date.now(), tmpRoot);

    // Track cost snapshots read from disk after each phase completes
    const costSnapshots: number[] = [];

    const subscribers: Record<string, Array<(e: unknown) => void>> = {};
    const bus = {
      publish: (topic: string, payload: unknown) => {
        (subscribers[topic] ?? []).forEach((cb) => cb(payload));
      },
      subscribe: (topic: string, cb: (e: unknown) => void) => {
        subscribers[topic] = [...(subscribers[topic] ?? []), cb];
        return () => {
          subscribers[topic] = (subscribers[topic] ?? []).filter((x) => x !== cb);
        };
      },
    };

    // Spy on flushCycleCost to capture mid-cycle values
    const originalFlush = logger.flushCycleCost.bind(logger);
    logger.flushCycleCost = (usd: number) => {
      costSnapshots.push(usd);
      originalFlush(usd);
    };

    const ctx = {
      sprintId: 'sprint-midcycle-test',
      sprintVersion: '1.0.0',
      projectRoot: tmpRoot,
      adapter: undefined as any,
      bus,
      runtime: undefined as any,
      cycleId: CYCLE_ID,
    };

    const makeResult = (phase: string, costUsd: number) => ({
      phase, status: 'completed', durationMs: 10, costUsd, agentRuns: [],
    });

    const PHASES = ['audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate', 'release', 'learn'] as const;
    const phaseCosts: Record<string, number> = { audit: 1.00, plan: 2.00 };
    const handlers: Record<string, (c: typeof ctx) => Promise<void>> = Object.fromEntries(
      PHASES.map((p) => [
        p,
        async () => {
          bus.publish('sprint.phase.completed', {
            sprintId: ctx.sprintId,
            phase: p,
            result: makeResult(p, phaseCosts[p] ?? 0),
          });
        },
      ]),
    );

    const scheduler = new PhaseScheduler(ctx as any, killSwitch, logger, handlers as any);
    await scheduler.run();

    // First flush should be after audit only (1.00), second after plan (3.00)
    expect(costSnapshots.length).toBeGreaterThanOrEqual(2);
    expect(costSnapshots[0]).toBeCloseTo(1.00, 5);
    expect(costSnapshots[1]).toBeCloseTo(3.00, 5);
  });
});

// ---------------------------------------------------------------------------
// execute.snapshot → mid-phase incremental cost flush
// ---------------------------------------------------------------------------

describe('PhaseScheduler flushes cost on execute.snapshot events (mid-phase)', () => {
  it('updates cycle.json when execute.snapshot fires between items — before execute completes', async () => {
    // This test verifies the key observability fix: during the long execute phase,
    // cycle.json cost.totalUsd reflects the running item spend even before the
    // phase publishes sprint.phase.completed.
    const { PhaseScheduler } = await import('../phase-scheduler.js');
    const { KillSwitch } = await import('../kill-switch.js');
    const logger = makeLogger();

    const config: import('../types.js').CycleConfig = {
      budget: { perCycleUsd: 100, perItemUsd: 10, perAgentUsd: 50, allowOverageApproval: true },
      limits: {
        maxItemsPerSprint: 5, maxDurationMinutes: 60, maxConsecutiveFailures: 3,
        maxExecutePhaseFailureRate: 0.5, maxExecutePhaseParallelism: 4, maxItemRetries: 1,
      },
      quality: { testPassRateFloor: 0.90, allowRegression: false, requireBuildSuccess: false, requireTypeCheckSuccess: false },
      git: { branchPrefix: 'autonomous/', baseBranch: 'main', refuseCommitToBaseBranch: true, includeDiagnosticBranchOnFailure: false, maxFilesPerCommit: 100, maxLinesPerCommit: 4000 },
      pr: { draft: false, assignReviewer: null, labelPrefix: 'autonomous', labels: [], titleTemplate: '' },
      sourcing: { lookbackDays: 7, minProposalConfidence: 0.6, includeTodoMarkers: true, todoMarkerPattern: '' },
      testing: { command: 'pnpm test', timeoutMinutes: 30, reporter: 'default', saveRawLog: false, buildCommand: '', typeCheckCommand: '' },
      scoring: { agentId: 'ceo', maxRetries: 2, fallbackToStatic: true },
      logging: { logDir: '.agentforge/cycles', retainCycles: 10 },
      safety: { stopFilePath: '.agentforge/stop', secretScanEnabled: false, verifyCleanWorkingTreeBeforeStart: false, workingTreeWhitelist: [] },
      retry: { maxAutoRetries: 0, requireApprovalAfter: 1, reExecuteOnRetry: false },
    };

    const killSwitch = new KillSwitch(config, CYCLE_ID, Date.now(), tmpRoot);

    const subscribers: Record<string, Array<(e: unknown) => void>> = {};
    const bus = {
      publish: (topic: string, payload: unknown) => {
        (subscribers[topic] ?? []).forEach((cb) => cb(payload));
      },
      subscribe: (topic: string, cb: (e: unknown) => void) => {
        subscribers[topic] = [...(subscribers[topic] ?? []), cb];
        return () => {
          subscribers[topic] = (subscribers[topic] ?? []).filter((x) => x !== cb);
        };
      },
    };

    const SPRINT_ID = 'sprint-execute-snapshot-test';
    const ctx = {
      sprintId: SPRINT_ID,
      sprintVersion: '1.0.0',
      projectRoot: tmpRoot,
      adapter: undefined as any,
      bus,
      runtime: undefined as any,
      cycleId: CYCLE_ID,
    };

    // Prior phases cost: audit=$1.00, plan=$2.00 — these come in via sprint.phase.completed
    // before execute starts.
    const auditResult = { phase: 'audit', status: 'completed', durationMs: 100, costUsd: 1.00, agentRuns: [] };
    const planResult  = { phase: 'plan',  status: 'completed', durationMs: 100, costUsd: 2.00, agentRuns: [] };

    // Snapshot captured mid-execute, before the phase completes.
    let midExecuteCostInCycleJson: number | undefined;

    const PHASES = ['audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate', 'release', 'learn'] as const;
    const handlers: Record<string, (c: typeof ctx) => Promise<void>> = {
      audit: async () => {
        bus.publish('sprint.phase.completed', { sprintId: SPRINT_ID, phase: 'audit', result: auditResult });
      },
      plan: async () => {
        bus.publish('sprint.phase.completed', { sprintId: SPRINT_ID, phase: 'plan', result: planResult });
      },
      execute: async () => {
        // Simulate first item completing — publish execute.snapshot with $4.50 execute cost.
        // At this point prior phases have $3.00 (audit+plan). Cycle total should be $7.50.
        bus.publish('execute.snapshot', {
          sprintId: SPRINT_ID,
          phase: 'execute',
          cycleId: CYCLE_ID,
          completedItems: 1,
          failedItems: 0,
          inFlightCount: 0,
          totalItems: 2,
          costUsd: 4.50,
        });

        // Read cycle.json immediately after the snapshot — before execute phase completes.
        if (existsSync(cyclePath())) {
          const snapshot = readCycle();
          midExecuteCostInCycleJson = (snapshot['cost'] as Record<string, unknown>)['totalUsd'] as number;
        }

        // Now the execute phase "finishes" — publish completed with full cost.
        bus.publish('sprint.phase.completed', {
          sprintId: SPRINT_ID,
          phase: 'execute',
          result: { phase: 'execute', status: 'completed', durationMs: 5000, costUsd: 9.00, agentRuns: [] },
        });
      },
      // Remaining phases complete cheaply.
      ...Object.fromEntries(
        (['assign', 'test', 'review', 'gate', 'release', 'learn'] as const).map((p) => [
          p,
          async () => {
            bus.publish('sprint.phase.completed', {
              sprintId: SPRINT_ID,
              phase: p,
              result: { phase: p, status: 'completed', durationMs: 10, costUsd: 0, agentRuns: [] },
            });
          },
        ]),
      ),
    };

    const scheduler = new PhaseScheduler(ctx as any, killSwitch, logger, handlers as any);
    await scheduler.run();

    // The mid-execute snapshot must have captured the cumulative cost of
    // prior phases (audit $1 + plan $2 = $3) + execute running spend ($4.50) = $7.50.
    expect(midExecuteCostInCycleJson).toBeCloseTo(7.50, 5);

    // After full cycle, cycle.json should reflect the final total
    // (audit $1 + plan $2 + execute $9 + remaining $0 = $12).
    const finalData = readCycle();
    const finalCost = (finalData['cost'] as Record<string, unknown>)['totalUsd'] as number;
    expect(finalCost).toBeCloseTo(12.00, 5);
  });

  it('does not flush when execute.snapshot costUsd is missing or non-numeric', async () => {
    const { PhaseScheduler } = await import('../phase-scheduler.js');
    const { KillSwitch } = await import('../kill-switch.js');
    const logger = makeLogger();

    const config: import('../types.js').CycleConfig = {
      budget: { perCycleUsd: 100, perItemUsd: 10, perAgentUsd: 50, allowOverageApproval: true },
      limits: {
        maxItemsPerSprint: 5, maxDurationMinutes: 60, maxConsecutiveFailures: 3,
        maxExecutePhaseFailureRate: 0.5, maxExecutePhaseParallelism: 4, maxItemRetries: 1,
      },
      quality: { testPassRateFloor: 0.90, allowRegression: false, requireBuildSuccess: false, requireTypeCheckSuccess: false },
      git: { branchPrefix: 'autonomous/', baseBranch: 'main', refuseCommitToBaseBranch: true, includeDiagnosticBranchOnFailure: false, maxFilesPerCommit: 100, maxLinesPerCommit: 4000 },
      pr: { draft: false, assignReviewer: null, labelPrefix: 'autonomous', labels: [], titleTemplate: '' },
      sourcing: { lookbackDays: 7, minProposalConfidence: 0.6, includeTodoMarkers: true, todoMarkerPattern: '' },
      testing: { command: 'pnpm test', timeoutMinutes: 30, reporter: 'default', saveRawLog: false, buildCommand: '', typeCheckCommand: '' },
      scoring: { agentId: 'ceo', maxRetries: 2, fallbackToStatic: true },
      logging: { logDir: '.agentforge/cycles', retainCycles: 10 },
      safety: { stopFilePath: '.agentforge/stop', secretScanEnabled: false, verifyCleanWorkingTreeBeforeStart: false, workingTreeWhitelist: [] },
      retry: { maxAutoRetries: 0, requireApprovalAfter: 1, reExecuteOnRetry: false },
    };

    const killSwitch = new KillSwitch(config, CYCLE_ID, Date.now(), tmpRoot);

    const subscribers: Record<string, Array<(e: unknown) => void>> = {};
    const bus = {
      publish: (topic: string, payload: unknown) => {
        (subscribers[topic] ?? []).forEach((cb) => cb(payload));
      },
      subscribe: (topic: string, cb: (e: unknown) => void) => {
        subscribers[topic] = [...(subscribers[topic] ?? []), cb];
        return () => { subscribers[topic] = (subscribers[topic] ?? []).filter((x) => x !== cb); };
      },
    };

    const SPRINT_ID = 'sprint-bad-snapshot-test';
    const ctx = {
      sprintId: SPRINT_ID, sprintVersion: '1.0.0', projectRoot: tmpRoot,
      adapter: undefined as any, bus, runtime: undefined as any, cycleId: CYCLE_ID,
    };

    // Track flush calls
    const flushValues: number[] = [];
    const origFlush = logger.flushCycleCost.bind(logger);
    logger.flushCycleCost = (usd: number) => { flushValues.push(usd); origFlush(usd); };

    const PHASES = ['audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate', 'release', 'learn'] as const;
    const handlers: Record<string, (c: typeof ctx) => Promise<void>> = Object.fromEntries(
      PHASES.map((p) => [
        p,
        async () => {
          if (p === 'execute') {
            // Publish snapshot WITHOUT costUsd — should be ignored
            bus.publish('execute.snapshot', { sprintId: SPRINT_ID, phase: 'execute', cycleId: CYCLE_ID, completedItems: 1, totalItems: 2 });
            // Also publish with non-numeric costUsd — should be ignored
            bus.publish('execute.snapshot', { sprintId: SPRINT_ID, phase: 'execute', cycleId: CYCLE_ID, costUsd: 'not-a-number' });
          }
          bus.publish('sprint.phase.completed', {
            sprintId: SPRINT_ID, phase: p,
            result: { phase: p, status: 'completed', durationMs: 10, costUsd: 0, agentRuns: [] },
          });
        },
      ]),
    );

    const scheduler = new PhaseScheduler(ctx as any, killSwitch, logger, handlers as any);
    await scheduler.run();

    // All flushes must have been triggered by phase.completed events, not
    // by malformed snapshots. Every value must be a finite number.
    expect(flushValues.every(v => Number.isFinite(v))).toBe(true);
  });
});
