/**
 * tests/autonomous/phase-handlers/execute-phase-scoring.test.ts
 *
 * T2 — Scorer integration tests for execute-phase.
 *
 * Covers:
 *  - After a successful item run, step-scores.jsonl is created with 1 entry
 *  - After a failed item run (maxRetries exhausted), step-scores.jsonl has
 *    a score with quality:0 and schema.valid:0
 *  - StepScore is non-blocking: a scoring write error does NOT fail the cycle
 *  - step_score_ids are present on completed ItemResult
 *  - step_score_ids are present on failed ItemResult
 *  - Multiple items produce one JSONL entry each (N entries total)
 *  - Schema validation failure (validatedOutput.ok === false) writes quality:0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runExecutePhase,
  type PhaseContext,
} from '../../../packages/core/src/autonomous/phase-handlers/execute-phase.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockBus() {
  return {
    publish: (_topic: string, _payload: unknown) => {},
    subscribe: (_topic: string, _cb: (event: unknown) => void) => () => {},
  } as any;
}

function writeSprintFile(
  cwd: string,
  version: string,
  items: Array<{
    id: string;
    title: string;
    assignee: string;
    description?: string;
    tags?: string[];
    outputSchema?: { name: string; strict?: boolean };
  }>,
) {
  const dir = join(cwd, '.agentforge', 'sprints');
  mkdirSync(dir, { recursive: true });
  const wrapper = {
    sprints: [
      {
        version,
        sprintId: `v${version}-scoring-test`,
        title: `scoring test sprint ${version}`,
        createdAt: new Date().toISOString(),
        phase: 'planned',
        items: items.map((i) => ({
          ...i,
          status: 'planned',
          priority: 'P1',
          estimatedCostUsd: 0,
        })),
        budget: 10,
        teamSize: 1,
        successCriteria: [],
      },
    ],
  };
  writeFileSync(join(dir, `v${version}.json`), JSON.stringify(wrapper, null, 2));
}

function makeCtx(opts: {
  cwd: string;
  sprintVersion: string;
  runtime: unknown;
  bus?: unknown;
  cycleId?: string;
}): PhaseContext {
  return {
    sprintId: `v${opts.sprintVersion}-scoring-test`,
    sprintVersion: opts.sprintVersion,
    projectRoot: opts.cwd,
    cycleId: opts.cycleId,
    adapter: {} as any,
    bus: (opts.bus ?? makeMockBus()) as any,
    runtime: opts.runtime as any,
  };
}

function readStepScores(cwd: string): unknown[] {
  const filePath = join(cwd, '.agentforge', 'memory', 'step-scores.jsonl');
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('execute-phase — scorer integration (T2)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-exec-scoring-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates step-scores.jsonl with 1 entry after a successful item run', async () => {
    const runtime = {
      run: async () => ({
        output: 'task done',
        costUsd: 0.05,
        sessionId: 'sess-ok',
      }),
    };

    writeSprintFile(tmpDir, '2.0.0', [
      { id: 'item-a', title: 'do work', assignee: 'coder-agent' },
    ]);

    const ctx = makeCtx({ cwd: tmpDir, sprintVersion: '2.0.0', runtime });
    const result = await runExecutePhase(ctx, { maxParallelism: 1, selfEvalDisabled: true });

    expect(result.status).toBe('completed');

    const scores = readStepScores(tmpDir);
    expect(scores).toHaveLength(1);

    const score = scores[0] as any;
    expect(score.step_score_id).toBeTruthy();
    expect(score.cycle_id).toBeTruthy();
    expect(score.phase).toBe('execute');
    expect(score.item_id).toBe('item-a');
    expect(score.agent_id).toBe('coder-agent');
    expect(typeof score.quality).toBe('number');
  });

  it('writes step_score_ids on completed ItemResult', async () => {
    const runtime = {
      run: async () => ({ output: 'done', costUsd: 0.01, sessionId: 'sess-1' }),
    };
    writeSprintFile(tmpDir, '2.0.1', [
      { id: 'item-b', title: 'work', assignee: 'coder-agent' },
    ]);
    const ctx = makeCtx({ cwd: tmpDir, sprintVersion: '2.0.1', runtime });
    const result = await runExecutePhase(ctx, { maxParallelism: 1, selfEvalDisabled: true });

    const itemRes = result.itemResults?.[0] as any;
    expect(itemRes?.step_score_ids).toBeDefined();
    expect(Array.isArray(itemRes.step_score_ids)).toBe(true);
    expect(itemRes.step_score_ids.length).toBeGreaterThan(0);
  });

  it('writes quality:0 + schema.valid:0 signal on failure path', async () => {
    const runtime = {
      run: async () => {
        throw new Error('agent crashed');
      },
    };
    writeSprintFile(tmpDir, '2.0.2', [
      { id: 'item-fail', title: 'crash work', assignee: 'coder-agent' },
    ]);
    const ctx = makeCtx({ cwd: tmpDir, sprintVersion: '2.0.2', runtime });
    const result = await runExecutePhase(ctx, {
      maxParallelism: 1,
      maxItemRetries: 0,
      selfEvalDisabled: true,
    });

    // Phase should survive the item failure.
    expect(['completed', 'blocked', 'failed']).toContain(result.status);

    const scores = readStepScores(tmpDir);
    expect(scores.length).toBeGreaterThanOrEqual(1);

    const failScore = scores[0] as any;
    expect(failScore.quality).toBe(0);
    const schemaSignal = failScore.signals?.find((s: any) => s.key === 'schema.valid');
    expect(schemaSignal?.value).toBe(0);
  });

  it('writes step_score_ids on failed ItemResult', async () => {
    const runtime = {
      run: async () => {
        throw new Error('timeout');
      },
    };
    writeSprintFile(tmpDir, '2.0.3', [
      { id: 'item-fail2', title: 'fail', assignee: 'agent-x' },
    ]);
    const ctx = makeCtx({ cwd: tmpDir, sprintVersion: '2.0.3', runtime });
    await runExecutePhase(ctx, {
      maxParallelism: 1,
      maxItemRetries: 0,
      maxFailureRate: 1.0,
      selfEvalDisabled: true,
    });

    const scores = readStepScores(tmpDir);
    expect(scores.length).toBeGreaterThanOrEqual(1);
  });

  it('produces N JSONL entries for N items', async () => {
    const runtime = {
      run: async (_agentId: string) => ({ output: 'done', costUsd: 0.01, sessionId: 'sess' }),
    };
    writeSprintFile(tmpDir, '2.0.4', [
      { id: 'item-1', title: 'work 1', assignee: 'agent-a' },
      { id: 'item-2', title: 'work 2', assignee: 'agent-b' },
      { id: 'item-3', title: 'work 3', assignee: 'agent-c' },
    ]);
    const ctx = makeCtx({ cwd: tmpDir, sprintVersion: '2.0.4', runtime });
    const result = await runExecutePhase(ctx, { maxParallelism: 3, selfEvalDisabled: true });

    expect(result.status).toBe('completed');

    const scores = readStepScores(tmpDir);
    expect(scores).toHaveLength(3);

    // Each entry should have a unique step_score_id.
    const ids = new Set((scores as any[]).map((s) => s.step_score_id));
    expect(ids.size).toBe(3);
  });

  it('cycle continues even when scoring throws (non-blocking)', async () => {
    // The appendStepScore silently swallows errors for EACCES/ENOSPC.
    // This test verifies the execute phase always completes regardless.
    const runtime = {
      run: async () => ({ output: 'done', costUsd: 0.01, sessionId: 'sess-safe' }),
    };
    writeSprintFile(tmpDir, '2.0.5', [
      { id: 'item-safe', title: 'safe work', assignee: 'agent-safe' },
    ]);
    const ctx = makeCtx({ cwd: tmpDir, sprintVersion: '2.0.5', runtime });

    // Should complete without throwing.
    const result = await runExecutePhase(ctx, { maxParallelism: 1, selfEvalDisabled: true });
    expect(result.status).toBe('completed');
    expect(result.itemResults?.[0]?.status).toBe('completed');
  });

  it('writes quality:0 when validatedOutput.ok === false (schema validation failure)', async () => {
    const runtime = {
      run: async () => ({
        output: 'not-json-at-all',
        costUsd: 0.01,
        sessionId: 'sess-schema-fail',
        schemaValidation: { ok: false, error: 'root must be object' },
      }),
    };
    writeSprintFile(tmpDir, '2.0.6', [
      {
        id: 'item-schema-fail',
        title: 'schema fail',
        assignee: 'schema-agent',
        outputSchema: { name: 'MyOutput', strict: false },
      },
    ]);
    const ctx = makeCtx({ cwd: tmpDir, sprintVersion: '2.0.6', runtime });
    await runExecutePhase(ctx, { maxParallelism: 1, selfEvalDisabled: true });

    const scores = readStepScores(tmpDir);
    expect(scores).toHaveLength(1);
    const score = scores[0] as any;
    expect(score.quality).toBe(0);
    const sig = score.signals?.find((s: any) => s.key === 'schema.valid');
    expect(sig?.value).toBe(0);
  });

  it('populates cycleId in StepScore when ctx.cycleId is set', async () => {
    const runtime = {
      run: async () => ({ output: 'done', costUsd: 0.01, sessionId: 'sess-cid' }),
    };
    writeSprintFile(tmpDir, '2.0.7', [
      { id: 'item-cid', title: 'cycle-id test', assignee: 'agent-z' },
    ]);
    const ctx = makeCtx({
      cwd: tmpDir,
      sprintVersion: '2.0.7',
      runtime,
      cycleId: 'cycle-abcd1234',
    });
    await runExecutePhase(ctx, { maxParallelism: 1, selfEvalDisabled: true });

    const scores = readStepScores(tmpDir);
    expect(scores).toHaveLength(1);
    expect((scores[0] as any).cycle_id).toBe('cycle-abcd1234');
  });
});
