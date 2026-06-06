// P0.6(a) — RuntimeAdapter structured-output threading.
//
// Verifies that RuntimeAdapter.run:
//   1. forwards `outputSchema` into the underlying AgentRuntime.run call, and
//   2. surfaces `schemaValidation` from the RunResult back on its return shape.
//
// We inject an inline agent config, then swap the cached AgentRuntime's `run`
// with a spy that captures the RunOptions and returns a RunResult carrying
// schemaValidation — exercising the adapter's threading without a real transport.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeAdapter } from '../runtime-adapter.js';
import type { AgentRuntimeConfig, RunOptions, RunResult } from '../../agent-runtime/types.js';
import type { AgentOutputSchema } from '../../runtime/types.js';

let tmpDir: string;

const SCHEMA: AgentOutputSchema = {
  name: 'test_schema',
  schema: {
    type: 'object',
    properties: { verdict: { type: 'string' } },
    required: ['verdict'],
    additionalProperties: false,
  },
  strict: true,
};

const INLINE: AgentRuntimeConfig = {
  agentId: 'ceo',
  name: 'CEO',
  model: 'opus',
  systemPrompt: 'you are the ceo',
  workspaceId: 'ws',
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-rt-schema-'));
  mkdirSync(join(tmpDir, '.agentforge', 'agents'), { recursive: true });
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function baseRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    sessionId: 's1',
    response: '{"verdict":"APPROVE"}',
    model: 'claude-opus-4-8',
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.01,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: 'completed',
    ...overrides,
  };
}

describe('RuntimeAdapter.run — outputSchema threading', () => {
  it('forwards outputSchema into AgentRuntime.run', async () => {
    const adapter = new RuntimeAdapter({ cwd: tmpDir, inlineAgents: { ceo: INLINE } });
    const runtime = await adapter['getOrCreateRuntime']('ceo');
    let received: RunOptions | undefined;
    runtime.run = async (opts: RunOptions): Promise<RunResult> => {
      received = opts;
      return baseRunResult({ schemaValidation: { ok: true } });
    };

    await adapter.run('ceo', 'review this', { outputSchema: SCHEMA, capabilityTier: 'opus' });
    expect(received?.outputSchema).toBe(SCHEMA);
  });

  it('surfaces schemaValidation.ok=true on the return shape', async () => {
    const adapter = new RuntimeAdapter({ cwd: tmpDir, inlineAgents: { ceo: INLINE } });
    const runtime = await adapter['getOrCreateRuntime']('ceo');
    runtime.run = async (): Promise<RunResult> =>
      baseRunResult({ schemaValidation: { ok: true } });

    const out = await adapter.run('ceo', 'review this', { outputSchema: SCHEMA });
    expect(out.schemaValidation).toEqual({ ok: true });
  });

  it('surfaces schemaValidation.ok=false (with error) on the return shape', async () => {
    const adapter = new RuntimeAdapter({ cwd: tmpDir, inlineAgents: { ceo: INLINE } });
    const runtime = await adapter['getOrCreateRuntime']('ceo');
    runtime.run = async (): Promise<RunResult> =>
      baseRunResult({ schemaValidation: { ok: false, error: 'missing required key' } });

    const out = await adapter.run('ceo', 'review this', { outputSchema: SCHEMA });
    expect(out.schemaValidation).toEqual({ ok: false, error: 'missing required key' });
  });

  it('omits schemaValidation when the transport did not validate (no schema requested)', async () => {
    const adapter = new RuntimeAdapter({ cwd: tmpDir, inlineAgents: { ceo: INLINE } });
    const runtime = await adapter['getOrCreateRuntime']('ceo');
    runtime.run = async (): Promise<RunResult> => baseRunResult();

    const out = await adapter.run('ceo', 'review this');
    expect('schemaValidation' in out).toBe(false);
  });
});
