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
// Routing intent:
//   - security OR high-complexity work  -> Anthropic profile (opus, sdk)
//   - bulk / docs / low-complexity work -> cheaper Codex profile (sonnet/haiku)
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
 * Default routing policy.
 *
 * - anthropic profile: anthropic-sdk + sdk + opus + high effort; alternate
 *   chain falls back to the Claude Code CLI, then Codex.
 * - codex profile: codex-cli + codex-cli mode + sonnet + medium effort;
 *   alternate chain falls back to anthropic, then the Claude Code CLI.
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
      preferredProvider: 'anthropic-sdk',
      runtimeMode: 'sdk',
      tier: 'opus',
      effort: 'high',
      alternate: ['claude-code-compat', 'codex-cli'],
    },
    codex: {
      preferredProvider: 'codex-cli',
      runtimeMode: 'codex-cli',
      tier: 'sonnet',
      effort: 'medium',
      alternate: ['anthropic-sdk', 'claude-code-compat'],
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
  const chain: ExecutionProviderKind[] = [profile.preferredProvider, ...alternates];

  for (const candidate of chain) {
    if (isAvailable(candidate, availability)) {
      return {
        preferredProvider: candidate,
        runtimeMode:
          candidate === profile.preferredProvider
            ? profile.runtimeMode
            : runtimeModeForProvider(candidate),
        tier: profile.tier,
        effort: profile.effort,
      };
    }
  }

  // Nothing in the chain is available — return the primary so downstream still
  // gets a concrete decision (the resolver will surface the real error later).
  return {
    preferredProvider: profile.preferredProvider,
    runtimeMode: profile.runtimeMode,
    tier: profile.tier,
    effort: profile.effort,
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
