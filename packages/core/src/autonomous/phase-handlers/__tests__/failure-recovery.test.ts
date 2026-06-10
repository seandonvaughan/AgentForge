// W5 — structured failure recovery: taxonomy, blocked cascade, evidence-rich
// retries. Mirrors the progress-events harness (mock bus + stub runtime).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PhaseContext } from '../../phase-scheduler.js';
import { deriveFailureClass, buildItemPrompt } from '../execute-phase.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'af-failure-recovery-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeBus() {
  const events: Array<{ topic: string; payload: unknown }> = [];
  return {
    publish: (topic: string, payload: unknown) => { events.push({ topic, payload }); },
    subscribe: () => () => {},
    events,
  };
}

function makeCtx(bus: ReturnType<typeof makeBus>, overrides: Partial<PhaseContext> = {}): PhaseContext {
  return {
    projectRoot: tmpRoot,
    sprintId: 'sprint-1',
    sprintVersion: '1.0.0',
    cycleId: 'cycle-0001',
    adapter: undefined as never,
    bus,
    runtime: { run: vi.fn().mockResolvedValue({ output: 'ok', costUsd: 0.01, status: 'completed' }) },
    ...overrides,
  } as PhaseContext;
}

function writeSprintFile(
  items: Array<Record<string, unknown>>,
  cycleId = 'cycle-0001',
): void {
  const data = { version: '1.0.0', sprintId: 'sprint-1', items };
  const sprintsDir = join(tmpRoot, '.agentforge', 'sprints');
  mkdirSync(sprintsDir, { recursive: true });
  writeFileSync(join(sprintsDir, 'v1.0.0.json'), JSON.stringify(data));
  const cycleDir = join(tmpRoot, '.agentforge', 'cycles', cycleId);
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(join(cycleDir, 'plan.json'), JSON.stringify(data));
}

describe('deriveFailureClass', () => {
  it.each([
    ['Per-child verify failed:\n[deps/failure] install failed', 'deps'],
    ['Per-child verify failed:\n[typecheck/failure] TS2339', 'typecheck'],
    ['Per-child verify failed:\n[tests/failure] 3 failed', 'tests'],
    ['Per-child verify failed:\n[scope/failure] touched undeclared file', 'scope'],
    ['Agent coder produced no source changes for item x', 'iron-law'],
    ['Worktree allocation failed for coder on item-1: boom', 'worktree'],
    ['429 Too Many Requests — rate limit', 'provider'],
    ['request timed out after 600000ms', 'timeout'],
    ['insufficient_quota: billing hard limit reached', 'budget'],
    ['some inexplicable explosion', 'unknown'],
    [undefined, 'unknown'],
  ])('classifies %j as %s', (error, expected) => {
    expect(deriveFailureClass(error as string | undefined)).toBe(expected);
  });
});

describe('evidence-rich retry prompt', () => {
  it('labels the failure class and splices class-specific guidance', () => {
    const item = { id: 'i1', title: 'T', description: 'd', assignee: 'coder', status: 'planned' } as never;
    const prompt = buildItemPrompt(
      item,
      tmpRoot,
      1,
      'Per-child verify failed:\n[scope/failure] touched src/index.ts (undeclared)',
    );
    expect(prompt).toContain('PREVIOUS ATTEMPT FAILED (class: scope)');
    expect(prompt).toContain('files[] contract');
  });
});

describe('blocked cascade', () => {
  it('marks dependents of a failed child as blocked without dispatching them', async () => {
    writeSprintFile([
      { id: 'a', title: 'TASK-ALPHA', assignee: 'coder', status: 'planned', wave: 0, predecessors: [] },
      { id: 'b', title: 'TASK-BRAVO', assignee: 'coder', status: 'planned', wave: 1, predecessors: ['a'] },
      { id: 'c', title: 'TASK-CHARLIE', assignee: 'coder', status: 'planned', wave: 1, predecessors: [] },
    ]);

    const bus = makeBus();
    const dispatched: string[] = [];
    const ctx = makeCtx(bus, {
      runtime: {
        run: vi.fn().mockImplementation(async (_agent: string, task: string) => {
          const id = task.includes('TASK-ALPHA') ? 'a' : task.includes('TASK-BRAVO') ? 'b' : 'c';
          dispatched.push(id);
          if (id === 'a') throw new Error('TS2339: kaboom');
          return { output: 'ok', costUsd: 0.01, status: 'completed' };
        }),
      } as never,
    });

    const { runExecutePhase } = await import('../execute-phase.js');
    const result = await runExecutePhase(ctx, { maxItemRetries: 0 });

    // b was never dispatched; a failed; c (independent, same wave as b) ran.
    const exec = JSON.parse(
      readFileSync(join(tmpRoot, '.agentforge', 'cycles', 'cycle-0001', 'phases', 'execute.json'), 'utf8'),
    );
    const byId = new Map((exec.itemResults as Array<{ itemId: string; status: string; failureClass?: string; error?: string }>).map((r) => [r.itemId, r]));
    expect(byId.get('a')!.status).toBe('failed');
    expect(byId.get('b')!.status).toBe('blocked');
    expect(byId.get('b')!.error).toContain('predecessor a');
    expect(byId.get('c')!.status).toBe('completed');
    expect(dispatched.filter((d) => d === 'a').length).toBeGreaterThanOrEqual(1);
    expect(dispatched).not.toContain('b');

    // blocked event published
    expect(bus.events.some((e) => e.topic === 'sprint.phase.item.blocked')).toBe(true);

    // blocked is checkpointed as 'skipped' (resumable) — never as completed.
    const checkpoint = JSON.parse(
      readFileSync(join(tmpRoot, '.agentforge', 'cycles', 'cycle-0001', 'checkpoint-execute.json'), 'utf8'),
    );
    expect(checkpoint.completedItemIds).not.toContain('b');

    // phase status: 1 of 3 failed (33% < default failure-rate cap) and blocked
    // does not count as a failure → completed.
    expect(result.status).toBe('completed');
  });

  it('failed results carry the derived failureClass into execute.json', async () => {
    writeSprintFile([
      { id: 'a', title: 'A', assignee: 'coder', status: 'planned' },
    ]);
    const bus = makeBus();
    const ctx = makeCtx(bus, {
      runtime: { run: vi.fn().mockRejectedValue(new Error('request timed out after 60000ms')) } as never,
    });
    const { runExecutePhase } = await import('../execute-phase.js');
    await runExecutePhase(ctx, { maxItemRetries: 0 });
    const exec = JSON.parse(
      readFileSync(join(tmpRoot, '.agentforge', 'cycles', 'cycle-0001', 'phases', 'execute.json'), 'utf8'),
    );
    expect((exec.itemResults as Array<{ failureClass?: string }>)[0]!.failureClass).toBe('timeout');
  });
});
