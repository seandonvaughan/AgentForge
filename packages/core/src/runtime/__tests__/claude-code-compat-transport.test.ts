import { describe, expect, it } from 'vitest';

// Access the private buildClaudeArgs method via a subclass for testing.
// We cast to `any` so we don't have to re-export the method.
import { ClaudeCodeCompatTransport } from '../transports/claude-code-compat-transport.js';
import type { ExecutionRequest } from '../types.js';

function makeRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    agent: {
      agentId: 'coder',
      name: 'Coder',
      model: 'opus',
      systemPrompt: 'You are a coder.',
      workspaceId: 'default',
    },
    task: 'do something',
    userContent: 'do something',
    modelId: 'claude-opus-4-8',
    ...overrides,
  };
}

// Expose the private method for testing by casting through `any`.
function buildArgs(
  request: ExecutionRequest,
  outputFormat: 'json' | 'stream-json',
): string[] {
  const transport = new ClaudeCodeCompatTransport();
  return (transport as any).buildClaudeArgs(request, outputFormat);
}

describe('ClaudeCodeCompatTransport.buildClaudeArgs', () => {
  describe('--max-budget-usd', () => {
    it('omits the flag when budgetUsd is not set', () => {
      const args = buildArgs(makeRequest(), 'json');
      expect(args).not.toContain('--max-budget-usd');
    });

    it('emits --max-budget-usd when budgetUsd is set', () => {
      const args = buildArgs(makeRequest({ budgetUsd: 50 }), 'json');
      const idx = args.indexOf('--max-budget-usd');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('50');
    });

    it('emits fractional values as strings', () => {
      const args = buildArgs(makeRequest({ budgetUsd: 12.5 }), 'json');
      const idx = args.indexOf('--max-budget-usd');
      expect(args[idx + 1]).toBe('12.5');
    });
  });

  describe('--exclude-dynamic-system-prompt-sections', () => {
    it('is added only in stream-json mode', () => {
      const streamArgs = buildArgs(makeRequest(), 'stream-json');
      expect(streamArgs).toContain('--exclude-dynamic-system-prompt-sections');

      const jsonArgs = buildArgs(makeRequest(), 'json');
      expect(jsonArgs).not.toContain('--exclude-dynamic-system-prompt-sections');
    });
  });

  describe('--fallback-model', () => {
    it('defaults to enabled: fable model gets opus fallback', () => {
      const args = buildArgs(
        makeRequest({ agent: { agentId: 'epic-planner', name: 'Epic Planner', model: 'fable', systemPrompt: 'sp', workspaceId: 'w' }, modelId: 'claude-fable-5' }),
        'json',
      );
      const idx = args.indexOf('--fallback-model');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('claude-opus-4-8');
    });

    it('defaults to enabled: opus model gets sonnet fallback', () => {
      const args = buildArgs(
        makeRequest({ agent: { agentId: 'coder', name: 'Coder', model: 'opus', systemPrompt: 'sp', workspaceId: 'w' }, modelId: 'claude-opus-4-8' }),
        'json',
      );
      const idx = args.indexOf('--fallback-model');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('claude-sonnet-4-6');
    });

    it('defaults to enabled: sonnet model gets haiku fallback', () => {
      const args = buildArgs(
        makeRequest({ agent: { agentId: 'coder', name: 'Coder', model: 'sonnet', systemPrompt: 'sp', workspaceId: 'w' }, modelId: 'claude-sonnet-4-6' }),
        'json',
      );
      const idx = args.indexOf('--fallback-model');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('claude-haiku-4-5');
    });

    it('haiku gets no fallback (already at bottom of ladder)', () => {
      const args = buildArgs(
        makeRequest({ agent: { agentId: 'coder', name: 'Coder', model: 'haiku', systemPrompt: 'sp', workspaceId: 'w' }, modelId: 'claude-haiku-4-5' }),
        'json',
      );
      expect(args).not.toContain('--fallback-model');
    });

    it('is suppressed when enableFallback is false', () => {
      const args = buildArgs(makeRequest({ enableFallback: false }), 'json');
      expect(args).not.toContain('--fallback-model');
    });

    it('is enabled when enableFallback is true', () => {
      const args = buildArgs(makeRequest({ enableFallback: true }), 'json');
      expect(args).toContain('--fallback-model');
    });
  });

  describe('timeoutMs — not a CLI arg (used at spawn level)', () => {
    it('setting timeoutMs on the request does not affect buildClaudeArgs output', () => {
      // timeoutMs is consumed in invokeClaudeCli/invokeClaudeCliStreaming, not in
      // buildClaudeArgs — it drives the spawn timer, not the CLI flag list.
      const withTimeout = buildArgs(makeRequest({ timeoutMs: 45 * 60 * 1000 }), 'json');
      const withoutTimeout = buildArgs(makeRequest(), 'json');
      expect(withTimeout).toEqual(withoutTimeout);
    });
  });

  describe('MODEL_IDS opus bump', () => {
    it('MODEL_IDS.opus is claude-opus-4-8', async () => {
      const { MODEL_IDS } = await import('../../agent-runtime/types.js');
      expect(MODEL_IDS.opus).toBe('claude-opus-4-8');
    });
  });

  describe('MODEL_IDS fable tier', () => {
    it('MODEL_IDS.fable is claude-fable-5 and priced at $10/$50 per MTok', async () => {
      const { MODEL_IDS, MODEL_PRICING } = await import('../../agent-runtime/types.js');
      expect(MODEL_IDS.fable).toBe('claude-fable-5');
      expect(MODEL_PRICING.fable).toEqual({ input: 10.00, output: 50.00 });
    });
  });
});

// ---------------------------------------------------------------------------
// toExecutionResult — model fallback detection over modelUsage
//
// Regression (acceptance cycle 441c037f): the claude CLI runs auxiliary helper
// calls (haiku) alongside the requested model, and modelUsage insertion order
// puts the helper FIRST. The old Object.keys(...)[0] read reported the helper
// as a "fallback" while opus had served the request — poisoning
// ExecutionResult.model and misleading operators into a capacity hunt.
// ---------------------------------------------------------------------------

function toResult(cliResult: Record<string, unknown>, modelId = 'claude-opus-4-8') {
  const transport = new ClaudeCodeCompatTransport();
  return (transport as any).toExecutionResult(makeRequest({ modelId }), cliResult);
}

describe('ClaudeCodeCompatTransport.toExecutionResult — modelUsage fallback detection', () => {
  it('aux helper listed FIRST does not mask the served requested model', () => {
    const result = toResult({
      result: 'ok',
      modelUsage: {
        'claude-haiku-4-5-20251001': { outputTokens: 120 },
        'claude-opus-4-8': { outputTokens: 5400 },
      },
    });
    expect(result.model).toBe('claude-opus-4-8');
  });

  it('a date-suffixed variant of the requested id counts as served', () => {
    const result = toResult({
      result: 'ok',
      modelUsage: {
        'claude-haiku-4-5-20251001': { outputTokens: 80 },
        'claude-opus-4-8-20260115': { outputTokens: 3000 },
      },
    });
    expect(result.model).toBe('claude-opus-4-8');
  });

  it('a REAL fallback resolves to the entry with the most output tokens', () => {
    const result = toResult({
      result: 'ok',
      modelUsage: {
        'claude-haiku-4-5-20251001': { outputTokens: 60 },
        'claude-sonnet-4-6': { outputTokens: 4100 },
      },
    });
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it('missing or empty modelUsage keeps the requested model', () => {
    expect(toResult({ result: 'ok' }).model).toBe('claude-opus-4-8');
    expect(toResult({ result: 'ok', modelUsage: {} }).model).toBe('claude-opus-4-8');
  });
});
