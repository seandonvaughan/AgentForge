import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceAdapter } from '@agentforge/db';
import { ExecutionService } from '../execution-service.js';
import { TransportRateLimitError } from '../transport-errors.js';
import type { AgentRuntimeConfig, ProviderSwitchEvent } from '../../agent-runtime/types.js';
import { RuntimeSession } from '../runtime-session.js';
import type { ExecutionResult, ExecutionTransport } from '../types.js';

const startedAt = '2026-01-01T00:00:00.000Z';
const config: AgentRuntimeConfig = {
  agentId: 'executor-runtime-engineer',
  name: 'Executor Runtime Engineer',
  model: 'sonnet',
  systemPrompt: 'You persist runtime audit trails.',
  workspaceId: 'test',
};

type ExecutionResultWithProviderSwitches = ExecutionResult & {
  providerSwitches?: ProviderSwitchEvent[];
};

function buildExecutionResult(
  providerSwitches: ProviderSwitchEvent[],
): ExecutionResultWithProviderSwitches {
  return {
    providerKind: 'openai-sdk',
    response: 'done',
    model: 'gpt-5.3-codex',
    usage: {
      inputTokens: 10,
      outputTokens: 20,
    },
    costUsd: 0.001,
    durationMs: 1000,
    providerSwitches,
  };
}

function buildSession(adapter: WorkspaceAdapter, sessionId: string): RuntimeSession {
  const session = new RuntimeSession({
    adapter,
    agentId: 'executor-runtime-engineer',
    task: 'persist provider switches',
    model: 'sonnet',
    capabilityTier: 'sonnet',
    sessionId,
    startedAt,
  });
  session.start();
  return session;
}

function stubTransport(
  kind: ExecutionTransport['kind'],
  behavior: 'succeed' | (() => Error),
): ExecutionTransport {
  return {
    kind,
    isAvailable: () => true,
    execute: vi.fn(async (): Promise<ExecutionResult> => {
      if (behavior === 'succeed') return buildExecutionResult([]);
      throw behavior();
    }),
  };
}

function loadRuntimeTransportPayload(adapter: WorkspaceAdapter, sessionId: string): {
  providerSwitches?: ProviderSwitchEvent[];
} {
  const events = adapter.listDecisionEvents({
    sessionId,
    decisionType: 'runtime_transport',
  });
  expect(events).toHaveLength(1);
  return JSON.parse(events[0]!.payload_json) as { providerSwitches?: ProviderSwitchEvent[] };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RuntimeSession.completeSuccess provider switches', () => {
  it('persists provider switch hops to the decision event payload', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
    const adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
    const recordDecisionEvent = vi.spyOn(adapter, 'recordDecisionEvent');
    const sessionId = 'session-provider-switches';

    buildSession(adapter, sessionId).completeSuccess(
      buildExecutionResult([
        { from: 'anthropic-sdk', to: 'openai-sdk', reason: '429' },
      ]),
      'openai-sdk',
    );

    expect(recordDecisionEvent).toHaveBeenCalledTimes(1);
    const payload = loadRuntimeTransportPayload(adapter, sessionId);
    expect(payload.providerSwitches).toHaveLength(1);
    expect(payload.providerSwitches![0]!.from).toBe('anthropic-sdk');
    expect(payload.providerSwitches![0]!.to).toBe('openai-sdk');

    adapter.close();
  });

  it('persists an empty provider switch array when no switch occurred', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
    const adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
    const recordDecisionEvent = vi.spyOn(adapter, 'recordDecisionEvent');
    const sessionId = 'session-no-provider-switches';

    buildSession(adapter, sessionId).completeSuccess(buildExecutionResult([]), 'openai-sdk');

    expect(recordDecisionEvent).toHaveBeenCalledTimes(1);
    const payload = loadRuntimeTransportPayload(adapter, sessionId);
    expect(payload.providerSwitches).toEqual([]);

    adapter.close();
  });

  it('persists provider switch hops from the actual failover path', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
    const adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
    const service = new ExecutionService({
      transports: [
        stubTransport('anthropic-sdk', () => new TransportRateLimitError('429')),
        stubTransport('openai-sdk', 'succeed'),
      ],
    });
    const sessionId = 'session-provider-switches-failover';

    const result = await service.run(
      config,
      {
        task: 'persist provider switches',
        providerPreference: ['anthropic-sdk', 'openai-sdk'],
        sessionId,
      },
      adapter,
    );

    expect(result.status).toBe('completed');
    expect(result.providerSwitches).toHaveLength(1);
    const payload = loadRuntimeTransportPayload(adapter, sessionId);
    expect(payload.providerSwitches).toHaveLength(1);
    expect(payload.providerSwitches![0]!.from).toBe('anthropic-sdk');
    expect(payload.providerSwitches![0]!.to).toBe('openai-sdk');

    adapter.close();
  });
});
