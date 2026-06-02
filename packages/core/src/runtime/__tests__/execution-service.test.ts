import { describe, expect, it, vi } from 'vitest';
import { ExecutionService } from '../execution-service.js';
import type { AgentRuntimeConfig } from '../../agent-runtime/types.js';
import { MODEL_IDS } from '../../agent-runtime/types.js';
import type {
  ExecutionRequest,
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

describe('ExecutionService buildRequest — timeoutMs forwarding', () => {
  it('forwards timeoutMs from RunOptions to ExecutionRequest when set', async () => {
    let capturedTimeout: number | undefined;
    const transport: ExecutionTransport = {
      kind: 'anthropic-sdk',
      isAvailable: () => true,
      execute: vi.fn(async (req) => {
        capturedTimeout = req.timeoutMs;
        return buildExecutionResult('ok');
      }),
    };
    const service = new ExecutionService({ transports: [transport] });

    await service.run(config, { task: 'heavy task', timeoutMs: 45 * 60 * 1000 });

    expect(capturedTimeout).toBe(45 * 60 * 1000);
  });

  it('omits timeoutMs from ExecutionRequest when not provided in RunOptions', async () => {
    let capturedRequest: { timeoutMs?: number } = {};
    const transport: ExecutionTransport = {
      kind: 'anthropic-sdk',
      isAvailable: () => true,
      execute: vi.fn(async (req) => {
        capturedRequest = req;
        return buildExecutionResult('ok');
      }),
    };
    const service = new ExecutionService({ transports: [transport] });

    await service.run(config, { task: 'normal task' });

    expect(capturedRequest.timeoutMs).toBeUndefined();
  });

  it('forwards preferredProvider from RunOptions to ExecutionRequest when set', async () => {
    let capturedPreferredProvider: ExecutionRequest['preferredProvider'];
    const transport: ExecutionTransport = {
      kind: 'anthropic-sdk',
      isAvailable: () => true,
      execute: vi.fn(async (req) => {
        capturedPreferredProvider = req.preferredProvider;
        return buildExecutionResult('ok');
      }),
    };
    const service = new ExecutionService({ transports: [transport] });

    await service.run(config, { task: 'route this', preferredProvider: 'openai-sdk' });

    expect(capturedPreferredProvider).toBe('openai-sdk');
  });
});

describe('ExecutionService buildRequest — allowedTools from skills', () => {
  it('merges resolved requiredTools with caller allowedTools as a deduped union', async () => {
    const capturedCliRequests: ExecutionRequest[] = [];
    const sdkTransport: ExecutionTransport = {
      kind: 'anthropic-sdk',
      isAvailable: () => true,
      execute: vi.fn(async () => buildExecutionResult('sdk')),
    };
    const cliTransport: ExecutionTransport = {
      kind: 'claude-code-compat',
      isAvailable: () => true,
      execute: vi.fn(async (req): Promise<ExecutionResult> => {
        capturedCliRequests.push(req);
        return {
          ...buildExecutionResult('cli'),
          providerKind: 'claude-code-compat',
        };
      }),
    };
    const service = new ExecutionService({ transports: [sdkTransport, cliTransport] });

    const skillsOnly = await service.run(
      { ...config, requiredTools: ['Read', 'Write', 'Read'] },
      { task: 'use skill tools' },
    );
    const explicitTools = await service.run(
      { ...config, requiredTools: ['Write', 'Read'] },
      { task: 'use caller and skill tools', allowedTools: ['Read', 'Bash'] },
    );

    expect(skillsOnly.runtimeModeResolved).toBe('claude-code-compat');
    expect(explicitTools.runtimeModeResolved).toBe('claude-code-compat');
    expect(capturedCliRequests.map((req) => req.allowedTools)).toEqual([
      ['Read', 'Write'],
      ['Read', 'Bash', 'Write'],
    ]);
  });
});

describe('ExecutionService.run — structured output validation', () => {
  it('preserves schemaValidation from transport results', async () => {
    const transport: ExecutionTransport = {
      kind: 'codex-cli',
      isAvailable: () => true,
      execute: vi.fn(async (): Promise<ExecutionResult> => {
        return {
          ...buildExecutionResult('{"ok":true}'),
          providerKind: 'codex-cli',
          model: 'gpt-5.3-codex',
          schemaValidation: { ok: true },
        };
      }),
    };
    const service = new ExecutionService({ transports: [transport] });

    const result = await service.run(config, { task: 'return json', runtimeMode: 'codex-cli' });

    expect(result.schemaValidation).toEqual({ ok: true });
  });

  it('preserves resolved effort and capability tier from Codex transport results', async () => {
    const transport: ExecutionTransport = {
      kind: 'codex-cli',
      isAvailable: () => true,
      execute: vi.fn(async (): Promise<ExecutionResult> => {
        return {
          ...buildExecutionResult('ok'),
          providerKind: 'codex-cli',
          model: 'gpt-5.3-codex',
          effort: 'high',
        };
      }),
    };
    const service = new ExecutionService({ transports: [transport] });

    const result = await service.run(config, { task: 'use codex', runtimeMode: 'codex-cli' });

    expect(result.model).toBe('gpt-5.3-codex');
    expect(result.effort).toBe('high');
    expect(result.capabilityTier).toBe('sonnet');
  });
});

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

describe('ExecutionService — per-call capabilityTier override', () => {
  it('overrides the dispatched model + capabilityTier for a single call without mutating config', async () => {
    let capturedAgentModel: string | undefined;
    let capturedModelId: string | undefined;
    let capturedProviderModelProfiles: ExecutionRequest['providerModelProfiles'];
    const transport: ExecutionTransport = {
      kind: 'anthropic-sdk',
      isAvailable: () => true,
      execute: vi.fn(async (req) => {
        capturedAgentModel = req.agent.model;
        capturedModelId = req.modelId;
        capturedProviderModelProfiles = req.providerModelProfiles;
        return buildExecutionResult('ok');
      }),
    };
    const service = new ExecutionService({ transports: [transport] });

    const result = await service.run(config, { task: 'route this', capabilityTier: 'haiku' });

    expect(capturedAgentModel).toBe('haiku');
    expect(capturedModelId).toBe(MODEL_IDS.haiku);
    expect(result.capabilityTier).toBe('haiku');
    expect(config.model).toBe('sonnet');
    // providerModelProfiles for anthropic-sdk is deterministic (no env reads for
    // this provider) — assert that it reflects the haiku model id.
    expect(capturedProviderModelProfiles?.['anthropic-sdk']?.modelId).toBe(MODEL_IDS.haiku);
  });

  it('falls back to the agent config model when capabilityTier is absent', async () => {
    let capturedAgentModel: string | undefined;
    const transport: ExecutionTransport = {
      kind: 'anthropic-sdk',
      isAvailable: () => true,
      execute: vi.fn(async (req) => {
        capturedAgentModel = req.agent.model;
        return buildExecutionResult('ok');
      }),
    };
    const service = new ExecutionService({ transports: [transport] });

    const result = await service.run(config, { task: 'no override' });

    expect(capturedAgentModel).toBe('sonnet');
    expect(result.capabilityTier).toBe('sonnet');
  });

  it('overrides the dispatched model + capabilityTier on the streaming path without mutating config', async () => {
    let capturedAgentModel: string | undefined;
    let capturedModelId: string | undefined;
    // Use a transport without executeStreaming so the fallback path (execute) is
    // taken — this is the simplest stub that exercises the capabilityTier override
    // logic in runStreaming without requiring real provider resolution.
    const transport: ExecutionTransport = {
      kind: 'anthropic-sdk',
      isAvailable: () => true,
      execute: vi.fn(async (req) => {
        capturedAgentModel = req.agent.model;
        capturedModelId = req.modelId;
        return buildExecutionResult('ok');
      }),
    };
    const service = new ExecutionService({ transports: [transport] });

    const result = await service.runStreaming(config, {
      task: 'route streaming',
      capabilityTier: 'haiku',
      onEvent: () => {},
    });

    expect(capturedAgentModel).toBe('haiku');
    expect(capturedModelId).toBe(MODEL_IDS.haiku);
    expect(result.capabilityTier).toBe('haiku');
    expect(config.model).toBe('sonnet');
  });
});
