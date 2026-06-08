/**
 * phase-handlers-epic-gate.test.ts
 *
 * Colocated vitest suite for the epic-gate delegation path added to
 * `runGatePhase` in phase-handlers.ts.
 *
 * Assertions:
 *  1. When ctx.objective is set, runGatePhase takes the epic path:
 *     - phases/epic-review.json is written with mode:'epic-review'
 *     - An APPROVE response resolves to a completed PhaseResult
 *     - A REQUEST_CHANGES response throws GateRejectedError
 *  2. When ctx.objective is NOT set, the legacy signal-backlog gate path is
 *     taken (the existing runLlmPhase / CEO agent path) and epic-review.json
 *     is NOT written.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runGatePhase, type PhaseContext, createNoopBus, writeSprint, type SprintFile } from '../phase-handlers.js';
import { GateRejectedError } from '@agentforge/core';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

// Mock @agentforge/core so that AgentRuntime + loadAgentConfig don't hit disk.
// We intercept the runStreaming call to return a controlled CEO response.
const mockRunStreaming = vi.fn();

vi.mock('@agentforge/core', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@agentforge/core')>();
  // AgentRuntime must be mocked as a constructor (class). Arrow functions are
  // not constructors — use a plain function so `new AgentRuntime(...)` works.
  function MockAgentRuntime() {
    return { runStreaming: mockRunStreaming };
  }
  return {
    ...orig,
    loadAgentConfig: vi.fn().mockResolvedValue({
      id: 'ceo',
      workspaceId: 'default',
      model: 'claude-opus-4-5',
    }),
    AgentRuntime: MockAgentRuntime,
  };
});

// Mock globalStream so SSE emits don't fail in tests.
vi.mock('../../../routes/v5/stream.js', () => ({
  globalStream: { emit: vi.fn() },
}));

// Mock careerHook to prevent disk writes.
vi.mock('../career-hook.js', () => ({
  careerHook: { postTaskHook: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;
let cycleId: string;

function agentforgeDir(): string {
  return join(tmpRoot, '.agentforge');
}

function phasesDir(): string {
  return join(agentforgeDir(), 'cycles', cycleId, 'phases');
}

function makeSprint(): SprintFile {
  return {
    sprintId: 'sprint-test',
    version: '99.0',
    title: 'Test sprint',
    createdAt: new Date().toISOString(),
    phase: 'gate',
    items: [{ id: 'i1', title: 'Item 1', description: 'desc', priority: 'P1', assignee: 'ceo', status: 'completed' }],
    budget: 10,
    teamSize: 1,
    successCriteria: [],
    auditFindings: [],
  };
}

function makeCtx(overrides: Partial<PhaseContext> = {}): PhaseContext {
  return {
    sprintId: 'sprint-test',
    sprintVersion: '99.0',
    projectRoot: tmpRoot,
    agentforgeDir: agentforgeDir(),
    bus: createNoopBus(),
    cycleId,
    ...overrides,
  };
}

function mockCeoResponse(response: string): void {
  mockRunStreaming.mockResolvedValue({
    response,
    costUsd: 0.01,
    inputTokens: 100,
    outputTokens: 50,
    status: 'completed' as const,
    sessionId: 'test-session-ceo',
    error: undefined,
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-epic-gate-test-'));
  cycleId = 'cycle-test-abc';
  mkdirSync(agentforgeDir(), { recursive: true });
  mkdirSync(phasesDir(), { recursive: true });
  // Write a minimal sprint file so readSprint succeeds.
  writeSprint(tmpRoot, '99.0', makeSprint());
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Epic-gate path (ctx.objective set)
// ---------------------------------------------------------------------------

describe('runGatePhase — epic path (ctx.objective set)', () => {
  it('writes phases/epic-review.json with mode:epic-review on APPROVE', async () => {
    const approveResponse = JSON.stringify({
      verdict: 'APPROVE',
      rationale: 'All items look good.',
      faultedItems: [],
    });
    mockCeoResponse(approveResponse);

    const ctx = makeCtx({ objective: 'Build a widget' });
    const result = await runGatePhase(ctx);

    // Phase result should be completed.
    expect(result.status).toBe('completed');
    expect(result.phase).toBe('gate');

    // phases/epic-review.json must be written.
    const artifactPath = join(phasesDir(), 'epic-review.json');
    expect(existsSync(artifactPath)).toBe(true);
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8')) as Record<string, unknown>;
    expect(artifact['mode']).toBe('epic-review');
    expect(artifact['verdict']).toBe('APPROVE');
    expect(artifact['cycleId']).toBe(cycleId);
  });

  it('throws GateRejectedError on REQUEST_CHANGES and writes phases/epic-review.json', async () => {
    const rejectResponse = JSON.stringify({
      verdict: 'REQUEST_CHANGES',
      rationale: 'Item i1 is incomplete.',
      faultedItems: [{ itemId: 'i1', reason: 'missing tests', files: ['src/foo.ts'] }],
    });
    mockCeoResponse(rejectResponse);

    const ctx = makeCtx({ objective: 'Build a widget' });
    await expect(runGatePhase(ctx)).rejects.toBeInstanceOf(GateRejectedError);

    // Artifact must still be written even though we threw.
    const artifactPath = join(phasesDir(), 'epic-review.json');
    expect(existsSync(artifactPath)).toBe(true);
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8')) as Record<string, unknown>;
    expect(artifact['verdict']).toBe('REQUEST_CHANGES');
    expect(artifact['mode']).toBe('epic-review');
  });

  it('resolves to TRIAGE (APPROVE-equivalent) when the response is unparseable', async () => {
    // Return prose that contains no valid JSON verdict.
    mockCeoResponse('Sorry, I cannot evaluate this at this time. Please try again later.');

    const ctx = makeCtx({ objective: 'Build a widget' });
    const result = await runGatePhase(ctx);

    // TRIAGE is treated like APPROVE — no throw.
    expect(result.status).toBe('completed');

    const artifactPath = join(phasesDir(), 'epic-review.json');
    expect(existsSync(artifactPath)).toBe(true);
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8')) as Record<string, unknown>;
    expect(artifact['verdict']).toBe('TRIAGE');
    expect(artifact['triageUsed']).toBe(true);
  });

  it('uses ctx.baseBranch in the task when provided', async () => {
    const approveResponse = JSON.stringify({
      verdict: 'APPROVE',
      rationale: 'Good.',
      faultedItems: [],
    });
    mockCeoResponse(approveResponse);

    // Capture the task passed to runStreaming.
    let capturedTask = '';
    mockRunStreaming.mockImplementation(({ task }: { task: string }) => {
      capturedTask = task;
      return Promise.resolve({
        response: approveResponse,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        status: 'completed' as const,
        sessionId: 'sid',
        error: undefined,
      });
    });

    const ctx = makeCtx({ objective: 'Build a widget', baseBranch: 'develop' });
    await runGatePhase(ctx);

    expect(capturedTask).toContain('develop');
  });

  it('reads the epic integration branch from phases/execute.json when available', async () => {
    // Write a phases/execute.json with epicIntegration data.
    writeFileSync(
      join(phasesDir(), 'execute.json'),
      JSON.stringify({
        phase: 'execute',
        epicIntegration: {
          branch: 'codex/epic-test123',
          epicId: 'epic-test123',
          mergedBranches: [],
          hadConflicts: false,
        },
      }),
    );

    const approveResponse = JSON.stringify({
      verdict: 'APPROVE',
      rationale: 'Looks complete.',
      faultedItems: [],
    });

    let capturedTask = '';
    mockRunStreaming.mockImplementation(({ task }: { task: string }) => {
      capturedTask = task;
      return Promise.resolve({
        response: approveResponse,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        status: 'completed' as const,
        sessionId: 'sid',
        error: undefined,
      });
    });

    const ctx = makeCtx({ objective: 'Build a widget' });
    await runGatePhase(ctx);

    expect(capturedTask).toContain('codex/epic-test123');
  });
});

// ---------------------------------------------------------------------------
// Legacy signal-backlog gate path (no ctx.objective)
// ---------------------------------------------------------------------------

describe('runGatePhase — legacy path (ctx.objective absent)', () => {
  it('does NOT write phases/epic-review.json when no objective is set', async () => {
    // The legacy path runs the CEO agent via runLlmPhase.
    mockCeoResponse('APPROVE: looks good');

    const ctx = makeCtx(); // no objective
    // The legacy path calls runLlmPhase which reads the sprint file.
    // It will complete successfully (the sprint file exists).
    await runGatePhase(ctx);

    const artifactPath = join(phasesDir(), 'epic-review.json');
    expect(existsSync(artifactPath)).toBe(false);
  });
});
