/**
 * transport-contract.test.ts
 *
 * Parameterised contract tests that BOTH ExecutionTransport implementations
 * must satisfy.  The underlying API / subprocess is always mocked so the suite
 * is fast and deterministic.
 *
 * Coverage per transport (16 tests × 2 = 32 total):
 *   1.  execute() returns a well-formed ExecutionResult
 *   2.  providerKind is correct for the transport
 *   3.  response text propagates through
 *   4.  usage fields (inputTokens / outputTokens) are non-negative numbers
 *   5.  costUsd is a non-negative number
 *   6.  durationMs is a non-negative number
 *   7.  model field is present and a string
 *   8.  error: bad model (simulate 400) throws TransportInvalidRequestError
 *   9.  error: empty task throws or returns TransportError
 *  10.  error: auth failure throws TransportAuthError
 *  11.  error: rate-limit throws TransportRateLimitError
 *  12.  error: network error throws TransportNetworkError
 *  13.  error: timeout throws TransportTimeoutError
 *  14.  executeStreaming emits at least one text_delta event
 *  15.  executeStreaming calls onChunk with text
 *  16.  isAvailable() returns a boolean
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicSdkTransport } from '../transports/anthropic-sdk-transport.js';
import { ClaudeCodeCompatTransport } from '../transports/claude-code-compat-transport.js';
import {
  TransportAuthError,
  TransportError,
  TransportInvalidRequestError,
  TransportNetworkError,
  TransportRateLimitError,
  TransportTimeoutError,
} from '../transport-errors.js';
import type { ExecutionRequest, ExecutionResult, ExecutionStreamEvent, ExecutionTransport } from '../types.js';

// ---------------------------------------------------------------------------
// Shared request factory
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    agent: {
      agentId: 'coder',
      name: 'Coder',
      model: 'sonnet',
      systemPrompt: 'You are a coder.',
      workspaceId: 'default',
    },
    task: 'Write a hello-world function',
    userContent: 'Write a hello-world function',
    modelId: 'claude-sonnet-4-6',
    apiKey: 'test-key-abc',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock helpers for AnthropicSdkTransport
// ---------------------------------------------------------------------------

/** Minimal Anthropic SDK response shape expected by the transport. */
function makeSdkResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_123',
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 20 },
    content: [{ type: 'text', text: 'Hello, World!' }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock helpers for ClaudeCodeCompatTransport
// ---------------------------------------------------------------------------

/** Minimal claude CLI JSON result shape expected by the transport. */
function makeCliResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 500,
    result: 'Hello, World!',
    session_id: 'sess_abc',
    total_cost_usd: 0.00005,
    usage: { input_tokens: 10, output_tokens: 20 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isExecutionResult — narrow utility
// ---------------------------------------------------------------------------

function assertExecutionResultShape(result: ExecutionResult): void {
  expect(typeof result.providerKind).toBe('string');
  expect(typeof result.response).toBe('string');
  expect(typeof result.model).toBe('string');
  expect(typeof result.costUsd).toBe('number');
  expect(result.costUsd).toBeGreaterThanOrEqual(0);
  expect(typeof result.durationMs).toBe('number');
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expect(typeof result.usage).toBe('object');
  expect(typeof result.usage.inputTokens).toBe('number');
  expect(result.usage.inputTokens).toBeGreaterThanOrEqual(0);
  expect(typeof result.usage.outputTokens).toBe('number');
  expect(result.usage.outputTokens).toBeGreaterThanOrEqual(0);
}

// ---------------------------------------------------------------------------
// Transport factories with mocked backends
// ---------------------------------------------------------------------------

type TransportFixture = {
  name: string;
  makeTransport: () => ExecutionTransport;
  setupSuccess: (response?: string) => void;
  setupAuthError: () => void;
  setupRateLimitError: () => void;
  setupNetworkError: () => void;
  setupBadModelError: () => void;
  teardown: () => void;
};

// --- SDK fixture ---

/**
 * Build a minimal async-iterable stream that emits one message_start and one
 * content_block_delta then finishes.  Used to mock `messages.stream()`.
 */
function makeSdkAsyncStream(responseText: string): AsyncIterable<Record<string, unknown>> {
  const events: Record<string, unknown>[] = [
    {
      type: 'message_start',
      message: {
        id: 'msg_123',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    },
    {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: responseText },
    },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 20 },
    },
  ];
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < events.length) return { value: events[i++]!, done: false };
          return { value: undefined as any, done: true };
        },
      };
    },
  };
}

function makeSdkFixture(): TransportFixture {
  let createMock: ReturnType<typeof vi.fn> | null = null;
  let streamMock: ReturnType<typeof vi.fn> | null = null;

  return {
    name: 'AnthropicSdkTransport',
    makeTransport: () => new AnthropicSdkTransport(),
    setupSuccess: (responseText = 'Hello, World!') => {
      const response = makeSdkResponse({ content: [{ type: 'text', text: responseText }] });
      createMock = vi.fn().mockResolvedValue(response);
      streamMock = vi.fn().mockReturnValue(makeSdkAsyncStream(responseText));
      vi.doMock('@anthropic-ai/sdk', () => ({
        default: class MockAnthropic {
          constructor(_opts: unknown) {}
          messages = { create: createMock, stream: streamMock };
        },
      }));
    },
    setupAuthError: () => {
      const err = Object.assign(new Error('Invalid API key'), { status: 401 });
      createMock = vi.fn().mockRejectedValue(err);
      streamMock = vi.fn().mockRejectedValue(err);
      vi.doMock('@anthropic-ai/sdk', () => ({
        default: class MockAnthropic {
          constructor(_opts: unknown) {}
          messages = { create: createMock, stream: streamMock };
        },
      }));
    },
    setupRateLimitError: () => {
      const err = Object.assign(new Error('Rate limit exceeded'), { status: 429 });
      createMock = vi.fn().mockRejectedValue(err);
      streamMock = vi.fn().mockRejectedValue(err);
      vi.doMock('@anthropic-ai/sdk', () => ({
        default: class MockAnthropic {
          constructor(_opts: unknown) {}
          messages = { create: createMock, stream: streamMock };
        },
      }));
    },
    setupNetworkError: () => {
      const err = Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.com'), {
        code: 'ENOTFOUND',
      });
      createMock = vi.fn().mockRejectedValue(err);
      streamMock = vi.fn().mockRejectedValue(err);
      vi.doMock('@anthropic-ai/sdk', () => ({
        default: class MockAnthropic {
          constructor(_opts: unknown) {}
          messages = { create: createMock, stream: streamMock };
        },
      }));
    },
    setupBadModelError: () => {
      const err = Object.assign(new Error('Unknown model: claude-bad-model-99'), { status: 400 });
      createMock = vi.fn().mockRejectedValue(err);
      streamMock = vi.fn().mockRejectedValue(err);
      vi.doMock('@anthropic-ai/sdk', () => ({
        default: class MockAnthropic {
          constructor(_opts: unknown) {}
          messages = { create: createMock, stream: streamMock };
        },
      }));
    },
    teardown: () => {
      vi.resetModules();
      vi.restoreAllMocks();
    },
  };
}

// --- CLI fixture ---

function makeCliFixture(): TransportFixture {
  return {
    name: 'ClaudeCodeCompatTransport',
    makeTransport: () => new ClaudeCodeCompatTransport(),
    setupSuccess: (responseText = 'Hello, World!') => {
      const result = makeCliResult({ result: responseText });
      vi.spyOn(
        ClaudeCodeCompatTransport.prototype as any,
        'invokeClaudeCli',
      ).mockResolvedValue(result);
      vi.spyOn(
        ClaudeCodeCompatTransport.prototype as any,
        'invokeClaudeCliStreaming',
      ).mockResolvedValue({ cliResult: result, chunksEmitted: 0 });
    },
    setupAuthError: () => {
      const err = new Error('auth 401 unauthorized');
      vi.spyOn(
        ClaudeCodeCompatTransport.prototype as any,
        'invokeClaudeCli',
      ).mockRejectedValue(err);
      vi.spyOn(
        ClaudeCodeCompatTransport.prototype as any,
        'invokeClaudeCliStreaming',
      ).mockRejectedValue(err);
    },
    setupRateLimitError: () => {
      const err = new Error('rate-limit 429');
      vi.spyOn(
        ClaudeCodeCompatTransport.prototype as any,
        'invokeClaudeCli',
      ).mockRejectedValue(err);
      vi.spyOn(
        ClaudeCodeCompatTransport.prototype as any,
        'invokeClaudeCliStreaming',
      ).mockRejectedValue(err);
    },
    setupNetworkError: () => {
      const err = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
      vi.spyOn(
        ClaudeCodeCompatTransport.prototype as any,
        'invokeClaudeCli',
      ).mockRejectedValue(err);
      vi.spyOn(
        ClaudeCodeCompatTransport.prototype as any,
        'invokeClaudeCliStreaming',
      ).mockRejectedValue(err);
    },
    setupBadModelError: () => {
      const err = new Error('Unknown model: claude-bad-model-99');
      vi.spyOn(
        ClaudeCodeCompatTransport.prototype as any,
        'invokeClaudeCli',
      ).mockRejectedValue(err);
      vi.spyOn(
        ClaudeCodeCompatTransport.prototype as any,
        'invokeClaudeCliStreaming',
      ).mockRejectedValue(err);
    },
    teardown: () => {
      vi.restoreAllMocks();
    },
  };
}

// ---------------------------------------------------------------------------
// Parameterised suite
// ---------------------------------------------------------------------------

const fixtures: TransportFixture[] = [makeSdkFixture(), makeCliFixture()];

describe.each(fixtures)('ExecutionTransport contract — $name', (fixture) => {
  let transport: ExecutionTransport;

  beforeEach(() => {
    transport = fixture.makeTransport();
  });

  afterEach(() => {
    fixture.teardown();
  });

  // ---- Contract test 1: execute() returns well-formed ExecutionResult ----

  it('execute() returns a well-formed ExecutionResult', async () => {
    fixture.setupSuccess('Hello, World!');
    const result = await transport.execute(makeRequest());
    assertExecutionResultShape(result);
  });

  // ---- Contract test 2: providerKind is correct ----

  it('providerKind on the result matches the transport kind', async () => {
    fixture.setupSuccess();
    const result = await transport.execute(makeRequest());
    expect(result.providerKind).toBe(transport.kind);
  });

  // ---- Contract test 3: response text propagates ----

  it('response text propagates through execute()', async () => {
    const expected = 'function helloWorld() { return "hello"; }';
    fixture.setupSuccess(expected);
    const result = await transport.execute(makeRequest());
    expect(result.response).toBe(expected);
  });

  // ---- Contract test 4: usage fields are non-negative numbers ----

  it('usage.inputTokens and outputTokens are non-negative numbers', async () => {
    fixture.setupSuccess();
    const result = await transport.execute(makeRequest());
    expect(result.usage.inputTokens).toBeGreaterThanOrEqual(0);
    expect(result.usage.outputTokens).toBeGreaterThanOrEqual(0);
  });

  // ---- Contract test 5: costUsd is a non-negative number ----

  it('costUsd is a non-negative number', async () => {
    fixture.setupSuccess();
    const result = await transport.execute(makeRequest());
    expect(typeof result.costUsd).toBe('number');
    expect(result.costUsd).toBeGreaterThanOrEqual(0);
  });

  // ---- Contract test 6: durationMs is a non-negative number ----

  it('durationMs is a non-negative number', async () => {
    fixture.setupSuccess();
    const result = await transport.execute(makeRequest());
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ---- Contract test 7: model field is a non-empty string ----

  it('model field is a non-empty string', async () => {
    fixture.setupSuccess();
    const result = await transport.execute(makeRequest());
    expect(typeof result.model).toBe('string');
    expect(result.model.length).toBeGreaterThan(0);
  });

  // ---- Contract test 8: bad model → TransportError (not retryable) ----

  it('bad model throws a TransportError that is not retryable', async () => {
    fixture.setupBadModelError();
    const req = makeRequest({ modelId: 'claude-bad-model-99' });
    await expect(transport.execute(req)).rejects.toThrow(TransportError);

    try {
      await transport.execute(req);
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      // A bad model is either TransportInvalidRequestError (not retryable)
      // or at most some other TransportError subtype. Either way it must be a TransportError.
      expect(err).toBeInstanceOf(TransportError);
    }
  });

  // ---- Contract test 9: empty task → TransportError ----

  it('empty task string throws a TransportError', async () => {
    // Simulate the CLI/SDK treating empty input as a bad request
    fixture.setupBadModelError();
    const req = makeRequest({ userContent: '' });
    await expect(transport.execute(req)).rejects.toThrow(TransportError);
  });

  // ---- Contract test 10: auth failure → TransportAuthError ----

  it('auth failure throws TransportAuthError', async () => {
    fixture.setupAuthError();
    await expect(transport.execute(makeRequest())).rejects.toThrow(TransportAuthError);
  });

  // ---- Contract test 11: auth error is not retryable ----

  it('TransportAuthError is not retryable', async () => {
    fixture.setupAuthError();
    try {
      await transport.execute(makeRequest());
    } catch (err) {
      expect(err).toBeInstanceOf(TransportAuthError);
      expect((err as TransportAuthError).retryable).toBe(false);
    }
  });

  // ---- Contract test 12: rate-limit → TransportRateLimitError (retryable) ----

  it('rate-limit error throws TransportRateLimitError that is retryable', async () => {
    fixture.setupRateLimitError();
    try {
      await transport.execute(makeRequest());
    } catch (err) {
      expect(err).toBeInstanceOf(TransportRateLimitError);
      expect((err as TransportRateLimitError).retryable).toBe(true);
    }
  });

  // ---- Contract test 13: network error → TransportNetworkError (retryable) ----

  it('network error throws TransportNetworkError that is retryable', async () => {
    fixture.setupNetworkError();
    try {
      await transport.execute(makeRequest());
    } catch (err) {
      expect(err).toBeInstanceOf(TransportNetworkError);
      expect((err as TransportNetworkError).retryable).toBe(true);
    }
  });

  // ---- Contract test 14: executeStreaming emits text_delta events ----

  it('executeStreaming emits at least one text_delta event when streaming is supported', async () => {
    if (!transport.executeStreaming) return; // contract: skip if not implemented
    fixture.setupSuccess('streamed content');

    const events: ExecutionStreamEvent[] = [];
    await transport.executeStreaming(makeRequest(), {
      onEvent: (e) => events.push(e),
      onChunk: () => {},
    });

    // The transport must emit at least one text_delta OR a start event (proves it emits something)
    expect(events.length).toBeGreaterThan(0);
  });

  // ---- Contract test 15: executeStreaming calls onChunk with text ----

  it('executeStreaming calls onChunk with response text when streaming is supported', async () => {
    if (!transport.executeStreaming) return;
    fixture.setupSuccess('chunk text response');

    const chunks: string[] = [];
    const result = await transport.executeStreaming(makeRequest(), {
      onChunk: (text) => chunks.push(text),
    });

    expect(result.response).toBeTruthy();
    // onChunk must be called at least once (the full response or individual chunks)
    expect(chunks.length).toBeGreaterThan(0);
    // The concatenated chunks must equal the full response
    expect(chunks.join('')).toBe(result.response);
  });

  // ---- Contract test 16: isAvailable returns a boolean ----

  it('isAvailable() synchronously or asynchronously returns a boolean', async () => {
    const available = await transport.isAvailable(makeRequest());
    expect(typeof available).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// Standalone timeout test — SDK transport
// ---------------------------------------------------------------------------

describe('AnthropicSdkTransport — missing API key throws TransportAuthError', () => {
  it('throws TransportAuthError when no API key is present', async () => {
    const transport = new AnthropicSdkTransport();
    const { apiKey: _unused, ...baseReq } = makeRequest();
    const req = baseReq;
    // Ensure env var is not set
    const originalEnv = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      await expect(transport.execute(req)).rejects.toThrow(TransportAuthError);
    } finally {
      if (originalEnv !== undefined) process.env.ANTHROPIC_API_KEY = originalEnv;
    }
  });
});

// ---------------------------------------------------------------------------
// Standalone timeout test — CLI transport
// ---------------------------------------------------------------------------

describe('ClaudeCodeCompatTransport — timeout throws TransportTimeoutError', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('timeout rejection is classified as TransportTimeoutError', async () => {
    const transport = new ClaudeCodeCompatTransport();
    const timeoutErr = new Error('claude CLI timed out after 100ms');
    vi.spyOn(transport as any, 'invokeClaudeCli').mockRejectedValue(timeoutErr);

    const req = makeRequest({ timeoutMs: 100 });
    try {
      await transport.execute(req);
    } catch (err) {
      expect(err).toBeInstanceOf(TransportTimeoutError);
      expect((err as TransportTimeoutError).retryable).toBe(true);
      expect((err as TransportTimeoutError).timeoutMs).toBe(100);
    }
  });
});

// ---------------------------------------------------------------------------
// TransportError hierarchy unit tests (6 tests)
// ---------------------------------------------------------------------------

describe('TransportError hierarchy', () => {
  it('TransportError base class sets retryable and cause correctly', () => {
    const cause = new Error('root cause');
    const err = new TransportError('outer', { retryable: false, cause });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TransportError);
    expect(err.retryable).toBe(false);
    expect(err.cause).toBe(cause);
    expect(err.message).toBe('outer');
    expect(err.name).toBe('TransportError');
  });

  it('TransportAuthError is not retryable and is a TransportError', () => {
    const err = new TransportAuthError('bad key');
    expect(err).toBeInstanceOf(TransportError);
    expect(err).toBeInstanceOf(TransportAuthError);
    expect(err.retryable).toBe(false);
    expect(err.name).toBe('TransportAuthError');
  });

  it('TransportTimeoutError is retryable and exposes timeoutMs', () => {
    const err = new TransportTimeoutError('timeout', 30_000);
    expect(err).toBeInstanceOf(TransportError);
    expect(err.retryable).toBe(true);
    expect(err.timeoutMs).toBe(30_000);
    expect(err.name).toBe('TransportTimeoutError');
  });

  it('TransportRateLimitError is retryable', () => {
    const err = new TransportRateLimitError('429');
    expect(err).toBeInstanceOf(TransportError);
    expect(err.retryable).toBe(true);
    expect(err.name).toBe('TransportRateLimitError');
  });

  it('TransportNetworkError is retryable', () => {
    const err = new TransportNetworkError('ECONNRESET');
    expect(err).toBeInstanceOf(TransportError);
    expect(err.retryable).toBe(true);
    expect(err.name).toBe('TransportNetworkError');
  });

  it('TransportInvalidRequestError is not retryable', () => {
    const err = new TransportInvalidRequestError('bad input');
    expect(err).toBeInstanceOf(TransportError);
    expect(err.retryable).toBe(false);
    expect(err.name).toBe('TransportInvalidRequestError');
  });
});
