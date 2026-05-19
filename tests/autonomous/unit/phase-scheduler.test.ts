import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhaseScheduler, KillSwitch, CycleLogger, DEFAULT_CYCLE_CONFIG } from '@agentforge/core';

function makeMockBus() {
  const subscribers: Record<string, Array<(event: any) => void>> = {};
  const published: any[] = [];
  return {
    published,
    bus: {
      publish: (topic: string, payload: any) => {
        published.push({ topic, payload });
        (subscribers[topic] ?? []).forEach((cb) => cb(payload));
      },
      subscribe: (topic: string, cb: (event: any) => void) => {
        if (!subscribers[topic]) subscribers[topic] = [];
        subscribers[topic]!.push(cb);
        return () => {
          subscribers[topic] = subscribers[topic]!.filter((c) => c !== cb);
        };
      },
    } as any,
  };
}

describe('PhaseScheduler', () => {
  let tmpDir: string;
  const cycleId = 'test-ps1';
  const sprintId = 'test-sprint';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-ps-'));
    mkdirSync(join(tmpDir, '.agentforge/cycles', cycleId), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  function makeDeps(busFactory = makeMockBus) {
    const { bus, published } = busFactory();
    const logger = new CycleLogger(tmpDir, cycleId);
    const killSwitch = new KillSwitch(DEFAULT_CYCLE_CONFIG, cycleId, Date.now(), tmpDir);
    return { bus, published, logger, killSwitch };
  }

  function makeAllPhasesCompleteHandlers() {
    const make = (phase: string) => async (ctx: any) => {
      ctx.bus.publish('sprint.phase.completed', {
        sprintId,
        phase,
        cycleId,
        result: {
          phase,
          status: 'completed',
          durationMs: 100,
          costUsd: 0.1,
          agentRuns: [],
          ...(phase === 'execute' ? { itemResults: [] } : {}),
        },
        completedAt: new Date().toISOString(),
      });
    };
    return {
      audit: make('audit'),
      plan: make('plan'),
      assign: make('assign'),
      execute: make('execute'),
      test: make('test'),
      review: make('review'),
      gate: make('gate'),
      release: make('release'),
      learn: make('learn'),
    };
  }

  it('triggers audit phase on run() and auto-advances through all 9 phases', async () => {
    const { bus, published, logger, killSwitch } = makeDeps();
    const handlers = makeAllPhasesCompleteHandlers();

    const scheduler = new PhaseScheduler(
      {
        sprintId,
        sprintVersion: '6.4.0',
        projectRoot: tmpDir,
        adapter: {} as any,
        bus,
        runtime: {} as any,
        cycleId,
      },
      killSwitch,
      logger,
      handlers as any,
    );

    const summary = await scheduler.run();
    expect(summary.completedPhases).toHaveLength(9);
    // Verify we saw all 9 completion events
    const completedEvents = published.filter((e) => e.topic === 'sprint.phase.completed');
    expect(completedEvents).toHaveLength(9);
    // Verify ordering — audit first, learn last
    expect(completedEvents[0]!.payload.phase).toBe('audit');
    expect(completedEvents[8]!.payload.phase).toBe('learn');
  });

  it('auto-advances through all 9 phases in correct order', async () => {
    const { bus, published, logger, killSwitch } = makeDeps();
    const handlers = makeAllPhasesCompleteHandlers();

    const scheduler = new PhaseScheduler(
      {
        sprintId,
        sprintVersion: '6.4.0',
        projectRoot: tmpDir,
        adapter: {} as any,
        bus,
        runtime: {} as any,
        cycleId,
      },
      killSwitch,
      logger,
      handlers as any,
    );

    const summary = await scheduler.run();
    const expectedOrder = [
      'audit',
      'plan',
      'assign',
      'execute',
      'test',
      'review',
      'gate',
      'release',
      'learn',
    ];
    expect(summary.completedPhases.map((p) => p.phase)).toEqual(expectedOrder);
    expect(summary.totalCostUsd).toBeCloseTo(0.9, 5);
    expect(summary.totalDurationMs).toBe(900);
  });

  it('rejects run() when kill switch trips', async () => {
    const { bus, logger } = makeDeps();
    const killSwitch = new KillSwitch(
      { ...DEFAULT_CYCLE_CONFIG, budget: { ...DEFAULT_CYCLE_CONFIG.budget, perCycleUsd: 0.05 } },
      cycleId,
      Date.now(),
      tmpDir,
    );

    const handlers = {
      audit: async (ctx: any) => {
        ctx.bus.publish('sprint.phase.completed', {
          sprintId,
          phase: 'audit',
          cycleId,
          result: {
            phase: 'audit',
            status: 'completed',
            durationMs: 100,
            costUsd: 1.0,
            agentRuns: [],
          },
          completedAt: new Date().toISOString(),
        });
      },
      plan: async () => {
        throw new Error('should not reach plan');
      },
      assign: async () => {},
      execute: async () => {},
      test: async () => {},
      review: async () => {},
      gate: async () => {},
      release: async () => {},
      learn: async () => {},
    };

    const scheduler = new PhaseScheduler(
      {
        sprintId,
        sprintVersion: '6.4.0',
        projectRoot: tmpDir,
        adapter: {} as any,
        bus,
        runtime: {} as any,
        cycleId,
      },
      killSwitch,
      logger,
      handlers as any,
    );

    await expect(scheduler.run()).rejects.toThrow();
  });

  it('rejects on phase.failed event', async () => {
    const { bus, logger, killSwitch } = makeDeps();
    const handlers = {
      audit: async (ctx: any) => {
        ctx.bus.publish('sprint.phase.failed', {
          sprintId,
          phase: 'audit',
          cycleId,
          error: 'researcher crashed',
          failedAt: new Date().toISOString(),
        });
      },
      plan: async () => {},
      assign: async () => {},
      execute: async () => {},
      test: async () => {},
      review: async () => {},
      gate: async () => {},
      release: async () => {},
      learn: async () => {},
    };
    const scheduler = new PhaseScheduler(
      {
        sprintId,
        sprintVersion: '6.4.0',
        projectRoot: tmpDir,
        adapter: {} as any,
        bus,
        runtime: {} as any,
        cycleId,
      },
      killSwitch,
      logger,
      handlers as any,
    );
    await expect(scheduler.run()).rejects.toThrow(/researcher crashed/);
  });

  it('does not advance to release when a gate result is published as failed', async () => {
    const { bus, logger, killSwitch } = makeDeps();
    const handlers = makeAllPhasesCompleteHandlers();
    let releaseCalls = 0;

    handlers.gate = async (ctx: any) => {
      ctx.bus.publish('sprint.phase.completed', {
        sprintId,
        phase: 'gate',
        cycleId,
        result: {
          phase: 'gate',
          status: 'failed',
          durationMs: 100,
          costUsd: 0.1,
          agentRuns: [],
          error: 'gate denied release',
        },
        completedAt: new Date().toISOString(),
      });
    };
    handlers.release = async () => {
      releaseCalls++;
      throw new Error('release should not run');
    };

    const scheduler = new PhaseScheduler(
      {
        sprintId,
        sprintVersion: '6.4.0',
        projectRoot: tmpDir,
        adapter: {} as any,
        bus,
        runtime: {} as any,
        cycleId,
      },
      killSwitch,
      logger,
      handlers as any,
    );

    await expect(scheduler.run()).rejects.toThrow(/gate denied release/);
    expect(releaseCalls).toBe(0);
  });

  it('rewinds the resume checkpoint to execute when a gate result is rejected', async () => {
    const { bus, logger, killSwitch } = makeDeps();
    const handlers = makeAllPhasesCompleteHandlers();

    handlers.gate = async (ctx: any) => {
      ctx.bus.publish('sprint.phase.completed', {
        sprintId,
        phase: 'gate',
        cycleId,
        result: {
          phase: 'gate',
          status: 'failed',
          durationMs: 100,
          costUsd: 0.1,
          agentRuns: [],
          error: 'gate denied release',
        },
        completedAt: new Date().toISOString(),
      });
    };

    const scheduler = new PhaseScheduler(
      {
        sprintId,
        sprintVersion: '6.4.0',
        projectRoot: tmpDir,
        adapter: {} as any,
        bus,
        runtime: {} as any,
        cycleId,
      },
      killSwitch,
      logger,
      handlers as any,
    );

    await expect(scheduler.run()).rejects.toThrow(/gate denied release/);

    const checkpoint = JSON.parse(
      readFileSync(join(tmpDir, '.agentforge', 'cycles', cycleId, 'checkpoint.json'), 'utf8'),
    );
    expect(checkpoint.resumeFromPhase).toBe('execute');
    expect(checkpoint.completedPhases).toEqual(['audit', 'plan', 'assign']);
  });

  it('persists a failure checkpoint at the blocked phase instead of leaving the next phase stale', async () => {
    const { bus, logger, killSwitch } = makeDeps();
    const handlers = makeAllPhasesCompleteHandlers();

    handlers.execute = async (ctx: any) => {
      ctx.bus.publish('sprint.phase.completed', {
        sprintId,
        phase: 'execute',
        cycleId,
        result: {
          phase: 'execute',
          status: 'blocked',
          durationMs: 100,
          costUsd: 0.1,
          agentRuns: [],
          itemResults: [],
          error: 'execute phase reported blocked',
        },
        completedAt: new Date().toISOString(),
      });
    };

    const scheduler = new PhaseScheduler(
      {
        sprintId,
        sprintVersion: '6.4.0',
        projectRoot: tmpDir,
        adapter: {} as any,
        bus,
        runtime: {} as any,
        cycleId,
      },
      killSwitch,
      logger,
      handlers as any,
    );

    await expect(scheduler.run()).rejects.toThrow(/execute phase reported blocked/);

    const checkpoint = JSON.parse(
      readFileSync(join(tmpDir, '.agentforge', 'cycles', cycleId, 'checkpoint.json'), 'utf8'),
    );
    expect(checkpoint.resumeFromPhase).toBe('execute');
    expect(checkpoint.completedPhases).toEqual(['audit', 'plan', 'assign']);
  });

  it('ignores events with mismatched sprintId', async () => {
    const { bus, logger, killSwitch } = makeDeps();
    let auditCalls = 0;
    const handlers = {
      audit: async (ctx: any) => {
        auditCalls++;
        // Publish a stray event with wrong sprintId — should be ignored
        ctx.bus.publish('sprint.phase.completed', {
          sprintId: 'OTHER_SPRINT',
          phase: 'audit',
          cycleId,
          result: {
            phase: 'audit',
            status: 'completed',
            durationMs: 50,
            costUsd: 0.05,
            agentRuns: [],
          },
          completedAt: new Date().toISOString(),
        });
        // Then publish the real event
        ctx.bus.publish('sprint.phase.completed', {
          sprintId,
          phase: 'audit',
          cycleId,
          result: {
            phase: 'audit',
            status: 'completed',
            durationMs: 100,
            costUsd: 0.1,
            agentRuns: [],
          },
          completedAt: new Date().toISOString(),
        });
      },
      plan: async (ctx: any) => {
        ctx.bus.publish('sprint.phase.completed', {
          sprintId,
          phase: 'plan',
          cycleId,
          result: {
            phase: 'plan',
            status: 'completed',
            durationMs: 100,
            costUsd: 0.1,
            agentRuns: [],
          },
          completedAt: new Date().toISOString(),
        });
      },
      assign: async (ctx: any) => {
        ctx.bus.publish('sprint.phase.completed', {
          sprintId,
          phase: 'assign',
          cycleId,
          result: {
            phase: 'assign',
            status: 'completed',
            durationMs: 100,
            costUsd: 0.1,
            agentRuns: [],
          },
          completedAt: new Date().toISOString(),
        });
      },
      execute: async (ctx: any) => {
        ctx.bus.publish('sprint.phase.completed', {
          sprintId,
          phase: 'execute',
          cycleId,
          result: {
            phase: 'execute',
            status: 'completed',
            durationMs: 100,
            costUsd: 0.1,
            agentRuns: [],
            itemResults: [],
          },
          completedAt: new Date().toISOString(),
        });
      },
      test: async (ctx: any) => {
        ctx.bus.publish('sprint.phase.completed', {
          sprintId,
          phase: 'test',
          cycleId,
          result: {
            phase: 'test',
            status: 'completed',
            durationMs: 100,
            costUsd: 0.1,
            agentRuns: [],
          },
          completedAt: new Date().toISOString(),
        });
      },
      review: async (ctx: any) => {
        ctx.bus.publish('sprint.phase.completed', {
          sprintId,
          phase: 'review',
          cycleId,
          result: {
            phase: 'review',
            status: 'completed',
            durationMs: 100,
            costUsd: 0.1,
            agentRuns: [],
          },
          completedAt: new Date().toISOString(),
        });
      },
      gate: async (ctx: any) => {
        ctx.bus.publish('sprint.phase.completed', {
          sprintId,
          phase: 'gate',
          cycleId,
          result: {
            phase: 'gate',
            status: 'completed',
            durationMs: 100,
            costUsd: 0.1,
            agentRuns: [],
          },
          completedAt: new Date().toISOString(),
        });
      },
      release: async (ctx: any) => {
        ctx.bus.publish('sprint.phase.completed', {
          sprintId,
          phase: 'release',
          cycleId,
          result: {
            phase: 'release',
            status: 'completed',
            durationMs: 100,
            costUsd: 0.1,
            agentRuns: [],
          },
          completedAt: new Date().toISOString(),
        });
      },
      learn: async (ctx: any) => {
        ctx.bus.publish('sprint.phase.completed', {
          sprintId,
          phase: 'learn',
          cycleId,
          result: {
            phase: 'learn',
            status: 'completed',
            durationMs: 100,
            costUsd: 0.1,
            agentRuns: [],
          },
          completedAt: new Date().toISOString(),
        });
      },
    };

    const scheduler = new PhaseScheduler(
      {
        sprintId,
        sprintVersion: '6.4.0',
        projectRoot: tmpDir,
        adapter: {} as any,
        bus,
        runtime: {} as any,
        cycleId,
      },
      killSwitch,
      logger,
      handlers as any,
    );

    const summary = await scheduler.run();
    expect(auditCalls).toBe(1);
    expect(summary.completedPhases).toHaveLength(9);
  });

  it('writes cycle.json with accumulated cost via flushCycleCost (incremental roll-up)', async () => {
    // Note on mock-bus timing: the mock bus fires subscriber callbacks
    // synchronously.  This means all 9 phases complete within the call stack
    // of the very first triggerPhase() before run() resolves — we cannot
    // capture per-phase snapshots inside handler bodies.  Instead we verify:
    //   (a) cycle.json was written at all (proving flushCycleCost was called),
    //   (b) its final cost matches the summary totalCostUsd,
    //   (c) stage stays 'run' (PhaseScheduler never writes a terminal stage).
    // Incremental per-call behaviour is covered by cycle-logger.test.ts.
    const { bus, logger, killSwitch } = makeDeps();
    const cyclePath = join(tmpDir, '.agentforge/cycles', cycleId, 'cycle.json');

    // Use distinct per-phase costs so we can verify the cumulative total.
    const phasesCosts: Record<string, number> = {
      audit: 1.00, plan: 2.00, assign: 3.00, execute: 0.50,
      test: 0.10, review: 0.10, gate: 0.10, release: 0.10, learn: 0.10,
    };
    const expectedTotal = Object.values(phasesCosts).reduce((a, b) => a + b, 0);

    const makeHandler = (phase: string) =>
      async (ctx: any) => {
        ctx.bus.publish('sprint.phase.completed', {
          sprintId,
          phase,
          cycleId,
          result: {
            phase,
            status: 'completed',
            durationMs: 100,
            costUsd: phasesCosts[phase]!,
            agentRuns: [],
            ...(phase === 'execute' ? { itemResults: [] } : {}),
          },
          completedAt: new Date().toISOString(),
        });
      };

    const handlers = Object.fromEntries(
      Object.keys(phasesCosts).map((p) => [p, makeHandler(p)]),
    );

    const summary = await new PhaseScheduler(
      { sprintId, sprintVersion: '16.0.0', projectRoot: tmpDir, adapter: {} as any, bus, runtime: {} as any, cycleId },
      killSwitch, logger, handlers as any,
    ).run();

    // cycle.json must exist — it was written by flushCycleCost, not logCycleResult
    // (CycleRunner calls logCycleResult; PhaseScheduler never does).
    expect(existsSync(cyclePath)).toBe(true);

    const data = JSON.parse(readFileSync(cyclePath, 'utf8'));
    expect(data.cycleId).toBe(cycleId);
    expect(data.cost.totalUsd).toBeCloseTo(expectedTotal, 5);
    expect(data.cost.totalUsd).toBeCloseTo(summary.totalCostUsd, 5);
  });

  it('cycle.json stage is preserved as "run" during incremental flush (not overwritten to terminal)', async () => {
    const { bus, logger, killSwitch } = makeDeps();
    const cyclePath = join(tmpDir, '.agentforge/cycles', cycleId, 'cycle.json');
    const handlers = makeAllPhasesCompleteHandlers();

    await new PhaseScheduler(
      { sprintId, sprintVersion: '16.0.0', projectRoot: tmpDir, adapter: {} as any, bus, runtime: {} as any, cycleId },
      killSwitch, logger, handlers as any,
    ).run();

    const data = JSON.parse(readFileSync(cyclePath, 'utf8'));
    // The PhaseScheduler's flush should never overwrite a stage with a
    // terminal value — cycle.json written mid-run must stay at 'run'.
    expect(data.stage).toBe('run');
  });
});
