/**
 * phase-handlers-events.test.ts — Task 16 of v6.4 autonomous loop.
 *
 * Locks in the EventBus contract that `packages/server/src/lib/phase-handlers.ts`
 * exposes to the future PhaseScheduler (Task 20). Each phase handler in
 * `PHASE_HANDLERS` MUST publish:
 *
 *   - `sprint.phase.started`  (always, at entry, before any I/O)
 *   - `sprint.phase.completed` (on success)
 *   - `sprint.phase.failed`    (on error, before rethrowing)
 *
 * with a payload that includes `sprintId`, `sprintVersion`, `phase`, and
 * (optionally) `cycleId`.
 *
 * Reality vs. plan deviations:
 * - The plan imports `EventBus` from `@agentforge/shared`, but in the actual
 *   Task 15 implementation `EventBus` is defined in `phase-handlers.ts`
 *   itself. We import it from there.
 * - The plan's `PhaseContext` mock includes `adapter` and `runtime` fields,
 *   but the real `PhaseContext` only has `{sprintId, sprintVersion,
 *   projectRoot, agentforgeDir, bus, cycleId?}`. Handlers reach for
 *   AgentRuntime + loadAgentConfig via direct import, so we mock
 *   `@agentforge/core` at the module level (same pattern as
 *   phase-handlers-http.test.ts).
 * - The plan assumes `runAuditPhase(ctx)` will reach `sprint.phase.completed`
 *   without seeding a sprint file; in reality the handler reads
 *   `.agentforge/sprints/v<version>.json` from disk before calling the agent
 *   and throws "Sprint v... not found" if missing. We seed a tmp dir with
 *   the expected file so the agent path runs and completes (with mocked
 *   AgentRuntime).
 * - We test ALL nine PHASE_HANDLERS (audit, plan, assign, execute, test,
 *   review, gate, release, learn), not just runAuditPhase, to lock in the
 *   contract for every entry in PHASE_HANDLERS.
 *
 * No production code is modified by this task; this is test-only.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Mocks — applied BEFORE importing phase-handlers so the handler module
// picks up the mocked versions of @agentforge/core and ../routes/v5/stream.js.
// Mirrors the pattern used by phase-handlers-http.test.ts.
// ---------------------------------------------------------------------------

vi.mock('@agentforge/core', () => {
  const mockRunResult = {
    sessionId: 'mock-phase-session',
    response: 'Mock phase agent response',
    model: 'claude-sonnet-4-6',
    inputTokens: 10,
    outputTokens: 20,
    costUsd: 0.0001,
    startedAt: '2026-04-06T00:00:00.000Z',
    completedAt: '2026-04-06T00:00:01.000Z',
    status: 'completed' as const,
  };

  return {
    AgentRuntime: vi.fn().mockImplementation(() => ({
      runStreaming: vi.fn().mockResolvedValue(mockRunResult),
      run: vi.fn().mockResolvedValue(mockRunResult),
    })),
    loadAgentConfig: vi.fn().mockImplementation(async (agentId: string) => {
      if (!agentId) return null;
      return {
        agentId,
        name: agentId,
        model: 'sonnet' as const,
        systemPrompt: 'mock system prompt',
        workspaceId: 'default',
      };
    }),
  };
});

vi.mock('../../../packages/server/src/routes/v5/stream.js', () => ({
  globalStream: {
    emit: vi.fn(),
  },
}));

vi.mock('@agentforge/shared', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@agentforge/shared');
  let counter = 0;
  return {
    ...actual,
    generateId: vi.fn(() => `test-id-${++counter}`),
    nowIso: vi.fn(() => '2026-04-06T12:00:00.000Z'),
  };
});

// Now safe to import phase-handlers — its top-level imports of @agentforge/core
// and globalStream will hit the mocks above.
import {
  runAuditPhase,
  runPlanPhase,
  runAssignPhase,
  runExecutePhase,
  runTestPhase,
  runReviewPhase,
  runGatePhase,
  runReleasePhase,
  runLearnPhase,
  PHASE_HANDLERS,
  PHASE_SEQUENCE,
  type EventBus,
  type PhaseContext,
  type PhaseEventPayload,
  type PhaseTopic,
  type PhaseName,
  type SprintFile,
} from '../../../packages/server/src/lib/phase-handlers.js';

// ---------------------------------------------------------------------------
// Mock EventBus that records every publish call
// ---------------------------------------------------------------------------

interface RecordedEvent {
  topic: PhaseTopic;
  payload: PhaseEventPayload;
}

function makeMockBus(): { bus: EventBus; published: RecordedEvent[] } {
  const published: RecordedEvent[] = [];
  const bus: EventBus = {
    publish: (topic, payload) => {
      published.push({ topic, payload });
    },
  };
  return { bus, published };
}

// ---------------------------------------------------------------------------
// Tmp project root + sprint seeding
// ---------------------------------------------------------------------------

function makeTmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentforge-phev-'));
  mkdirSync(join(dir, '.agentforge/sprints'), { recursive: true });
  mkdirSync(join(dir, '.agentforge/agents'), { recursive: true });
  return dir;
}

interface SeedSprintOpts {
  version: string;
  phase: string;
  itemCount?: number;
  itemStatus?: 'planned' | 'in_progress' | 'completed' | 'blocked' | 'deferred';
  unassigned?: boolean;
}

function seedSprint(root: string, opts: SeedSprintOpts): void {
  const items = Array.from({ length: opts.itemCount ?? 1 }, (_, i) => ({
    id: `item-${i + 1}`,
    title: `Item ${i + 1}`,
    description: `Description ${i + 1}`,
    priority: 'P1' as const,
    assignee: opts.unassigned ? '' : 'coder',
    status: opts.itemStatus ?? 'planned',
  }));
  const sprint: SprintFile = {
    sprintId: `seed-${opts.version}`,
    version: opts.version,
    title: `Test sprint v${opts.version}`,
    createdAt: '2026-04-06T00:00:00.000Z',
    phase: opts.phase,
    items,
    budget: 100,
    teamSize: 2,
    successCriteria: ['ships'],
    auditFindings: [],
    agentsInvolved: [],
    budgetUsed: 0,
    phaseResults: [],
  };
  const file = join(root, '.agentforge/sprints', `v${opts.version}.json`);
  writeFileSync(file, JSON.stringify(sprint, null, 2), 'utf-8');
}

function makeCtx(
  bus: EventBus,
  projectRoot: string,
  version: string,
  cycleId: string | undefined = 'cycle-test',
): PhaseContext {
  return {
    sprintId: `seed-${version}`,
    sprintVersion: version,
    projectRoot,
    agentforgeDir: join(projectRoot, '.agentforge'),
    bus,
    ...(cycleId !== undefined ? { cycleId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('phase-handlers event publishing contract (Task 16)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTmpRoot();
  });

  afterEach(() => {
    if (tmpRoot && existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Plan-required scenarios (1, 2, 3, 4)
  // -------------------------------------------------------------------------

  describe('plan-required scenarios', () => {
    it('runAuditPhase publishes sprint.phase.started + sprint.phase.completed', async () => {
      const { bus, published } = makeMockBus();
      seedSprint(tmpRoot, { version: '6.4.audit1', phase: 'audit' });

      const ctx = makeCtx(bus, tmpRoot, '6.4.audit1');
      await runAuditPhase(ctx);

      const topics = published.map((e) => e.topic);
      expect(topics).toContain('sprint.phase.started');
      expect(topics).toContain('sprint.phase.completed');
    });

    it('events include sprintId, cycleId, and phase in payload', async () => {
      const { bus, published } = makeMockBus();
      seedSprint(tmpRoot, { version: '6.4.audit2', phase: 'audit' });

      const ctx = makeCtx(bus, tmpRoot, '6.4.audit2', 'cycle-abc-123');
      await runAuditPhase(ctx);

      const started = published.find((e) => e.topic === 'sprint.phase.started');
      expect(started).toBeDefined();
      const startedPayload = started!.payload as Record<string, unknown>;
      expect(startedPayload.sprintId).toBe('seed-6.4.audit2');
      expect(startedPayload.cycleId).toBe('cycle-abc-123');
      expect(startedPayload.phase).toBe('audit');
      expect(startedPayload.sprintVersion).toBe('6.4.audit2');

      const completed = published.find((e) => e.topic === 'sprint.phase.completed');
      expect(completed).toBeDefined();
      const completedPayload = completed!.payload as Record<string, unknown>;
      expect(completedPayload.sprintId).toBe('seed-6.4.audit2');
      expect(completedPayload.cycleId).toBe('cycle-abc-123');
      expect(completedPayload.phase).toBe('audit');
    });

    it('every phase in PHASE_SEQUENCE has a corresponding entry in PHASE_HANDLERS', () => {
      for (const phase of PHASE_SEQUENCE) {
        expect(PHASE_HANDLERS[phase]).toBeDefined();
        expect(typeof PHASE_HANDLERS[phase]).toBe('function');
      }
    });

    it('PHASE_SEQUENCE has the exact 9-phase order required by the autonomous loop', () => {
      expect(PHASE_SEQUENCE).toEqual([
        'audit',
        'plan',
        'assign',
        'execute',
        'test',
        'review',
        'gate',
        'release',
        'learn',
      ]);
      expect(PHASE_SEQUENCE.length).toBe(9);
    });
  });

  // -------------------------------------------------------------------------
  // Per-phase coverage — every PHASE_HANDLERS entry publishes started+completed
  //
  // For LLM-driven phases (audit/plan/test/review/gate) the mocked
  // AgentRuntime returns a "completed" RunResult instantly so the handlers
  // walk the success path. For non-LLM phases (assign/execute/release/learn)
  // the handlers walk their own success path off seeded sprint data.
  // -------------------------------------------------------------------------

  describe('per-phase contract coverage (all 9 PHASE_HANDLERS)', () => {
    interface PhaseSpec {
      phase: PhaseName;
      handler: (ctx: PhaseContext) => Promise<unknown>;
      seedPhase: string;
    }

    const phaseSpecs: PhaseSpec[] = [
      { phase: 'audit', handler: runAuditPhase, seedPhase: 'audit' },
      { phase: 'plan', handler: runPlanPhase, seedPhase: 'plan' },
      { phase: 'assign', handler: runAssignPhase, seedPhase: 'assign' },
      { phase: 'execute', handler: runExecutePhase, seedPhase: 'execute' },
      { phase: 'test', handler: runTestPhase, seedPhase: 'test' },
      { phase: 'review', handler: runReviewPhase, seedPhase: 'review' },
      { phase: 'gate', handler: runGatePhase, seedPhase: 'gate' },
      { phase: 'release', handler: runReleasePhase, seedPhase: 'release' },
      { phase: 'learn', handler: runLearnPhase, seedPhase: 'learn' },
    ];

    for (const spec of phaseSpecs) {
      it(`run${spec.phase[0]!.toUpperCase()}${spec.phase.slice(1)}Phase publishes started + completed`, async () => {
        const { bus, published } = makeMockBus();
        const version = `6.4.${spec.phase}.cov`;
        seedSprint(tmpRoot, { version, phase: spec.seedPhase });

        const ctx = makeCtx(bus, tmpRoot, version, `cycle-${spec.phase}`);
        await spec.handler(ctx);

        const startedEvents = published.filter((e) => e.topic === 'sprint.phase.started');
        expect(startedEvents.length).toBeGreaterThanOrEqual(1);

        // sprint.phase.started must be the FIRST event published (handler entry).
        expect(published[0]!.topic).toBe('sprint.phase.started');

        const startedPayload = startedEvents[0]!.payload as Record<string, unknown>;
        expect(startedPayload.phase).toBe(spec.phase);
        expect(startedPayload.sprintVersion).toBe(version);
        expect(startedPayload.sprintId).toBe(`seed-${version}`);
        expect(startedPayload.cycleId).toBe(`cycle-${spec.phase}`);
        expect(typeof startedPayload.startedAt).toBe('string');

        const completedEvents = published.filter(
          (e) => e.topic === 'sprint.phase.completed',
        );
        expect(completedEvents.length).toBeGreaterThanOrEqual(1);

        const completedPayload = completedEvents[0]!.payload as Record<string, unknown>;
        expect(completedPayload.phase).toBe(spec.phase);
        expect(completedPayload.sprintVersion).toBe(version);
        expect(completedPayload.sprintId).toBe(`seed-${version}`);
        expect(completedPayload.cycleId).toBe(`cycle-${spec.phase}`);
        expect(typeof completedPayload.completedAt).toBe('string');
        expect(completedPayload.result).toBeDefined();
      });
    }

    it('PHASE_HANDLERS entries match the exported phase functions', () => {
      expect(PHASE_HANDLERS.audit).toBe(runAuditPhase);
      expect(PHASE_HANDLERS.plan).toBe(runPlanPhase);
      expect(PHASE_HANDLERS.assign).toBe(runAssignPhase);
      expect(PHASE_HANDLERS.execute).toBe(runExecutePhase);
      expect(PHASE_HANDLERS.test).toBe(runTestPhase);
      expect(PHASE_HANDLERS.review).toBe(runReviewPhase);
      expect(PHASE_HANDLERS.gate).toBe(runGatePhase);
      expect(PHASE_HANDLERS.release).toBe(runReleasePhase);
      expect(PHASE_HANDLERS.learn).toBe(runLearnPhase);
    });
  });

  // -------------------------------------------------------------------------
  // Failure path — sprint missing on disk
  //
  // The handlers MUST publish sprint.phase.started before they touch the
  // disk, then publish sprint.phase.failed when readSprint() returns null,
  // then rethrow. This is the contract the PhaseScheduler relies on to
  // observe both lifecycle edges of a failed phase.
  // -------------------------------------------------------------------------

  describe('failure path (missing sprint file)', () => {
    it('publishes started + failed when sprint file is missing (audit phase)', async () => {
      const { bus, published } = makeMockBus();
      const ctx = makeCtx(bus, tmpRoot, '6.4.missing', 'cycle-fail');

      await expect(runAuditPhase(ctx)).rejects.toThrow(/not found/);

      const topics = published.map((e) => e.topic);
      expect(topics).toContain('sprint.phase.started');
      expect(topics).toContain('sprint.phase.failed');

      // started must precede failed in publish order
      const startedIdx = topics.indexOf('sprint.phase.started');
      const failedIdx = topics.indexOf('sprint.phase.failed');
      expect(startedIdx).toBeLessThan(failedIdx);

      const failed = published.find((e) => e.topic === 'sprint.phase.failed');
      const failedPayload = failed!.payload as Record<string, unknown>;
      expect(failedPayload.phase).toBe('audit');
      expect(failedPayload.sprintVersion).toBe('6.4.missing');
      expect(failedPayload.cycleId).toBe('cycle-fail');
      expect(typeof failedPayload.error).toBe('string');
      expect(typeof failedPayload.failedAt).toBe('string');
    });

    it('publishes started + failed when sprint file is missing (assign phase, non-LLM)', async () => {
      const { bus, published } = makeMockBus();
      const ctx = makeCtx(bus, tmpRoot, '6.4.missing2', 'cycle-fail2');

      await expect(runAssignPhase(ctx)).rejects.toThrow(/not found/);

      const topics = published.map((e) => e.topic);
      expect(topics).toContain('sprint.phase.started');
      expect(topics).toContain('sprint.phase.failed');
    });
  });
});
