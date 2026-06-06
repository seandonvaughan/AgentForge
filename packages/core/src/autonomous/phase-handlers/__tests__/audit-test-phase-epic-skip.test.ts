// P0.6 follow-up — on the objective/epic path the LLM audit (measured at 49%
// of campaign spend with findings frozen out of plan.json) and the advisory LLM
// QA-strategy report are both skipped for $0. The epic plan path never reads
// audit.json (it decomposes ctx.objective directly), and the deterministic
// per-child verify (P0.5) + cycle VERIFY stage replace the QA report. Legacy
// (signal) cycles are untouched. This keeps the epic path at exactly TWO
// scheduled strong-model calls: plan/decompose + epic review.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PhaseContext } from '../../phase-scheduler.js';
import { runAuditPhase } from '../audit-phase.js';
import { runTestPhase } from '../test-phase.js';

let tmpRoot: string;
const cycleId = '44444444-4444-4444-4444-444444444444';

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
        return { output: 'findings: none', costUsd: 0.4 };
      },
    },
    cycleId,
    baseBranch: 'main',
    ...(withObjective ? { objective: 'Build the widget feature' } : {}),
  } as unknown as PhaseContext;
  return { ctx, ran };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-audit-test-skip-'));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('runAuditPhase — epic skip (P0.6)', () => {
  it('does NOT dispatch the researcher when ctx.objective is set', async () => {
    const { ctx, ran } = makeCtx(true);
    const result = await runAuditPhase(ctx);
    expect(ran.dispatched).toBe(false);
    expect(result.status).toBe('completed');
    expect(result.costUsd).toBe(0);
    expect(result.agentRuns).toEqual([]);
  });

  it('writes audit.json with skipped:true and a clear reason', async () => {
    const { ctx } = makeCtx(true);
    await runAuditPhase(ctx);
    const auditJson = JSON.parse(readFileSync(join(phasesDir(), 'audit.json'), 'utf8'));
    expect(auditJson.skipped).toBe(true);
    expect(auditJson.costUsd).toBe(0);
    expect(auditJson.reason).toContain('epic path');
  });

  it('still dispatches the researcher on the legacy path (no objective)', async () => {
    const { ctx, ran } = makeCtx(false);
    await runAuditPhase(ctx);
    expect(ran.dispatched).toBe(true);
  });
});

describe('runTestPhase — epic skip (P0.6)', () => {
  it('does NOT dispatch the QA agent when ctx.objective is set', async () => {
    const { ctx, ran } = makeCtx(true);
    const result = await runTestPhase(ctx);
    expect(ran.dispatched).toBe(false);
    expect(result.status).toBe('completed');
    expect(result.costUsd).toBe(0);
    expect(result.agentRuns).toEqual([]);
  });

  it('writes test.json with skipped:true and a clear reason', async () => {
    const { ctx } = makeCtx(true);
    await runTestPhase(ctx);
    const testJson = JSON.parse(readFileSync(join(phasesDir(), 'test.json'), 'utf8'));
    expect(testJson.skipped).toBe(true);
    expect(testJson.costUsd).toBe(0);
    expect(testJson.reason).toContain('epic path');
  });

  it('still dispatches the QA agent on the legacy path (no objective)', async () => {
    const { ctx, ran } = makeCtx(false);
    await runTestPhase(ctx);
    expect(ran.dispatched).toBe(true);
  });
});
