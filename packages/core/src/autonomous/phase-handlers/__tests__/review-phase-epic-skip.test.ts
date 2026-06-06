// P0.6(d) — on the objective/epic path the legacy code-reviewer review is
// skipped; the single strong-model epic review runs at the gate slot instead.
// This keeps the epic path at exactly ONE scheduled review call. Legacy (signal)
// cycles are untouched.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PhaseContext } from '../../phase-scheduler.js';
import { runReviewPhase } from '../review-phase.js';

let tmpRoot: string;
const cycleId = '33333333-3333-3333-3333-333333333333';

function phasesDir(): string {
  return join(tmpRoot, '.agentforge', 'cycles', cycleId, 'phases');
}

function makeCtx(withObjective: boolean): {
  ctx: PhaseContext;
  ran: { dispatched: boolean };
} {
  const ran = { dispatched: false };
  const ctx = {
    sprintId: 'sprint-1',
    sprintVersion: '1.0.0',
    projectRoot: tmpRoot,
    adapter: {},
    bus: { publish: () => {}, subscribe: () => () => {} },
    runtime: {
      run: async () => {
        ran.dispatched = true;
        return { output: '5/5 ship it', costUsd: 0.3 };
      },
    },
    cycleId,
    baseBranch: 'main',
    ...(withObjective ? { objective: 'Build the widget feature' } : {}),
  } as unknown as PhaseContext;
  return { ctx, ran };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-review-skip-'));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('runReviewPhase — epic skip (P0.6d)', () => {
  it('does NOT dispatch the code-reviewer when ctx.objective is set', async () => {
    const { ctx, ran } = makeCtx(true);
    const result = await runReviewPhase(ctx);
    expect(ran.dispatched).toBe(false);
    expect(result.status).toBe('completed');
    expect(result.costUsd).toBe(0);
    expect(result.agentRuns).toEqual([]);
  });

  it('writes review.json with skipped:true and a clear reason', async () => {
    const { ctx } = makeCtx(true);
    await runReviewPhase(ctx);
    const reviewJson = JSON.parse(readFileSync(join(phasesDir(), 'review.json'), 'utf8'));
    expect(reviewJson.skipped).toBe(true);
    expect(reviewJson.costUsd).toBe(0);
    expect(reviewJson.reason).toContain('epic path');
  });

  it('still dispatches the code-reviewer on the legacy path (no objective)', async () => {
    const { ctx, ran } = makeCtx(false);
    await runReviewPhase(ctx);
    expect(ran.dispatched).toBe(true);
    // Legacy review.json is the full shape, NOT a skipped marker.
    const reviewJson = JSON.parse(readFileSync(join(phasesDir(), 'review.json'), 'utf8'));
    expect(reviewJson.skipped).toBeUndefined();
    expect(existsSync(join(phasesDir(), 'review.json'))).toBe(true);
  });
});
