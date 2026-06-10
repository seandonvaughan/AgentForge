import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionService } from '../execution-service.js';
import { ProviderResolver } from '../provider-resolver.js';
import {
  CodexAuthError,
  TransportInvalidRequestError,
  TransportRateLimitError,
  TransportTimeoutError,
  isRetriableTransportError,
} from '../transport-errors.js';
import type { ProviderAvailabilityMap } from '../provider-availability.js';
import type { AgentRuntimeConfig } from '../../agent-runtime/types.js';
import type { ExecutionRequest, ExecutionResult, ExecutionTransport } from '../types.js';

const config: AgentRuntimeConfig = {
  agentId: 'coder',
  name: 'Coder',
  model: 'sonnet',
  systemPrompt: 'You are a coder.',
  workspaceId: 'default',
};

function result(kind: ExecutionTransport['kind'], response = 'ok'): ExecutionResult {
  return {
    providerKind: kind,
    response,
    model: 'm',
    usage: { inputTokens: 1, outputTokens: 1 },
    costUsd: 0,
    durationMs: 1,
  };
}

/** A transport whose execute() behavior is controlled by `behavior`. */
function stub(
  kind: ExecutionTransport['kind'],
  behavior: 'succeed' | (() => Error | null),
): ExecutionTransport & { calls: number } {
  const t = {
    kind,
    calls: 0,
    isAvailable: () => true,
    execute: vi.fn(async (): Promise<ExecutionResult> => {
      t.calls += 1;
      if (behavior === 'succeed') return result(kind);
      const err = behavior();
      if (err) throw err;
      return result(kind); // null → this attempt succeeds (backoff-clear tests)
    }),
  } as ExecutionTransport & { calls: number };
  return t;
}

function availabilityMap(overrides: Partial<ProviderAvailabilityMap> = {}): ProviderAvailabilityMap {
  return {
    'anthropic-sdk': { available: true, reason: 'ok' },
    'claude-code-compat': { available: true, reason: 'ok' },
    'codex-cli': { available: true, reason: 'ok' },
    'openai-sdk': { available: true, reason: 'ok' },
    ...overrides,
  };
}

function buildRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    agent: { agentId: 'coder', name: 'Coder', model: 'sonnet', systemPrompt: 'x', workspaceId: 'default' },
    task: 't',
    userContent: 't',
    modelId: 'm',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isRetriableTransportError — the classified-retriable set
// ---------------------------------------------------------------------------

describe('isRetriableTransportError', () => {
  it('is true for rate-limit, timeout, network, and Codex auth errors', () => {
    expect(isRetriableTransportError(new TransportRateLimitError('429'))).toBe(true);
    expect(isRetriableTransportError(new CodexAuthError('not logged in'))).toBe(true);
  });

  it('is false for non-retriable auth/invalid-request and plain errors', () => {
    expect(isRetriableTransportError(new TransportInvalidRequestError('bad'))).toBe(false);
    expect(isRetriableTransportError(new Error('???'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ProviderResolver.resolveOrdered — ordered, availability-filtered candidates
// ---------------------------------------------------------------------------

describe('ProviderResolver.resolveOrdered', () => {
  it('returns the preference order mapped to available transports', async () => {
    const resolver = new ProviderResolver([
      stub('anthropic-sdk', 'succeed'),
      stub('openai-sdk', 'succeed'),
    ]);

    const ordered = await resolver.resolveOrdered(buildRequest(), ['openai-sdk', 'anthropic-sdk']);

    expect(ordered.map((c) => c.transport.kind)).toEqual(['openai-sdk', 'anthropic-sdk']);
    expect(ordered[0]!.runtimeModeResolved).toBe('openai-sdk');
    expect(ordered[1]!.runtimeModeResolved).toBe('sdk');
  });

  it('drops providers reported unavailable by the availability snapshot', async () => {
    const resolver = new ProviderResolver(
      [stub('anthropic-sdk', 'succeed'), stub('openai-sdk', 'succeed')],
      () => availabilityMap({ 'anthropic-sdk': { available: false, reason: 'no key' } }),
    );

    const ordered = await resolver.resolveOrdered(buildRequest(), ['anthropic-sdk', 'openai-sdk']);

    expect(ordered.map((c) => c.transport.kind)).toEqual(['openai-sdk']);
  });

  it('de-duplicates repeated preference entries', async () => {
    const resolver = new ProviderResolver([stub('anthropic-sdk', 'succeed'), stub('openai-sdk', 'succeed')]);

    const ordered = await resolver.resolveOrdered(buildRequest(), [
      'anthropic-sdk',
      'anthropic-sdk',
      'openai-sdk',
    ]);

    expect(ordered.map((c) => c.transport.kind)).toEqual(['anthropic-sdk', 'openai-sdk']);
  });
});

// ---------------------------------------------------------------------------
// ExecutionService auto-switch on retriable failure
// ---------------------------------------------------------------------------

describe('ExecutionService.run — auto-switch on retriable failure', () => {
  // W4 — rate-limit errors are retried in place (with backoff) before the
  // provider switch; zero base collapses the backoff for tests.
  beforeEach(() => { process.env['AGENTFORGE_BACKOFF_BASE_MS'] = '0'; });
  afterEach(() => { delete process.env['AGENTFORGE_BACKOFF_BASE_MS']; });

  it('switches to the next provider after exhausting in-place rate-limit retries', async () => {
    const a = stub('anthropic-sdk', () => new TransportRateLimitError('rate limited'));
    const b = stub('openai-sdk', 'succeed');
    const service = new ExecutionService({ transports: [a, b] });

    const res = await service.run(config, {
      task: 'do it',
      providerPreference: ['anthropic-sdk', 'openai-sdk'],
    });

    expect(res.status).toBe('completed');
    expect(res.providerKind).toBe('openai-sdk'); // real re-dispatch to B, not a re-label
    expect(a.calls).toBe(3); // 1 attempt + 2 in-place backoff retries (W4)
    expect(b.calls).toBe(1);
    expect(res.providerSwitches).toHaveLength(1);
    expect(res.providerSwitches![0]).toMatchObject({ from: 'anthropic-sdk', to: 'openai-sdk' });
  });

  it('W4: a rate limit that clears on retry keeps the SAME provider (no switch)', async () => {
    let aCalls = 0;
    const a = stub('anthropic-sdk', () => {
      aCalls += 1;
      return aCalls < 2 ? new TransportRateLimitError('429') : null; // clears on 2nd attempt
    });
    const b = stub('openai-sdk', 'succeed');
    const service = new ExecutionService({ transports: [a, b] });

    const res = await service.run(config, {
      task: 'do it',
      providerPreference: ['anthropic-sdk', 'openai-sdk'],
    });

    expect(res.status).toBe('completed');
    expect(res.providerKind).toBe('anthropic-sdk'); // kept the requested provider
    expect(b.calls).toBe(0);
    expect(res.providerSwitches ?? []).toHaveLength(0);
  });

  it('non-rate-limit retriable errors (timeout/network) switch immediately', async () => {
    const a = stub('anthropic-sdk', () => new TransportTimeoutError('request timed out', 60000));
    const b = stub('openai-sdk', 'succeed');
    const service = new ExecutionService({ transports: [a, b] });

    const res = await service.run(config, {
      task: 'do it',
      providerPreference: ['anthropic-sdk', 'openai-sdk'],
    });

    expect(res.status).toBe('completed');
    expect(a.calls).toBe(1); // no in-place retry for non-429 classes
    expect(b.calls).toBe(1);
  });

  it('does NOT switch on a non-retriable error — surfaces the failure on A', async () => {
    const a = stub('anthropic-sdk', () => new TransportInvalidRequestError('bad request'));
    const b = stub('openai-sdk', 'succeed');
    const service = new ExecutionService({ transports: [a, b] });

    const res = await service.run(config, {
      task: 'do it',
      providerPreference: ['anthropic-sdk', 'openai-sdk'],
    });

    expect(res.status).toBe('failed');
    expect(res.providerKind).toBe('anthropic-sdk');
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(0); // B never tried
    expect(res.providerSwitches ?? []).toHaveLength(0);
  });

  it('never retries the same transport twice (dedupes repeated preference)', async () => {
    const a = stub('anthropic-sdk', () => new TransportRateLimitError('429'));
    const b = stub('openai-sdk', 'succeed');
    const service = new ExecutionService({ transports: [a, b] });

    const res = await service.run(config, {
      task: 'do it',
      providerPreference: ['anthropic-sdk', 'anthropic-sdk', 'openai-sdk'],
    });

    expect(a.calls).toBe(3); // 3 in-place attempts, but never re-enters the rotation
    expect(b.calls).toBe(1);
    expect(res.providerKind).toBe('openai-sdk');
  });

  it('surfaces failure when every candidate fails retriably', async () => {
    const a = stub('anthropic-sdk', () => new TransportRateLimitError('429'));
    const b = stub('openai-sdk', () => new CodexAuthError('nope'));
    const service = new ExecutionService({ transports: [a, b] });

    const res = await service.run(config, {
      task: 'do it',
      providerPreference: ['anthropic-sdk', 'openai-sdk'],
    });

    expect(res.status).toBe('failed');
    expect(a.calls).toBe(3); // rate-limited → in-place retries before switching
    expect(b.calls).toBe(1); // auth error → no in-place retry
    expect(res.providerKind).toBe('openai-sdk'); // last attempted
  });
});
