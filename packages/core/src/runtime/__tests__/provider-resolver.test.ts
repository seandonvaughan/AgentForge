import { describe, expect, it } from 'vitest';
import { ProviderResolver } from '../provider-resolver.js';
import type { ExecutionRequest, ExecutionTransport } from '../types.js';

function buildTransport(
  kind: ExecutionTransport['kind'],
  available = true,
): ExecutionTransport {
  return {
    kind,
    isAvailable: async () => available,
    execute: async () => {
      throw new Error('not used in resolver test');
    },
  };
}

function buildRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    agent: {
      agentId: 'coder',
      name: 'Coder',
      model: 'sonnet',
      systemPrompt: 'You are a coder.',
      workspaceId: 'default',
    },
    task: 'Write code',
    userContent: 'Write code',
    modelId: 'claude-sonnet-4-6',
    ...overrides,
  };
}

describe('ProviderResolver', () => {
  it('prefers the Anthropic SDK transport in auto mode when both transports are available', async () => {
    const resolver = new ProviderResolver([
      buildTransport('anthropic-sdk'),
      buildTransport('claude-code-compat'),
    ]);

    const result = await resolver.resolve('auto', buildRequest());

    expect(result.transport.kind).toBe('anthropic-sdk');
    expect(result.runtimeModeResolved).toBe('sdk');
  });

  it('requires the Claude Code compatibility transport when allowed tools are requested', async () => {
    const resolver = new ProviderResolver([
      buildTransport('anthropic-sdk'),
      buildTransport('claude-code-compat'),
    ]);

    const result = await resolver.resolve(
      'auto',
      buildRequest({ allowedTools: ['Read', 'Write'] }),
    );

    expect(result.transport.kind).toBe('claude-code-compat');
    expect(result.runtimeModeResolved).toBe('claude-code-compat');
  });

  it('fails fast when allowed tools are requested but Claude Code compatibility is unavailable', async () => {
    const resolver = new ProviderResolver([
      buildTransport('anthropic-sdk'),
      buildTransport('claude-code-compat', false),
    ]);

    await expect(
      resolver.resolve('auto', buildRequest({ allowedTools: ['Read'] })),
    ).rejects.toThrow(/allowedTools/i);
  });
});
