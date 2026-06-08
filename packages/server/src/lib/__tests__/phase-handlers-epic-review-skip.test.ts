/**
 * phase-handlers-epic-review-skip.test.ts
 *
 * Colocated vitest suite for the epic-review skip added to `runReviewPhase`
 * in phase-handlers.ts (P0.6 objective path).
 *
 * Assertions:
 *  1. When ctx.objective is set, runReviewPhase skips the code-reviewer
 *     dispatch, returns a zero-cost completed PhaseResult, and writes
 *     phases/review.json with {skipped:true, reason, costUsd:0}.
 *  2. When ctx.objective is NOT set (legacy signal cycle), the code-reviewer
 *     agent IS dispatched and phases/review.json is NOT written as a skip
 *     marker.
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
import {
  runReviewPhase,
  type PhaseContext,
  createNoopBus,
  writeSprint,
  type SprintFile,
} from '../phase-handlers.js';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

// Mock @agentforge/core so AgentRuntime + loadAgentConfig don't hit disk.
const mockRunStreaming = vi.fn();

vi.mock('@agentforge/core', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@agentforge/core')>();
  // AgentRuntime must be a plain function (not arrow) so `new AgentRuntime(...)` works.
  function MockAgentRuntime() {
    return { runStreaming: mockRunStreaming };
  }
  return {
    ...orig,
    loadAgentConfig: vi.fn().mockResolvedValue({
      id: 'code-reviewer',
      workspaceId: 'default',
      model: 'claude-sonnet-4-5',
    }),
    AgentRuntime: MockAgentRuntime,
  };
});

// Mock globalStream so SSE emits don't fail.
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
    sprintId: 'sprint-review-skip',
    version: '99.0',
    title: 'Test sprint for review skip',
    createdAt: new Date().toISOString(),
    phase: 'review',
    items: [
      {
        id: 'i1',
        title: 'Item 1',
        description: 'desc',
        priority: 'P1',
        assignee: 'code-reviewer',
        status: 'completed',
      },
    ],
    budget: 10,
    teamSize: 1,
    successCriteria: [],
    auditFindings: [],
  };
}

function makeCtx(overrides: Partial<PhaseContext> = {}): PhaseContext {
  return {
    sprintId: 'sprint-review-skip',
    sprintVersion: '99.0',
    projectRoot: tmpRoot,
    agentforgeDir: agentforgeDir(),
    bus: createNoopBus(),
    cycleId,
    ...overrides,
  };
}

function mockReviewerResponse(response: string): void {
  mockRunStreaming.mockResolvedValue({
    response,
    costUsd: 0.05,
    inputTokens: 200,
    outputTokens: 100,
    status: 'completed' as const,
    sessionId: 'test-session-reviewer',
    error: undefined,
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-review-skip-test-'));
  cycleId = 'cycle-review-test-abc';
  mkdirSync(agentforgeDir(), { recursive: true });
  mkdirSync(phasesDir(), { recursive: true });
  writeSprint(tmpRoot, '99.0', makeSprint());
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Epic skip path (ctx.objective set)
// ---------------------------------------------------------------------------

describe('runReviewPhase — epic skip (ctx.objective set)', () => {
  it('does NOT dispatch the code-reviewer agent', async () => {
    const ctx = makeCtx({ objective: 'Build the widget feature end-to-end' });
    await runReviewPhase(ctx);
    expect(mockRunStreaming).not.toHaveBeenCalled();
  });

  it('returns a completed PhaseResult with zero cost and no agentRuns', async () => {
    const ctx = makeCtx({ objective: 'Build the widget feature end-to-end' });
    const result = await runReviewPhase(ctx);
    expect(result.phase).toBe('review');
    expect(result.status).toBe('completed');
    expect(result.costUsd).toBe(0);
    expect(result.agentRuns).toEqual([]);
  });

  it('writes phases/review.json with skipped:true, a reason, and costUsd:0', async () => {
    const ctx = makeCtx({ objective: 'Build the widget feature end-to-end' });
    await runReviewPhase(ctx);

    const reviewJsonPath = join(phasesDir(), 'review.json');
    expect(existsSync(reviewJsonPath)).toBe(true);

    const reviewJson = JSON.parse(readFileSync(reviewJsonPath, 'utf8')) as Record<string, unknown>;
    expect(reviewJson['skipped']).toBe(true);
    expect(reviewJson['costUsd']).toBe(0);
    expect(typeof reviewJson['reason']).toBe('string');
    expect((reviewJson['reason'] as string).toLowerCase()).toContain('epic path');
  });

  it('creates the phases directory when it does not exist yet', async () => {
    // Remove the pre-created phases dir so we can test auto-creation.
    rmSync(phasesDir(), { recursive: true, force: true });

    const ctx = makeCtx({ objective: 'Test auto-dir creation' });
    await runReviewPhase(ctx);

    expect(existsSync(join(phasesDir(), 'review.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Legacy signal cycle path (ctx.objective absent)
// ---------------------------------------------------------------------------

describe('runReviewPhase — legacy path (ctx.objective absent)', () => {
  it('dispatches the code-reviewer agent on the normal path', async () => {
    mockReviewerResponse('Overall verdict 4/5 — looks good, minor nits only.');

    const ctx = makeCtx(); // no objective
    await runReviewPhase(ctx);

    expect(mockRunStreaming).toHaveBeenCalled();
  });

  it('does NOT write a skipped:true review.json on the legacy path', async () => {
    mockReviewerResponse('Overall verdict 4/5 — looks good, minor nits only.');

    const ctx = makeCtx(); // no objective
    await runReviewPhase(ctx);

    // The legacy path writes a full review.json (not a skip marker).
    // Verify it does NOT contain skipped:true.
    const reviewJsonPath = join(phasesDir(), 'review.json');
    // The file may or may not exist (depends on cycleId being set),
    // but if it does exist it must NOT be a skip marker.
    if (existsSync(reviewJsonPath)) {
      const reviewJson = JSON.parse(readFileSync(reviewJsonPath, 'utf8')) as Record<string, unknown>;
      expect(reviewJson['skipped']).toBeUndefined();
    }
  });
});
