import { describe, expect, it } from 'vitest';
import {
  resolveJobRouting,
  DEFAULT_JOB_ROUTING_POLICY,
  type RoutableJob,
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

  it('routes a security / high-complexity item to the Anthropic profile (opus)', () => {
    const decision = resolveJobRouting(
      { itemId: 's1', title: 'fix auth bypass', tags: ['security'], estimatedComplexity: 'high' },
      DEFAULT_JOB_ROUTING_POLICY,
      ALL_AVAILABLE,
    );
    expect(decision.preferredProvider).toBe('anthropic-sdk');
    expect(decision.runtimeMode).toBe('sdk');
    expect(decision.tier).toBe('opus');
    expect(decision.effort).toBe('high');
  });

  it('routes high-complexity (no security tag) to the Anthropic profile', () => {
    const decision = resolveJobRouting(
      { itemId: 'h1', title: 'rework scheduler core', estimatedComplexity: 'high' },
      DEFAULT_JOB_ROUTING_POLICY,
      ALL_AVAILABLE,
    );
    expect(decision.preferredProvider).toBe('anthropic-sdk');
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
    expect(decision.preferredProvider).toBe('anthropic-sdk');
  });

  it('routes a bulk / docs low-complexity item to the cheaper Codex profile', () => {
    const decision = resolveJobRouting(
      { itemId: 'd1', title: 'update README links', tags: ['docs'], estimatedComplexity: 'low' },
      DEFAULT_JOB_ROUTING_POLICY,
      ALL_AVAILABLE,
    );
    expect(decision.preferredProvider).toBe('codex-cli');
    expect(decision.runtimeMode).toBe('codex-cli');
    expect(decision.tier === 'sonnet' || decision.tier === 'haiku').toBe(true);
  });

  it('escalates a job with prior failures up a profile (anthropic)', () => {
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
    expect(decision.preferredProvider).toBe('anthropic-sdk');
  });

  it('falls back to the configured alternate when the preferred provider is unavailable', () => {
    // A high-complexity job prefers anthropic; with anthropic unavailable it
    // must land on the policy's configured alternate, returning a concrete
    // decision (not anthropic, not undefined).
    const decision = resolveJobRouting(
      { itemId: 'o1', title: 'fix auth bypass', tags: ['security'], estimatedComplexity: 'high' },
      DEFAULT_JOB_ROUTING_POLICY,
      availabilityMap({ 'anthropic-sdk': { available: false, reason: 'no key' } }),
    );
    expect(decision.preferredProvider).not.toBe('anthropic-sdk');
    const alternate = DEFAULT_JOB_ROUTING_POLICY.profiles.anthropic.alternate;
    const firstAlternate = Array.isArray(alternate) ? alternate[0] : alternate;
    expect(decision.preferredProvider).toBe(firstAlternate);
    // concrete runtime mode aligned to the chosen alternate
    expect(decision.runtimeMode).toBe('claude-code-compat');
  });

  it('defaults everything to available when availability is omitted', () => {
    const decision = resolveJobRouting(
      { itemId: 'n1', title: 'fix auth bypass', tags: ['security'], estimatedComplexity: 'high' },
      DEFAULT_JOB_ROUTING_POLICY,
    );
    expect(decision.preferredProvider).toBe('anthropic-sdk');
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
      availabilityMap({ 'anthropic-sdk': { available: false, reason: 'no key' } }),
    );
    expect(decision.preferredProvider).toBe('codex-cli');
    expect(decision.runtimeMode).toBe('codex-cli');
  });
});

// ---------------------------------------------------------------------------
// Dispatch matrix — ANTI-FAKE GUARD.
//
// Two DIFFERENT items in the SAME plan must receive DIFFERENT preferredProvider
// values, AND each must dispatch to the matching stub transport (verified by
// which transport's execute() recorded the call). Plus an availability-driven
// override that flips the chosen transport.
// ---------------------------------------------------------------------------

describe('dispatch matrix (resolveJobRouting -> ProviderResolver -> transport.execute)', () => {
  const plan: RoutableJob[] = [
    { itemId: 'sec', title: 'patch auth bypass', tags: ['security'], estimatedComplexity: 'high' },
    { itemId: 'doc', title: 'update docs', tags: ['docs'], estimatedComplexity: 'low' },
  ];

  it('routes >=2 distinct providers within one plan and dispatches each to its matching transport', async () => {
    const decisions = plan.map((job) =>
      resolveJobRouting(job, DEFAULT_JOB_ROUTING_POLICY, ALL_AVAILABLE),
    );
    const chosenProviders = new Set(decisions.map((d) => d.preferredProvider));
    // ANTI-FAKE: hard-coding one provider fails here.
    expect(chosenProviders.size).toBeGreaterThanOrEqual(2);
    expect(chosenProviders.has('anthropic-sdk')).toBe(true);
    expect(chosenProviders.has('codex-cli')).toBe(true);

    const calls: string[] = [];
    const resolver = new ProviderResolver(
      [
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

    // security item ran on anthropic; docs item ran on codex.
    expect(calls).toContain('anthropic-sdk:sec');
    expect(calls).toContain('codex-cli:doc');
    expect(calls).not.toContain('codex-cli:sec');
    expect(calls).not.toContain('anthropic-sdk:doc');
  });

  it('availability-driven override: anthropic down => security item dispatches to its alternate transport', async () => {
    const availability = availabilityMap({
      'anthropic-sdk': { available: false, reason: 'no key' },
    });
    const secJob = plan[0]!;
    const decision = resolveJobRouting(secJob, DEFAULT_JOB_ROUTING_POLICY, availability);
    // routing chose the alternate up front
    expect(decision.preferredProvider).toBe('claude-code-compat');

    const calls: string[] = [];
    const resolver = new ProviderResolver(
      [
        buildRecordingTransport('anthropic-sdk', calls),
        buildRecordingTransport('claude-code-compat', calls),
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

    // The security item did NOT run on anthropic (it was unavailable) — it ran
    // on the configured alternate transport.
    expect(calls).toContain('claude-code-compat:sec');
    expect(calls).not.toContain('anthropic-sdk:sec');
  });
});
