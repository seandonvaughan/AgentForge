// packages/core/src/autonomous/routing/job-router.ts
//
// v7 north-star item 3 — Per-job provider x model x effort routing policy engine.
//
// `resolveJobRouting` is a PURE function: no I/O, no env reads, no clock. It
// derives the best provider/model/effort PER JOB from the job's own
// characteristics (kind/tags, complexity, touched subsystems/files, prior
// failures) instead of relying on a single global runtime. The assign phase
// calls it for every item and writes the decision onto the item so the execute
// phase dispatches each item to the matching transport.
//
// Routing intent (Claude-primary product decision, 2026-06-06):
//   AgentForge is ONE product with no modes. Claude is the default provider for
//   EVERYTHING; codex is OPTIONAL auxiliary capacity that only enters a failover
//   chain when its binary passes identity validation. Both profiles therefore
//   PREFER a tool-capable Claude transport (`claude-code-compat`):
//   - security OR high-complexity work  -> Claude opus (claude-code-compat),
//     alternate: anthropic-sdk ONLY. Judgment + security stay on Claude — codex
//     is intentionally NOT in this chain.
//   - bulk / docs / low-complexity work -> Claude sonnet/haiku
//     (claude-code-compat), alternate: anthropic-sdk then codex-cli. Codex is the
//     LAST fallback (auxiliary), used only when both Claude transports are down.
//
//   NOTE: `anthropic-sdk` is a TEXT-ONLY transport (no tools). Items that edit
//   files need `claude-code-compat`, which is why it leads both chains.
//
// If the chosen preferredProvider is unavailable in the supplied availability
// snapshot, the decision falls back to the profile's configured alternate (and
// keeps falling back along the chain until it finds an available provider, or
// returns the primary unchanged when nothing is available so callers always
// receive a concrete decision).

import type { ModelTier } from '@agentforge/shared';
import type { ProviderAvailabilityMap } from '../../runtime/provider-availability.js';
import type { ExecutionProviderKind, RuntimeMode } from '../../runtime/types.js';

/**
 * The subset of a ranked/sprint item that routing reads. Kept structural so
 * any item shape carrying these fields (RankedItem, SprintItem, plan items)
 * can be routed without coupling to one concrete interface.
 */
export interface RoutableJob {
  itemId?: string;
  id?: string;
  title?: string;
  description?: string;
  /** Item kind tags, e.g. 'security', 'docs', 'bulk', 'feature'. */
  tags?: string[];
  suggestedTags?: string[];
  /** Touched subsystems / declared file paths. */
  files?: string[];
  owns_subsystems?: string[];
  /** Coarse complexity estimate. */
  estimatedComplexity?: 'high' | 'medium' | 'low';
  /** Count of prior failed attempts on this item, if tracked. */
  priorFailureCount?: number;
}

/** The concrete routing decision for one job. */
export interface JobRoutingDecision {
  preferredProvider: ExecutionProviderKind;
  runtimeMode: RuntimeMode;
  tier: ModelTier;
  effort: string;
  /**
   * Ordered provider failover chain: [preferredProvider, ...remaining alternates],
   * filtered to available providers and de-duplicated. Threaded to
   * ExecutionService as `providerPreference` so a classified-retriable failure on
   * the preferred provider auto-switches to the next eligible one.
   */
  providerPreference: ExecutionProviderKind[];
}

/**
 * A routing profile: the provider to prefer, the runtime mode + tier + effort
 * that go with it, and an ordered fallback `alternate` chain used when the
 * primary provider is unavailable.
 */
export interface JobRoutingProfile {
  preferredProvider: ExecutionProviderKind;
  runtimeMode: RuntimeMode;
  tier: ModelTier;
  effort: string;
  /**
   * Provider to fall back to when `preferredProvider` is unavailable. May be a
   * single provider or an ordered chain (tried left to right).
   */
  alternate: ExecutionProviderKind | ExecutionProviderKind[];
}

export interface JobRoutingPolicy {
  /** Substrings (matched case-insensitively via includes) that mark a job as security work. */
  securityMarkers: string[];
  /** Substrings that mark a job as cheap/bulk/docs work. */
  cheapMarkers: string[];
  /** Prior-failure count at/above which a job is escalated to the anthropic profile. */
  escalateAfterFailures: number;
  profiles: {
    /** High-stakes profile: strategic / security / high-complexity. */
    anthropic: JobRoutingProfile;
    /** Cheaper profile: bulk / docs / low-complexity. */
    codex: JobRoutingProfile;
  };
}

/**
 * Default routing policy — Claude-primary, codex-auxiliary (2026-06-06).
 *
 * Both profiles prefer the tool-capable Claude transport (`claude-code-compat`)
 * so file-editing work always has tools:
 * - anthropic profile (security / high-complexity / repeated-failure escalation):
 *   claude-code-compat + opus + high effort; alternate chain is anthropic-sdk
 *   ONLY. Codex is deliberately absent — judgment + security stay on Claude.
 * - codex profile (the cost-conscious DEFAULT for bulk / docs / low-complexity
 *   and unmarked work): claude-code-compat + sonnet + medium effort; alternate
 *   chain falls back to anthropic-sdk, then codex-cli as the LAST resort. Codex
 *   is auxiliary capacity used only when both Claude transports are unavailable.
 *
 * The profile key `codex` is retained for backward compatibility (forced-runtime
 * family mapping and existing call sites) even though it now prefers Claude; it
 * is the cost-optimized "non-escalated" profile, not a codex-first one.
 */
export const DEFAULT_JOB_ROUTING_POLICY: JobRoutingPolicy = {
  securityMarkers: [
    'security',
    'auth',
    'rbac',
    'secret',
    'token',
    'credential',
    'crypto',
    'vuln',
    'cve',
  ],
  cheapMarkers: ['docs', 'documentation', 'bulk', 'chore', 'typo', 'comment', 'readme', 'lint'],
  escalateAfterFailures: 2,
  profiles: {
    anthropic: {
      preferredProvider: 'claude-code-compat',
      runtimeMode: 'claude-code-compat',
      tier: 'opus',
      effort: 'high',
      // Security + judgment stay on Claude: anthropic-sdk only, never codex.
      alternate: ['anthropic-sdk'],
    },
    codex: {
      preferredProvider: 'claude-code-compat',
      runtimeMode: 'claude-code-compat',
      tier: 'sonnet',
      effort: 'medium',
      // Codex is the LAST fallback (auxiliary), after both Claude transports.
      alternate: ['anthropic-sdk', 'codex-cli'],
    },
  },
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** All free-text + tag + subsystem signal for one job, lowercased once. */
function jobSignal(job: RoutableJob): string {
  const parts: string[] = [];
  if (job.title) parts.push(job.title);
  if (job.description) parts.push(job.description);
  for (const t of job.tags ?? []) parts.push(t);
  for (const t of job.suggestedTags ?? []) parts.push(t);
  for (const f of job.files ?? []) parts.push(f);
  for (const s of job.owns_subsystems ?? []) parts.push(s);
  return parts.join(' ').toLowerCase();
}

/** Substring match using String.includes (never regex on item-derived text). */
function matchesAny(signal: string, markers: string[]): boolean {
  for (const marker of markers) {
    if (signal.includes(marker.toLowerCase())) return true;
  }
  return false;
}

function runtimeModeForProvider(kind: ExecutionProviderKind): RuntimeMode {
  if (kind === 'anthropic-sdk') return 'sdk';
  // claude-code-compat, codex-cli, openai-sdk are their own runtime modes.
  return kind;
}

function isAvailable(
  kind: ExecutionProviderKind,
  availability: ProviderAvailabilityMap | undefined,
): boolean {
  // Backward-compatible: no snapshot => treat everything as available.
  if (!availability) return true;
  return availability[kind]?.available !== false;
}

/**
 * Apply an availability-driven override to a profile. Returns a decision whose
 * `preferredProvider` is the first available provider in
 * [primary, ...alternates], with `runtimeMode` re-derived for whichever
 * provider was chosen. If none are available, returns the primary unchanged so
 * the caller always gets a concrete decision.
 */
function applyAvailability(
  profile: JobRoutingProfile,
  availability: ProviderAvailabilityMap | undefined,
): JobRoutingDecision {
  const alternates = Array.isArray(profile.alternate)
    ? profile.alternate
    : [profile.alternate];
  // De-dupe the [primary, ...alternates] chain, preserving order.
  const chain: ExecutionProviderKind[] = [...new Set([profile.preferredProvider, ...alternates])];

  // Ordered failover chain limited to currently-available providers.
  const available = chain.filter((candidate) => isAvailable(candidate, availability));

  if (available.length > 0) {
    const preferred = available[0]!;
    return {
      preferredProvider: preferred,
      runtimeMode:
        preferred === profile.preferredProvider
          ? profile.runtimeMode
          : runtimeModeForProvider(preferred),
      tier: profile.tier,
      effort: profile.effort,
      providerPreference: available,
    };
  }

  // Nothing in the chain is available — return the primary plus the full chain so
  // downstream still gets a concrete decision and a failover order to try (the
  // resolver will surface the real error later).
  return {
    preferredProvider: profile.preferredProvider,
    runtimeMode: profile.runtimeMode,
    tier: profile.tier,
    effort: profile.effort,
    providerPreference: chain,
  };
}

// ---------------------------------------------------------------------------
// Forced-runtime provider override
// ---------------------------------------------------------------------------

/**
 * Provider families that a forced AGENTFORGE_RUNTIME pins the cycle to. 'auto'
 * (and any unrecognized mode) is intentionally absent: when the runtime is auto
 * the cost-optimizing job-router decides per-item exactly as before.
 */
const CLAUDE_RUNTIME_FAMILY: ReadonlySet<RuntimeMode> = new Set<RuntimeMode>([
  'sdk',
  'cli',
  'anthropic-sdk',
  'claude-cli',
  'claude-code-compat',
]);
const CODEX_RUNTIME_FAMILY: ReadonlySet<RuntimeMode> = new Set<RuntimeMode>([
  'codex-cli',
  'openai-sdk',
]);

/**
 * The concrete ExecutionProvider members of each runtime family. A forced
 * family's failover chain is restricted to these so a force can NEVER cross
 * over to the other family (forcing Claude must never dispatch Codex, and
 * vice-versa).
 */
const CLAUDE_FAMILY_PROVIDERS: readonly ExecutionProviderKind[] = [
  'anthropic-sdk',
  'claude-code-compat',
];
const CODEX_FAMILY_PROVIDERS: readonly ExecutionProviderKind[] = ['codex-cli', 'openai-sdk'];

/** Map a forced runtime mode to its concrete provider kind, when one exists. */
function forcedProviderKind(mode: RuntimeMode): ExecutionProviderKind | undefined {
  switch (mode) {
    case 'sdk':
    case 'anthropic-sdk':
      return 'anthropic-sdk';
    case 'claude-code-compat':
      return 'claude-code-compat';
    case 'codex-cli':
      return 'codex-cli';
    case 'openai-sdk':
      return 'openai-sdk';
    // 'cli' / 'claude-cli' have no distinct routing provider kind; the family
    // chain (anthropic-sdk first) covers them.
    default:
      return undefined;
  }
}

/**
 * Honor an operator-forced runtime over the cost-optimizing router.
 *
 * When AGENTFORGE_RUNTIME pins a single provider family, the operator has
 * explicitly chosen which provider runs the cycle. Override only the routed
 * decision's PROVIDER + failover chain to that family while PRESERVING the
 * cost-optimized tier/effort the router chose. The model then resolves to that
 * family's model for the same tier (e.g. sonnet -> claude-sonnet on the Claude
 * family, gpt-5.5 on the Codex family) so the dashboard reflects the provider
 * that will actually run.
 *
 * The failover chain is restricted to SAME-FAMILY providers (and led by the
 * exact forced transport when it maps to a concrete provider kind), so a forced
 * Claude runtime can never fall through to Codex and vice-versa.
 *
 * For mode === 'auto' (and undefined / unrecognized modes) the decision is
 * returned UNCHANGED — byte-identical to the router's output, so the default
 * auto path has zero behavior change.
 *
 * PURE: depends only on its arguments. No env / clock / IO. Does not mutate input.
 */
export function applyForcedRuntimeProvider(
  decision: JobRoutingDecision,
  mode: RuntimeMode | undefined,
  policy: JobRoutingPolicy = DEFAULT_JOB_ROUTING_POLICY,
  availability?: ProviderAvailabilityMap,
): JobRoutingDecision {
  if (mode === undefined) return decision;
  const isClaudeFamily = CLAUDE_RUNTIME_FAMILY.has(mode);
  const isCodexFamily = CODEX_RUNTIME_FAMILY.has(mode);
  if (!isClaudeFamily && !isCodexFamily) return decision; // 'auto' / unrecognized -> unchanged

  const baseProfile = isClaudeFamily ? policy.profiles.anthropic : policy.profiles.codex;
  const familyProviders = isClaudeFamily ? CLAUDE_FAMILY_PROVIDERS : CODEX_FAMILY_PROVIDERS;

  // Build a same-family failover chain: exact forced transport first (when it
  // maps to a concrete kind), then the profile's own chain, de-duped and
  // filtered to this family. The base profile's preferred provider is always a
  // member of its own family, so the result is never empty.
  const baseChain: ExecutionProviderKind[] = [
    baseProfile.preferredProvider,
    ...(Array.isArray(baseProfile.alternate) ? baseProfile.alternate : [baseProfile.alternate]),
  ];
  const exact = forcedProviderKind(mode);
  const orderedChain = [...(exact ? [exact] : []), ...baseChain];
  const familyChain = [...new Set(orderedChain)].filter((p) => familyProviders.includes(p));

  const sameFamilyProfile: JobRoutingProfile = {
    preferredProvider: familyChain[0]!,
    runtimeMode: runtimeModeForProvider(familyChain[0]!),
    tier: baseProfile.tier,
    effort: baseProfile.effort,
    alternate: familyChain.slice(1),
  };

  const providerChoice = applyAvailability(sameFamilyProfile, availability);
  return {
    preferredProvider: providerChoice.preferredProvider,
    runtimeMode: providerChoice.runtimeMode,
    tier: decision.tier, // preserve cost-optimized tier
    effort: decision.effort, // preserve cost-optimized effort
    providerPreference: providerChoice.providerPreference,
  };
}

// ---------------------------------------------------------------------------
// Public API — the pure resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the per-job provider x model x effort routing decision.
 *
 * PURE: depends only on its arguments. No env, no clock, no I/O. Does not
 * mutate the input job.
 *
 * @param job          The job/item to route.
 * @param policy       Routing policy (use DEFAULT_JOB_ROUTING_POLICY).
 * @param availability Optional provider availability snapshot. When omitted,
 *                     every provider is treated as available.
 */
export function resolveJobRouting(
  job: RoutableJob,
  policy: JobRoutingPolicy = DEFAULT_JOB_ROUTING_POLICY,
  availability?: ProviderAvailabilityMap,
): JobRoutingDecision {
  const signal = jobSignal(job);

  const isSecurity = matchesAny(signal, policy.securityMarkers);
  const isHighComplexity = job.estimatedComplexity === 'high';
  const isLowComplexity = job.estimatedComplexity === 'low';
  const isCheapKind = matchesAny(signal, policy.cheapMarkers);
  const failures = job.priorFailureCount ?? 0;
  const hasRepeatedFailures = failures >= policy.escalateAfterFailures;

  // Escalation rules (any one routes to the high-stakes Anthropic profile):
  //   - security work
  //   - high-complexity work
  //   - work that has already failed repeatedly (needs the strongest model)
  const useAnthropic = isSecurity || isHighComplexity || hasRepeatedFailures;

  if (useAnthropic) {
    return applyAvailability(policy.profiles.anthropic, availability);
  }

  // Cheap profile for explicitly cheap kinds or low-complexity work; medium
  // work without other signal also lands here as the cost-conscious default.
  const useCheap = isCheapKind || isLowComplexity || !isHighComplexity;
  if (useCheap) {
    const decision = applyAvailability(policy.profiles.codex, availability);
    // Pure docs/low-complexity bulk can run on the cheapest tier.
    if (isCheapKind && isLowComplexity) {
      return { ...decision, tier: 'haiku' };
    }
    return decision;
  }

  // Unreachable in practice (useCheap is true whenever useAnthropic is false),
  // but keep a concrete default for total coverage.
  return applyAvailability(policy.profiles.codex, availability);
}
