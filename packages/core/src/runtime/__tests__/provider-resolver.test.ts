import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearProviderAvailabilityCache,
  getProviderAvailability,
  ProviderResolver,
} from '../provider-resolver.js';
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
  const originalAnthropic = process.env.ANTHROPIC_API_KEY;
  const originalOpenAi = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    clearProviderAvailabilityCache();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    clearProviderAvailabilityCache();
    if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropic;
    if (originalOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAi;
  });

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

  it('returns stale availability within TTL and refreshes after the injected clock passes the TTL', () => {
    const env: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: 'anthropic-key',
      OPENAI_API_KEY: 'openai-key',
    };
    let nowMs = 1_000;
    let claudeAvailable = true;
    let codexAuthed = true;

    const readAvailability = () => getProviderAvailability(env, {
      ttlMs: 5_000,
      clock: { now: () => nowMs },
      probeClaudeCodeCompatAvailable: () => claudeAvailable,
      probeCodexCliAvailability: () => (
        codexAuthed
          ? { available: true, reason: 'codex CLI is authenticated.' }
          : { available: false, reason: 'codex CLI is not authenticated.' }
      ),
    });

    const first = readAvailability();
    expect(first['anthropic-sdk'].available).toBe(true);
    expect(first['claude-code-compat'].available).toBe(true);
    expect(first['codex-cli'].available).toBe(true);
    expect(first['openai-sdk'].available).toBe(true);

    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;
    claudeAvailable = false;
    codexAuthed = false;

    const stale = readAvailability();
    expect(stale['anthropic-sdk'].available).toBe(true);
    expect(stale['openai-sdk'].available).toBe(true);
    expect(stale['codex-cli'].available).toBe(true);

    nowMs += 5_001;
    const refreshed = readAvailability();
    expect(refreshed['anthropic-sdk']).toEqual({
      available: false,
      reason: 'Missing ANTHROPIC_API_KEY.',
    });
    expect(refreshed['openai-sdk']).toEqual({
      available: false,
      reason: 'Missing OPENAI_API_KEY.',
    });
    expect(refreshed['claude-code-compat'].available).toBe(false);
    expect(refreshed['codex-cli']).toEqual({
      available: false,
      reason: 'codex CLI is not authenticated.',
    });
  });

  it('excludes providers marked unavailable by the availability probe even when transport.isAvailable returns true', async () => {
    const env: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: 'openai-key',
    };
    const resolver = new ProviderResolver(
      [buildTransport('anthropic-sdk', true), buildTransport('openai-sdk', true)],
      {
        env,
        getProviderAvailability: (probeEnv) => getProviderAvailability(probeEnv, {
          ttlMs: 0,
          probeClaudeCodeCompatAvailable: () => false,
          probeCodexCliAvailability: () => ({
            available: false,
            reason: 'codex CLI is not authenticated.',
          }),
        }),
      },
    );

    const availability = getProviderAvailability(env, {
      ttlMs: 0,
      probeClaudeCodeCompatAvailable: () => false,
      probeCodexCliAvailability: () => ({
        available: false,
        reason: 'codex CLI is not authenticated.',
      }),
    });
    expect(availability['anthropic-sdk']).toEqual({
      available: false,
      reason: 'Missing ANTHROPIC_API_KEY.',
    });

    const result = await resolver.resolve('auto', buildRequest());
    expect(result.transport.kind).toBe('openai-sdk');
    expect(result.runtimeModeResolved).toBe('openai-sdk');
  });
});
