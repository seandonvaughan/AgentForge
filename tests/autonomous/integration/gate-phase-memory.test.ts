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
): void {
  const sprint: SprintFile = {
    sprintId: `sprint-${version}`,
    version,
    title: `v${version} sprint`,
    createdAt: '2026-04-09T00:00:00.000Z',
    phase: 'gate',
    items: [{ id: 'i1', title: 'Item 1', description: '', priority: 'P1', assignee: 'coder', status: 'completed' }],
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
});
