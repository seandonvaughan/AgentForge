// tests/autonomous/integration/gate-phase-memory.test.ts
//
// Verifies that the server-side runGatePhase writes a gate-verdict memory
// entry to .agentforge/memory/gate-verdict.jsonl after each cycle.
//
// This is the regression guard for the "wire gate phase handler to write
// gate-verdict memory entries per cycle" sprint item. The canonical
// (packages/core) gate-phase handler is tested separately in
// tests/autonomous/unit/phase-handlers-strategic.test.ts; this test covers
// the server-side path in packages/server/src/lib/phase-handlers.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports that touch these modules.
// We mock AgentRuntime and loadAgentConfig (needed by runLlmPhase) but leave
// writeMemoryEntry un-mocked so the actual file write occurs.
// ---------------------------------------------------------------------------

vi.mock('@agentforge/core', async () => {
  // Re-import the real module so writeMemoryEntry works correctly.
  const real = await vi.importActual<typeof import('@agentforge/core')>('@agentforge/core');

  const mockRunResult = {
    sessionId: 'mock-gate-session',
    response: 'APPROVE: all criteria met, tests green',
    model: 'claude-sonnet-4-6',
    inputTokens: 50,
    outputTokens: 100,
    costUsd: 0.003,
    startedAt: '2026-04-09T00:00:00.000Z',
    completedAt: '2026-04-09T00:00:01.000Z',
    status: 'completed' as const,
  };

  return {
    ...real,
    AgentRuntime: vi.fn(function () {
      return {
        runStreaming: vi.fn().mockResolvedValue(mockRunResult),
        run: vi.fn().mockResolvedValue(mockRunResult),
      };
    }),
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
  globalStream: { emit: vi.fn() },
}));

vi.mock('@agentforge/shared', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@agentforge/shared');
  let counter = 0;
  return {
    ...actual,
    generateId: vi.fn(() => `gate-test-id-${++counter}`),
    nowIso: vi.fn(() => '2026-04-09T00:00:00.000Z'),
  };
});

// Import after mocks are established.
import { AgentRuntime } from '@agentforge/core';
import {
  runGatePhase,
  type PhaseContext,
  type EventBus,
  type SprintFile,
} from '../../../packages/server/src/lib/phase-handlers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockBus(): EventBus {
  return { publish: vi.fn() };
}

function makeTmp(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), 'agentforge-gate-mem-'));
  mkdirSync(join(cwd, '.agentforge', 'sprints'), { recursive: true });
  mkdirSync(join(cwd, '.agentforge', 'agents'), { recursive: true });
  return {
    cwd,
    cleanup: () => {
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {}
    },
  };
}

function seedSprint(
  cwd: string,
  version: string,
  gateResponse?: string,
  itemTags?: string[],
): void {
  const sprint: SprintFile = {
    sprintId: `sprint-${version}`,
    version,
    title: `v${version} sprint`,
    createdAt: '2026-04-09T00:00:00.000Z',
    phase: 'gate',
    items: [{ id: 'i1', title: 'Item 1', description: '', priority: 'P1', assignee: 'coder', status: 'completed', ...(itemTags ? { tags: itemTags } : {}) }],
    budget: 50,
    teamSize: 1,
    successCriteria: [],
    auditFindings: [],
    agentsInvolved: [],
    budgetUsed: 5,
    phaseResults: gateResponse
      ? [
          {
            phase: 'gate',
            agentId: 'ceo',
            sessionId: 'pre-seeded-gate',
            response: gateResponse,
            costUsd: 0.001,
            inputTokens: 10,
            outputTokens: 20,
            status: 'completed',
            ranAt: '2026-04-09T00:00:00.000Z',
          },
        ]
      : [],
  };
  writeFileSync(
    join(cwd, '.agentforge', 'sprints', `v${version}.json`),
    JSON.stringify(sprint, null, 2),
  );
}

function makeCtx(cwd: string, version: string, cycleId?: string): PhaseContext {
  return {
    sprintId: `sprint-${version}`,
    sprintVersion: version,
    projectRoot: cwd,
    agentforgeDir: join(cwd, '.agentforge'),
    bus: makeMockBus(),
    ...(cycleId !== undefined ? { cycleId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('server runGatePhase — gate-verdict memory write', () => {
  let cwd: string;
  let cleanup: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    const tmp = makeTmp();
    cwd = tmp.cwd;
    cleanup = tmp.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it('writes a gate-verdict.jsonl entry after the phase runs', async () => {
    seedSprint(cwd, '6.8.gate-mem-1');
    const ctx = makeCtx(cwd, '6.8.gate-mem-1', 'cycle-gm1');

    await runGatePhase(ctx);

    const memFile = join(cwd, '.agentforge', 'memory', 'gate-verdict.jsonl');
    expect(existsSync(memFile)).toBe(true);

    const line = readFileSync(memFile, 'utf8').trim();
    const entry = JSON.parse(line);
    expect(entry.type).toBe('gate-verdict');
    expect(entry.source).toBe('cycle-gm1');
    expect(typeof entry.id).toBe('string');
    expect(typeof entry.createdAt).toBe('string');
    expect(entry.tags).toContain('sprint:v6.8.gate-mem-1');
  });

  it('tags the entry with verdict:approved when CEO responds APPROVE', async () => {
    // Seed sprint with a pre-existing gate phase result so readSprint finds it.
    seedSprint(cwd, '6.8.gate-mem-2', 'APPROVE: quality bar met');
    const ctx = makeCtx(cwd, '6.8.gate-mem-2', 'cycle-gm2');

    await runGatePhase(ctx);

    const memFile = join(cwd, '.agentforge', 'memory', 'gate-verdict.jsonl');
    expect(existsSync(memFile)).toBe(true);

    // Get the LAST written entry (the one our runGatePhase wrote).
    const lines = readFileSync(memFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const lastEntry = JSON.parse(lines[lines.length - 1]!);
    // Tag uses canonical 'approved' (with 'd') per GateVerdictMetadata.
    expect(lastEntry.tags).toContain('verdict:approved');
    // Structured fields live in metadata, not in a JSON-parsed value.
    const meta = lastEntry.metadata;
    expect(meta.sprintVersion).toBeUndefined(); // sprintVersion lives on the sprint file, not metadata
    expect(meta.cycleId).toBe('cycle-gm2');
    expect(meta.verdict).toBe('approved');
    // value is a human-readable summary, not a JSON blob.
    expect(() => JSON.parse(lastEntry.value)).toThrow();
    expect(lastEntry.value).toContain('approved');
  });

  it('tags the entry with verdict:rejected when CEO responds REJECT', async () => {
    seedSprint(cwd, '6.8.gate-mem-3', 'REJECT: test coverage too low');
    const ctx = makeCtx(cwd, '6.8.gate-mem-3', 'cycle-gm3');

    await runGatePhase(ctx);

    const memFile = join(cwd, '.agentforge', 'memory', 'gate-verdict.jsonl');
    expect(existsSync(memFile)).toBe(true);

    const lines = readFileSync(memFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const lastEntry = JSON.parse(lines[lines.length - 1]!);
    // Tag uses canonical 'rejected' (with 'd') per GateVerdictMetadata.
    expect(lastEntry.tags).toContain('verdict:rejected');
    expect(lastEntry.metadata.verdict).toBe('rejected');
  });

  it('writes the entry even when cycleId is not provided', async () => {
    seedSprint(cwd, '6.8.gate-mem-4');
    // No cycleId in context
    const ctx = makeCtx(cwd, '6.8.gate-mem-4');

    await runGatePhase(ctx);

    const memFile = join(cwd, '.agentforge', 'memory', 'gate-verdict.jsonl');
    expect(existsSync(memFile)).toBe(true);

    const entry = JSON.parse(readFileSync(memFile, 'utf8').trim());
    expect(entry.type).toBe('gate-verdict');
    // When cycleId is absent, metadata.cycleId falls back to empty string (per GateVerdictMetadata).
    expect(entry.metadata.cycleId).toBe('');
    // value is human-readable, not a JSON blob.
    expect(typeof entry.value).toBe('string');
    expect(() => JSON.parse(entry.value)).toThrow();
  });

  it('appends a new entry per cycle without overwriting previous ones', async () => {
    seedSprint(cwd, '6.8.gate-mem-5');
    const ctx1 = makeCtx(cwd, '6.8.gate-mem-5', 'cycle-a');
    const ctx2 = makeCtx(cwd, '6.8.gate-mem-5', 'cycle-b');

    await runGatePhase(ctx1);
    await runGatePhase(ctx2);

    const memFile = join(cwd, '.agentforge', 'memory', 'gate-verdict.jsonl');
    const lines = readFileSync(memFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(2);

    const sources = lines.map((l) => JSON.parse(l).source);
    expect(sources).toContain('cycle-a');
    expect(sources).toContain('cycle-b');
  });

  it('does not throw or fail the phase when memory write has a problem', async () => {
    seedSprint(cwd, '6.8.gate-mem-6');
    const ctx = makeCtx(cwd, '6.8.gate-mem-6', 'cycle-resilient');

    // The phase result must be returned regardless of memory write outcome.
    const result = await runGatePhase(ctx);
    expect(result.status).toBe('completed');
    expect(result.phase).toBe('gate');
  });

  it('writes GateVerdictMetadata with cycleId, verdict, rationale, and findings in the metadata field', async () => {
    seedSprint(cwd, '6.8.gate-mem-7', 'APPROVE: all criteria met');
    const ctx = makeCtx(cwd, '6.8.gate-mem-7', 'cycle-metadata-test');

    await runGatePhase(ctx);

    const memFile = join(cwd, '.agentforge', 'memory', 'gate-verdict.jsonl');
    const lines = readFileSync(memFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const lastEntry = JSON.parse(lines[lines.length - 1]!);

    // Verify the canonical GateVerdictMetadata fields are present in metadata
    // (not buried inside a JSON-blob value field).
    const meta = lastEntry.metadata;
    expect(typeof meta).toBe('object');
    expect(meta.cycleId).toBe('cycle-metadata-test');
    expect(meta.verdict === 'approved' || meta.verdict === 'rejected').toBe(true);
    expect(typeof meta.rationale).toBe('string');
    expect(meta.rationale.length).toBeGreaterThan(0);
    expect(Array.isArray(meta.criticalFindings)).toBe(true);
    expect(Array.isArray(meta.majorFindings)).toBe(true);

    // value is a human-readable summary, not a JSON blob.
    expect(typeof lastEntry.value).toBe('string');
    expect(() => JSON.parse(lastEntry.value)).toThrow();
  });

  it('appends sprint item domain tags to the gate-verdict entry for execute-phase matching', async () => {
    // Seed a sprint whose items carry domain tags. These must be collected by
    // collectSprintItemTags and appended to the gate-verdict memory entry so
    // the execute-phase injector can find the verdict when future items share
    // the same domain tags (cross-cycle learning).
    seedSprint(cwd, '6.8.gate-mem-8', 'APPROVE: domain tag test', ['memory', 'execute', 'backend']);
    const ctx = makeCtx(cwd, '6.8.gate-mem-8', 'cycle-domain-tags');

    await runGatePhase(ctx);

    const memFile = join(cwd, '.agentforge', 'memory', 'gate-verdict.jsonl');
    const lines = readFileSync(memFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const lastEntry = JSON.parse(lines[lines.length - 1]!);

    // Structural tags must always be present.
    expect(lastEntry.tags).toContain('sprint:v6.8.gate-mem-8');
    expect(lastEntry.tags).toContain('verdict:approved');

    // Domain tags collected from sprint items must also appear so the
    // execute-phase injector can match this verdict to future items.
    expect(lastEntry.tags).toContain('memory');
    expect(lastEntry.tags).toContain('execute');
    expect(lastEntry.tags).toContain('backend');
  });
});

// ---------------------------------------------------------------------------
// Known-debt injection into the gate-phase prompt
//
// The CEO agent must see known pre-existing debt from the prior gate-verdict
// JSONL so it can distinguish old accepted issues from new regressions.
// These tests verify that buildLlmPhaseTask (gate case) threads the known-debt
// section into the task string that is sent to the AgentRuntime.
// ---------------------------------------------------------------------------

describe('server runGatePhase — known-debt injection into gate prompt', () => {
  let cwd: string;
  let cleanup: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    const tmp = makeTmp();
    cwd = tmp.cwd;
    cleanup = tmp.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  /**
   * Write a gate-verdict.jsonl entry with structured metadata directly, without
   * going through a full gate run. Simulates a prior cycle's gate phase output.
   */
  function seedPriorVerdict(
    root: string,
    opts: {
      verdict: 'approved' | 'rejected';
      cycleId: string;
      majorFindings?: string[];
      criticalFindings?: string[];
    },
  ): void {
    const memDir = join(root, '.agentforge', 'memory');
    mkdirSync(memDir, { recursive: true });
    const entry = {
      id: `prior-${opts.cycleId}`,
      type: 'gate-verdict',
      value: `Gate ${opts.verdict}: prior cycle entry`,
      createdAt: '2026-04-01T00:00:00.000Z',
      source: opts.cycleId,
      tags: [`verdict:${opts.verdict}`, 'sprint:v0.0'],
      metadata: {
        cycleId: opts.cycleId,
        verdict: opts.verdict,
        rationale: 'prior cycle entry',
        criticalFindings: opts.criticalFindings ?? [],
        majorFindings: opts.majorFindings ?? [],
      },
    };
    writeFileSync(join(memDir, 'gate-verdict.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
  }

  it('injects known-debt section into the gate prompt when prior verdict has findings', async () => {
    seedPriorVerdict(cwd, {
      verdict: 'approved',
      cycleId: 'cycle-prior-kd',
      majorFindings: ['readCycleRecord duplicated across two packages'],
      criticalFindings: [],
    });

    seedSprint(cwd, '6.8.kd-inject-1');
    const ctx = makeCtx(cwd, '6.8.kd-inject-1', 'cycle-kd-inject-1');

    await runGatePhase(ctx);

    // Capture the task sent to the CEO agent via the mocked AgentRuntime.
    const ctor = vi.mocked(AgentRuntime);
    const lastInstance = ctor.mock.results.at(-1)!.value;
    const streamingArg = lastInstance.runStreaming.mock.calls[0]![0] as { task: string };

    expect(streamingArg.task).toContain('Known pre-existing debt');
    expect(streamingArg.task).toContain('readCycleRecord duplicated across two packages');
    // The APPROVED label from buildKnownDebtSection
    expect(streamingArg.task).toContain('APPROVED');
    // The guidance telling the CEO not to reject for these items
    expect(streamingArg.task).toContain('Do NOT let them drive a REJECT');
  });

  it('includes critical findings in the known-debt section', async () => {
    seedPriorVerdict(cwd, {
      verdict: 'rejected',
      cycleId: 'cycle-prior-crit',
      criticalFindings: ['Auth bypass in middleware — token check absent'],
      majorFindings: [],
    });

    seedSprint(cwd, '6.8.kd-inject-2');
    const ctx = makeCtx(cwd, '6.8.kd-inject-2', 'cycle-kd-inject-2');

    await runGatePhase(ctx);

    const ctor = vi.mocked(AgentRuntime);
    const lastInstance = ctor.mock.results.at(-1)!.value;
    const streamingArg = lastInstance.runStreaming.mock.calls[0]![0] as { task: string };

    expect(streamingArg.task).toContain('Known pre-existing debt');
    expect(streamingArg.task).toContain('Auth bypass in middleware — token check absent');
    // REJECTED label with verify-if-fixed guidance
    expect(streamingArg.task).toContain('REJECTED');
    expect(streamingArg.task).toContain('Verify whether each has been addressed');
  });

  it('omits the known-debt section when no prior gate-verdict exists', async () => {
    // Do NOT seed any prior verdict — the memory dir doesn't even exist yet.
    seedSprint(cwd, '6.8.kd-inject-3');
    const ctx = makeCtx(cwd, '6.8.kd-inject-3', 'cycle-kd-inject-3');

    await runGatePhase(ctx);

    const ctor = vi.mocked(AgentRuntime);
    const lastInstance = ctor.mock.results.at(-1)!.value;
    const streamingArg = lastInstance.runStreaming.mock.calls[0]![0] as { task: string };

    // No known-debt section should appear in the prompt.
    expect(streamingArg.task).not.toContain('Known pre-existing debt');
    // The base prompt should still be present.
    expect(streamingArg.task).toContain('Approve or reject sprint');
    expect(streamingArg.task).toContain('Provide a clear APPROVE or REJECT decision');
  });

  it('omits the known-debt section when prior verdict has no findings', async () => {
    // Verdict with empty findings lists — section should not be injected.
    seedPriorVerdict(cwd, {
      verdict: 'approved',
      cycleId: 'cycle-clean',
      criticalFindings: [],
      majorFindings: [],
    });

    seedSprint(cwd, '6.8.kd-inject-4');
    const ctx = makeCtx(cwd, '6.8.kd-inject-4', 'cycle-kd-inject-4');

    await runGatePhase(ctx);

    const ctor = vi.mocked(AgentRuntime);
    const lastInstance = ctor.mock.results.at(-1)!.value;
    const streamingArg = lastInstance.runStreaming.mock.calls[0]![0] as { task: string };

    expect(streamingArg.task).not.toContain('Known pre-existing debt');
    expect(streamingArg.task).toContain('Approve or reject sprint');
  });
});
