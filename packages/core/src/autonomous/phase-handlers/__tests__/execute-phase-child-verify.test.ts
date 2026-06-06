/**
 * P0.5 — execute-phase wiring of the DETERMINISTIC per-child completion bar.
 *
 * Uses a REAL WorktreePool + real git (same harness as
 * execute-phase-epic-integration.test.ts) so the worktree allocation, diff
 * capture, and wave-merge run end-to-end. The per-child verify *command runner*
 * is mocked via ExecutePhaseOptions.childVerifyRunner so the test controls
 * verify pass/fail without spawning tsc/vitest.
 *
 * Asserts:
 *   1. An epic child whose scoped verify FAILS is marked `failed` and its branch
 *      is NOT merged into the integration branch (its file never lands there).
 *   2. A passing sibling still completes and merges.
 *   3. A CI-config-class child touch surfaces requiresFullGates on the phase's
 *      epicIntegration result.
 *   4. Flat (non-epic) cycles never invoke the child-verify runner.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { PhaseContext } from '../../phase-scheduler.js';
import { runExecutePhase } from '../execute-phase.js';
import type { ChildVerifyCommandRunner } from '../child-verify.js';
import { WorktreePool } from '../../../runtime/worktree-pool.js';
import {
  epicIntegrationBranchName,
  integrationWorktreePathFor,
} from '../wave-integration.js';

const execFile = promisify(execFileCb);

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-child-verify-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeBus() {
  const events: Array<{ topic: string; payload: unknown }> = [];
  return {
    publish: (topic: string, payload: unknown) => { events.push({ topic, payload }); },
    subscribe: (_t: string, _cb: (e: unknown) => void) => () => {},
    events,
  };
}

type Bus = ReturnType<typeof makeBus>;

async function initGitRepo(dir: string): Promise<void> {
  await execFile('git', ['init', '-b', 'main'], { cwd: dir });
  await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFile('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'shared.txt'), 'baseline\n');
  await execFile('git', ['add', '.'], { cwd: dir });
  await execFile('git', ['commit', '-m', 'initial'], { cwd: dir });
}

const EPIC_ID = 'epic-child-verify';

function writeEpicPlan(
  items: Array<{ id: string; assignee: string; wave: number; files?: string[] }>,
  cycleId: string,
): void {
  const data = {
    version: '1.0.0',
    sprintId: 'sprint-cv-1',
    items: items.map((i) => ({
      id: i.id,
      title: `Item ${i.id}`,
      assignee: i.assignee,
      status: 'planned',
      tags: ['coder'],
      description: `Description for ${i.id}`,
      wave: i.wave,
      parentEpicId: EPIC_ID,
      ...(i.files ? { files: i.files } : {}),
    })),
  };
  const cycleDir = join(tmpRoot, '.agentforge', 'cycles', cycleId);
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(join(cycleDir, 'plan.json'), JSON.stringify(data));
}

function writeFlatPlan(
  items: Array<{ id: string; assignee: string }>,
  cycleId: string,
): void {
  const data = {
    version: '1.0.0',
    sprintId: 'sprint-cv-flat',
    items: items.map((i) => ({
      id: i.id,
      title: `Item ${i.id}`,
      assignee: i.assignee,
      status: 'planned',
      tags: ['scoring'],
      description: `Description for ${i.id}`,
    })),
  };
  const cycleDir = join(tmpRoot, '.agentforge', 'cycles', cycleId);
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(join(cycleDir, 'plan.json'), JSON.stringify(data));
}

function makeCtx(bus: Bus, cycleId: string, runtime: PhaseContext['runtime']): PhaseContext {
  return {
    projectRoot: tmpRoot,
    sprintId: 'sprint-cv-1',
    sprintVersion: '1.0.0',
    cycleId,
    baseBranch: 'main',
    adapter: undefined as any,
    bus,
    runtime,
    worktreePool: new WorktreePool({
      projectRoot: tmpRoot,
      baseBranch: 'main',
      branchPrefix: 'codex/',
      rootDir: '.agentforge/worktrees',
    }),
  } as PhaseContext;
}

describe('execute phase — per-child verify wiring (P0.5)', () => {
  it('fails a child whose scoped verify fails and does NOT merge its branch', async () => {
    const cycleId = 'cycle-cv-fail';
    await initGitRepo(tmpRoot);
    writeEpicPlan(
      [
        { id: 'c1', assignee: 'coder', wave: 0, files: ['a.ts'] },
        { id: 'c2', assignee: 'coder', wave: 0, files: ['b.ts'] },
      ],
      cycleId,
    );

    const bus = makeBus();
    // Each child writes a disjoint file so the wave-merge itself never conflicts.
    const runtime = {
      run: vi.fn().mockImplementation(async (_agentId: string, task: string, opts: { cwd?: string }) => {
        if (!opts.cwd) throw new Error('missing worktree cwd');
        const file = task.includes('"Item c1"') ? 'a.ts' : 'b.ts';
        writeFileSync(join(opts.cwd, file), `export const x = '${file}';\n`);
        return { output: 'done', costUsd: 0.01 };
      }),
    };

    // Verify runner: c1's worktree (contains a.ts) FAILS the scoped test run;
    // c2 (b.ts) passes everything. We key off the changed file in cwd via the
    // affected-test args the bar passes (`related --run <file>`).
    const childVerifyRunner: ChildVerifyCommandRunner = async (_cmd, args) => {
      const failsForC1 = args.includes('a.ts') && args.includes('related');
      if (failsForC1) return { ok: false, code: 1, output: 'FAIL a.ts\nAssertionError' };
      return { ok: true, code: 0, output: '' };
    };

    const ctx = makeCtx(bus, cycleId, runtime);
    const result = await runExecutePhase(ctx, {
      maxParallelism: 2,
      maxItemRetries: 0,
      requireWorktrees: true,
      childVerifyRunner,
    });

    const items = (result.itemResults ?? []) as Array<{ itemId: string; status: string; error?: string }>;
    const c1 = items.find((r) => r.itemId === 'c1')!;
    const c2 = items.find((r) => r.itemId === 'c2')!;

    // c1 failed the per-child verify; c2 completed.
    expect(c1.status).toBe('failed');
    expect(c1.error).toContain('Per-child verify failed');
    expect(c2.status).toBe('completed');

    // The verify event fired for both children.
    const verifyEvents = bus.events.filter((e) => e.topic === 'execute.child.verified');
    expect(verifyEvents.length).toBe(2);

    // c1's file must NOT land on the integration branch; c2's must.
    const epic = (result as any).epicIntegration;
    expect(epic).toBeDefined();
    const intWtPath = integrationWorktreePathFor(tmpRoot, epic.branch);
    expect(existsSync(join(intWtPath, 'a.ts'))).toBe(false);
    expect(existsSync(join(intWtPath, 'b.ts'))).toBe(true);
    expect(epic.mergedBranches.length).toBe(1);
  });

  it('surfaces requiresFullGates when a child touches a CI-config-class file', async () => {
    const cycleId = 'cycle-cv-cigates';
    await initGitRepo(tmpRoot);
    // c1 writes a scripts/ file (CI-config class) → requiresFullGates.
    writeEpicPlan([{ id: 'c1', assignee: 'coder', wave: 0 }], cycleId);

    const bus = makeBus();
    const runtime = {
      run: vi.fn().mockImplementation(async (_agentId: string, _task: string, opts: { cwd?: string }) => {
        if (!opts.cwd) throw new Error('missing worktree cwd');
        mkdirSync(join(opts.cwd, 'scripts'), { recursive: true });
        writeFileSync(join(opts.cwd, 'scripts', 'gen.mjs'), 'export const v = 1;\n');
        return { output: 'done', costUsd: 0.01 };
      }),
    };
    const ctx = makeCtx(bus, cycleId, runtime);

    const result = await runExecutePhase(ctx, {
      maxParallelism: 1,
      maxItemRetries: 0,
      requireWorktrees: true,
      // All commands pass — we only care about the requiresFullGates flag.
      childVerifyRunner: async () => ({ ok: true, code: 0, output: '' }),
    });

    const epic = (result as any).epicIntegration;
    expect(epic).toBeDefined();
    expect(epic.requiresFullGates).toBe(true);
    expect(result.status).toBe('completed');
  });

  it('does NOT run the child-verify runner for a flat (non-epic) cycle', async () => {
    const cycleId = 'cycle-cv-flat';
    await initGitRepo(tmpRoot);
    writeFlatPlan([{ id: 'f1', assignee: 'scorer' }], cycleId);

    const bus = makeBus();
    // Flat, non-coder item on the shared tree (no worktree isolation) — mirrors
    // the waves-suite flat path. The point is purely that the verify hook is
    // inert when there is no parentEpicId.
    const runtime = {
      run: vi.fn().mockResolvedValue({ output: 'done', costUsd: 0.01, status: 'completed' }),
    };
    const childVerifyRunner = vi.fn<ChildVerifyCommandRunner>(async () => ({ ok: true, code: 0, output: '' }));
    const ctx = makeCtx(bus, cycleId, runtime);

    const result = await runExecutePhase(ctx, {
      maxParallelism: 1,
      maxItemRetries: 0,
      childVerifyRunner,
    });

    // Flat cycle: the per-child verify hook is inert (no parentEpicId).
    expect(childVerifyRunner).not.toHaveBeenCalled();
    const verifyEvents = bus.events.filter((e) => e.topic === 'execute.child.verified');
    expect(verifyEvents.length).toBe(0);
    expect(result.status).toBe('completed');
    expect((result as any).epicIntegration).toBeUndefined();
  });
});
