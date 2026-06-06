/**
 * P0.4 — KEYSTONE. Epic wave-integration behaviour in the execute phase.
 *
 * Verifies that:
 *  1. Clean (disjoint) child branches all merge into the integration branch and
 *     the phase surfaces an `epicIntegration` signal naming them, with the
 *     integration worktree LEFT IN PLACE (release pushes/removes it later).
 *  2. A conflicting child's wave-merge is a HARD signal: the owning item is
 *     marked `failed` with an explicit conflict error AND the
 *     `execute.epic.wave-merge-conflict` event still fires.
 *
 * Uses a REAL WorktreePool + real git so the merge logic is exercised end-to-end.
 * No `origin` remote is configured, so agent-commit's push step is skipped
 * cleanly (local-only) — exactly the unit-test contract in agent-commit.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { PhaseContext } from '../../phase-scheduler.js';
import { runExecutePhase } from '../execute-phase.js';
import { WorktreePool } from '../../../runtime/worktree-pool.js';
import {
  epicIntegrationBranchName,
  integrationWorktreePathFor,
} from '../wave-integration.js';

const execFile = promisify(execFileCb);

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-epic-'));
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
  // A baseline file all child branches start from.
  writeFileSync(join(dir, 'shared.txt'), 'baseline\n');
  await execFile('git', ['add', '.'], { cwd: dir });
  await execFile('git', ['commit', '-m', 'initial'], { cwd: dir });
}

const EPIC_ID = 'epic-keystone';

function writeEpicPlan(
  items: Array<{ id: string; assignee: string; wave: number }>,
  cycleId: string,
): void {
  const data = {
    version: '1.0.0',
    sprintId: 'sprint-epic-1',
    items: items.map((i) => ({
      id: i.id,
      title: `Item ${i.id}`,
      assignee: i.assignee,
      status: 'planned',
      tags: ['coder'],
      description: `Description for ${i.id}`,
      wave: i.wave,
      parentEpicId: EPIC_ID,
    })),
  };
  const cycleDir = join(tmpRoot, '.agentforge', 'cycles', cycleId);
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(join(cycleDir, 'plan.json'), JSON.stringify(data));
}

function makeCtx(bus: Bus, cycleId: string, runtime: PhaseContext['runtime']): PhaseContext {
  return {
    projectRoot: tmpRoot,
    sprintId: 'sprint-epic-1',
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

describe('execute phase — epic wave integration (P0.4)', () => {
  it('merges disjoint children, surfaces epicIntegration, and leaves the integration worktree in place', async () => {
    const cycleId = 'cycle-epic-clean';
    await initGitRepo(tmpRoot);
    writeEpicPlan(
      [
        { id: 'c1', assignee: 'coder', wave: 0 },
        { id: 'c2', assignee: 'coder', wave: 0 },
      ],
      cycleId,
    );

    const bus = makeBus();
    // Each child writes a DISJOINT file in its own worktree → no conflicts.
    const runtime = {
      run: vi.fn().mockImplementation(async (_agentId: string, task: string, opts: { cwd?: string }) => {
        if (!opts.cwd) throw new Error('missing worktree cwd');
        const file = task.includes('c1') ? 'a.ts' : 'b.ts';
        writeFileSync(join(opts.cwd, file), `export const x = '${file}';\n`);
        return { output: 'done', costUsd: 0.01 };
      }),
    };
    const ctx = makeCtx(bus, cycleId, runtime);

    const result = await runExecutePhase(ctx, {
      maxParallelism: 2,
      maxItemRetries: 0,
      requireWorktrees: true,
      // P0.5: this suite exercises ONLY the P0.4 wave-merge path on a bare git
      // repo with no build/test environment; the per-child deterministic verify
      // bar (typecheck + scoped tests) is covered in execute-phase-child-verify.
      disableChildVerify: true,
    });

    expect(result.status).toBe('completed');
    // The epic signal is surfaced on the phase result.
    const epic = (result as any).epicIntegration;
    expect(epic).toBeDefined();
    expect(epic.branch).toBe(epicIntegrationBranchName(EPIC_ID));
    expect(epic.epicId).toBe(EPIC_ID);
    expect(epic.hadConflicts).toBe(false);
    expect(epic.mergedBranches.length).toBe(2);

    // KEYSTONE: the integration worktree is NOT removed by the execute phase —
    // it must survive until the cycle-runner's release stage pushes + opens the PR.
    const intWtPath = integrationWorktreePathFor(tmpRoot, epic.branch);
    expect(existsSync(intWtPath)).toBe(true);
    // Both children's files landed on the integration branch.
    expect(existsSync(join(intWtPath, 'a.ts'))).toBe(true);
    expect(existsSync(join(intWtPath, 'b.ts'))).toBe(true);
  });

  it('marks a conflicted child failed with an explicit error AND still publishes the conflict event', async () => {
    const cycleId = 'cycle-epic-conflict';
    await initGitRepo(tmpRoot);
    writeEpicPlan(
      [
        { id: 'c1', assignee: 'coder', wave: 0 },
        { id: 'c2', assignee: 'coder', wave: 0 },
      ],
      cycleId,
    );

    const bus = makeBus();
    // Both children edit the SAME baseline file with DIFFERENT content →
    // the first merges, the second conflicts on wave integration.
    const runtime = {
      run: vi.fn().mockImplementation(async (_agentId: string, task: string, opts: { cwd?: string }) => {
        if (!opts.cwd) throw new Error('missing worktree cwd');
        const content = task.includes('c1') ? 'from-c1\n' : 'from-c2\n';
        writeFileSync(join(opts.cwd, 'shared.txt'), content);
        return { output: 'done', costUsd: 0.01 };
      }),
    };
    const ctx = makeCtx(bus, cycleId, runtime);

    const result = await runExecutePhase(ctx, {
      maxParallelism: 1, // deterministic order: c1 commits before c2
      maxItemRetries: 0,
      requireWorktrees: true,
      // P0.5: see note above — wave-merge-only suite, no build/test env.
      disableChildVerify: true,
    });

    // The conflict event still fires.
    const conflictEvents = bus.events.filter((e) => e.topic === 'execute.epic.wave-merge-conflict');
    expect(conflictEvents.length).toBe(1);
    const conflicted = (conflictEvents[0]!.payload as any).conflicted as string[];
    expect(conflicted.length).toBe(1);

    // Exactly one item is failed, with an explicit conflict error naming the branch.
    const items = (result.itemResults ?? []) as Array<{ itemId: string; status: string; error?: string }>;
    const failed = items.filter((r) => r.status === 'failed');
    expect(failed.length).toBe(1);
    expect(failed[0]!.error).toContain('Epic wave-merge conflict');
    expect(failed[0]!.error).toContain(epicIntegrationBranchName(EPIC_ID));
    // The conflicted branch in the event belongs to the failed item's owner.
    expect(conflicted[0]).toContain('codex/');

    // The epic signal records that conflicts happened.
    const epic = (result as any).epicIntegration;
    expect(epic.hadConflicts).toBe(true);
  });
});
