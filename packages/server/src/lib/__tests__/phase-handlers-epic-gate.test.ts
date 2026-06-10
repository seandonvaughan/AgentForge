// packages/server/src/lib/__tests__/phase-handlers-epic-gate.test.ts
//
// Verifies that server/src/lib/phase-handlers.ts runGatePhase correctly
// delegates to the core epic-review path when ctx.objective is present,
// and falls back to the unchanged legacy path otherwise.
//
// Detection mirrors the pattern in @agentforge/core gate-phase.ts (P0.6).
// The canonical proof that the epic path ran is the presence of
// phases/epic-review.json, which only runEpicReview writes.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runGatePhase } from '../phase-handlers.js';
import type { PhaseContext } from '../phase-handlers.js';
import { GateRejectedError } from '@agentforge/core';

// ── Test fixtures ─────────────────────────────────────────────────────────────

let tmpRoot: string;
const CYCLE_ID = 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb';

function phasesDir(): string {
  return join(tmpRoot, '.agentforge', 'cycles', CYCLE_ID, 'phases');
}

/** Write a minimal plan.json so runEpicReview can load plan items. */
function writePlan(items: Array<{ id: string; title: string }>): void {
  const cycleDir = join(tmpRoot, '.agentforge', 'cycles', CYCLE_ID);
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(
    join(cycleDir, 'plan.json'),
    JSON.stringify({
      version: '1.0.0',
      sprintId: 'sprint-epic-gate-test',
      items: items.map((i) => ({
        id: i.id,
        title: i.title,
        description: `implement ${i.title}`,
        files: [],
        status: 'completed',
      })),
    }),
  );
}

/**
 * Write a minimal phases/execute.json carrying epicIntegration so
 * loadEpicIntegration (inside runEpicReview) can resolve the branch.
 */
function writeExecuteJson(): void {
  mkdirSync(phasesDir(), { recursive: true });
  writeFileSync(
    join(phasesDir(), 'execute.json'),
    JSON.stringify({
      phase: 'execute',
      status: 'completed',
      costUsd: 1.0,
      epicIntegration: {
        branch: 'codex/epic-test-branch',
        epicId: 'epic-test',
      },
    }),
  );
}

/**
 * Build a PhaseContext for the epic path. The runtime stub captures calls and
 * returns the structured output provided by `runImpl`.
 */
function makeEpicCtx(
  runImpl: (agentId: string, task: string, opts: Record<string, unknown>) => Promise<unknown>,
): PhaseContext {
  return {
    sprintId: 'sprint-epic-gate-test',
    sprintVersion: '1',
    projectRoot: tmpRoot,
    agentforgeDir: join(tmpRoot, '.agentforge'),
    bus: { publish: () => {} },
    cycleId: CYCLE_ID,
    objective: 'Build the widget feature end to end',
    baseBranch: 'main',
    runtime: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      run: async (agentId: string, task: string, opts: any) => runImpl(agentId, task, opts),
    },
  } as PhaseContext;
}

/**
 * Build a PhaseContext for the legacy path — no objective, no runtime.
 * The legacy path will attempt to load the 'ceo' agent config which does
 * not exist in the tmp dir, so it will throw. That throw is EXPECTED — we
 * only care that the epic path was not taken (no epic-review.json written).
 */
function makeLegacyCtx(): PhaseContext {
  return {
    sprintId: 'sprint-epic-gate-test',
    sprintVersion: '1',
    projectRoot: tmpRoot,
    agentforgeDir: join(tmpRoot, '.agentforge'),
    bus: { publish: () => {} },
    cycleId: CYCLE_ID,
    // objective intentionally absent → legacy path
  } as PhaseContext;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-server-epic-gate-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runGatePhase — epic-path delegation', () => {
  it('takes the epic branch when ctx.objective is set — APPROVE path', async () => {
    writePlan([{ id: 'item-1', title: 'widget feature' }]);
    writeExecuteJson();

    const ctx = makeEpicCtx(async () => ({
      output: JSON.stringify({
        verdict: 'APPROVE',
        rationale: 'All acceptance criteria met for widget feature',
        faultedItems: [],
      }),
      costUsd: 0.05,
      schemaValidation: { ok: true },
    }));

    const result = await runGatePhase(ctx);

    expect(result.status).toBe('completed');
    // phases/epic-review.json is the canonical artifact that proves the epic
    // path ran (only runEpicReview from @agentforge/core writes it).
    expect(existsSync(join(phasesDir(), 'epic-review.json'))).toBe(true);
  });

  it('throws GateRejectedError when epic review returns REQUEST_CHANGES', async () => {
    writePlan([{ id: 'item-1', title: 'widget feature' }]);
    writeExecuteJson();

    const ctx = makeEpicCtx(async () => ({
      output: JSON.stringify({
        verdict: 'REQUEST_CHANGES',
        rationale: 'item-1 implementation is incomplete',
        faultedItems: [
          { itemId: 'item-1', reason: 'widget not implemented', files: ['src/widget.ts'] },
        ],
      }),
      costUsd: 0.05,
      schemaValidation: { ok: true },
    }));

    await expect(runGatePhase(ctx)).rejects.toBeInstanceOf(GateRejectedError);
    // The artifact MUST be written before the throw so callers can read it.
    expect(existsSync(join(phasesDir(), 'epic-review.json'))).toBe(true);
  });

  it('does NOT take the epic branch when objective is absent (legacy path)', async () => {
    // The legacy path attempts to load the 'ceo' agent config from the
    // agentforgeDir — which does not exist in the tmp dir — and throws.
    // That throw is expected; we only assert that epic-review.json was
    // never created (i.e. the epic delegation was not invoked).
    const ctx = makeLegacyCtx();

    await expect(runGatePhase(ctx)).rejects.toThrow();
    expect(existsSync(join(phasesDir(), 'epic-review.json'))).toBe(false);
  });
});
