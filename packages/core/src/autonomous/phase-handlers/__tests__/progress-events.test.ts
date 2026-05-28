/**
 * Unit tests for the new per-step bus events added in the progress-events feature.
 *
 * Each phase test verifies that the relevant event fires with the expected
 * topic — the bus is mocked so no real agents or file I/O is needed.
 *
 * Tests:
 *  - execute-phase: sprint.phase.item.started fires before runtime.run
 *  - execute-phase: execute.parallelism.assessed fires after assessLoad
 *  - execute-phase: execute.snapshot fires after each snapshotExecuteProgress
 *  - execute-phase: execute.circuit-breaker.tripped fires when circuit breaks
 *  - audit-phase:   audit.memory.injected fires after readRecentMemoryEntries
 *  - gate-phase:    gate.verification.progress fires before the CEO agent run
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PhaseContext } from '../../phase-scheduler.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-progress-events-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeBus() {
  const events: Array<{ topic: string; payload: unknown }> = [];
  const bus = {
    publish: (topic: string, payload: unknown) => {
      events.push({ topic, payload });
    },
    subscribe: (_topic: string, _cb: (e: unknown) => void) => () => {},
    events,
  };
  return bus;
}

function makeCtx(bus: ReturnType<typeof makeBus>, overrides: Partial<PhaseContext> = {}): PhaseContext {
  return {
    projectRoot: tmpRoot,
    sprintId: 'sprint-test-1',
    sprintVersion: '1.0.0',
    cycleId: 'cycle-test-1',
    adapter: undefined as any,
    bus,
    runtime: {
      run: vi.fn().mockResolvedValue({
        output: 'mock agent output',
        costUsd: 0.01,
        status: 'completed',
      }),
    },
    ...overrides,
  } as PhaseContext;
}

// Write a minimal plan/sprint JSON so execute-phase can read it.
// When cycleId is set, execute-phase reads from cycles/{cycleId}/plan.json.
// Write both locations so tests pass regardless of ctx.cycleId presence.
function writeSprintFile(
  items: Array<{ id: string; title: string; assignee: string; status?: string; description?: string; files?: string[] }> = [],
  cycleId = 'cycle-test-1',
) {
  const data = {
    version: '1.0.0',
    sprintId: 'sprint-test-1',
    items: items.map((i) => ({
      id: i.id,
      title: i.title,
      assignee: i.assignee,
      status: i.status ?? 'planned',
      description: i.description ?? `Description for ${i.title}`,
      ...(i.files !== undefined ? { files: i.files } : {}),
    })),
  };

  // Legacy path (no cycleId)
  const sprintsDir = join(tmpRoot, '.agentforge', 'sprints');
  mkdirSync(sprintsDir, { recursive: true });
  writeFileSync(join(sprintsDir, 'v1.0.0.json'), JSON.stringify(data));

  // New path (with cycleId) — cycles/{cycleId}/plan.json
  const cycleDir = join(tmpRoot, '.agentforge', 'cycles', cycleId);
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(join(cycleDir, 'plan.json'), JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// execute-phase: sprint.phase.item.started
// ---------------------------------------------------------------------------

describe('execute-phase progress events', () => {
  it('emits sprint.phase.item.started before dispatching each item to the runtime', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Add feature X', assignee: 'backend-dev' },
    ]);

    const bus = makeBus();
    const ctx = makeCtx(bus);

    const { runExecutePhase } = await import('../execute-phase.js');
    await runExecutePhase(ctx);

    const startedEvents = bus.events.filter((e) => e.topic === 'sprint.phase.item.started');
    expect(startedEvents).toHaveLength(1);
    const payload = startedEvents[0]!.payload as any;
    expect(payload.itemId).toBe('item-1');
    expect(payload.agentId).toBe('backend-dev');
    expect(payload.title).toBe('Add feature X');
    expect(payload.attempt).toBe(1);
  });

  it('emits execute.parallelism.assessed after load assessment', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Task A', assignee: 'agent-1' },
      { id: 'item-2', title: 'Task B', assignee: 'agent-2' },
    ]);

    const bus = makeBus();
    const ctx = makeCtx(bus);

    const { runExecutePhase } = await import('../execute-phase.js');
    await runExecutePhase(ctx);

    const assessed = bus.events.filter((e) => e.topic === 'execute.parallelism.assessed');
    expect(assessed).toHaveLength(1);
    const payload = assessed[0]!.payload as any;
    expect(payload.itemCount).toBe(2);
    expect(typeof payload.parallelism).toBe('number');
    expect(typeof payload.ceiling).toBe('number');
    expect(typeof payload.rationale).toBe('string');
  });

  it('emits execute.snapshot after each item completes', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Task A', assignee: 'agent-1' },
    ]);

    const bus = makeBus();
    const ctx = makeCtx(bus, {
      // cycleId required so snapshotExecuteProgress actually runs
      cycleId: 'cycle-test-1',
    });

    const { runExecutePhase } = await import('../execute-phase.js');
    await runExecutePhase(ctx);

    const snapshots = bus.events.filter((e) => e.topic === 'execute.snapshot');
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    const payload = snapshots[0]!.payload as any;
    expect(typeof payload.completedItems).toBe('number');
    expect(typeof payload.failedItems).toBe('number');
    expect(typeof payload.totalItems).toBe('number');
    expect(typeof payload.costUsd).toBe('number');
  });

  it('emits execute.circuit-breaker.tripped when consecutive rate-limit failures exceed threshold', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Task A', assignee: 'agent-1' },
      { id: 'item-2', title: 'Task B', assignee: 'agent-2' },
      { id: 'item-3', title: 'Task C', assignee: 'agent-3' },
      { id: 'item-4', title: 'Task D', assignee: 'agent-4' },
    ]);

    const bus = makeBus();
    // Runtime always throws with a rate-limit-like error
    const rateLimitError = new Error('rate limit exceeded: 429 Too Many Requests');
    const ctx = makeCtx(bus, {
      runtime: {
        run: vi.fn().mockRejectedValue(rateLimitError),
      } as any,
    });

    const { runExecutePhase } = await import('../execute-phase.js');
    // maxItemRetries defaults to 1, so each item gets 2 attempts — 4 items * 2 = 8 rate-limit failures
    await runExecutePhase(ctx, { maxParallelism: 4, maxItemRetries: 0 });

    const tripped = bus.events.filter((e) => e.topic === 'execute.circuit-breaker.tripped');
    // At least one circuit breaker trip should have fired
    expect(tripped.length).toBeGreaterThanOrEqual(1);
    const payload = tripped[0]!.payload as any;
    expect(typeof payload.reason).toBe('string');
    expect(typeof payload.parallelism).toBe('number');
    expect(Array.isArray(payload.failedItems)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// audit-phase: audit.memory.injected
// ---------------------------------------------------------------------------

describe('audit-phase progress events', () => {
  it('emits audit.memory.injected with count and types after reading memory entries', async () => {
    // Write a memory file so the audit phase actually finds entries
    const memDir = join(tmpRoot, '.agentforge', 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      join(memDir, 'gate-verdict.jsonl'),
      JSON.stringify({
        id: 'gv-1',
        type: 'gate-verdict',
        value: 'Gate approved: all tests pass',
        createdAt: new Date().toISOString(),
        tags: ['sprint:v1.0.0'],
      }) + '\n',
    );

    const bus = makeBus();
    const ctx = makeCtx(bus);

    const { runAuditPhase } = await import('../audit-phase.js');
    await runAuditPhase(ctx);

    const injected = bus.events.filter((e) => e.topic === 'audit.memory.injected');
    expect(injected).toHaveLength(1);
    const payload = injected[0]!.payload as any;
    expect(payload.count).toBe(1);
    expect(Array.isArray(payload.types)).toBe(true);
    expect(payload.types).toContain('gate-verdict');
  });

  it('emits audit.memory.injected with count=0 when no memory entries exist', async () => {
    const bus = makeBus();
    const ctx = makeCtx(bus);

    const { runAuditPhase } = await import('../audit-phase.js');
    await runAuditPhase(ctx);

    const injected = bus.events.filter((e) => e.topic === 'audit.memory.injected');
    expect(injected).toHaveLength(1);
    const payload = injected[0]!.payload as any;
    expect(payload.count).toBe(0);
    expect(payload.types).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// gate-phase: gate.verification.progress
// ---------------------------------------------------------------------------

describe('gate-phase progress events', () => {
  it('emits gate.verification.progress before invoking the CEO agent', async () => {
    // Write a sprint file so the gate phase can read items
    writeSprintFile([{ id: 'item-1', title: 'Task A', assignee: 'backend', status: 'completed' }]);

    // Write a review.json with findings in the cycle phases dir
    const phasesDir = join(tmpRoot, '.agentforge', 'cycles', 'cycle-test-1', 'phases');
    mkdirSync(phasesDir, { recursive: true });
    writeFileSync(
      join(phasesDir, 'review.json'),
      JSON.stringify({
        findings: 'CRITICAL: SQL injection in auth handler\nMAJOR: Missing error handling',
      }),
    );

    const bus = makeBus();
    const ctx = makeCtx(bus);

    // Mock runtime to return an APPROVE verdict so the gate doesn't throw
    (ctx.runtime.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      output: JSON.stringify({ verdict: 'APPROVE', rationale: 'All good' }),
      costUsd: 0.05,
      status: 'completed',
    });

    const { runGatePhase } = await import('../gate-phase.js');
    await runGatePhase(ctx);

    const progress = bus.events.filter((e) => e.topic === 'gate.verification.progress');
    expect(progress).toHaveLength(1);
    const payload = progress[0]!.payload as any;
    expect(typeof payload.findingsCount).toBe('number');
    expect(typeof payload.critical).toBe('number');
    expect(typeof payload.major).toBe('number');
    // The review.json has 1 CRITICAL and 1 MAJOR finding
    expect(payload.critical).toBe(1);
    expect(payload.major).toBe(1);
    expect(payload.findingsCount).toBe(2);
  });

  it('emits gate.verification.progress with zeros when no review findings exist', async () => {
    writeSprintFile([{ id: 'item-1', title: 'Task A', assignee: 'backend', status: 'completed' }]);

    const bus = makeBus();
    const ctx = makeCtx(bus);

    (ctx.runtime.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      output: JSON.stringify({ verdict: 'APPROVE', rationale: 'LGTM' }),
      costUsd: 0.02,
      status: 'completed',
    });

    const { runGatePhase } = await import('../gate-phase.js');
    await runGatePhase(ctx);

    const progress = bus.events.filter((e) => e.topic === 'gate.verification.progress');
    expect(progress).toHaveLength(1);
    const payload = progress[0]!.payload as any;
    expect(payload.critical).toBe(0);
    expect(payload.major).toBe(0);
    expect(payload.findingsCount).toBe(0);
  });

  it('labels test-phase output as QA strategy rather than executable test results', async () => {
    writeSprintFile([{
      id: 'item-1',
      title: 'Task A',
      assignee: 'backend',
      status: 'completed',
      description: 'Add sourceFile to both text and JSON backlog status output.',
      files: ['packages/cli/src/commands/backlog.ts'],
    }]);

    const phasesDir = join(tmpRoot, '.agentforge', 'cycles', 'cycle-test-1', 'phases');
    mkdirSync(phasesDir, { recursive: true });
    writeFileSync(
      join(phasesDir, 'test.json'),
      JSON.stringify({
        kind: 'qa-strategy',
        testsRun: false,
        status: 'completed',
        strategy: 'Tests were not run because this is a read-only QA strategy phase.',
      }),
    );

    const capturedTask = { value: '' };
    const bus = makeBus();
    const ctx = makeCtx(bus);

    (ctx.runtime.run as ReturnType<typeof vi.fn>).mockImplementation(
      async (_agentId: string, task: string) => {
        capturedTask.value = task;
        return {
          output: JSON.stringify({ verdict: 'APPROVE', rationale: 'No blocking findings' }),
          costUsd: 0.05,
          status: 'completed',
        };
      },
    );

    const { runGatePhase } = await import('../gate-phase.js');
    await runGatePhase(ctx);

    expect(capturedTask.value).toContain('## QA strategy report (not executable test results)');
    expect(capturedTask.value).toContain('Acceptance / backlog description: Add sourceFile to both text and JSON backlog status output.');
    expect(capturedTask.value).toContain('Declared files: packages/cli/src/commands/backlog.ts');
    expect(capturedTask.value).toContain('Enumerate every explicit requirement');
    expect(capturedTask.value).toContain('text + JSON');
    expect(capturedTask.value).toContain('missing explicit acceptance requirements are grounds for REJECT');
    expect(capturedTask.value).toContain('Do not treat the QA strategy report above as executable test evidence');
    expect(capturedTask.value).toContain('If the QA strategy says tests were not run, that is expected');
    expect(capturedTask.value).toContain('Do not use');
    expect(capturedTask.value).toContain('agentforge cycle list');
    expect(capturedTask.value).toContain('current cycle has not reached VERIFY yet');
    expect(capturedTask.value).toContain('MUST NOT independently drive a REJECT verdict for the');
    expect(capturedTask.value).not.toContain('## Test results');
  });

  it('writes knownDebt field to gate.json so operators can audit which findings were excluded', async () => {
    // Seed a prior gate-verdict JSONL entry directly so the knownDebt list is non-empty.
    const memDir = join(tmpRoot, '.agentforge', 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      join(memDir, 'gate-verdict.jsonl'),
      JSON.stringify({
        id: 'prior-debt-entry',
        type: 'gate-verdict',
        value: 'Gate approved: prior cycle',
        createdAt: '2026-01-01T00:00:00.000Z',
        source: 'prior-cycle',
        tags: ['verdict:approved'],
        metadata: {
          cycleId: 'prior-cycle',
          verdict: 'approved',
          rationale: 'prior cycle entry',
          criticalFindings: [],
          majorFindings: ['readCycleRecord duplicated across two packages'],
        },
      }) + '\n',
    );

    writeSprintFile([{ id: 'item-1', title: 'Task A', assignee: 'backend', status: 'completed' }]);

    const bus = makeBus();
    const ctx = makeCtx(bus);

    (ctx.runtime.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      output: JSON.stringify({ verdict: 'APPROVE', rationale: 'All good' }),
      costUsd: 0.05,
      status: 'completed',
    });

    const { runGatePhase } = await import('../gate-phase.js');
    await runGatePhase(ctx);

    // The gate.json must contain the knownDebt field so operators can audit
    // which pre-existing findings were excluded from REJECT grounds.
    const { readFileSync, existsSync } = await import('node:fs');
    const gateJsonPath = join(tmpRoot, '.agentforge', 'cycles', 'cycle-test-1', 'phases', 'gate.json');
    expect(existsSync(gateJsonPath)).toBe(true);

    const gateJson = JSON.parse(readFileSync(gateJsonPath, 'utf8'));
    expect(Array.isArray(gateJson.knownDebt)).toBe(true);
    expect(gateJson.knownDebt).toContain('readCycleRecord duplicated across two packages');
  });

  it('writes an empty knownDebt array to gate.json when no prior verdict exists', async () => {
    writeSprintFile([{ id: 'item-1', title: 'Task A', assignee: 'backend', status: 'completed' }]);

    const bus = makeBus();
    const ctx = makeCtx(bus);

    (ctx.runtime.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      output: JSON.stringify({ verdict: 'APPROVE', rationale: 'All good' }),
      costUsd: 0.05,
      status: 'completed',
    });

    const { runGatePhase } = await import('../gate-phase.js');
    await runGatePhase(ctx);

    const { readFileSync, existsSync } = await import('node:fs');
    const gateJsonPath = join(tmpRoot, '.agentforge', 'cycles', 'cycle-test-1', 'phases', 'gate.json');
    expect(existsSync(gateJsonPath)).toBe(true);

    const gateJson = JSON.parse(readFileSync(gateJsonPath, 'utf8'));
    // An empty list means the CEO evaluated all findings without any exclusions.
    expect(Array.isArray(gateJson.knownDebt)).toBe(true);
    expect(gateJson.knownDebt).toHaveLength(0);
  });

  it('includes the cross-reference step in the gate task when known debt is present', async () => {
    // Seed a prior gate-verdict JSONL entry so the knownDebt list is non-empty.
    const memDir = join(tmpRoot, '.agentforge', 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      join(memDir, 'gate-verdict.jsonl'),
      JSON.stringify({
        id: 'prior-crossref-entry',
        type: 'gate-verdict',
        value: 'Gate approved: prior',
        createdAt: '2026-01-01T00:00:00.000Z',
        source: 'prior-cycle',
        tags: ['verdict:approved'],
        metadata: {
          cycleId: 'prior-cycle',
          verdict: 'approved',
          rationale: 'prior',
          criticalFindings: [],
          majorFindings: ['CORS wildcard on /api/v5/memory/stream'],
        },
      }) + '\n',
    );

    writeSprintFile([{ id: 'item-1', title: 'Task A', assignee: 'backend', status: 'completed' }]);

    const capturedTask = { value: '' };
    const bus = makeBus();
    const ctx = makeCtx(bus);

    // Capture the task string passed to runtime.run
    (ctx.runtime.run as ReturnType<typeof vi.fn>).mockImplementation(
      async (_agentId: string, task: string) => {
        capturedTask.value = task;
        return {
          output: JSON.stringify({ verdict: 'APPROVE', rationale: 'All good' }),
          costUsd: 0.05,
          status: 'completed',
        };
      },
    );

    const { runGatePhase } = await import('../gate-phase.js');
    await runGatePhase(ctx);

    // The gate task must include the cross-reference step so the CEO's REJECT
    // criteria are explicitly scoped to sprint-introduced findings only.
    expect(capturedTask.value).toContain('Cross-check every finding against the "Known pre-existing debt"');
    expect(capturedTask.value).toContain('MUST NOT independently drive a REJECT');
    expect(capturedTask.value).toContain('CORS wildcard on /api/v5/memory/stream');
  });

  it('extracts reviewFindings from agentRuns[0].response when review.json uses PhaseResult format', async () => {
    // Regression test for the bug where gate-phase fell through to
    // JSON.stringify(reviewJson) when the file used the PhaseResult format
    // (agentRuns[0].response) instead of a top-level `review` or `findings`
    // field. The JSON.stringify fallback produced a giant serialised blob on one
    // line, and the |\\[MAJOR\\] regex alternative matched the whole line
    // (because [MAJOR] appears somewhere in the text), producing a garbage
    // "finding" that poisoned the knownDebt JSONL store.
    const reviewText = [
      '## Code Review — Sprint v1.0.0',
      '',
      '**CRITICAL: Double computeCycleHistory call in flywheel route**',
      'Calling computeCycleHistory twice per request with different limits.',
      '',
      '- [MAJOR] packages/server/src/routes/search.ts — TS2554 errors at 3 call sites',
      '',
      'Overall: 2/5 — block on CRITICAL',
    ].join('\n');

    // Write review.json in the PhaseResult format (what the cycle runner actually writes)
    const phasesDir = join(tmpRoot, '.agentforge', 'cycles', 'cycle-test-1', 'phases');
    mkdirSync(phasesDir, { recursive: true });
    writeFileSync(
      join(phasesDir, 'review.json'),
      JSON.stringify({
        phase: 'review',
        status: 'completed',
        durationMs: 12000,
        costUsd: 0.04,
        agentRuns: [
          {
            agentId: 'code-reviewer',
            costUsd: 0.04,
            durationMs: 12000,
            response: reviewText,
          },
        ],
      }),
    );

    writeSprintFile([{ id: 'item-1', title: 'Task A', assignee: 'backend', status: 'completed' }]);

    const capturedTask = { value: '' };
    const bus = makeBus();
    const ctx = makeCtx(bus);

    (ctx.runtime.run as ReturnType<typeof vi.fn>).mockImplementation(
      async (_agentId: string, task: string) => {
        capturedTask.value = task;
        return {
          output: JSON.stringify({ verdict: 'REJECT', rationale: 'CRITICAL bug found' }),
          costUsd: 0.05,
          status: 'completed',
        };
      },
    );

    const { runGatePhase } = await import('../gate-phase.js');
    await runGatePhase(ctx).catch(() => {});  // REJECT throws GateRejectedError

    // The gate task should contain the actual review text, not a JSON blob.
    // A JSON blob would start with '{"phase":' or '"agentRuns":'.
    expect(capturedTask.value).toContain('Double computeCycleHistory call');
    expect(capturedTask.value).toContain('TS2554 errors at 3 call sites');
    // Must NOT contain the raw JSON structure keys which indicate the fallback path fired.
    expect(capturedTask.value).not.toContain('"agentRuns"');
    expect(capturedTask.value).not.toContain('"agentId": "code-reviewer"');
  });

  it('gate-verdict JSONL findings are real finding lines when reviewFindings is properly extracted', async () => {
    // End-to-end: run a gate phase with a PhaseResult-format review.json and
    // verify that the findings written to gate-verdict.jsonl are real finding
    // lines (short, human-readable) — NOT the entire serialised JSON blob.
    const reviewText = [
      '## Code Review',
      '',
      'CRITICAL: YAML parser silently drops dash-list skill arrays',
      'MAJOR: computeCycleHistory called twice per /flywheel request',
      '',
      'Overall: 1/5',
    ].join('\n');

    const phasesDir = join(tmpRoot, '.agentforge', 'cycles', 'cycle-test-1', 'phases');
    mkdirSync(phasesDir, { recursive: true });
    writeFileSync(
      join(phasesDir, 'review.json'),
      JSON.stringify({
        phase: 'review',
        status: 'completed',
        durationMs: 8000,
        costUsd: 0.03,
        agentRuns: [{ agentId: 'code-reviewer', costUsd: 0.03, durationMs: 8000, response: reviewText }],
      }),
    );

    writeSprintFile([{ id: 'item-1', title: 'Task A', assignee: 'backend', status: 'completed' }]);

    const bus = makeBus();
    const ctx = makeCtx(bus);

    (ctx.runtime.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      output: JSON.stringify({ verdict: 'REJECT', rationale: 'CRITICAL finding present' }),
      costUsd: 0.05,
      status: 'completed',
    });

    const { runGatePhase } = await import('../gate-phase.js');
    const { readMemoryEntries } = await import('../../../memory/types.js');

    await runGatePhase(ctx).catch(() => {});  // REJECT throws GateRejectedError

    // The gate-verdict JSONL entry must have real finding lines (not JSON blobs).
    const entries = readMemoryEntries(tmpRoot, 'gate-verdict', 1);
    expect(entries).toHaveLength(1);

    const meta = entries[0]!.metadata as any;
    expect(meta.criticalFindings).toHaveLength(1);
    // The critical finding must be the actual finding line, not a JSON blob.
    const critFinding = meta.criticalFindings[0] as string;
    expect(critFinding).toContain('YAML parser silently drops dash-list skill arrays');
    // Must not contain JSON structure keys — proof it's not the JSON blob.
    expect(critFinding).not.toContain('"agentRuns"');
    expect(critFinding.length).toBeLessThan(300);

    expect(meta.majorFindings).toHaveLength(1);
    const majFinding = meta.majorFindings[0] as string;
    expect(majFinding).toContain('computeCycleHistory called twice');
    expect(majFinding).not.toContain('"agentRuns"');
  });

  it('does not publish phase.completed for a REJECT verdict', async () => {
    writeSprintFile([{ id: 'item-1', title: 'Task A', assignee: 'backend', status: 'completed' }]);

    const bus = makeBus();
    const ctx = makeCtx(bus);

    (ctx.runtime.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      output: JSON.stringify({ verdict: 'REJECT', rationale: 'release blocker remains' }),
      costUsd: 0.05,
      status: 'completed',
    });

    const { runGatePhase } = await import('../gate-phase.js');
    await runGatePhase(ctx).catch(() => {});

    expect(bus.events.some((e) => e.topic === 'sprint.phase.completed')).toBe(false);
    const gateJson = JSON.parse(
      (await import('node:fs')).readFileSync(
        join(tmpRoot, '.agentforge', 'cycles', 'cycle-test-1', 'phases', 'gate.json'),
        'utf8',
      ),
    );
    expect(gateJson.verdict).toBe('REJECT');
  });
});
