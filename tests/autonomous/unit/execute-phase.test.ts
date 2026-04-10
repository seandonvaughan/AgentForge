// tests/autonomous/unit/execute-phase.test.ts
//
// v6.5.1 — Tests for the real execute phase handler. The handler is
// exercised against a mocked runtime so no real `claude -p` calls happen.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runExecutePhase,
  EXECUTE_PHASE_DEFAULT_TOOLS,
  FileLockManager,
  extractFilesFromItem,
  readRelevantMemoryEntries,
  formatMemorySection,
  type MemoryEntry,
} from '../../../packages/core/src/autonomous/phase-handlers/execute-phase.js';
import type { PhaseContext } from '../../../packages/core/src/autonomous/phase-scheduler.js';

function makeMockBus() {
  const subscribers: Record<string, Array<(event: any) => void>> = {};
  const published: Array<{ topic: string; payload: any }> = [];
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

function writeSprintFile(
  cwd: string,
  version: string,
  items: Array<{ id: string; title: string; assignee: string; description?: string; tags?: string[]; source?: string }>,
) {
  const dir = join(cwd, '.agentforge', 'sprints');
  mkdirSync(dir, { recursive: true });
  const wrapper = {
    sprints: [
      {
        version,
        sprintId: `v${version}-test`,
        title: `v${version} test`,
        createdAt: new Date().toISOString(),
        phase: 'planned',
        items: items.map((i) => ({ ...i, status: 'planned', priority: 'P1', estimatedCostUsd: 0 })),
        budget: 10,
        teamSize: 1,
        successCriteria: [],
      },
    ],
  };
  writeFileSync(join(dir, `v${version}.json`), JSON.stringify(wrapper, null, 2));
}

function makeCtx(opts: {
  cwd: string;
  sprintVersion: string;
  cycleId?: string;
  runtime: any;
  bus: any;
}): PhaseContext {
  return {
    sprintId: `v${opts.sprintVersion}-test`,
    sprintVersion: opts.sprintVersion,
    projectRoot: opts.cwd,
    adapter: {},
    bus: opts.bus,
    runtime: opts.runtime,
    ...(opts.cycleId ? { cycleId: opts.cycleId } : {}),
  };
}

describe('runExecutePhase', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-exec-phase-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dispatches each item in the sprint to runtime.run once', async () => {
    writeSprintFile(tmpDir, '9.9.9', [
      { id: 'i1', title: 'fix a', assignee: 'coder' },
      { id: 'i2', title: 'fix b', assignee: 'coder' },
      { id: 'i3', title: 'fix c', assignee: 'reviewer' },
    ]);
    const runtime = {
      run: vi.fn().mockResolvedValue({ output: 'done', costUsd: 0.01, durationMs: 5, model: 'm', usage: { input_tokens: 1, output_tokens: 1 } }),
    };
    const { bus } = makeMockBus();
    const result = await runExecutePhase(makeCtx({ cwd: tmpDir, sprintVersion: '9.9.9', runtime, bus }));

    expect(runtime.run).toHaveBeenCalledTimes(3);
    expect(result.status).toBe('completed');
    expect(result.itemResults).toHaveLength(3);
  });

  it('updates item status to completed in sprint JSON when runtime.run succeeds', async () => {
    writeSprintFile(tmpDir, '9.9.9', [
      { id: 'i1', title: 'a', assignee: 'coder' },
    ]);
    const runtime = {
      run: vi.fn().mockResolvedValue({ output: 'ok', costUsd: 0.02, durationMs: 1, model: 'm', usage: { input_tokens: 0, output_tokens: 0 } }),
    };
    const { bus } = makeMockBus();
    await runExecutePhase(makeCtx({ cwd: tmpDir, sprintVersion: '9.9.9', runtime, bus }));

    const updated = JSON.parse(readFileSync(join(tmpDir, '.agentforge/sprints/v9.9.9.json'), 'utf8'));
    expect(updated.sprints[0].items[0].status).toBe('completed');
  });

  it('marks item failed when runtime.run throws', async () => {
    writeSprintFile(tmpDir, '9.9.9', [
      { id: 'i1', title: 'a', assignee: 'coder' },
      { id: 'i2', title: 'b', assignee: 'coder' },
    ]);
    const runtime = {
      run: vi.fn()
        .mockResolvedValueOnce({ output: 'ok', costUsd: 0.01, durationMs: 1, model: 'm', usage: { input_tokens: 0, output_tokens: 0 } })
        .mockRejectedValueOnce(new Error('boom')),
    };
    const { bus } = makeMockBus();
    const result = await runExecutePhase(
      makeCtx({ cwd: tmpDir, sprintVersion: '9.9.9', runtime, bus }),
      { maxParallelism: 1, maxItemRetries: 0 },
    );

    expect(result.itemResults).toHaveLength(2);
    expect((result.itemResults as any[])[1].status).toBe('failed');
    expect((result.itemResults as any[])[1].error).toContain('boom');

    const updated = JSON.parse(readFileSync(join(tmpDir, '.agentforge/sprints/v9.9.9.json'), 'utf8'));
    expect(updated.sprints[0].items[1].status).toBe('failed');
  });

  it("returns status='completed' when all items succeed", async () => {
    writeSprintFile(tmpDir, '9.9.9', [
      { id: 'i1', title: 'a', assignee: 'coder' },
      { id: 'i2', title: 'b', assignee: 'coder' },
    ]);
    const runtime = { run: vi.fn().mockResolvedValue({ output: '', costUsd: 0, durationMs: 0, model: 'm', usage: { input_tokens: 0, output_tokens: 0 } }) };
    const { bus } = makeMockBus();
    const result = await runExecutePhase(makeCtx({ cwd: tmpDir, sprintVersion: '9.9.9', runtime, bus }));
    expect(result.status).toBe('completed');
  });

  it("returns status='failed' when more than 50% of items fail", async () => {
    writeSprintFile(tmpDir, '9.9.9', [
      { id: 'i1', title: 'a', assignee: 'coder' },
      { id: 'i2', title: 'b', assignee: 'coder' },
      { id: 'i3', title: 'c', assignee: 'coder' },
    ]);
    const runtime = {
      run: vi.fn()
        .mockRejectedValueOnce(new Error('x'))
        .mockRejectedValueOnce(new Error('y'))
        .mockResolvedValueOnce({ output: '', costUsd: 0, durationMs: 0, model: 'm', usage: { input_tokens: 0, output_tokens: 0 } }),
    };
    const { bus } = makeMockBus();
    const result = await runExecutePhase(
      makeCtx({ cwd: tmpDir, sprintVersion: '9.9.9', runtime, bus }),
      { maxParallelism: 1, maxItemRetries: 0 },
    );
    expect(result.status).toBe('failed');
  });

  it("returns status='blocked' when all items fail", async () => {
    writeSprintFile(tmpDir, '9.9.9', [
      { id: 'i1', title: 'a', assignee: 'coder' },
      { id: 'i2', title: 'b', assignee: 'coder' },
    ]);
    const runtime = { run: vi.fn().mockRejectedValue(new Error('nope')) };
    const { bus } = makeMockBus();
    const result = await runExecutePhase(makeCtx({ cwd: tmpDir, sprintVersion: '9.9.9', runtime, bus }));
    expect(result.status).toBe('blocked');
  });

  it('publishes sprint.phase.started and sprint.phase.completed events', async () => {
    writeSprintFile(tmpDir, '9.9.9', [{ id: 'i1', title: 'a', assignee: 'coder' }]);
    const runtime = { run: vi.fn().mockResolvedValue({ output: '', costUsd: 0, durationMs: 0, model: 'm', usage: { input_tokens: 0, output_tokens: 0 } }) };
    const mock = makeMockBus();
    await runExecutePhase(makeCtx({ cwd: tmpDir, sprintVersion: '9.9.9', runtime, bus: mock.bus }));
    const topics = mock.published.map((p) => p.topic);
    expect(topics).toContain('sprint.phase.started');
    expect(topics).toContain('sprint.phase.completed');
  });

  it('reads sprint JSON from .agentforge/sprints/v{version}.json', async () => {
    // Missing file should publish failed event and throw
    const runtime = { run: vi.fn() };
    const mock = makeMockBus();
    await expect(
      runExecutePhase(makeCtx({ cwd: tmpDir, sprintVersion: '0.0.0', runtime, bus: mock.bus })),
    ).rejects.toThrow();
    const topics = mock.published.map((p) => p.topic);
    expect(topics).toContain('sprint.phase.failed');
  });

  it('writes phase JSON to the cycle dir when cycleId is set', async () => {
    writeSprintFile(tmpDir, '9.9.9', [{ id: 'i1', title: 'a', assignee: 'coder' }]);
    const runtime = { run: vi.fn().mockResolvedValue({ output: '', costUsd: 0.05, durationMs: 1, model: 'm', usage: { input_tokens: 0, output_tokens: 0 } }) };
    const { bus } = makeMockBus();
    await runExecutePhase(makeCtx({ cwd: tmpDir, sprintVersion: '9.9.9', cycleId: 'cy-1', runtime, bus }));
    const phaseJsonPath = join(tmpDir, '.agentforge/cycles/cy-1/phases/execute.json');
    expect(existsSync(phaseJsonPath)).toBe(true);
    const json = JSON.parse(readFileSync(phaseJsonPath, 'utf8'));
    expect(json.phase).toBe('execute');
    expect(json.totalItems).toBe(1);
  });

  it('dispatches items in parallel up to the parallelism cap', async () => {
    writeSprintFile(tmpDir, '9.9.9', [
      { id: 'i1', title: 'a', assignee: 'coder', files: ['src/a.ts'] } as any,
      { id: 'i2', title: 'b', assignee: 'coder', files: ['src/b.ts'] } as any,
      { id: 'i3', title: 'c', assignee: 'coder', files: ['src/c.ts'] } as any,
    ]);
    let inFlight = 0;
    let maxInFlight = 0;
    const runtime = {
      run: vi.fn().mockImplementation(async () => {
        inFlight += 1;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await new Promise((r) => setTimeout(r, 30));
        inFlight -= 1;
        return { output: '', costUsd: 0, durationMs: 0, model: 'm', usage: { input_tokens: 0, output_tokens: 0 } };
      }),
    };
    const { bus } = makeMockBus();
    await runExecutePhase(
      makeCtx({ cwd: tmpDir, sprintVersion: '9.9.9', runtime, bus }),
      { maxParallelism: 3, maxItemRetries: 0 },
    );
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('respects parallelism cap of 1 (sequential)', async () => {
    writeSprintFile(tmpDir, '9.9.9', [
      { id: 'i1', title: 'a', assignee: 'coder' },
      { id: 'i2', title: 'b', assignee: 'coder' },
      { id: 'i3', title: 'c', assignee: 'coder' },
    ]);
    let inFlight = 0;
    let maxInFlight = 0;
    const runtime = {
      run: vi.fn().mockImplementation(async () => {
        inFlight += 1;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await new Promise((r) => setTimeout(r, 10));
        inFlight -= 1;
        return { output: '', costUsd: 0, durationMs: 0, model: 'm', usage: { input_tokens: 0, output_tokens: 0 } };
      }),
    };
    const { bus } = makeMockBus();
    await runExecutePhase(
      makeCtx({ cwd: tmpDir, sprintVersion: '9.9.9', runtime, bus }),
      { maxParallelism: 1, maxItemRetries: 0 },
    );
    expect(maxInFlight).toBe(1);
  });

  it('retries a failing item once and succeeds', async () => {
    writeSprintFile(tmpDir, '9.9.9', [
      { id: 'i1', title: 'a', assignee: 'coder' },
    ]);
    const runtime = {
      run: vi
        .fn()
        .mockRejectedValueOnce(new Error('first-fail'))
        .mockResolvedValueOnce({ output: 'ok', costUsd: 0.01, durationMs: 1, model: 'm', usage: { input_tokens: 0, output_tokens: 0 } }),
    };
    const { bus } = makeMockBus();
    const result = await runExecutePhase(
      makeCtx({ cwd: tmpDir, sprintVersion: '9.9.9', runtime, bus }),
      { maxItemRetries: 1 },
    );
    expect(runtime.run).toHaveBeenCalledTimes(2);
    expect((result.itemResults as any[])[0].status).toBe('completed');
    expect((result.itemResults as any[])[0].attempts).toBe(2);
  });

  it('retry prompt includes the previous error', async () => {
    writeSprintFile(tmpDir, '9.9.9', [
      { id: 'i1', title: 'a', assignee: 'coder' },
    ]);
    const runtime = {
      run: vi
        .fn()
        .mockRejectedValueOnce(new Error('boom-xyz'))
        .mockResolvedValueOnce({ output: '', costUsd: 0, durationMs: 0, model: 'm', usage: { input_tokens: 0, output_tokens: 0 } }),
    };
    const { bus } = makeMockBus();
    await runExecutePhase(
      makeCtx({ cwd: tmpDir, sprintVersion: '9.9.9', runtime, bus }),
      { maxItemRetries: 1 },
    );
    const secondCallPrompt = runtime.run.mock.calls[1]![1] as string;
    expect(secondCallPrompt).toContain('PREVIOUS ATTEMPT FAILED');
    expect(secondCallPrompt).toContain('boom-xyz');
    expect(secondCallPrompt).toContain('different approach');
  });

  it('marks item failed with attempts=2 when both attempts fail', async () => {
    writeSprintFile(tmpDir, '9.9.9', [
      { id: 'i1', title: 'a', assignee: 'coder' },
    ]);
    const runtime = {
      run: vi.fn().mockRejectedValue(new Error('always-fail')),
    };
    const { bus } = makeMockBus();
    const result = await runExecutePhase(
      makeCtx({ cwd: tmpDir, sprintVersion: '9.9.9', runtime, bus }),
      { maxItemRetries: 1 },
    );
    expect(runtime.run).toHaveBeenCalledTimes(2);
    const r0 = (result.itemResults as any[])[0];
    expect(r0.status).toBe('failed');
    expect(r0.attempts).toBe(2);
    expect(r0.error).toContain('always-fail');
  });

  it('writes attempts field to execute.json per-item', async () => {
    writeSprintFile(tmpDir, '9.9.9', [
      { id: 'i1', title: 'a', assignee: 'coder' },
    ]);
    const runtime = {
      run: vi.fn().mockResolvedValue({ output: '', costUsd: 0, durationMs: 0, model: 'm', usage: { input_tokens: 0, output_tokens: 0 } }),
    };
    const { bus } = makeMockBus();
    await runExecutePhase(
      makeCtx({ cwd: tmpDir, sprintVersion: '9.9.9', cycleId: 'cy-9', runtime, bus }),
      { maxItemRetries: 1 },
    );
    const json = JSON.parse(readFileSync(join(tmpDir, '.agentforge/cycles/cy-9/phases/execute.json'), 'utf8'));
    expect(json.itemResults[0].attempts).toBe(1);
  });

  it('passes allowedTools through to runtime.run', async () => {
    writeSprintFile(tmpDir, '9.9.9', [{ id: 'i1', title: 'a', assignee: 'coder' }]);
    const runtime = { run: vi.fn().mockResolvedValue({ output: '', costUsd: 0, durationMs: 0, model: 'm', usage: { input_tokens: 0, output_tokens: 0 } }) };
    const { bus } = makeMockBus();
    await runExecutePhase(makeCtx({ cwd: tmpDir, sprintVersion: '9.9.9', runtime, bus }));
    expect(runtime.run).toHaveBeenCalledWith(
      'coder',
      expect.any(String),
      expect.objectContaining({ allowedTools: EXECUTE_PHASE_DEFAULT_TOOLS }),
    );
  });

  // ---- v6.6.0 file-conflict detection ----

  it('runs items with disjoint files in parallel', async () => {
    writeSprintFile(tmpDir, '9.9.9', [
      { id: 'i1', title: 'a', assignee: 'coder', files: ['src/a.ts'] } as any,
      { id: 'i2', title: 'b', assignee: 'coder', files: ['src/b.ts'] } as any,
      { id: 'i3', title: 'c', assignee: 'coder', files: ['src/c.ts'] } as any,
    ]);
    let inFlight = 0;
    let maxInFlight = 0;
    const runtime = {
      run: vi.fn().mockImplementation(async () => {
        inFlight += 1;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await new Promise((r) => setTimeout(r, 30));
        inFlight -= 1;
        return { output: '', costUsd: 0, durationMs: 0, model: 'm', usage: { input_tokens: 0, output_tokens: 0 } };
      }),
    };
    const { bus } = makeMockBus();
    await runExecutePhase(
      makeCtx({ cwd: tmpDir, sprintVersion: '9.9.9', runtime, bus }),
      { maxParallelism: 3, maxItemRetries: 0 },
    );
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });

  it('serializes items with overlapping files even when parallelism > 1', async () => {
    writeSprintFile(tmpDir, '9.9.9', [
      { id: 'i1', title: 'a', assignee: 'coder', files: ['src/shared.ts'] } as any,
      { id: 'i2', title: 'b', assignee: 'coder', files: ['src/shared.ts'] } as any,
      { id: 'i3', title: 'c', assignee: 'coder', files: ['src/shared.ts'] } as any,
    ]);
    let inFlight = 0;
    let maxInFlight = 0;
    const runtime = {
      run: vi.fn().mockImplementation(async () => {
        inFlight += 1;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
        return { output: '', costUsd: 0, durationMs: 0, model: 'm', usage: { input_tokens: 0, output_tokens: 0 } };
      }),
    };
    const { bus } = makeMockBus();
    await runExecutePhase(
      makeCtx({ cwd: tmpDir, sprintVersion: '9.9.9', runtime, bus }),
      { maxParallelism: 3, maxItemRetries: 0 },
    );
    expect(maxInFlight).toBe(1);
    expect(runtime.run).toHaveBeenCalledTimes(3);
  });

  it('items without declared or inferred files run in parallel (optimistic mode default)', async () => {
    // v6.7.4: FileLockManager defaults to optimistic=true so items with no
    // declared or inferred files run unconstrained — they no longer serialize
    // against each other. The old conservative mode serialized them to 1
    // concurrent agent, which was the root cause of cycles showing only 1-2
    // active agents even with maxParallelism: 10.
    writeSprintFile(tmpDir, '9.9.9', [
      { id: 'i1', title: 'just a vague task', assignee: 'coder', description: 'no paths here' },
      { id: 'i2', title: 'another vague task', assignee: 'coder', description: 'still nothing' },
      { id: 'i3', title: 'one more', assignee: 'coder', description: 'empty' },
    ]);
    let inFlight = 0;
    let maxInFlight = 0;
    const runtime = {
      run: vi.fn().mockImplementation(async () => {
        inFlight += 1;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await new Promise((r) => setTimeout(r, 15));
        inFlight -= 1;
        return { output: '', costUsd: 0, durationMs: 0, model: 'm', usage: { input_tokens: 0, output_tokens: 0 } };
      }),
    };
    const { bus } = makeMockBus();
    await runExecutePhase(
      makeCtx({ cwd: tmpDir, sprintVersion: '9.9.9', runtime, bus }),
      { maxParallelism: 3, maxItemRetries: 0 },
    );
    // In optimistic mode, all 3 no-file items should run in parallel up to the cap.
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('extractFilesFromItem heuristically finds .ts/.md/.yaml paths in description', () => {
    const f = extractFilesFromItem({
      title: 'Fix the scanner',
      description: 'Update packages/core/src/foo.ts and docs/readme.md and config.yaml',
    });
    expect(f).toContain('packages/core/src/foo.ts');
    expect(f).toContain('docs/readme.md');
    expect(f).toContain('config.yaml');
  });

  it('extractFilesFromItem prefers explicit files declaration over heuristic', () => {
    const f = extractFilesFromItem({
      files: ['explicit/path.ts'],
      title: 'mentions other.ts',
      description: 'and other.md',
    });
    expect(f).toEqual(['explicit/path.ts']);
  });

  it('FileLockManager.release drops locks so the next item can acquire', () => {
    const m = new FileLockManager();
    expect(m.canAcquire('i1', ['a.ts'])).toBe(true);
    m.acquire('i1', ['a.ts']);
    expect(m.canAcquire('i2', ['a.ts'])).toBe(false);
    expect(m.canAcquire('i3', ['b.ts'])).toBe(true);
    m.release('i1');
    expect(m.canAcquire('i2', ['a.ts'])).toBe(true);
  });
});

// ---- Memory injection helpers ----

describe('readRelevantMemoryEntries', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-memory-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeMemoryFile(type: string, entries: MemoryEntry[]) {
    const dir = join(tmpDir, '.agentforge', 'memory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${type}.jsonl`),
      entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
  }

  it('returns empty array when memory directory does not exist', () => {
    const entries = readRelevantMemoryEntries(tmpDir, ['memory', 'chore']);
    expect(entries).toEqual([]);
  });

  it('returns empty array when no tags overlap', () => {
    writeMemoryFile('review-finding', [
      { key: 'past-bug', value: 'forgot null check', type: 'review-finding', createdAt: '2026-01-01T00:00:00Z', tags: ['api', 'auth'] },
    ]);
    const entries = readRelevantMemoryEntries(tmpDir, ['memory', 'chore']);
    expect(entries).toHaveLength(0);
  });

  it('returns entries whose tags intersect with itemTags', () => {
    writeMemoryFile('review-finding', [
      { key: 'null-deref', value: 'forgot to guard undefined sprint items', type: 'review-finding', createdAt: '2026-01-02T00:00:00Z', tags: ['execute', 'memory'] },
      { key: 'auth-bug', value: 'missing token validation', type: 'review-finding', createdAt: '2026-01-01T00:00:00Z', tags: ['auth'] },
    ]);
    const entries = readRelevantMemoryEntries(tmpDir, ['memory', 'execute']);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.key).toBe('null-deref');
  });

  it('respects maxEntries cap', () => {
    writeMemoryFile('failure-pattern', [
      { key: 'f1', value: 'v1', type: 'failure-pattern', createdAt: '2026-01-01T00:00:00Z', tags: ['execute'] },
      { key: 'f2', value: 'v2', type: 'failure-pattern', createdAt: '2026-01-02T00:00:00Z', tags: ['execute'] },
      { key: 'f3', value: 'v3', type: 'failure-pattern', createdAt: '2026-01-03T00:00:00Z', tags: ['execute'] },
    ]);
    const entries = readRelevantMemoryEntries(tmpDir, ['execute'], 2);
    expect(entries).toHaveLength(2);
  });

  it('prioritizes failure-pattern and review-finding over cycle-outcome', () => {
    writeMemoryFile('mixed', [
      { key: 'cycle', value: 'completed fine', type: 'cycle-outcome', createdAt: '2026-01-03T00:00:00Z', tags: ['execute'] },
      { key: 'bug', value: 'null deref in handler', type: 'review-finding', createdAt: '2026-01-01T00:00:00Z', tags: ['execute'] },
    ]);
    const entries = readRelevantMemoryEntries(tmpDir, ['execute']);
    // review-finding should come before cycle-outcome despite older createdAt
    expect(entries[0]!.type).toBe('review-finding');
  });

  it('skips malformed JSONL lines without throwing', () => {
    const dir = join(tmpDir, '.agentforge', 'memory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'mixed.jsonl'), [
      JSON.stringify({ key: 'good', value: 'ok', type: 'learned-fact', createdAt: '2026-01-01T00:00:00Z', tags: ['execute'] }),
      'not-valid-json',
      JSON.stringify({ key: 'also-good', value: 'ok2', type: 'learned-fact', createdAt: '2026-01-02T00:00:00Z', tags: ['execute'] }),
    ].join('\n'));
    expect(() => readRelevantMemoryEntries(tmpDir, ['execute'])).not.toThrow();
    const entries = readRelevantMemoryEntries(tmpDir, ['execute']);
    expect(entries).toHaveLength(2);
  });
});

describe('formatMemorySection', () => {
  it('returns empty string for empty entries', () => {
    expect(formatMemorySection([])).toBe('');
  });

  it('includes entry key, type, and value in the output', () => {
    const entries: MemoryEntry[] = [
      { key: 'null-check-missing', value: 'Always guard for undefined sprint items', type: 'review-finding', createdAt: '2026-01-01T00:00:00Z', tags: ['execute'] },
    ];
    const section = formatMemorySection(entries);
    expect(section).toContain('null-check-missing');
    expect(section).toContain('review-finding');
    expect(section).toContain('Always guard for undefined sprint items');
  });

  it('includes a section header', () => {
    const entries: MemoryEntry[] = [
      { key: 'k', value: 'v', type: 'failure-pattern', createdAt: '2026-01-01T00:00:00Z', tags: [] },
    ];
    expect(formatMemorySection(entries)).toContain('Memory: Past Failures');
  });
});

describe('execute phase prompt includes memory', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-exec-mem-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('injects matching memory entries into agent prompt', async () => {
    // Write a memory entry matching the item tags
    const memDir = join(tmpDir, '.agentforge', 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, 'review-finding.jsonl'), JSON.stringify({
      key: 'guard-sprint-items',
      value: 'Always check items array before iterating',
      type: 'review-finding',
      createdAt: '2026-01-01T00:00:00Z',
      tags: ['execute', 'chore'],
    }) + '\n');

    // Write sprint with a matching-tag item
    const sprintDir = join(tmpDir, '.agentforge', 'sprints');
    mkdirSync(sprintDir, { recursive: true });
    const sprint = {
      sprints: [{
        version: '1.0.0',
        sprintId: 'v1.0.0-test',
        title: 'test',
        createdAt: new Date().toISOString(),
        phase: 'planned',
        items: [{ id: 'i1', title: 'update executor', assignee: 'coder', status: 'planned', tags: ['execute', 'chore'] }],
        budget: 1,
        teamSize: 1,
        successCriteria: [],
      }],
    };
    writeFileSync(join(sprintDir, 'v1.0.0.json'), JSON.stringify(sprint, null, 2));

    let capturedPrompt = '';
    const runtime = {
      run: vi.fn().mockImplementation(async (_agentId: string, prompt: string) => {
        capturedPrompt = prompt;
        return { output: 'done', costUsd: 0, durationMs: 0, model: 'm', usage: { input_tokens: 0, output_tokens: 0 } };
      }),
    };
    const { bus } = makeMockBus();
    await runExecutePhase(makeCtx({ cwd: tmpDir, sprintVersion: '1.0.0', runtime, bus }));

    expect(capturedPrompt).toContain('Memory: Past Failures');
    expect(capturedPrompt).toContain('guard-sprint-items');
  });

  it('prompt has no memory section when no matching entries exist', async () => {
    // Memory dir exists but no entries share tags with the item
    const memDir = join(tmpDir, '.agentforge', 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, 'review-finding.jsonl'), JSON.stringify({
      key: 'auth-issue',
      value: 'Some auth problem',
      type: 'review-finding',
      createdAt: '2026-01-01T00:00:00Z',
      tags: ['auth'],
    }) + '\n');

    const sprintDir = join(tmpDir, '.agentforge', 'sprints');
    mkdirSync(sprintDir, { recursive: true });
    const sprint = {
      sprints: [{
        version: '1.0.0',
        sprintId: 'v1.0.0-test',
        title: 'test',
        createdAt: new Date().toISOString(),
        phase: 'planned',
        items: [{ id: 'i1', title: 'update executor', assignee: 'coder', status: 'planned', tags: ['execute', 'chore'] }],
        budget: 1,
        teamSize: 1,
        successCriteria: [],
      }],
    };
    writeFileSync(join(sprintDir, 'v1.0.0.json'), JSON.stringify(sprint, null, 2));

    let capturedPrompt = '';
    const runtime = {
      run: vi.fn().mockImplementation(async (_agentId: string, prompt: string) => {
        capturedPrompt = prompt;
        return { output: 'done', costUsd: 0, durationMs: 0, model: 'm', usage: { input_tokens: 0, output_tokens: 0 } };
      }),
    };
    const { bus } = makeMockBus();
    await runExecutePhase(makeCtx({ cwd: tmpDir, sprintVersion: '1.0.0', runtime, bus }));

    expect(capturedPrompt).not.toContain('Memory: Past Failures');
  });
});
