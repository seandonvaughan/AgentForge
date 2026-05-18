/**
 * T4 — Execute-phase typed-output tests.
 *
 * Covers:
 *   - Agent WITH output_schema + valid JSON → ValidatedJsonOutput captured
 *   - Agent WITH output_schema + invalid JSON → ValidatedJsonOutput.ok === false
 *   - Agent WITHOUT output_schema → keyword-search path unchanged (no validatedOutput)
 *   - Existing execute-phase behaviour unaffected by T4 changes
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runExecutePhase,
  type PhaseContext,
} from '../../../packages/core/src/autonomous/phase-handlers/execute-phase.js';
import type { ValidatedJsonOutput } from '../../../packages/core/src/autonomous/phase-handlers/execute-phase.js';

// ---------------------------------------------------------------------------
// Helpers (mirrors execute-phase.test.ts conventions)
// ---------------------------------------------------------------------------

function makeMockBus() {
  const published: Array<{ topic: string; payload: unknown }> = [];
  return {
    published,
    bus: {
      publish: (topic: string, payload: unknown) => {
        published.push({ topic, payload });
      },
      subscribe: (_topic: string, _cb: (event: unknown) => void) => () => {},
    } as any,
  };
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
        sprintId: `v${version}-typed-test`,
        title: `v${version} typed output test`,
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
  bus: unknown;
}): PhaseContext {
  return {
    sprintId: `v${opts.sprintVersion}-typed-test`,
    sprintVersion: opts.sprintVersion,
    projectRoot: opts.cwd,
    adapter: {} as any,
    bus: opts.bus as any,
    runtime: opts.runtime as any,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runExecutePhase — typed output (T4)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-exec-typed-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('populates validatedOutput when agent has outputSchema and schemaValidation.ok === true', async () => {
    const validJson = JSON.stringify({ status: 'done', score: 42 });

    const runtime = {
      run: async (_agentId: string, _task: string, _opts: unknown) => ({
        output: validJson,
        costUsd: 0,
        sessionId: 'sess-ok',
        schemaValidation: { ok: true },
      }),
    };

    writeSprintFile(tmpDir, '1.0.0', [
      {
        id: 'schema-item',
        title: 'structured task',
        assignee: 'scoring-agent',
        outputSchema: { name: 'ScoreOutput', strict: true },
      },
    ]);

    const { bus } = makeMockBus();
    const ctx = makeCtx({ cwd: tmpDir, sprintVersion: '1.0.0', runtime, bus });

    const result = await runExecutePhase(ctx, {
      maxParallelism: 1,
      selfEvalDisabled: true,
    });

    expect(result.status).toBe('completed');
    const itemRes = result.itemResults?.[0] as any;
    expect(itemRes).toBeDefined();

    const vo: ValidatedJsonOutput = itemRes.validatedOutput;
    expect(vo).toBeDefined();
    expect(vo.ok).toBe(true);
    expect(vo.schemaName).toBe('ScoreOutput');
    expect(vo.agentId).toBe('scoring-agent');
    expect(vo.raw).toBe(validJson);
    expect(vo.parsed).toEqual({ status: 'done', score: 42 });
    expect(vo.capturedAt).toBeTruthy();
  });

  it('populates validatedOutput with ok:false when schemaValidation reports failure', async () => {
    const runtime = {
      run: async (_agentId: string, _task: string, _opts: unknown) => ({
        output: 'not json',
        costUsd: 0,
        sessionId: 'sess-fail',
        schemaValidation: { ok: false, error: 'expected object at root' },
      }),
    };

    writeSprintFile(tmpDir, '1.0.1', [
      {
        id: 'schema-fail-item',
        title: 'structured task bad output',
        assignee: 'scoring-agent',
        // strict: false so it doesn't throw, just records failure
        outputSchema: { name: 'ScoreOutput', strict: false },
      },
    ]);

    const { bus } = makeMockBus();
    const ctx = makeCtx({ cwd: tmpDir, sprintVersion: '1.0.1', runtime, bus });

    const result = await runExecutePhase(ctx, {
      maxParallelism: 1,
      selfEvalDisabled: true,
    });

    // Item should still complete (strict:false means no throw)
    expect(result.status).toBe('completed');
    const itemRes = result.itemResults?.[0] as any;
    const vo: ValidatedJsonOutput = itemRes.validatedOutput;
    expect(vo).toBeDefined();
    expect(vo.ok).toBe(false);
    expect(vo.validationError).toBe('expected object at root');
    expect(vo.raw).toBe('not json');
    expect(vo.parsed).toBeUndefined();
  });

  it('does NOT populate validatedOutput when agent has NO outputSchema (keyword-search path)', async () => {
    const runtime = {
      run: async (_agentId: string, _task: string, _opts: unknown) => ({
        output: 'I completed the task successfully.',
        costUsd: 0,
        sessionId: 'sess-plain',
      }),
    };

    writeSprintFile(tmpDir, '1.0.2', [
      {
        id: 'plain-item',
        title: 'plain task without schema',
        assignee: 'coder-agent',
        // no outputSchema
      },
    ]);

    const { bus } = makeMockBus();
    const ctx = makeCtx({ cwd: tmpDir, sprintVersion: '1.0.2', runtime, bus });

    const result = await runExecutePhase(ctx, {
      maxParallelism: 1,
      selfEvalDisabled: true,
    });

    expect(result.status).toBe('completed');
    const itemRes = result.itemResults?.[0] as any;
    expect(itemRes.validatedOutput).toBeUndefined();
    // Confirm response is the plain text
    expect(itemRes.response).toBe('I completed the task successfully.');
  });

  it('existing items still complete when mixing schema and non-schema items', async () => {
    let callCount = 0;
    const runtime = {
      run: async (agentId: string, _task: string, _opts: unknown) => {
        callCount++;
        if (agentId === 'schema-agent') {
          return {
            output: '{"result":"ok"}',
            costUsd: 0.01,
            sessionId: `sess-${callCount}`,
            schemaValidation: { ok: true },
          };
        }
        return {
          output: 'done',
          costUsd: 0.005,
          sessionId: `sess-${callCount}`,
        };
      },
    };

    writeSprintFile(tmpDir, '1.0.3', [
      {
        id: 'schema-item-2',
        title: 'structured work',
        assignee: 'schema-agent',
        outputSchema: { name: 'ResultOutput' },
      },
      {
        id: 'plain-item-2',
        title: 'plain work',
        assignee: 'coder-agent',
      },
    ]);

    const { bus } = makeMockBus();
    const ctx = makeCtx({ cwd: tmpDir, sprintVersion: '1.0.3', runtime, bus });

    const result = await runExecutePhase(ctx, {
      maxParallelism: 2,
      selfEvalDisabled: true,
    });

    expect(result.status).toBe('completed');
    expect(callCount).toBe(2);

    const schemaRes = result.itemResults?.find((r: any) => r.itemId === 'schema-item-2') as any;
    const plainRes = result.itemResults?.find((r: any) => r.itemId === 'plain-item-2') as any;

    expect(schemaRes?.validatedOutput).toBeDefined();
    expect(schemaRes?.validatedOutput.ok).toBe(true);
    expect(plainRes?.validatedOutput).toBeUndefined();
  });
});
