/**
 * Safeguard #2 — gate-retry routes findings to the owning item.
 *
 * Root cause (live cycle c6954dbe): the gate-retry context is CYCLE-level, so the
 * execute phase re-ran ALL sprint items to fix a SINGLE finding — even items that
 * did not own the faulted file. Those non-owning agents made no real edit and the
 * change-detection failed them ("produced no source changes"), blocking the cycle.
 *
 * Fix: on a gate-rejection retry, re-execute only the item(s) whose declared files
 * match the finding's files; keep the others (their attempt-1 branch/PR stands).
 * If no item matches, fall back to re-executing all (no regression).
 *
 * See docs/superpowers/specs/2026-05-25-loop-safeguards-recommendations.md (#2).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PhaseContext } from '../../phase-scheduler.js';
import { runExecutePhase } from '../execute-phase.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'af-gate-retry-'));
  vi.clearAllMocks();
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeBus() {
  return {
    publish: (_t: string, _p: unknown) => {},
    subscribe: (_t: string, _cb: (e: unknown) => void) => () => {},
  };
}

function writeSprint(
  items: Array<{
    id: string;
    title: string;
    assignee: string;
    files: string[];
    wave?: number;
    predecessors?: string[];
  }>,
): void {
  const data = {
    version: '1.0.0',
    sprintId: 'sprint-gr',
    items: items.map((i) => ({
      id: i.id,
      title: i.title,
      assignee: i.assignee,
      files: i.files,
      ...(i.wave !== undefined ? { wave: i.wave } : {}),
      ...(i.predecessors !== undefined ? { predecessors: i.predecessors } : {}),
      status: 'planned',
      tags: [],
      description: i.title,
    })),
  };
  const cycleDir = join(tmpRoot, '.agentforge', 'cycles', 'cycle-gr');
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(join(cycleDir, 'plan.json'), JSON.stringify(data));
}

function writeProjectFiles(files: string[]): void {
  for (const file of files) {
    const parts = file.split(/[\\/]+/).filter(Boolean);
    mkdirSync(join(tmpRoot, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(tmpRoot, ...parts), '// test fixture\n', 'utf8');
  }
}

function makeCtx(runtime: unknown, gateRetry: unknown): PhaseContext {
  return {
    projectRoot: tmpRoot,
    sprintId: 'sprint-gr',
    sprintVersion: '1.0.0',
    cycleId: 'cycle-gr',
    adapter: undefined as never,
    bus: makeBus(),
    runtime,
    gateRetry,
  } as PhaseContext;
}

describe('execute phase — gate-retry routes findings to the owning item', () => {
  it('re-executes only the item whose files match the finding; keeps the rest', async () => {
    writeProjectFiles([
      'docs/runtime-modes.md',
      'CLAUDE.md',
      'README.md',
      'packages/core/src/runtime/types.ts',
    ]);
    writeSprint([
      { id: 'item-A', title: 'Fix runtime-modes docs', assignee: 'docs-engineer', files: ['docs/runtime-modes.md'] },
      { id: 'item-B', title: 'Reconcile CLAUDE.md', assignee: 'chief-architect', files: ['CLAUDE.md', 'README.md'] },
      { id: 'item-C', title: 'preferredProvider hint', assignee: 'executor-runtime-engineer', files: ['packages/core/src/runtime/types.ts'] },
    ]);
    const runtime = { run: vi.fn().mockResolvedValue({ output: 'fixed', costUsd: 0.01 }) };
    const gateRetry = {
      attempt: 1,
      rationale: 'Gate rejected: docs/runtime-modes.md drift',
      files: ['docs/runtime-modes.md'],
      findings: ['MAJOR: docs/runtime-modes.md drift'],
    };

    const result = await runExecutePhase(makeCtx(runtime, gateRetry), {
      maxParallelism: 3,
      maxItemRetries: 0,
      disableWorktrees: true,
      selfEvalDisabled: true,
    });

    // Only the implicated item (owns docs/runtime-modes.md) was dispatched.
    expect(runtime.run).toHaveBeenCalledTimes(1);

    const rows = (result.itemResults ?? []) as Array<{ itemId: string; status: string; response: string }>;
    const byId = new Map(rows.map((r) => [r.itemId, r] as const));
    expect(byId.get('item-A')?.status).toBe('completed');
    expect(byId.get('item-B')?.status).toBe('completed');
    expect(byId.get('item-C')?.status).toBe('completed');
    // Non-faulted items were KEPT (not re-run), so they can't fail "no source changes".
    expect(byId.get('item-B')?.response).toContain('kept');
    expect(byId.get('item-C')?.response).toContain('kept');
    expect(byId.get('item-A')?.response).not.toContain('kept');
  });

  it('uses rejected branch ledger item IDs when gate files do not match declared item files', async () => {
    writeSprint([
      { id: 'item-A', title: 'Fix runtime-modes docs', assignee: 'docs-engineer', files: [] },
      { id: 'item-B', title: 'Reconcile CLAUDE.md', assignee: 'chief-architect', files: [] },
      { id: 'item-C', title: 'preferredProvider hint', assignee: 'executor-runtime-engineer', files: [] },
    ]);
    const runtime = { run: vi.fn().mockResolvedValue({ output: 'fixed', costUsd: 0.01 }) };
    const gateRetry = {
      attempt: 1,
      rationale:
        'Verified finding against branch codex/agent-executor-runtime-engineer-2b3018a8ef57.',
      rejectedBranch: 'codex/agent-executor-runtime-engineer-2b3018a8ef57',
      itemIds: ['item-C'],
      files: ['tests/docs/runtime-modes.test.ts'],
      findings: ['MAJOR: the new runtime-modes test can pass vacuously'],
    };

    const result = await runExecutePhase(makeCtx(runtime, gateRetry), {
      maxParallelism: 3,
      maxItemRetries: 0,
      disableWorktrees: true,
      selfEvalDisabled: true,
    });

    expect(runtime.run).toHaveBeenCalledTimes(1);

    const rows = (result.itemResults ?? []) as Array<{ itemId: string; status: string; response: string }>;
    const byId = new Map(rows.map((r) => [r.itemId, r] as const));
    expect(byId.get('item-A')?.response).toContain('kept');
    expect(byId.get('item-B')?.response).toContain('kept');
    expect(byId.get('item-C')?.status).toBe('completed');
    expect(byId.get('item-C')?.response).not.toContain('kept');
  });

  it('falls back to re-executing all items when no item file matches the finding', async () => {
    writeProjectFiles(['docs/a.md', 'docs/b.md']);
    writeSprint([
      { id: 'item-A', title: 'A', assignee: 'a', files: ['docs/a.md'] },
      { id: 'item-B', title: 'B', assignee: 'b', files: ['docs/b.md'] },
    ]);
    const runtime = { run: vi.fn().mockResolvedValue({ output: 'done', costUsd: 0.01 }) };
    const gateRetry = {
      attempt: 1,
      rationale: 'Gate rejected: unrelated',
      files: ['some/unrelated/file.ts'],
      findings: ['x'],
    };

    await runExecutePhase(makeCtx(runtime, gateRetry), {
      maxParallelism: 2,
      maxItemRetries: 0,
      disableWorktrees: true,
      selfEvalDisabled: true,
    });

    // No item matched → safe fallback: re-execute all (no regression vs old behavior).
    expect(runtime.run).toHaveBeenCalledTimes(2);
  });

  it('retries prior failed and blocked items plus dependent closure on gate retry', async () => {
    writeProjectFiles(['packages/a.ts', 'packages/b.ts', 'packages/c.ts']);
    writeSprint([
      { id: 'a', title: 'A', assignee: 'a-agent', files: ['packages/a.ts'], wave: 0 },
      { id: 'b', title: 'B depends on A', assignee: 'b-agent', files: ['packages/b.ts'], wave: 1, predecessors: ['a'] },
      { id: 'c', title: 'C independent', assignee: 'c-agent', files: ['packages/c.ts'], wave: 0 },
    ]);
    const calls: string[] = [];
    const runtime = {
      run: vi.fn().mockImplementation(async (agentId: string) => {
        calls.push(agentId);
        return { output: 'fixed', costUsd: 0.01 };
      }),
    };
    const gateRetry = {
      attempt: 1,
      rationale: 'Gate rejected after incomplete execute phase',
      failedItemIds: ['a'],
      blockedItemIds: ['b'],
      timeoutItemIds: ['a'],
      findings: ['a timed out; b was blocked by a'],
    };

    const result = await runExecutePhase(makeCtx(runtime, gateRetry), {
      maxParallelism: 2,
      maxItemRetries: 0,
      disableWorktrees: true,
      selfEvalDisabled: true,
    });

    expect(runtime.run).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(['a-agent', 'b-agent']);
    const rows = (result.itemResults ?? []) as Array<{ itemId: string; status: string; response: string }>;
    const byId = new Map(rows.map((r) => [r.itemId, r] as const));
    expect(byId.get('a')?.status).toBe('completed');
    expect(byId.get('b')?.status).toBe('completed');
    expect(byId.get('c')?.response).toContain('kept');
  });

  it('passes a bumped timeoutMs when a gate retry is recovering a timeout item', async () => {
    writeSprint([
      { id: 'item-A', title: 'A', assignee: 'a', files: [] },
    ]);
    const runtime = { run: vi.fn().mockResolvedValue({ output: 'done', costUsd: 0.01 }) };
    const gateRetry = {
      attempt: 1,
      rationale: 'Gate rejected after timeout',
      failedItemIds: ['item-A'],
      timeoutItemIds: ['item-A'],
    };

    await runExecutePhase(makeCtx(runtime, gateRetry), {
      maxParallelism: 1,
      maxItemRetries: 0,
      disableWorktrees: true,
      selfEvalDisabled: true,
      itemTimeoutMs: 100,
      retryTimeoutMultiplier: 3,
      retryTimeoutMaxMs: 250,
    });

    expect(runtime.run).toHaveBeenCalledWith(
      'a',
      expect.any(String),
      expect.objectContaining({ timeoutMs: 250 }),
    );
  });

  it('re-executes all items when there is no gate-retry (normal first pass)', async () => {
    writeProjectFiles(['docs/a.md', 'docs/b.md']);
    writeSprint([
      { id: 'item-A', title: 'A', assignee: 'a', files: ['docs/a.md'] },
      { id: 'item-B', title: 'B', assignee: 'b', files: ['docs/b.md'] },
    ]);
    const runtime = { run: vi.fn().mockResolvedValue({ output: 'done', costUsd: 0.01 }) };

    await runExecutePhase(makeCtx(runtime, undefined), {
      maxParallelism: 2,
      maxItemRetries: 0,
      disableWorktrees: true,
      selfEvalDisabled: true,
    });

    expect(runtime.run).toHaveBeenCalledTimes(2);
  });
});
