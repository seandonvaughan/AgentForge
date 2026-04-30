import { describe, expect, it, vi } from 'vitest';
import { ExecutionService } from '../execution-service.js';
import type { AgentRuntimeConfig } from '../../agent-runtime/types.js';
import type {
  ExecutionResult,
  ExecutionStreamEvent,
  ExecutionTransport,
} from '../types.js';

const config: AgentRuntimeConfig = {
  agentId: 'coder',
  name: 'Coder',
  model: 'sonnet',
  systemPrompt: 'You are a coder.',
  workspaceId: 'default',
};

function buildExecutionResult(response: string): ExecutionResult {
  return {
    providerKind: 'anthropic-sdk',
    response,
    model: 'claude-sonnet-4-6',
    usage: {
      inputTokens: 10,
      outputTokens: 20,
    },
    costUsd: 0.0001,
    durationMs: 25,
  };
}

describe('ExecutionService.runStreaming', () => {
  it('uses transport executeStreaming when available', async () => {
    const transport: ExecutionTransport = {
      kind: 'anthropic-sdk',
      isAvailable: () => true,
      execute: vi.fn(async () => {
        throw new Error('execute should not be used');
      }),
      executeStreaming: vi.fn(async (_request, options) => {
        options?.onChunk?.('hel', 0);
        options?.onChunk?.('lo', 1);
        options?.onEvent?.({ type: 'metadata', data: { remoteSessionId: 'msg-1' } });
        return buildExecutionResult('hello');
      }),
    };
    const service = new ExecutionService({ transports: [transport] });
    const chunks: string[] = [];
    const events: ExecutionStreamEvent[] = [];

    const result = await service.runStreaming(config, {
      task: 'Write code',
      sessionId: 'session-1',
      runtimeMode: 'sdk',
      onChunk: (text) => chunks.push(text),
      onEvent: (event) => events.push(event),
    });

    expect(transport.executeStreaming).toHaveBeenCalledTimes(1);
    expect(transport.execute).not.toHaveBeenCalled();
    expect(result.status).toBe('completed');
    expect(result.response).toBe('hello');
    expect(chunks).toEqual(['hel', 'lo']);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['metadata', 'done']));
  });

  it('falls back to execute and emits one full-response chunk when streaming is unavailable', async () => {
    const transport: ExecutionTransport = {
      kind: 'anthropic-sdk',
      isAvailable: () => true,
      execute: vi.fn(async () => buildExecutionResult('fallback response')),
    };
    const service = new ExecutionService({ transports: [transport] });
    const chunks: string[] = [];
    const events: ExecutionStreamEvent[] = [];

    const result = await service.runStreaming(config, {
      task: 'Write code',
      sessionId: 'session-2',
      runtimeMode: 'sdk',
      onChunk: (text) => chunks.push(text),
      onEvent: (event) => events.push(event),
    });

    expect(transport.execute).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('completed');
    expect(result.response).toBe('fallback response');
    expect(chunks).toEqual(['fallback response']);
    expect(events.map((event) => event.type)).toEqual(['text_delta', 'done']);
  });
});
