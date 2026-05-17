/**
 * Unit tests for self-eval integration in the execute phase.
 *
 * Deliverables verified:
 *  1. System prompt receives the fragment when selfEvalDisabled is unset
 *  2. System prompt does NOT receive the fragment when selfEvalDisabled: true
 *  3. Mock runtime returns a response with a self-eval block → recordSelfEval
 *     called with the parsed grade
 *  4. Mock runtime returns a response without self-eval block → recordSelfEval
 *     NOT called, no error
 *  5. recordSelfEval throws → cycle continues (caught)
 *  6. cycleId is threaded through to the SelfEvalRecord
 *  7. Fragment is non-empty (sanity check that the .md loaded correctly)
 *  8. HTML-comment format self-eval is also parsed and recorded
 *  9. Multiple items each trigger independent parse+record calls
 * 10. selfEvalDisabled skips both prompt append AND recordSelfEval call
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PhaseContext } from '../../phase-scheduler.js';
import { runExecutePhase, SELF_EVAL_FRAGMENT } from '../execute-phase.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// We spy on recordSelfEval to avoid real file I/O in all but the integration tests.
vi.mock('../../self-eval/recorder.js', () => ({
  recordSelfEval: vi.fn().mockResolvedValue(undefined),
}));

import { recordSelfEval } from '../../self-eval/recorder.js';
const recordSelfEvalMock = recordSelfEval as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-selfeval-'));
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeBus() {
  const events: Array<{ topic: string; payload: unknown }> = [];
  return {
    publish: (topic: string, payload: unknown) => {
      events.push({ topic, payload });
    },
    subscribe: (_t: string, _cb: (e: unknown) => void) => () => {},
    events,
  };
}

function makeCtx(
  bus: ReturnType<typeof makeBus>,
  overrides: Partial<PhaseContext> = {},
): PhaseContext {
  return {
    projectRoot: tmpRoot,
    sprintId: 'sprint-se-1',
    sprintVersion: '1.0.0',
    cycleId: 'cycle-se-1',
    adapter: undefined as any,
    bus,
    runtime: {
      run: vi.fn().mockResolvedValue({
        output: 'Done. All changes applied.',
        costUsd: 0.01,
        status: 'completed',
      }),
    },
    ...overrides,
  } as PhaseContext;
}

function writeSprintFile(
  items: Array<{
    id: string;
    title: string;
    assignee: string;
    status?: string;
    tags?: string[];
  }>,
  cycleId = 'cycle-se-1',
) {
  const data = {
    version: '1.0.0',
    sprintId: 'sprint-se-1',
    items: items.map((i) => ({
      id: i.id,
      title: i.title,
      assignee: i.assignee,
      status: i.status ?? 'planned',
      tags: i.tags ?? [],
      description: `Description for ${i.title}`,
    })),
  };
  const sprintsDir = join(tmpRoot, '.agentforge', 'sprints');
  mkdirSync(sprintsDir, { recursive: true });
  writeFileSync(join(sprintsDir, 'v1.0.0.json'), JSON.stringify(data));

  const cycleDir = join(tmpRoot, '.agentforge', 'cycles', cycleId);
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(join(cycleDir, 'plan.json'), JSON.stringify(data));
}

// A response that includes a valid markdown self-eval block.
const RESPONSE_WITH_SELF_EVAL = `I completed the task successfully.

Modified execute-phase.ts to add the new feature.

## Self-eval
Score: 4
Why: Hit all acceptance criteria but left one edge-case test as a TODO.`;

// A response with the HTML-comment self-eval alternative format.
const RESPONSE_WITH_COMMENT_SELF_EVAL = `I completed the task.

<!-- self-eval: {"score": 3, "justification": "Mostly working but mocked one test instead of implementing it."} -->`;

// A response with no self-eval block.
const RESPONSE_WITHOUT_SELF_EVAL = `I completed the task. Changes were made to the relevant files.`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SELF_EVAL_FRAGMENT export', () => {
  it('exports a non-empty string (prompt-fragment.md loaded successfully)', () => {
    expect(typeof SELF_EVAL_FRAGMENT).toBe('string');
    expect(SELF_EVAL_FRAGMENT.length).toBeGreaterThan(0);
  });

  it('contains the expected self-eval heading', () => {
    expect(SELF_EVAL_FRAGMENT).toContain('Self-eval');
  });
});

describe('self-eval prompt fragment injection', () => {
  it('appends the self-eval fragment to the agent task when selfEvalDisabled is not set', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Add logging', assignee: 'coder', tags: ['typescript'] },
    ]);

    const runtime = { run: vi.fn().mockResolvedValue({ output: 'done', costUsd: 0.01 }) };
    const bus = makeBus();
    const ctx = makeCtx(bus, { runtime });

    await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0, disableWorktrees: true });

    expect(runtime.run).toHaveBeenCalledTimes(1);
    const callArgs = runtime.run.mock.calls[0]!;
    // Second argument is the task/prompt string
    const prompt = callArgs[1] as string;
    expect(prompt).toContain('Self-eval');
    expect(prompt).toContain('Score:');
  });

  it('does NOT append the fragment when selfEvalDisabled: true', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Add logging', assignee: 'coder', tags: ['typescript'] },
    ]);

    const runtime = { run: vi.fn().mockResolvedValue({ output: 'done', costUsd: 0.01 }) };
    const bus = makeBus();
    const ctx = makeCtx(bus, { runtime });

    await runExecutePhase(ctx, {
      maxParallelism: 1,
      maxItemRetries: 0,
      disableWorktrees: true,
      selfEvalDisabled: true,
    });

    expect(runtime.run).toHaveBeenCalledTimes(1);
    const prompt = runtime.run.mock.calls[0]![1] as string;
    expect(prompt).not.toContain('## Self-eval');
    expect(prompt).not.toContain('Score:');
  });
});

describe('self-eval parse + record after runtime.run()', () => {
  it('calls recordSelfEval with the parsed grade when response contains markdown self-eval block', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Implement feature', assignee: 'backend-engineer', tags: ['backend'] },
    ]);

    const runtime = {
      run: vi.fn().mockResolvedValue({
        output: RESPONSE_WITH_SELF_EVAL,
        costUsd: 0.02,
      }),
    };
    const bus = makeBus();
    const ctx = makeCtx(bus, { runtime });

    await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0, disableWorktrees: true });

    expect(recordSelfEvalMock).toHaveBeenCalledTimes(1);
    const callArgs = recordSelfEvalMock.mock.calls[0]![0];
    expect(callArgs.projectRoot).toBe(tmpRoot);
    expect(callArgs.record.agentId).toBe('backend-engineer');
    expect(callArgs.record.cycleId).toBe('cycle-se-1');
    expect(callArgs.record.sprintItemId).toBe('item-1');
    expect(callArgs.record.grade.score).toBe(4);
    expect(typeof callArgs.record.grade.justification).toBe('string');
    expect(callArgs.record.grade.justification.length).toBeGreaterThan(0);
    expect(typeof callArgs.record.recordedAt).toBe('string');
  });

  it('does NOT call recordSelfEval when the response has no self-eval block', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Fix bug', assignee: 'coder', tags: ['typescript'] },
    ]);

    const runtime = {
      run: vi.fn().mockResolvedValue({
        output: RESPONSE_WITHOUT_SELF_EVAL,
        costUsd: 0.01,
      }),
    };
    const bus = makeBus();
    const ctx = makeCtx(bus, { runtime });

    await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0, disableWorktrees: true });

    expect(recordSelfEvalMock).not.toHaveBeenCalled();
  });

  it('cycle continues and returns completed when recordSelfEval throws', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Write tests', assignee: 'coder', tags: ['testing'] },
    ]);

    recordSelfEvalMock.mockRejectedValueOnce(new Error('disk full'));

    const runtime = {
      run: vi.fn().mockResolvedValue({
        output: RESPONSE_WITH_SELF_EVAL,
        costUsd: 0.01,
      }),
    };
    const bus = makeBus();
    const ctx = makeCtx(bus, { runtime });

    // Should not throw — the error must be swallowed
    const result = await runExecutePhase(ctx, {
      maxParallelism: 1,
      maxItemRetries: 0,
      disableWorktrees: true,
    });

    expect(result.status).toBe('completed');
    expect(recordSelfEvalMock).toHaveBeenCalledTimes(1);
  });

  it('parses and records the HTML-comment self-eval format', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Refactor module', assignee: 'fullstack-dev', tags: ['refactor'] },
    ]);

    const runtime = {
      run: vi.fn().mockResolvedValue({
        output: RESPONSE_WITH_COMMENT_SELF_EVAL,
        costUsd: 0.01,
      }),
    };
    const bus = makeBus();
    const ctx = makeCtx(bus, { runtime });

    await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0, disableWorktrees: true });

    expect(recordSelfEvalMock).toHaveBeenCalledTimes(1);
    const callArgs = recordSelfEvalMock.mock.calls[0]![0];
    expect(callArgs.record.grade.score).toBe(3);
    expect(callArgs.record.grade.justification).toContain('mocked');
  });

  it('records self-eval for each item independently when multiple items complete', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Task A', assignee: 'coder', tags: ['typescript'] },
      { id: 'item-2', title: 'Task B', assignee: 'backend-dev', tags: ['backend'] },
    ]);

    const runtime = {
      run: vi.fn()
        .mockResolvedValueOnce({ output: RESPONSE_WITH_SELF_EVAL, costUsd: 0.01 })
        .mockResolvedValueOnce({ output: RESPONSE_WITH_COMMENT_SELF_EVAL, costUsd: 0.01 }),
    };
    const bus = makeBus();
    const ctx = makeCtx(bus, { runtime });

    await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0, disableWorktrees: true });

    // Both items had self-eval blocks → two record calls
    expect(recordSelfEvalMock).toHaveBeenCalledTimes(2);
    const ids = recordSelfEvalMock.mock.calls.map((c: any[]) => c[0].record.sprintItemId);
    expect(ids).toContain('item-1');
    expect(ids).toContain('item-2');
  });

  it('does NOT call recordSelfEval at all when selfEvalDisabled: true', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Task A', assignee: 'coder', tags: ['typescript'] },
    ]);

    const runtime = {
      run: vi.fn().mockResolvedValue({
        output: RESPONSE_WITH_SELF_EVAL,
        costUsd: 0.01,
      }),
    };
    const bus = makeBus();
    const ctx = makeCtx(bus, { runtime });

    await runExecutePhase(ctx, {
      maxParallelism: 1,
      maxItemRetries: 0,
      disableWorktrees: true,
      selfEvalDisabled: true,
    });

    // Even though the response contains a self-eval block, disabled flag means
    // we never even attempt to parse or record it.
    expect(recordSelfEvalMock).not.toHaveBeenCalled();
  });

  it('threads cycleId into the SelfEvalRecord (not sprintId fallback)', async () => {
    writeSprintFile([
      { id: 'item-1', title: 'Task', assignee: 'coder', tags: [] },
    ], 'my-cycle-abc');

    const runtime = {
      run: vi.fn().mockResolvedValue({
        output: RESPONSE_WITH_SELF_EVAL,
        costUsd: 0.01,
      }),
    };
    const bus = makeBus();
    const ctx: PhaseContext = {
      projectRoot: tmpRoot,
      sprintId: 'sprint-se-99',
      sprintVersion: '1.0.0',
      cycleId: 'my-cycle-abc',
      adapter: undefined as any,
      bus,
      runtime,
    } as PhaseContext;

    await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0, disableWorktrees: true });

    expect(recordSelfEvalMock).toHaveBeenCalledTimes(1);
    const record = recordSelfEvalMock.mock.calls[0]![0].record;
    expect(record.cycleId).toBe('my-cycle-abc');
  });

  it('falls back to sprintId as cycleId when ctx.cycleId is undefined', async () => {
    const data = {
      version: '1.0.0',
      sprintId: 'sprint-se-fallback',
      items: [{
        id: 'item-1',
        title: 'Task fallback',
        assignee: 'coder',
        status: 'planned',
        tags: [],
        description: 'desc',
      }],
    };
    const sprintsDir = join(tmpRoot, '.agentforge', 'sprints');
    mkdirSync(sprintsDir, { recursive: true });
    writeFileSync(join(sprintsDir, 'v1.0.0.json'), JSON.stringify(data));

    const runtime = {
      run: vi.fn().mockResolvedValue({
        output: RESPONSE_WITH_SELF_EVAL,
        costUsd: 0.01,
      }),
    };
    const bus = makeBus();
    // No cycleId in context
    const ctx: PhaseContext = {
      projectRoot: tmpRoot,
      sprintId: 'sprint-se-fallback',
      sprintVersion: '1.0.0',
      adapter: undefined as any,
      bus,
      runtime,
    } as PhaseContext;

    await runExecutePhase(ctx, { maxParallelism: 1, maxItemRetries: 0, disableWorktrees: true });

    expect(recordSelfEvalMock).toHaveBeenCalledTimes(1);
    const record = recordSelfEvalMock.mock.calls[0]![0].record;
    // Falls back to sprintId when cycleId is undefined
    expect(record.cycleId).toBe('sprint-se-fallback');
  });
});
