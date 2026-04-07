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
    const result = await runExecutePhase(makeCtx({ cwd: tmpDir, sprintVersion: '9.9.9', runtime, bus }));

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
    const result = await runExecutePhase(makeCtx({ cwd: tmpDir, sprintVersion: '9.9.9', runtime, bus }));
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
});
