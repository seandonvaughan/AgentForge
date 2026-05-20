import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiSdkTransport } from '../transports/openai-sdk-transport.js';
import {
  TransportAuthError,
  TransportInvalidRequestError,
  TransportRateLimitError,
} from '../transport-errors.js';
import type { ExecutionRequest } from '../types.js';

function makeRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    agent: {
      agentId: 'coder',
      name: 'Coder',
      model: 'sonnet',
      systemPrompt: 'You are a coder.',
      workspaceId: 'default',
    },
    task: 'do something',
    userContent: 'do something',
    modelId: 'claude-sonnet-4-6',
    apiKey: 'test-openai-key',
    providerModelProfiles: {
      'openai-sdk': { modelId: 'gpt-5.3-codex', effort: 'high' },
    },
    ...overrides,
  };
}

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    })),
  );
}

function mockStreamingFetch(events: string[]): void {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      body,
      text: async () => '',
    })),
  );
}

describe('OpenAiSdkTransport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds Responses API payload with model, reasoning effort, and JSON schema format', () => {
    const transport = new OpenAiSdkTransport();
    const payload = transport.buildResponsePayload(makeRequest({
      outputSchema: {
        name: 'result',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, lines_changed: { type: 'integer' } },
          required: ['ok'],
        },
      },
    }));

    expect(payload.model).toBe('gpt-5.3-codex');
    expect(payload.reasoning).toEqual({ effort: 'high' });
    expect(payload.text).toEqual({
      format: {
        type: 'json_schema',
        name: 'result',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, lines_changed: { type: 'integer' } },
          required: ['ok', 'lines_changed'],
          additionalProperties: false,
        },
        strict: true,
      },
    });
  });

  it('parses Responses API output and returns schema validation', async () => {
    mockFetch(200, {
      id: 'resp_123',
      model: 'gpt-5.3-codex',
      output_text: '{"ok":true}',
      usage: { input_tokens: 11, output_tokens: 7 },
    });
    const transport = new OpenAiSdkTransport();

    const result = await transport.execute(makeRequest({
      outputSchema: {
        name: 'result',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
      },
    }));

    expect(result.response).toBe('{"ok":true}');
    expect(result.remoteSessionId).toBe('resp_123');
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(result.effort).toBe('high');
    expect(result.schemaValidation).toEqual({ ok: true });
  });

  it('classifies auth, rate-limit, and bad-request HTTP errors', async () => {
    const transport = new OpenAiSdkTransport();

    mockFetch(401, { error: { message: 'bad key' } });
    await expect(transport.execute(makeRequest())).rejects.toThrow(TransportAuthError);

    mockFetch(429, { error: { message: 'slow down' } });
    await expect(transport.execute(makeRequest())).rejects.toThrow(TransportRateLimitError);

    mockFetch(400, { error: { message: 'bad request' } });
    await expect(transport.execute(makeRequest())).rejects.toThrow(TransportInvalidRequestError);
  });

  it('streams response.output_text.delta chunks and returns usage from response.completed', async () => {
    mockStreamingFetch([
      'data: {"type":"response.output_text.delta","delta":"Hello "}\n\n',
      'data: {"type":"response.output_text.delta","delta":"world"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_stream_1","model":"gpt-5.3-codex","usage":{"input_tokens":13,"output_tokens":8}}}\n\n',
      'data: [DONE]\n\n',
    ]);
    const transport = new OpenAiSdkTransport();
    const chunks: string[] = [];

    const result = await transport.executeStreaming(makeRequest(), {
      onChunk: (text) => chunks.push(text),
    });

    expect(chunks).toEqual(['Hello ', 'world']);
    expect(result.response).toBe('Hello world');
    expect(result.remoteSessionId).toBe('resp_stream_1');
    expect(result.model).toBe('gpt-5.3-codex');
    expect(result.usage).toEqual({ inputTokens: 13, outputTokens: 8 });
  });
});
