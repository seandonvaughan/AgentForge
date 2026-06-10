/**
 * Cycle 5242ca92 — resume defects in the execute phase.
 *
 * 1. On `--resume`, the checkpoint contract (#282) is the ONLY authority on
 *    what is skippable: items whose id is NOT in checkpoint-execute.json's
 *    completedItemIds must be dispatched regardless of the status the failed
 *    attempt persisted into plan.json ('failed', 'blocked', ...). The observed
 *    failure re-entered execute with totalItems:0 and completed vacuously.
 *
 * 2. A resumed EPIC where EVERY item is already completed dispatches nothing,
 *    but the phase result must STILL carry the epicIntegration signal (branch
 *    + epicId) — without it the cycle-runner fell through to the legacy
 *    main-tree release path (which shipped the operator's untracked files as
 *    PR #307). ensureIntegrationWorktree is idempotent, so the existing
 *    integration branch/worktree is resolved even with no worktree pool.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { PhaseContext } from '../../phase-scheduler.js';
import { runExecutePhase } from '../execute-phase.js';
import {
  epicIntegrationBranchName,
  integrationWorktreePathFor,
} from '../wave-integration.js';

const execFile = promisify(execFileCb);

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-exec-resume-'));
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

function makeCtx(bus: Bus, cycleId: string, runtime: PhaseContext['runtime']): PhaseContext {
  return {
    projectRoot: tmpRoot,
    sprintId: 'sprint-resume-1',
    sprintVersion: '1.0.0',
    cycleId,
    baseBranch: 'main',
    adapter: undefined as any,
    bus,
    runtime,
  } as PhaseContext;
}

interface PlanItemFixture {
  id: string;
  status: string;
  parentEpicId?: string;
  wave?: number;
}

function writePlan(cycleId: string, items: PlanItemFixture[]): void {
  const cycleDir = join(tmpRoot, '.agentforge', 'cycles', cycleId);
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(
    join(cycleDir, 'plan.json'),
    JSON.stringify({
      version: '1.0.0',
      sprintId: 'sprint-resume-1',
      items: items.map((i) => ({
        id: i.id,
        title: `Item ${i.id}`,
        assignee: 'scorer',
        status: i.status,
        tags: ['scoring'],
        description: `Description for ${i.id}`,
        ...(i.parentEpicId !== undefined ? { parentEpicId: i.parentEpicId } : {}),
        ...(i.wave !== undefined ? { wave: i.wave } : {}),
      })),
    }),
  );
}

/** Write a schemaVersion:2 checkpoint-execute.json (the #282 contract file). */
function writeCheckpoint(cycleId: string, completedItemIds: string[], totalItems: number): void {
  const cycleDir = join(tmpRoot, '.agentforge', 'cycles', cycleId);
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(
    join(cycleDir, 'checkpoint-execute.json'),
    JSON.stringify({
      cycleId,
      phase: 'execute',
      completedItemIds,
      currentItemId: null,
      totalItems,
      lastUpdatedAt: new Date().toISOString(),
      schemaVersion: 2,
    }),
  );
}

async function initGitRepo(dir: string): Promise<void> {
  await execFile('git', ['init', '-b', 'main'], { cwd: dir });
  await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFile('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'shared.txt'), 'baseline\n');
  await execFile('git', ['add', '.'], { cwd: dir });
  await execFile('git', ['commit', '-m', 'initial'], { cwd: dir });
}

describe('execute phase — resume dispatches every non-completed item (cycle 5242ca92)', () => {
  it("dispatches items stored as 'failed'/'blocked' when they are not in completedItemIds", async () => {
    const cycleId = 'cycle-resume-defect1';
    writePlan(cycleId, [
      { id: 'child-001', status: 'completed' },
      { id: 'child-004', status: 'failed' },
      { id: 'child-021', status: 'blocked' },
    ]);
    // The prior crashed run completed ONLY child-001. The failed/blocked
    // statuses in plan.json must NOT shrink the resumable dispatch set.
    writeCheckpoint(cycleId, ['child-001'], 3);

    const bus = makeBus();
    const runtime = {
      run: vi.fn().mockResolvedValue({ output: 'done', costUsd: 0.01, status: 'completed' }),
    };
    const ctx = makeCtx(bus, cycleId, runtime);

    const result = await runExecutePhase(ctx, {
      resume: true,
      maxParallelism: 2,
      maxItemRetries: 0,
      disableWorktrees: true,
      disableChildVerify: true,
      selfEvalDisabled: true,
    });

    // Both non-completed items were dispatched; the completed one was skipped.
    expect(runtime.run).toHaveBeenCalledTimes(2);
    const dispatchedIds = runtime.run.mock.calls.map((c: unknown[]) => String(c[1]));
    expect(dispatchedIds.some((t) => t.includes('child-004'))).toBe(true);
    expect(dispatchedIds.some((t) => t.includes('child-021'))).toBe(true);

    // totalItems reflects the FULL plan, not a status-filtered subset.
    expect(result.itemResults).toHaveLength(3);
    const phaseJson = JSON.parse(
      readFileSync(
        join(tmpRoot, '.agentforge', 'cycles', cycleId, 'phases', 'execute.json'),
        'utf8',
      ),
    );
    expect(phaseJson.totalItems).toBe(3);

    const byId = new Map(
      (result.itemResults ?? []).map((r: any) => [r.itemId, r]),
    );
    // The checkpointed item is skipped without re-dispatch.
    expect((byId.get('child-001') as any).response).toContain('skipped');
    expect((byId.get('child-001') as any).attempts).toBe(0);
    // The previously failed/blocked items ran for real.
    expect((byId.get('child-004') as any).status).toBe('completed');
    expect((byId.get('child-021') as any).status).toBe('completed');
    expect(result.status).toBe('completed');
  });

  it('does NOT reset statuses when resume is not set (non-resume runs unchanged)', async () => {
    const cycleId = 'cycle-resume-off-1';
    writePlan(cycleId, [
      { id: 'child-101', status: 'planned' },
      { id: 'child-102', status: 'planned' },
    ]);

    const bus = makeBus();
    const runtime = {
      run: vi.fn().mockResolvedValue({ output: 'done', costUsd: 0.01, status: 'completed' }),
    };
    const ctx = makeCtx(bus, cycleId, runtime);

    const result = await runExecutePhase(ctx, {
      maxParallelism: 2,
      maxItemRetries: 0,
      disableWorktrees: true,
      disableChildVerify: true,
      selfEvalDisabled: true,
    });

    expect(runtime.run).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('completed');
  });
});

describe('execute phase — all-skipped epic resume still surfaces epicIntegration (cycle 5242ca92)', () => {
  const EPIC_ID = 'epic-resume';

  it('resolves the existing integration branch and sets epicIntegration with zero dispatches', async () => {
    const cycleId = 'cycle-epic-resume-1';
    await initGitRepo(tmpRoot);
    const branch = epicIntegrationBranchName(EPIC_ID);
    // The original run already created the integration branch with the
    // children's merged work; the resume only needs to re-resolve it.
    await execFile('git', ['branch', branch, 'main'], { cwd: tmpRoot });

    writePlan(cycleId, [
      { id: 'child-201', status: 'completed', parentEpicId: EPIC_ID, wave: 0 },
      { id: 'child-202', status: 'completed', parentEpicId: EPIC_ID, wave: 1 },
    ]);
    writeCheckpoint(cycleId, ['child-201', 'child-202'], 2);

    const bus = makeBus();
    const runtime = {
      run: vi.fn().mockResolvedValue({ output: 'should never run', costUsd: 0 }),
    };
    const ctx = makeCtx(bus, cycleId, runtime);

    const result = await runExecutePhase(ctx, {
      resume: true,
      maxItemRetries: 0,
      // No worktree pool in ctx AND worktrees disabled — the all-skipped epic
      // resume must STILL resolve the integration branch for the release stage.
      disableWorktrees: true,
      disableChildVerify: true,
      selfEvalDisabled: true,
    });

    // Nothing was dispatched — every item was checkpoint-completed.
    expect(runtime.run).not.toHaveBeenCalled();
    expect(result.status).toBe('completed');

    // The phase result is NOT vacuous: the epic signal is present so the
    // release stage pushes codex/epic-<id> instead of the legacy main tree.
    const epic = (result as any).epicIntegration;
    expect(epic).toBeDefined();
    expect(epic.branch).toBe(branch);
    expect(epic.epicId).toBe(EPIC_ID);
    expect(existsSync(integrationWorktreePathFor(tmpRoot, branch))).toBe(true);

    // The persisted artifact carries the signal too (the cycle-runner disk
    // fallback reads it from phases/execute.json).
    const phaseJson = JSON.parse(
      readFileSync(
        join(tmpRoot, '.agentforge', 'cycles', cycleId, 'phases', 'execute.json'),
        'utf8',
      ),
    );
    expect(phaseJson.epicIntegration?.branch).toBe(branch);
    expect(phaseJson.epicIntegration?.epicId).toBe(EPIC_ID);
  });
});
