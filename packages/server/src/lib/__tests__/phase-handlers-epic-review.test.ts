// packages/server/src/lib/__tests__/phase-handlers-epic-review.test.ts
//
// Verifies that server/src/lib/phase-handlers.ts runReviewPhase correctly
// skips the code-reviewer dispatch when ctx.objective is present (P0.6),
// and falls through to the normal LLM dispatch on the legacy path.
//
// Contract mirrors packages/core/src/autonomous/phase-handlers/__tests__/
// review-phase-epic-skip.test.ts — the server handler must behave identically.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runReviewPhase } from '../phase-handlers.js';
import type { PhaseContext } from '../phase-handlers.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

let tmpRoot: string;
const CYCLE_ID = 'cccccccc-4444-4444-4444-cccccccccccc';

function phasesDir(): string {
  return join(tmpRoot, '.agentforge', 'cycles', CYCLE_ID, 'phases');
}

/**
 * Epic-path context — ctx.objective is set, and a runtime stub is provided
 * so we can detect whether the code-reviewer was dispatched.
 */
function makeEpicCtx(): { ctx: PhaseContext; ran: { dispatched: boolean } } {
  const ran = { dispatched: false };
  const ctx: PhaseContext = {
    sprintId: 'sprint-epic-review-test',
    sprintVersion: '1',
    projectRoot: tmpRoot,
    agentforgeDir: join(tmpRoot, '.agentforge'),
    bus: { publish: () => {} },
    cycleId: CYCLE_ID,
    objective: 'Build the widget feature end to end',
    baseBranch: 'main',
    runtime: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      run: async (_agentId: string, _task: string, _opts: any) => {
        ran.dispatched = true;
        return { output: '5/5 ship it', costUsd: 0.3 };
      },
    },
  };
  return { ctx, ran };
}

/**
 * Legacy-path context — no objective set, no runtime provided.
 * The legacy path reads the sprint file; since there is none in the tmp dir
 * it throws "Sprint v1 not found". That throw confirms the epic skip was NOT
 * taken and the code proceeded toward the normal LLM dispatch path.
 */
function makeLegacyCtx(): PhaseContext {
  return {
    sprintId: 'sprint-epic-review-test',
    sprintVersion: '1',
    projectRoot: tmpRoot,
    agentforgeDir: join(tmpRoot, '.agentforge'),
    bus: { publish: () => {} },
    cycleId: CYCLE_ID,
    // objective intentionally absent → legacy path
  } as PhaseContext;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-server-epic-review-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runReviewPhase — epic-skip (P0.6)', () => {
  it('does NOT dispatch the code-reviewer when ctx.objective is set', async () => {
    const { ctx, ran } = makeEpicCtx();
    const result = await runReviewPhase(ctx);

    expect(ran.dispatched).toBe(false);
    expect(result.status).toBe('completed');
    expect(result.costUsd).toBe(0);
    expect(result.agentRuns).toEqual([]);
  });

  it('writes review.json with skipped:true and a reason containing "epic path"', async () => {
    const { ctx } = makeEpicCtx();
    await runReviewPhase(ctx);

    const reviewJsonPath = join(phasesDir(), 'review.json');
    expect(existsSync(reviewJsonPath)).toBe(true);

    const reviewJson = JSON.parse(readFileSync(reviewJsonPath, 'utf8'));
    expect(reviewJson.skipped).toBe(true);
    expect(reviewJson.costUsd).toBe(0);
    expect(reviewJson.reason).toContain('epic path');
  });

  it('falls through to the LLM dispatch on the legacy path (no objective)', async () => {
    // No sprint file exists in tmpRoot → runLlmPhase throws "Sprint v1 not found".
    // This confirms the epic-skip was NOT taken (otherwise the function would
    // have returned early with status:'completed' before touching the sprint).
    const ctx = makeLegacyCtx();
    await expect(runReviewPhase(ctx)).rejects.toThrow(/Sprint.*not found/);

    // No skipped marker should have been written on the legacy path.
    expect(existsSync(join(phasesDir(), 'review.json'))).toBe(false);
  });
});
