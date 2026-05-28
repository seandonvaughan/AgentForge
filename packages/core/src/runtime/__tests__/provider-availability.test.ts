import { describe, expect, it } from 'vitest';
import {
  createProviderAvailabilityProbe,
  getProviderAvailability,
} from '../provider-availability.js';
import type { ExecutionProviderKind } from '../types.js';

const ALL_PROVIDERS: ExecutionProviderKind[] = [
  'anthropic-sdk',
  'claude-code-compat',
  'codex-cli',
  'openai-sdk',
];

/** Default to "everything reachable" so each test isolates a single signal. */
const ALL_AVAILABLE_PROBES = {
  isClaudeCliAvailable: () => true,
  isCodexCliAvailable: () => true,
  isCodexAuthenticated: () => true,
};

describe('provider availability probe', () => {
  it('reports every provider with an available flag and a non-empty reason', () => {
    const probe = createProviderAvailabilityProbe({ probes: ALL_AVAILABLE_PROBES });

    const map = probe.get({ ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' });

    for (const kind of ALL_PROVIDERS) {
      expect(map[kind], `missing entry for ${kind}`).toBeDefined();
      expect(typeof map[kind].available).toBe('boolean');
      expect(map[kind].reason.length).toBeGreaterThan(0);
    }
  });

  it('marks anthropic-sdk available only when ANTHROPIC_API_KEY is set', () => {
    const present = createProviderAvailabilityProbe({ probes: ALL_AVAILABLE_PROBES }).get({
      ANTHROPIC_API_KEY: 'sk-xxx',
    });
    expect(present['anthropic-sdk'].available).toBe(true);

    const absent = createProviderAvailabilityProbe({ probes: ALL_AVAILABLE_PROBES }).get({});
    expect(absent['anthropic-sdk'].available).toBe(false);
    expect(absent['anthropic-sdk'].reason).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('marks openai-sdk available only when OPENAI_API_KEY is set', () => {
    const present = createProviderAvailabilityProbe({ probes: ALL_AVAILABLE_PROBES }).get({
      OPENAI_API_KEY: 'sk-xxx',
    });
    expect(present['openai-sdk'].available).toBe(true);

    const absent = createProviderAvailabilityProbe({ probes: ALL_AVAILABLE_PROBES }).get({});
    expect(absent['openai-sdk'].available).toBe(false);
    expect(absent['openai-sdk'].reason).toMatch(/OPENAI_API_KEY/);
  });

  it('marks claude-code-compat unavailable when the claude CLI is not on PATH', () => {
    const probe = createProviderAvailabilityProbe({
      probes: { ...ALL_AVAILABLE_PROBES, isClaudeCliAvailable: () => false },
    });

    const map = probe.get({ ANTHROPIC_API_KEY: 'k' });

    expect(map['claude-code-compat'].available).toBe(false);
    expect(map['claude-code-compat'].reason).toMatch(/PATH/i);
  });

  it('marks codex-cli unavailable with a PATH reason when the codex CLI is missing', () => {
    const probe = createProviderAvailabilityProbe({
      probes: { ...ALL_AVAILABLE_PROBES, isCodexCliAvailable: () => false },
    });

    const map = probe.get({});

    expect(map['codex-cli'].available).toBe(false);
    expect(map['codex-cli'].reason).toMatch(/PATH/i);
  });

  it('marks codex-cli unavailable with an auth reason when present but not authenticated', () => {
    const probe = createProviderAvailabilityProbe({
      probes: {
        ...ALL_AVAILABLE_PROBES,
        isCodexCliAvailable: () => true,
        isCodexAuthenticated: () => false,
      },
    });

    const map = probe.get({});

    expect(map['codex-cli'].available).toBe(false);
    expect(map['codex-cli'].reason).toMatch(/auth/i);
  });

  it('returns the cached value within the TTL and refreshes after the injected clock advances past it', () => {
    let clock = 1_000;
    const probe = createProviderAvailabilityProbe({
      ttlMs: 100,
      now: () => clock,
      probes: ALL_AVAILABLE_PROBES,
    });

    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'present' };
    const first = probe.get(env);
    expect(first['anthropic-sdk'].available).toBe(true);

    // Credential removed, but we are still inside the TTL window.
    delete env.ANTHROPIC_API_KEY;
    clock += 50;
    const cached = probe.get(env);
    expect(cached['anthropic-sdk'].available).toBe(true); // stale, served from cache

    // Advance past the TTL — the probe must re-evaluate and see the removal.
    clock += 60; // 110ms elapsed > 100ms TTL
    const refreshed = probe.get(env);
    expect(refreshed['anthropic-sdk'].available).toBe(false);
  });

  it('getProviderAvailability honors injected probes and env (hermetic, no subprocess)', () => {
    const map = getProviderAvailability(
      {},
      {
        probes: {
          isClaudeCliAvailable: () => false,
          isCodexCliAvailable: () => false,
          isCodexAuthenticated: () => false,
        },
      },
    );

    expect(map['anthropic-sdk'].available).toBe(false);
    expect(map['claude-code-compat'].available).toBe(false);
    expect(map['codex-cli'].available).toBe(false);
    expect(map['openai-sdk'].available).toBe(false);
  });
});
