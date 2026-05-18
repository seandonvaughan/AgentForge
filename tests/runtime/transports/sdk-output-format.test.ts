/**
 * Tests for AnthropicSdkTransport — outputSchema / outputFormat plumbing (T3)
 *
 * SDK path chosen: @anthropic-ai/sdk does NOT expose a top-level outputFormat
 * parameter, so we fall back to:
 *   response_format: { type: 'json_object' }  (signals JSON-only output)
 *   + post-validation via validateAgainstSchema()
 *   + exactly one retry on validation failure
 *
 * Tests here verify the deterministic, non-SDK parts:
 *   - buildMessageParams includes response_format when outputSchema is set
 *   - buildMessageParams omits response_format without outputSchema
 *   - cache breakpoints are preserved with outputSchema
 *
 * The retry / schemaValidation integration is covered in packages/core tests
 * (anthropic-sdk-transport.test.ts) where @anthropic-ai/sdk mock resolution
 * is stable.
 */

import { describe, expect, it } from 'vitest';
import {
  AnthropicSdkTransport,
  CACHE_CONTROL_CHAR_THRESHOLD,
} from '../../../packages/core/src/runtime/transports/anthropic-sdk-transport.js';
import type { ExecutionRequest } from '../../../packages/core/src/runtime/types.js';
import type { AgentOutputSchema } from '../../../packages/core/src/runtime/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testSchema: AgentOutputSchema = {
  name: 'test_output',
  description: 'Test output schema',
  schema: {
    type: 'object',
    properties: {
      status: { type: 'string' },
      count: { type: 'number' },
    },
    required: ['status'],
    additionalProperties: false,
  },
};

function makeRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    agent: {
      agentId: 'test-agent',
      name: 'Test Agent',
      model: 'sonnet',
      systemPrompt: 'You are a test agent.',
      workspaceId: 'default',
    },
    task: 'Return structured data',
    userContent: 'Return structured data',
    modelId: 'claude-sonnet-4-6',
    apiKey: 'test-api-key',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnthropicSdkTransport — outputSchema plumbing', () => {
  const transport = new AnthropicSdkTransport();

  describe('buildMessageParams with outputSchema', () => {
    it('includes response_format json_object when outputSchema is set', () => {
      const params = transport.buildMessageParams(makeRequest({ outputSchema: testSchema }));
      expect(params['response_format']).toEqual({ type: 'json_object' });
    });

    it('does NOT include response_format when outputSchema is absent', () => {
      const params = transport.buildMessageParams(makeRequest());
      expect(params['response_format']).toBeUndefined();
    });

    it('preserves withCacheBreakpoints system prompt structure when outputSchema is set', () => {
      const params = transport.buildMessageParams(makeRequest({ outputSchema: testSchema }));
      const system = params['system'] as Array<{ type: string; cache_control?: object }>;
      expect(Array.isArray(system)).toBe(true);
      expect(system[0]).toMatchObject({ type: 'text', cache_control: { type: 'ephemeral' } });
    });

    it('cache breakpoint is present with outputSchema AND long user content', () => {
      const longContent = 'x'.repeat(CACHE_CONTROL_CHAR_THRESHOLD);
      const params = transport.buildMessageParams(
        makeRequest({ outputSchema: testSchema, userContent: longContent }),
      );
      const messages = params['messages'] as Array<{ role: string; content: unknown }>;
      const content = messages[0]!.content as Array<{ type: string; cache_control?: object }>;
      expect(Array.isArray(content)).toBe(true);
      expect(content[0]).toMatchObject({ type: 'text', cache_control: { type: 'ephemeral' } });
    });

    it('response_format json_object is present alongside temperature when both set', () => {
      const params = transport.buildMessageParams(
        makeRequest({ outputSchema: testSchema, temperature: 0.5 }),
      );
      expect(params['response_format']).toEqual({ type: 'json_object' });
      expect(params['temperature']).toBe(0.5);
    });

    it('response_format is absent when outputSchema is absent, even with temperature', () => {
      const params = transport.buildMessageParams(makeRequest({ temperature: 0.7 }));
      expect(params['response_format']).toBeUndefined();
    });
  });

  describe('no regression on requests without outputSchema', () => {
    it('model field is set correctly', () => {
      const params = transport.buildMessageParams(makeRequest());
      expect(params['model']).toBe('claude-sonnet-4-6');
    });

    it('messages array has a single user message', () => {
      const params = transport.buildMessageParams(makeRequest());
      const messages = params['messages'] as Array<{ role: string }>;
      expect(messages).toHaveLength(1);
      expect(messages[0]!.role).toBe('user');
    });

    it('max_tokens defaults to 8096', () => {
      const params = transport.buildMessageParams(makeRequest());
      expect(params['max_tokens']).toBe(8096);
    });
  });

  describe('isAvailable', () => {
    it('returns true when request.apiKey is set', () => {
      expect(transport.isAvailable(makeRequest({ apiKey: 'key' }))).toBe(true);
    });

    it('returns false when no key and no env var', () => {
      const savedKey = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      try {
        const req = makeRequest();
        delete (req as unknown as Record<string, unknown>)['apiKey'];
        expect(transport.isAvailable(req)).toBe(false);
      } finally {
        if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
      }
    });
  });
});
