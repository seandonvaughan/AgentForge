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

const AUTO_TRANSPORT_ORDER: ExecutionTransport['kind'][] = [
  'anthropic-sdk',
  'claude-code-compat',
  'codex-cli',
  'openai-sdk',
];

function buildAutoModeResolver(
  unavailable: ExecutionTransport['kind'][] = [],
): ProviderResolver {
  const unavailableSet = new Set(unavailable);
  return new ProviderResolver(
    AUTO_TRANSPORT_ORDER.map((kind) => buildTransport(kind, !unavailableSet.has(kind))),
  );
}

describe('ProviderResolver', () => {
  it('honors preferredProvider in auto mode when that transport is available', async () => {
    const resolver = new ProviderResolver([
      buildTransport('anthropic-sdk'),
      buildTransport('openai-sdk'),
    ]);

    const result = await resolver.resolve(
      'auto',
      buildRequest({ preferredProvider: 'openai-sdk' }),
    );

    expect(result.transport.kind).toBe('openai-sdk');
    expect(result.runtimeModeResolved).toBe('openai-sdk');
  });

  it('falls back to default auto-mode order when preferredProvider is unavailable', async () => {
    const resolver = new ProviderResolver([
      buildTransport('anthropic-sdk'),
      buildTransport('openai-sdk', false),
    ]);

    const result = await resolver.resolve(
      'auto',
      buildRequest({ preferredProvider: 'openai-sdk' }),
    );

    expect(result.transport.kind).toBe('anthropic-sdk');
    expect(result.runtimeModeResolved).toBe('sdk');
  });

  it('prefers the Anthropic SDK transport in auto mode when both transports are available', async () => {
    const resolver = new ProviderResolver([
      buildTransport('anthropic-sdk'),
      buildTransport('claude-code-compat'),
    ]);

    const result = await resolver.resolve('auto', buildRequest());

    expect(result.transport.kind).toBe('anthropic-sdk');
    expect(result.runtimeModeResolved).toBe('sdk');
  });

  it.each([
    {
      unavailable: ['anthropic-sdk'],
      expectedKind: 'claude-code-compat',
      expectedRuntimeMode: 'claude-code-compat',
    },
    {
      unavailable: ['anthropic-sdk', 'claude-code-compat'],
      expectedKind: 'codex-cli',
      expectedRuntimeMode: 'codex-cli',
    },
    {
      unavailable: ['anthropic-sdk', 'claude-code-compat', 'codex-cli'],
      expectedKind: 'openai-sdk',
      expectedRuntimeMode: 'openai-sdk',
    },
  ] as Array<{
    unavailable: ExecutionTransport['kind'][];
    expectedKind: ExecutionTransport['kind'];
    expectedRuntimeMode: string;
  }>)(
    'falls back to $expectedKind in no-tools auto mode when earlier transports are unavailable',
    async ({ unavailable, expectedKind, expectedRuntimeMode }) => {
      const resolver = buildAutoModeResolver(unavailable);

      const result = await resolver.resolve('auto', buildRequest());

      expect(result.transport.kind).toBe(expectedKind);
      expect(result.runtimeModeResolved).toBe(expectedRuntimeMode);
    },
  );

  it('fails fast in auto mode when every transport is unavailable', async () => {
    const resolver = buildAutoModeResolver(AUTO_TRANSPORT_ORDER);

    await expect(resolver.resolve('auto', buildRequest())).rejects.toThrow(
      /No execution transport is available/i,
    );
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

  it('falls back to Codex CLI in auto mode when allowed tools are requested and Claude Code is unavailable', async () => {
    const resolver = new ProviderResolver([
      buildTransport('anthropic-sdk'),
      buildTransport('claude-code-compat', false),
      buildTransport('codex-cli'),
    ]);

    const result = await resolver.resolve('auto', buildRequest({ allowedTools: ['Read'] }));

    expect(result.transport.kind).toBe('codex-cli');
    expect(result.runtimeModeResolved).toBe('codex-cli');
  });

  it('honors preferredProvider for allowedTools when set to codex-cli', async () => {
    const resolver = new ProviderResolver([
      buildTransport('claude-code-compat'),
      buildTransport('codex-cli'),
    ]);

    const result = await resolver.resolve(
      'auto',
      buildRequest({ allowedTools: ['Read'], preferredProvider: 'codex-cli' }),
    );

    expect(result.transport.kind).toBe('codex-cli');
    expect(result.runtimeModeResolved).toBe('codex-cli');
  });

  it('resolves explicit codex-cli mode to the Codex transport', async () => {
    const resolver = new ProviderResolver([
      buildTransport('anthropic-sdk'),
      buildTransport('codex-cli'),
      buildTransport('openai-sdk'),
    ]);

    const result = await resolver.resolve('codex-cli', buildRequest());

    expect(result.transport.kind).toBe('codex-cli');
    expect(result.runtimeModeResolved).toBe('codex-cli');
  });

  it('resolves explicit openai-sdk mode to the OpenAI transport', async () => {
    const resolver = new ProviderResolver([
      buildTransport('anthropic-sdk'),
      buildTransport('openai-sdk'),
    ]);

    const result = await resolver.resolve('openai-sdk', buildRequest());

    expect(result.transport.kind).toBe('openai-sdk');
    expect(result.runtimeModeResolved).toBe('openai-sdk');
  });
});
