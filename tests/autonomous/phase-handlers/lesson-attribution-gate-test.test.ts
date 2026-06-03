/**
 * tests/autonomous/phase-handlers/lesson-attribution-gate-test.test.ts
 *
 * Phase 0 — Unit 4 acceptance tests for gate-phase and test-phase
 * lesson-attribution seams.
 *
 * Ungameable checks:
 *  - gate-phase: every gateVerdict in attribution rows == verdict in gate.json
 *  - test-phase: verifyPassed == (cycle.json tests.failed === 0)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runGatePhase,
  runTestPhase,
  type PhaseContext,
} from '@agentforge/core';
import { readLessonAttributions } from '../../../packages/core/src/memory/lesson-attribution.js';
import { appendLessonAttributions } from '../../../packages/core/src/memory/lesson-attribution.js';
import { computeLessonId } from '../../../packages/core/src/team/engine/learnings/lesson-id.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockBus() {
  return {
    publish: (_topic: string, _payload: unknown) => {},
    subscribe: (_topic: string, _cb: (event: unknown) => void) => () => {},
  } as any;
}

function makeCtx(opts: {
  cwd: string;
  sprintVersion: string;
  cycleId?: string;
  runtime: any;
  bus?: any;
}): PhaseContext {
  return {
    sprintId: `v${opts.sprintVersion}-la-gate-test`,
    sprintVersion: opts.sprintVersion,
    projectRoot: opts.cwd,
    cycleId: opts.cycleId,
    adapter: {} as any,
    bus: opts.bus ?? makeMockBus(),
    runtime: opts.runtime,
  };
}

/**
 * Write a sprint JSON file (required by gate-phase to read sprint items).
 */
function writeSprint(cwd: string, version: string, cycleId: string) {
  const dir = join(cwd, '.agentforge', 'sprints');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `v${version}.json`),
    JSON.stringify(
      {
        sprints: [
          {
            version,
            sprintId: `v${version}-la-gate-test`,
            phase: 'planned',
            items: [
              {
                id: 'item-gate-1',
                title: 'fix auth',
                assignee: 'auth-agent',
                status: 'completed',
                priority: 'P1',
                estimatedCostUsd: 0,
                tags: ['auth'],
              },
            ],
            budget: 10,
            teamSize: 1,
            successCriteria: [],
          },
        ],
      },
      null,
      2,
    ),
  );
}

/**
 * Write an execute.json phase artifact with a specific itemResult.
 */
function writeExecuteJson(cwd: string, cycleId: string, itemResults: unknown[]) {
  const dir = join(cwd, '.agentforge', 'cycles', cycleId, 'phases');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'execute.json'),
    JSON.stringify({ phase: 'execute', itemResults }, null, 2),
  );
}

/**
 * Seed attribution rows for a cycle (simulates what execute-phase would have written).
 */
function seedAttributionRows(
  cwd: string,
  cycleId: string,
  lessons: Array<{ itemId: string; agentId: string; lessonText: string }>,
) {
  const rows = lessons.map((l) => ({
    cycleId,
    itemId: l.itemId,
    agentId: l.agentId,
    lessonId: computeLessonId(l.lessonText),
    lessonText: l.lessonText,
    scope: 'cycle' as const,
  }));
  appendLessonAttributions(cwd, rows);
}

/**
 * Read gate.json from the phases directory.
 */
function readGateJson(cwd: string, cycleId: string): Record<string, unknown> {
  const path = join(cwd, '.agentforge', 'cycles', cycleId, 'phases', 'gate.json');
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/**
 * Write a cycle.json with test stats (simulates what cycle-runner writes after VERIFY).
 */
function writeCycleJson(cwd: string, cycleId: string, testsFailed: number) {
  const dir = join(cwd, '.agentforge', 'cycles', cycleId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'cycle.json'),
    JSON.stringify({
      cycleId,
      status: 'completed',
      tests: { passed: 100, failed: testsFailed, skipped: 0, total: 100 + testsFailed },
    }, null, 2),
  );
}

// ---------------------------------------------------------------------------
// Gate-phase attribution tests
// ---------------------------------------------------------------------------

describe('gate-phase — lesson-attribution seam (Phase 0)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-la-gate-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('gateVerdict in attribution rows equals verdict in gate.json (approved)', async () => {
    const cycleId = 'cycle-gate-approved';
    writeSprint(tmpDir, '4.0.0', cycleId);
    writeExecuteJson(tmpDir, cycleId, []);

    const LESSON = 'Always validate JWT token expiry.';
    seedAttributionRows(tmpDir, cycleId, [
      { itemId: 'item-gate-1', agentId: 'auth-agent', lessonText: LESSON },
    ]);

    const runtime = {
      run: async () => ({
        output: '{ "verdict": "APPROVE", "rationale": "all checks pass" }',
        costUsd: 0.01,
      }),
    };
    const ctx = makeCtx({ cwd: tmpDir, sprintVersion: '4.0.0', cycleId, runtime });

    // Gate APPROVE should NOT throw
    await expect(runGatePhase(ctx, { knownDebt: [] })).resolves.toBeDefined();

    // Read the gate.json for the on-disk verdict.
    // gate.json stores the raw verdict ('APPROVE'/'REJECT') at the top level,
    // and the normalized verdict ('approved'/'rejected') in gateMetadata.
    // The attribution stores the normalized form (verdictNorm), so we compare
    // against the normalized value — the same value written to gate-verdict.jsonl.
    const gateJson = readGateJson(tmpDir, cycleId);
    // Normalize: gate.json top-level verdict is 'APPROVE'/'REJECT'; attribution
    // stores the lowercase form matching the memory entry ('approved'/'rejected').
    const rawVerdictInGateJson = (gateJson['verdict'] as string).toUpperCase();
    const normalizedVerdictInGateJson = rawVerdictInGateJson === 'APPROVE' ? 'approved' : 'rejected';
    expect(normalizedVerdictInGateJson).toBe('approved');

    // UNGAMEABLE CHECK: every gateVerdict in attribution == normalized verdict from gate.json
    const rows = readLessonAttributions(tmpDir).filter((r) => r.cycleId === cycleId);
    const verdictRows = rows.filter((r) => r.gateVerdict !== undefined);
    expect(verdictRows.length).toBeGreaterThan(0);
    for (const row of verdictRows) {
      expect(row.gateVerdict).toBe(normalizedVerdictInGateJson);
    }
  });

  it('gateVerdict in attribution rows equals verdict in gate.json (rejected)', async () => {
    const cycleId = 'cycle-gate-rejected';
    writeSprint(tmpDir, '4.0.1', cycleId);
    writeExecuteJson(tmpDir, cycleId, []);

    const LESSON = 'Use execFile not exec for subprocess invocations.';
    seedAttributionRows(tmpDir, cycleId, [
      { itemId: 'item-gate-1', agentId: 'auth-agent', lessonText: LESSON },
    ]);

    const runtime = {
      run: async () => ({
        output: '{ "verdict": "REJECT", "rationale": "test failures detected" }',
        costUsd: 0.01,
      }),
    };
    const ctx = makeCtx({ cwd: tmpDir, sprintVersion: '4.0.1', cycleId, runtime });

    // Gate REJECT throws GateRejectedError
    await expect(runGatePhase(ctx, { knownDebt: [] })).rejects.toThrow();

    // On-disk gate.json should still have been written before the throw
    const gateJson = readGateJson(tmpDir, cycleId);
    // Normalize verdict for comparison (same logic as approved test above)
    const rawVerdictInGateJson = (gateJson['verdict'] as string).toUpperCase();
    const normalizedVerdictInGateJson = rawVerdictInGateJson === 'APPROVE' ? 'approved' : 'rejected';
    expect(normalizedVerdictInGateJson).toBe('rejected');

    // UNGAMEABLE CHECK
    const rows = readLessonAttributions(tmpDir).filter((r) => r.cycleId === cycleId);
    const verdictRows = rows.filter((r) => r.gateVerdict !== undefined);
    expect(verdictRows.length).toBeGreaterThan(0);
    for (const row of verdictRows) {
      expect(row.gateVerdict).toBe(normalizedVerdictInGateJson);
    }
  });

  it('emits no augmented rows when no prior attribution rows exist for the cycle', async () => {
    const cycleId = 'cycle-gate-empty';
    writeSprint(tmpDir, '4.0.2', cycleId);
    writeExecuteJson(tmpDir, cycleId, []);

    // No attribution rows seeded
    const runtime = {
      run: async () => ({
        output: '{ "verdict": "APPROVE", "rationale": "clean" }',
        costUsd: 0.01,
      }),
    };
    const ctx = makeCtx({ cwd: tmpDir, sprintVersion: '4.0.2', cycleId, runtime });
    await runGatePhase(ctx, { knownDebt: [] });

    const rows = readLessonAttributions(tmpDir).filter((r) => r.cycleId === cycleId);
    expect(rows.every((r) => r.gateVerdict === undefined)).toBe(true);
  });

  it('does not augment rows from a different cycle', async () => {
    const cycleId = 'cycle-gate-mine';
    const otherCycleId = 'cycle-gate-other';
    writeSprint(tmpDir, '4.0.3', cycleId);
    writeExecuteJson(tmpDir, cycleId, []);

    const LESSON = 'Keep diffs minimal.';
    // Seed rows for a DIFFERENT cycle
    seedAttributionRows(tmpDir, otherCycleId, [
      { itemId: 'item-x', agentId: 'agent-x', lessonText: LESSON },
    ]);

    const runtime = {
      run: async () => ({
        output: '{ "verdict": "APPROVE", "rationale": "ok" }',
        costUsd: 0.01,
      }),
    };
    const ctx = makeCtx({ cwd: tmpDir, sprintVersion: '4.0.3', cycleId, runtime });
    await runGatePhase(ctx, { knownDebt: [] });

    // The other cycle's rows should have no gateVerdict
    const otherRows = readLessonAttributions(tmpDir).filter(
      (r) => r.cycleId === otherCycleId,
    );
    expect(otherRows.every((r) => r.gateVerdict === undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test-phase attribution tests
// ---------------------------------------------------------------------------

describe('test-phase — verifyPassed attribution (Phase 0)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-la-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('verifyPassed=true when cycle.json tests.failed === 0', async () => {
    const cycleId = 'cycle-verify-pass';
    const LESSON = 'Use String.includes not regex for user input.';
    seedAttributionRows(tmpDir, cycleId, [
      { itemId: 'item-1', agentId: 'coder-agent', lessonText: LESSON },
    ]);
    // Simulate VERIFY stage having run with 0 failures
    writeCycleJson(tmpDir, cycleId, 0);

    const runtime = {
      run: async () => ({ output: 'QA strategy: looks good.', costUsd: 0.01 }),
    };
    const ctx = makeCtx({ cwd: tmpDir, sprintVersion: '5.0.0', cycleId, runtime });
    await runTestPhase(ctx);

    // UNGAMEABLE CHECK: verifyPassed == (cycle.json tests.failed === 0)
    const gateJson = readFileSync(
      join(tmpDir, '.agentforge', 'cycles', cycleId, 'cycle.json'),
      'utf8',
    );
    const cycleParsed = JSON.parse(gateJson) as { tests: { failed: number } };
    const expectedVerifyPassed = cycleParsed.tests.failed === 0;
    expect(expectedVerifyPassed).toBe(true);

    const rows = readLessonAttributions(tmpDir).filter((r) => r.cycleId === cycleId);
    const verifyRows = rows.filter((r) => r.verifyPassed !== undefined);
    expect(verifyRows.length).toBeGreaterThan(0);
    for (const row of verifyRows) {
      expect(row.verifyPassed).toBe(expectedVerifyPassed);
    }
  });

  it('verifyPassed=false when cycle.json tests.failed > 0', async () => {
    const cycleId = 'cycle-verify-fail';
    const LESSON = 'Add test coverage before marking done.';
    seedAttributionRows(tmpDir, cycleId, [
      { itemId: 'item-2', agentId: 'test-agent', lessonText: LESSON },
    ]);
    // Simulate VERIFY stage having run with 3 failures
    writeCycleJson(tmpDir, cycleId, 3);

    const runtime = {
      run: async () => ({ output: 'QA: test gaps found.', costUsd: 0.01 }),
    };
    const ctx = makeCtx({ cwd: tmpDir, sprintVersion: '5.0.1', cycleId, runtime });
    await runTestPhase(ctx);

    // UNGAMEABLE CHECK
    const cycleParsed = JSON.parse(
      readFileSync(join(tmpDir, '.agentforge', 'cycles', cycleId, 'cycle.json'), 'utf8'),
    ) as { tests: { failed: number } };
    const expectedVerifyPassed = cycleParsed.tests.failed === 0;
    expect(expectedVerifyPassed).toBe(false);

    const rows = readLessonAttributions(tmpDir).filter((r) => r.cycleId === cycleId);
    const verifyRows = rows.filter((r) => r.verifyPassed !== undefined);
    expect(verifyRows.length).toBeGreaterThan(0);
    for (const row of verifyRows) {
      expect(row.verifyPassed).toBe(expectedVerifyPassed);
    }
  });

  it('emits no verifyPassed rows when cycle.json is absent (no VERIFY run yet)', async () => {
    const cycleId = 'cycle-no-verify';
    const LESSON = 'Keep diffs minimal.';
    seedAttributionRows(tmpDir, cycleId, [
      { itemId: 'item-3', agentId: 'agent-3', lessonText: LESSON },
    ]);
    // No cycle.json written

    const runtime = {
      run: async () => ({ output: 'QA analysis.', costUsd: 0.01 }),
    };
    const ctx = makeCtx({ cwd: tmpDir, sprintVersion: '5.0.2', cycleId, runtime });
    await runTestPhase(ctx);

    const rows = readLessonAttributions(tmpDir).filter((r) => r.cycleId === cycleId);
    // No verifyPassed rows should exist since cycle.json was absent
    const verifyRows = rows.filter((r) => r.verifyPassed !== undefined);
    expect(verifyRows).toHaveLength(0);
  });

  it('emits no augmented rows when no prior attribution rows exist', async () => {
    const cycleId = 'cycle-test-empty';
    writeCycleJson(tmpDir, cycleId, 0);
    // No attribution rows seeded

    const runtime = {
      run: async () => ({ output: 'QA analysis.', costUsd: 0.01 }),
    };
    const ctx = makeCtx({ cwd: tmpDir, sprintVersion: '5.0.3', cycleId, runtime });
    await runTestPhase(ctx);

    const rows = readLessonAttributions(tmpDir).filter((r) => r.cycleId === cycleId);
    expect(rows.every((r) => r.verifyPassed === undefined)).toBe(true);
  });
});
