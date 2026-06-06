import { describe, expect, it } from 'vitest';
import {
  resolveJobRouting,
  DEFAULT_JOB_ROUTING_POLICY,
  applyForcedRuntimeProvider,
  type RoutableJob,
  type JobRoutingDecision,
  type JobRoutingPolicy,
} from '../job-router.js';
import { ProviderResolver } from '../../../runtime/provider-resolver.js';
import type { ProviderAvailabilityMap } from '../../../runtime/provider-availability.js';
import type { ExecutionRequest, ExecutionTransport } from '../../../runtime/types.js';

// ---------------------------------------------------------------------------
// availability fixtures (mirror provider-resolver.test.ts)
// ---------------------------------------------------------------------------

function availabilityMap(
  overrides: Partial<ProviderAvailabilityMap> = {},
): ProviderAvailabilityMap {
  return {
    'anthropic-sdk': { available: true, reason: 'ok' },
    'claude-code-compat': { available: true, reason: 'ok' },
    'codex-cli': { available: true, reason: 'ok' },
    'openai-sdk': { available: true, reason: 'ok' },
    ...overrides,
  };
}

// A transport whose execute() records that it was dispatched. The resolver
// test never calls execute(); here we DO, so the dispatch assertion is on the
// actual transport that ran — the ungameable part of the acceptance contract.
function buildRecordingTransport(
  kind: ExecutionTransport['kind'],
  calls: string[],
  available = true,
): ExecutionTransport {
  return {
    kind,
    isAvailable: async () => available,
    execute: async (request) => {
      calls.push(`${kind}:${request.agent.agentId}`);
      return {
        providerKind: kind,
        response: 'ok',
        model: request.modelId,
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        durationMs: 0,
      };
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
    task: 'Do work',
    userContent: 'Do work',
    modelId: 'claude-sonnet-4-6',
    ...overrides,
  };
}

const ALL_AVAILABLE = availabilityMap();

describe('resolveJobRouting', () => {
  it('is pure — same inputs yield deeply-equal output and no input mutation', () => {
    const job: RoutableJob = {
      itemId: 'a',
      title: 'tighten auth',
      tags: ['security'],
      estimatedComplexity: 'high',
    };
    const a = resolveJobRouting(job, DEFAULT_JOB_ROUTING_POLICY, ALL_AVAILABLE);
    const b = resolveJobRouting(job, DEFAULT_JOB_ROUTING_POLICY, ALL_AVAILABLE);
    expect(a).toEqual(b);
    // input untouched
    expect(job).toEqual({
      itemId: 'a',
      title: 'tighten auth',
      tags: ['security'],
      estimatedComplexity: 'high',
    });
  });

  it('routes a security / high-complexity item to the Claude opus profile (tool-capable)', () => {
    // Claude-primary (2026-06-06): security work runs on the tool-capable Claude
    // transport at opus tier, never codex.
    const decision = resolveJobRouting(
      { itemId: 's1', title: 'fix auth bypass', tags: ['security'], estimatedComplexity: 'high' },
      DEFAULT_JOB_ROUTING_POLICY,
      ALL_AVAILABLE,
    );
    expect(decision.preferredProvider).toBe('claude-code-compat');
    expect(decision.runtimeMode).toBe('claude-code-compat');
    expect(decision.tier).toBe('opus');
    expect(decision.effort).toBe('high');
  });

  it('routes high-complexity (no security tag) to the Claude opus profile', () => {
    const decision = resolveJobRouting(
      { itemId: 'h1', title: 'rework scheduler core', estimatedComplexity: 'high' },
      DEFAULT_JOB_ROUTING_POLICY,
      ALL_AVAILABLE,
    );
    expect(decision.preferredProvider).toBe('claude-code-compat');
    expect(decision.tier).toBe('opus');
  });

  it('detects security from touched subsystems/files even without a tag', () => {
    const decision = resolveJobRouting(
      {
        itemId: 's2',
        title: 'rotate token handling',
        files: ['packages/server/src/auth/rbac.ts'],
        estimatedComplexity: 'medium',
      },
      DEFAULT_JOB_ROUTING_POLICY,
      ALL_AVAILABLE,
    );
    expect(decision.preferredProvider).toBe('claude-code-compat');
  });

  it('routes a bulk / docs low-complexity item to codex-cli (gpt-5.5, high effort)', () => {
    // Split-tier (2026-06-06 operator decision): sonnet-tier implementation
    // prefers codex-cli (gpt-5.5 at high effort); Claude is the fallback chain.
    const decision = resolveJobRouting(
      { itemId: 'd1', title: 'update README links', tags: ['docs'], estimatedComplexity: 'low' },
      DEFAULT_JOB_ROUTING_POLICY,
      ALL_AVAILABLE,
    );
    expect(decision.preferredProvider).toBe('codex-cli');
    expect(decision.runtimeMode).toBe('codex-cli');
    expect(decision.effort).toBe('high');
    expect(decision.tier === 'sonnet' || decision.tier === 'haiku').toBe(true);
  });

  it('escalates a job with prior failures up to the Claude opus profile', () => {
    const decision = resolveJobRouting(
      {
        itemId: 'f1',
        title: 'fix flaky docs build',
        tags: ['docs'],
        estimatedComplexity: 'low',
        priorFailureCount: 2,
      },
      DEFAULT_JOB_ROUTING_POLICY,
      ALL_AVAILABLE,
    );
    expect(decision.preferredProvider).toBe('claude-code-compat');
    expect(decision.tier).toBe('opus');
  });

  it('falls back to the configured alternate when the preferred provider is unavailable', () => {
    // A high-complexity job prefers claude-code-compat; with it unavailable it
    // must land on the policy's configured alternate (anthropic-sdk), returning a
    // concrete decision (not claude-code-compat, not undefined).
    const decision = resolveJobRouting(
      { itemId: 'o1', title: 'fix auth bypass', tags: ['security'], estimatedComplexity: 'high' },
      DEFAULT_JOB_ROUTING_POLICY,
      availabilityMap({ 'claude-code-compat': { available: false, reason: 'cli missing' } }),
    );
    expect(decision.preferredProvider).not.toBe('claude-code-compat');
    const alternate = DEFAULT_JOB_ROUTING_POLICY.profiles.anthropic.alternate;
    const firstAlternate = Array.isArray(alternate) ? alternate[0] : alternate;
    expect(decision.preferredProvider).toBe(firstAlternate);
    expect(decision.preferredProvider).toBe('anthropic-sdk');
    // concrete runtime mode aligned to the chosen alternate
    expect(decision.runtimeMode).toBe('sdk');
  });

  it('defaults everything to available when availability is omitted', () => {
    const decision = resolveJobRouting(
      { itemId: 'n1', title: 'fix auth bypass', tags: ['security'], estimatedComplexity: 'high' },
      DEFAULT_JOB_ROUTING_POLICY,
    );
    expect(decision.preferredProvider).toBe('claude-code-compat');
  });

  it('respects a custom policy alternate', () => {
    const policy: JobRoutingPolicy = {
      ...DEFAULT_JOB_ROUTING_POLICY,
      profiles: {
        ...DEFAULT_JOB_ROUTING_POLICY.profiles,
        anthropic: { ...DEFAULT_JOB_ROUTING_POLICY.profiles.anthropic, alternate: 'codex-cli' },
      },
    };
    const decision = resolveJobRouting(
      { itemId: 'c1', title: 'fix auth bypass', tags: ['security'], estimatedComplexity: 'high' },
      policy,
      availabilityMap({ 'claude-code-compat': { available: false, reason: 'cli missing' } }),
    );
    expect(decision.preferredProvider).toBe('codex-cli');
    expect(decision.runtimeMode).toBe('codex-cli');
  });

  it('SECURITY PROFILE: contains no codex in its failover chain', () => {
    // Claude-primary (2026-06-06): judgment + security never route to codex,
    // even as a fallback. The full security chain is Claude-family only.
    const decision = resolveJobRouting(
      { itemId: 'sec-no-codex', title: 'fix auth bypass', tags: ['security'], estimatedComplexity: 'high' },
      DEFAULT_JOB_ROUTING_POLICY,
      ALL_AVAILABLE,
    );
    expect(decision.providerPreference).not.toContain('codex-cli');
    expect(decision.providerPreference).not.toContain('openai-sdk');
    expect(decision.providerPreference).toEqual(['claude-code-compat', 'anthropic-sdk']);
  });
});

// ---------------------------------------------------------------------------
// Dispatch matrix — ANTI-FAKE GUARD (Claude-primary, 2026-06-06).
//
// Under the Claude-primary product decision, BOTH a security item and a cheap
// docs item default to the tool-capable Claude transport. The ungameable
// invariants are now:
//   (1) every item dispatches to claude-code-compat when Claude is available;
//   (2) the security profile's chain contains NO codex, while the cheap profile
//       lists codex only as the LAST fallback (auxiliary capacity);
//   (3) availability overrides shift codex into play ONLY when the whole Claude
//       family is unavailable AND the item is non-security.
// ---------------------------------------------------------------------------

describe('dispatch matrix (resolveJobRouting -> ProviderResolver -> transport.execute)', () => {
  const plan: RoutableJob[] = [
    { itemId: 'sec', title: 'patch auth bypass', tags: ['security'], estimatedComplexity: 'high' },
    { itemId: 'doc', title: 'update docs', tags: ['docs'], estimatedComplexity: 'low' },
  ];

  it('split-tier dispatch: security stays on Claude, sonnet-tier work dispatches to codex', async () => {
    const decisions = plan.map((job) =>
      resolveJobRouting(job, DEFAULT_JOB_ROUTING_POLICY, ALL_AVAILABLE),
    );
    // ANTI-FAKE: the two items take DIFFERENT providers — a hard-coded single
    // chain fails here. Security/judgment stays on Claude (codex never listed);
    // sonnet-tier implementation leads with codex-cli (gpt-5.5) and falls back
    // to the Claude chain.
    const secDecision = decisions[0]!;
    const docDecision = decisions[1]!;
    expect(secDecision.preferredProvider).toBe('claude-code-compat');
    expect(secDecision.providerPreference).not.toContain('codex-cli');
    expect(docDecision.preferredProvider).toBe('codex-cli');
    expect(docDecision.effort).toBe('high');
    expect(docDecision.providerPreference).toEqual(['codex-cli', 'claude-code-compat', 'anthropic-sdk']);

    const calls: string[] = [];
    const resolver = new ProviderResolver(
      [
        buildRecordingTransport('claude-code-compat', calls),
        buildRecordingTransport('anthropic-sdk', calls),
        buildRecordingTransport('codex-cli', calls),
      ],
      () => ALL_AVAILABLE,
    );

    for (let i = 0; i < plan.length; i += 1) {
      const decision = decisions[i]!;
      const job = plan[i]!;
      const agentId = job.itemId ?? 'job';
      const agent = {
        agentId,
        name: agentId,
        model: decision.tier,
        systemPrompt: 'x',
        workspaceId: 'default',
      };
      const { transport } = await resolver.resolve(
        decision.runtimeMode,
        buildRequest({ agent, preferredProvider: decision.preferredProvider }),
      );
      await transport.execute(
        buildRequest({ agent, preferredProvider: decision.preferredProvider }),
      );
    }

    // Security ran on the Claude transport; the docs item ran on codex.
    expect(calls).toContain('claude-code-compat:sec');
    expect(calls).toContain('codex-cli:doc');
    expect(calls).not.toContain('codex-cli:sec');
    expect(calls).not.toContain('claude-code-compat:doc');
  });

  it('availability-driven override: claude-code-compat down => security item dispatches to its anthropic-sdk alternate', async () => {
    const availability = availabilityMap({
      'claude-code-compat': { available: false, reason: 'cli missing' },
    });
    const secJob = plan[0]!;
    const decision = resolveJobRouting(secJob, DEFAULT_JOB_ROUTING_POLICY, availability);
    // routing chose the (Claude-family) alternate up front, never codex
    expect(decision.preferredProvider).toBe('anthropic-sdk');

    const calls: string[] = [];
    const resolver = new ProviderResolver(
      [
        buildRecordingTransport('claude-code-compat', calls),
        buildRecordingTransport('anthropic-sdk', calls),
      ],
      () => availability,
    );

    const agentId = secJob.itemId ?? 'job';
    const agent = {
      agentId,
      name: agentId,
      model: decision.tier,
      systemPrompt: 'x',
      workspaceId: 'default',
    };
    const { transport } = await resolver.resolve(
      decision.runtimeMode,
      buildRequest({ agent, preferredProvider: decision.preferredProvider }),
    );
    await transport.execute(
      buildRequest({ agent, preferredProvider: decision.preferredProvider }),
    );

    // The security item did NOT run on the (down) Claude CLI — it ran on the
    // anthropic-sdk alternate, and never on codex.
    expect(calls).toContain('anthropic-sdk:sec');
    expect(calls).not.toContain('claude-code-compat:sec');
    expect(calls).not.toContain('codex-cli:sec');
  });

  it('CODEX-IDENTITY-INVALID: codex unavailable => availability-filtered chain excludes codex; cheap item stays on Claude', () => {
    // Simulate the merged identity probe reporting codex unavailable (wrong/
    // missing binary). The cheap profile's chain must filter codex out entirely.
    const availability = availabilityMap({
      'codex-cli': {
        available: false,
        reason: 'codex CLI not found on PATH (or the resolved binary failed identity validation)',
      },
    });
    const docDecision = resolveJobRouting(
      { itemId: 'doc-no-codex', title: 'update README links', tags: ['docs'], estimatedComplexity: 'low' },
      DEFAULT_JOB_ROUTING_POLICY,
      availability,
    );
    expect(docDecision.preferredProvider).toBe('claude-code-compat');
    expect(docDecision.providerPreference).not.toContain('codex-cli');
    expect(docDecision.providerPreference).toEqual(['claude-code-compat', 'anthropic-sdk']);
  });
});

describe('resolveJobRouting — providerPreference failover chain', () => {
  it('cheap/bulk job: providerPreference leads with codex-cli, Claude as fallback chain', () => {
    const d = resolveJobRouting(
      { itemId: 'b1', title: 'update README links', tags: ['docs'], estimatedComplexity: 'low' },
      DEFAULT_JOB_ROUTING_POLICY,
      ALL_AVAILABLE,
    );
    expect(d.preferredProvider).toBe('codex-cli');
    // Split-tier (2026-06-06): codex-cli first for sonnet-tier work; Claude follows.
    expect(d.providerPreference).toEqual(['codex-cli', 'claude-code-compat', 'anthropic-sdk']);
    expect(d.providerPreference[0]).toBe(d.preferredProvider);
  });

  it('security job: providerPreference is the Claude-only chain (no codex), preferred first', () => {
    const d = resolveJobRouting(
      { itemId: 's1', title: 'fix auth bypass', tags: ['security'], estimatedComplexity: 'high' },
      DEFAULT_JOB_ROUTING_POLICY,
      ALL_AVAILABLE,
    );
    expect(d.preferredProvider).toBe('claude-code-compat');
    expect(d.providerPreference).toEqual(['claude-code-compat', 'anthropic-sdk']);
    expect(d.providerPreference).not.toContain('codex-cli');
  });

  it('excludes an unavailable provider and leads with the first available', () => {
    // The codex-is-unavailable case is the one that matters in production:
    // the binary is absent or fails P0.7a identity validation, and the cheap
    // profile must drop cleanly to the Claude chain (codex optional, never
    // required).
    const d = resolveJobRouting(
      { itemId: 'b2', title: 'update README links', tags: ['docs'], estimatedComplexity: 'low' },
      DEFAULT_JOB_ROUTING_POLICY,
      availabilityMap({ 'codex-cli': { available: false, reason: 'identity validation failed' } }),
    );
    expect(d.preferredProvider).toBe('claude-code-compat');
    expect(d.providerPreference).toEqual(['claude-code-compat', 'anthropic-sdk']);
    expect(d.providerPreference).not.toContain('codex-cli');
  });

  it('providerPreference has no duplicates and starts with preferredProvider', () => {
    const d = resolveJobRouting(
      { itemId: 'x', title: 'misc work', estimatedComplexity: 'medium' },
      DEFAULT_JOB_ROUTING_POLICY,
      ALL_AVAILABLE,
    );
    expect(new Set(d.providerPreference).size).toBe(d.providerPreference.length);
    expect(d.providerPreference[0]).toBe(d.preferredProvider);
  });
});

// ---------------------------------------------------------------------------
// applyForcedRuntimeProvider
// ---------------------------------------------------------------------------

describe('applyForcedRuntimeProvider', () => {
  // A representative cost-optimized decision (low-complexity docs item). Under
  // Claude-primary this prefers claude-code-compat at the cheap tier; the name is
  // kept for continuity — these tests assert FORCED-runtime behavior, not the
  // unforced provider.
  const codexDecision: JobRoutingDecision = resolveJobRouting(
    { itemId: 'doc1', title: 'update README', tags: ['docs'], estimatedComplexity: 'low' },
    DEFAULT_JOB_ROUTING_POLICY,
    ALL_AVAILABLE,
  );

  // A representative high-stakes decision (security item) — opus tier on Claude.
  const anthropicDecision: JobRoutingDecision = resolveJobRouting(
    { itemId: 'sec1', title: 'fix auth bypass', tags: ['security'], estimatedComplexity: 'high' },
    DEFAULT_JOB_ROUTING_POLICY,
    ALL_AVAILABLE,
  );

  it('returns a value deep-equal to the input when mode is "auto" (byte-identical guarantee)', () => {
    const result = applyForcedRuntimeProvider(codexDecision, 'auto');
    expect(result).toEqual(codexDecision);
    // Must be the same object reference (unchanged)
    expect(result).toBe(codexDecision);
  });

  it('returns a value deep-equal to the input when mode is undefined (byte-identical guarantee)', () => {
    const result = applyForcedRuntimeProvider(codexDecision, undefined);
    expect(result).toEqual(codexDecision);
    expect(result).toBe(codexDecision);
  });

  it('forced claude-code-compat: preferredProvider is NOT codex-cli and IS a Claude-family provider', () => {
    const result = applyForcedRuntimeProvider(codexDecision, 'claude-code-compat');
    expect(result.preferredProvider).not.toBe('codex-cli');
    expect(['anthropic-sdk', 'claude-code-compat'] as const).toContain(result.preferredProvider);
  });

  it('forced sdk: preferredProvider is NOT codex-cli and IS a Claude-family provider', () => {
    const result = applyForcedRuntimeProvider(codexDecision, 'sdk');
    expect(result.preferredProvider).not.toBe('codex-cli');
    expect(['anthropic-sdk', 'claude-code-compat'] as const).toContain(result.preferredProvider);
  });

  it('tier and effort are unchanged from the input decision when a Claude transport is forced', () => {
    const result = applyForcedRuntimeProvider(codexDecision, 'claude-code-compat');
    expect(result.tier).toBe(codexDecision.tier);
    expect(result.effort).toBe(codexDecision.effort);
  });

  it('forced claude-code-compat: providerPreference[0] is NOT codex-cli', () => {
    const result = applyForcedRuntimeProvider(codexDecision, 'claude-code-compat');
    expect(result.providerPreference[0]).not.toBe('codex-cli');
  });

  it('forced codex-cli applied to an anthropic-style decision: preferredProvider === "codex-cli"', () => {
    const result = applyForcedRuntimeProvider(anthropicDecision, 'codex-cli');
    expect(result.preferredProvider).toBe('codex-cli');
  });

  it('forced codex-cli: tier preserved from the anthropic decision input', () => {
    const result = applyForcedRuntimeProvider(anthropicDecision, 'codex-cli');
    expect(result.tier).toBe(anthropicDecision.tier);
  });

  it('availability is honored: anthropic-sdk unavailable + forced claude-code-compat => falls through to claude-code-compat', () => {
    const avail = availabilityMap({ 'anthropic-sdk': { available: false, reason: 'no key' } });
    const result = applyForcedRuntimeProvider(codexDecision, 'claude-code-compat', DEFAULT_JOB_ROUTING_POLICY, avail);
    expect(result.preferredProvider).toBe('claude-code-compat');
    expect(result.providerPreference).not.toContain('anthropic-sdk');
  });

  it('CROSS-FAMILY GUARANTEE: forcing Claude with the whole Claude family down never falls through to Codex', () => {
    const avail = availabilityMap({
      'anthropic-sdk': { available: false, reason: 'no key' },
      'claude-code-compat': { available: false, reason: 'cli missing' },
    });
    const result = applyForcedRuntimeProvider(
      codexDecision,
      'claude-code-compat',
      DEFAULT_JOB_ROUTING_POLICY,
      avail,
    );
    // Even with no Claude provider available, the forced family must NOT cross
    // over to Codex — the chain stays Claude-only (this is the regression the
    // adversarial-correctness review caught).
    expect(result.preferredProvider).not.toBe('codex-cli');
    expect(result.preferredProvider).not.toBe('openai-sdk');
    expect(result.providerPreference).not.toContain('codex-cli');
    expect(result.providerPreference).not.toContain('openai-sdk');
  });

  it('CROSS-FAMILY GUARANTEE: forcing Codex with the whole Codex family down never falls through to Claude', () => {
    const avail = availabilityMap({
      'codex-cli': { available: false, reason: 'no auth' },
      'openai-sdk': { available: false, reason: 'no key' },
    });
    const result = applyForcedRuntimeProvider(
      anthropicDecision,
      'codex-cli',
      DEFAULT_JOB_ROUTING_POLICY,
      avail,
    );
    expect(result.preferredProvider).not.toBe('anthropic-sdk');
    expect(result.preferredProvider).not.toBe('claude-code-compat');
    expect(result.providerPreference).not.toContain('anthropic-sdk');
    expect(result.providerPreference).not.toContain('claude-code-compat');
  });
});
