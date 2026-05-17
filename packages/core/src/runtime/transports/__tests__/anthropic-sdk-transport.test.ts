/**
 * Tests for AnthropicSdkTransport — T5.2 (Cloud SDK transport production-readiness)
 *
 * All tests mock `@anthropic-ai/sdk` so no real network calls are made.
 *
 * Coverage:
 *  - Non-streaming path (execute)
 *  - Streaming path (executeStreaming) — onChunk, onEvent, final result
 *  - Cost calculation including cached tokens (read + creation)
 *  - Cache-control applied to system prompt unconditionally
 *  - Cache-control applied to large user content (>= threshold chars)
 *  - Cache-control NOT applied to short user content
 *  - Usage fields parsed including cache_creation_input_tokens / cache_read_input_tokens
 *  - Missing API key throws TransportAuthError
 *  - SDK errors classified as structured TransportError subtypes
 *  - AbortSignal forwarded to streaming call
 *  - done event emitted at end of stream
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnthropicSdkTransport,
  CACHE_CONTROL_CHAR_THRESHOLD,
} from '../anthropic-sdk-transport.js';
import {
  TransportAuthError,
  TransportRateLimitError,
  TransportError,
} from '../../transport-errors.js';
import type { ExecutionRequest } from '../../types.js';

// ---------------------------------------------------------------------------
// Anthropic SDK mock
// ---------------------------------------------------------------------------

const mockCreate = vi.fn();
const mockStream = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  // Must use `function` (not arrow) so `new Anthropic()` works in the transport.
  function MockAnthropic() {
    return {
      messages: {
        create: mockCreate,
        stream: mockStream,
      },
    };
  }
  return { default: MockAnthropic };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    agent: {
      agentId: 'test-agent',
      name: 'Test Agent',
      model: 'sonnet',
      systemPrompt: 'You are a test agent.',
      workspaceId: 'default',
    },
    task: 'Say hello',
    userContent: 'Say hello',
    modelId: 'claude-sonnet-4-6',
    apiKey: 'test-api-key',
    ...overrides,
  };
}

/** Make a request with no API key (omits the field entirely, avoiding exactOptionalPropertyTypes). */
function makeRequestNoKey(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  const { apiKey: _drop, ...base } = makeRequest(overrides);
  return base;
}

/** Build an async iterable from an array of stream events. */
async function* makeStreamEvents(
  events: object[],
): AsyncIterable<object> {
  for (const event of events) {
    yield event;
  }
}

/** Minimal non-streaming API response. */
function makeApiResponse(overrides: object = {}) {
  return {
    id: 'msg_test123',
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    content: [{ type: 'text', text: 'Hello!' }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnthropicSdkTransport', () => {
  let transport: AnthropicSdkTransport;

  beforeEach(() => {
    transport = new AnthropicSdkTransport();
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  // ── Non-streaming path ────────────────────────────────────────────────────

  describe('execute (non-streaming)', () => {
    it('calls messages.create and returns a structured ExecutionResult', async () => {
      mockCreate.mockResolvedValueOnce(makeApiResponse());

      const result = await transport.execute(makeRequest());

      expect(result.providerKind).toBe('anthropic-sdk');
      expect(result.response).toBe('Hello!');
      expect(result.model).toBe('claude-sonnet-4-6');
      expect(result.usage.inputTokens).toBe(100);
      expect(result.usage.outputTokens).toBe(50);
      expect(result.remoteSessionId).toBe('msg_test123');
      expect(result.stopReason).toBe('end_turn');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('includes costUsd calculated from MODEL_PRICING', async () => {
      mockCreate.mockResolvedValueOnce(
        makeApiResponse({ usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } }),
      );

      const result = await transport.execute(makeRequest());
      // sonnet pricing: input=$3/M, output=$15/M → 3+15 = $18
      expect(result.costUsd).toBeCloseTo(18, 2);
    });

    it('throws TransportAuthError when no API key is available', async () => {
      const req = makeRequest();
      delete (req as { apiKey?: string }).apiKey;
      await expect(transport.execute(req)).rejects.toThrow(TransportAuthError);
    });

    it('uses ANTHROPIC_API_KEY env var as fallback', async () => {
      process.env.ANTHROPIC_API_KEY = 'env-key';
      mockCreate.mockResolvedValueOnce(makeApiResponse());

      const req = makeRequest();
      delete (req as { apiKey?: string }).apiKey;
      const result = await transport.execute(req);
      expect(result.response).toBe('Hello!');
    });

    it('classifies SDK 429 as TransportRateLimitError', async () => {
      const sdkError = Object.assign(new Error('Rate limited'), { status: 429 });
      mockCreate.mockRejectedValueOnce(sdkError);

      await expect(transport.execute(makeRequest())).rejects.toThrow(TransportRateLimitError);
    });

    it('wraps unknown errors as TransportError', async () => {
      mockCreate.mockRejectedValueOnce(new Error('Something exploded'));

      await expect(transport.execute(makeRequest())).rejects.toThrow(TransportError);
    });
  });

  // ── Streaming path ────────────────────────────────────────────────────────

  describe('executeStreaming', () => {
    it('calls messages.stream and collects text chunks', async () => {
      const events = [
        { type: 'message_start', message: { id: 'msg_s1', model: 'claude-sonnet-4-6', usage: { input_tokens: 50, output_tokens: 0 } } },
        { type: 'content_block_start', content_block: { type: 'text', text: 'Hello' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: ', world' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: '!' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } },
      ];

      mockStream.mockReturnValueOnce(makeStreamEvents(events));

      const chunks: string[] = [];
      const result = await transport.executeStreaming(makeRequest(), {
        onChunk: (text) => chunks.push(text),
      });

      expect(chunks).toEqual(['Hello', ', world', '!']);
      expect(result.response).toBe('Hello, world!');
      expect(result.usage.inputTokens).toBe(50);
      expect(result.usage.outputTokens).toBe(30);
      expect(result.stopReason).toBe('end_turn');
      expect(result.remoteSessionId).toBe('msg_s1');
    });

    it('calls onChunk for each text delta in sequence', async () => {
      const events = [
        { type: 'message_start', message: { id: 'msg_2', model: 'claude-sonnet-4-6', usage: { input_tokens: 10 } } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'A' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'B' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'C' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      ];

      mockStream.mockReturnValueOnce(makeStreamEvents(events));

      const received: Array<{ text: string; index: number }> = [];
      await transport.executeStreaming(makeRequest(), {
        onChunk: (text, index) => received.push({ text, index }),
      });

      expect(received).toEqual([
        { text: 'A', index: 0 },
        { text: 'B', index: 1 },
        { text: 'C', index: 2 },
      ]);
    });

    it('emits start, metadata, usage_delta, text_delta, and done events', async () => {
      const events = [
        { type: 'message_start', message: { id: 'msg_e', model: 'claude-sonnet-4-6', usage: { input_tokens: 20 } } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      ];

      mockStream.mockReturnValueOnce(makeStreamEvents(events));

      const eventTypes: string[] = [];
      await transport.executeStreaming(makeRequest(), {
        onEvent: (event) => eventTypes.push(event.type),
      });

      expect(eventTypes).toContain('start');
      expect(eventTypes).toContain('metadata');
      expect(eventTypes).toContain('usage_delta');
      expect(eventTypes).toContain('text_delta');
      expect(eventTypes).toContain('done');
    });

    it('parses cache_creation and cache_read tokens from usage', async () => {
      const events = [
        {
          type: 'message_start',
          message: {
            id: 'msg_c',
            model: 'claude-sonnet-4-6',
            usage: {
              input_tokens: 500,
              output_tokens: 0,
              cache_creation_input_tokens: 200,
              cache_read_input_tokens: 100,
            },
          },
        },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } },
      ];

      mockStream.mockReturnValueOnce(makeStreamEvents(events));

      const result = await transport.executeStreaming(makeRequest());

      expect(result.usage.cacheCreationInputTokens).toBe(200);
      expect(result.usage.cacheReadInputTokens).toBe(100);
    });

    it('throws TransportAuthError when no API key is available', async () => {
      const req = makeRequest();
      delete (req as { apiKey?: string }).apiKey;
      await expect(transport.executeStreaming(req)).rejects.toThrow(TransportAuthError);
    });

    it('classifies stream errors as TransportError subtypes', async () => {
      const sdkError = Object.assign(new Error('Rate limited'), { status: 429 });
      mockStream.mockReturnValueOnce(
        // eslint-disable-next-line require-yield -- intentionally throws before yielding
        (async function* () {
          throw sdkError;
        })(),
      );

      await expect(transport.executeStreaming(makeRequest())).rejects.toThrow(
        TransportRateLimitError,
      );
    });

    it('forwards AbortSignal to messages.stream', async () => {
      mockStream.mockReturnValueOnce(makeStreamEvents([]));
      const controller = new AbortController();
      await transport.executeStreaming(makeRequest(), { signal: controller.signal });

      expect(mockStream).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ signal: controller.signal }),
      );
    });
  });

  // ── Cost calculation ──────────────────────────────────────────────────────

  describe('cost calculation', () => {
    it('accounts for cache-read tokens at 10% of input price', async () => {
      mockCreate.mockResolvedValueOnce(
        makeApiResponse({
          usage: {
            input_tokens: 1_000_000,
            output_tokens: 0,
            cache_read_input_tokens: 1_000_000,
            cache_creation_input_tokens: 0,
          },
        }),
      );

      const result = await transport.execute(makeRequest());
      // sonnet input: $3/M. 1M cache-read = $3*0.1 = $0.30. Regular input = 0.
      expect(result.costUsd).toBeCloseTo(0.3, 4);
    });

    it('accounts for cache-creation tokens at 125% of input price', async () => {
      mockCreate.mockResolvedValueOnce(
        makeApiResponse({
          usage: {
            input_tokens: 1_000_000,
            output_tokens: 0,
            cache_creation_input_tokens: 1_000_000,
            cache_read_input_tokens: 0,
          },
        }),
      );

      const result = await transport.execute(makeRequest());
      // sonnet input: $3/M. 1M cache-creation = $3*1.25 = $3.75.
      expect(result.costUsd).toBeCloseTo(3.75, 4);
    });
  });

  // ── Cache-control / buildMessageParams ───────────────────────────────────

  describe('buildMessageParams — cache_control', () => {
    it('always applies cache_control to the system prompt', () => {
      const params = transport.buildMessageParams(makeRequest());
      const system = params['system'] as Array<{ type: string; text: string; cache_control?: object }>;
      expect(Array.isArray(system)).toBe(true);
      expect(system[0]).toMatchObject({
        type: 'text',
        cache_control: { type: 'ephemeral' },
      });
    });

    it('does NOT apply cache_control to short user content', () => {
      const params = transport.buildMessageParams(
        makeRequest({ userContent: 'short' }),
      );
      const messages = params['messages'] as Array<{ role: string; content: unknown }>;
      // Short content should be a plain string, not a content-block array.
      expect(typeof messages[0]!.content).toBe('string');
    });

    it('applies cache_control to user content at or above the threshold', () => {
      const longContent = 'x'.repeat(CACHE_CONTROL_CHAR_THRESHOLD);
      const params = transport.buildMessageParams(
        makeRequest({ userContent: longContent }),
      );
      const messages = params['messages'] as Array<{ role: string; content: unknown }>;
      const content = messages[0]!.content as Array<{ type: string; cache_control?: object }>;
      expect(Array.isArray(content)).toBe(true);
      expect(content[0]).toMatchObject({
        type: 'text',
        cache_control: { type: 'ephemeral' },
      });
    });

    it('threshold is configurable via cacheControlThreshold property', () => {
      transport.cacheControlThreshold = 5;
      const params = transport.buildMessageParams(
        makeRequest({ userContent: '12345' }),
      );
      const messages = params['messages'] as Array<{ role: string; content: unknown }>;
      expect(Array.isArray(messages[0]!.content)).toBe(true);
    });
  });

  // ── isAvailable ───────────────────────────────────────────────────────────

  describe('isAvailable', () => {
    it('returns true when request.apiKey is set', () => {
      expect(transport.isAvailable(makeRequest({ apiKey: 'key' }))).toBe(true);
    });

    it('returns false when no key and no env var', () => {
      const req = makeRequest();
      delete (req as unknown as Record<string, unknown>)['apiKey'];
      expect(transport.isAvailable(req)).toBe(false);
    });

    it('returns true when ANTHROPIC_API_KEY env var is set', () => {
      process.env.ANTHROPIC_API_KEY = 'env-key';
      const req = makeRequest();
      delete (req as unknown as Record<string, unknown>)['apiKey'];
      expect(transport.isAvailable(req)).toBe(true);
    });
  });
});
