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
    modelId: 'claude-opus-4-7',
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
    it('defaults to enabled: opus model gets sonnet fallback', () => {
      const args = buildArgs(
        makeRequest({ agent: { agentId: 'coder', name: 'Coder', model: 'opus', systemPrompt: 'sp', workspaceId: 'w' }, modelId: 'claude-opus-4-7' }),
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
      expect(args[idx + 1]).toBe('claude-haiku-4-5-20251001');
    });

    it('haiku gets no fallback (already at bottom of ladder)', () => {
      const args = buildArgs(
        makeRequest({ agent: { agentId: 'coder', name: 'Coder', model: 'haiku', systemPrompt: 'sp', workspaceId: 'w' }, modelId: 'claude-haiku-4-5-20251001' }),
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

  describe('MODEL_IDS opus bump', () => {
    it('MODEL_IDS.opus is claude-opus-4-7', async () => {
      const { MODEL_IDS } = await import('../../agent-runtime/types.js');
      expect(MODEL_IDS.opus).toBe('claude-opus-4-7');
    });
  });
});
