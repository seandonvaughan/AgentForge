// Provider-accurate model display resolver.
//
// HISTORY: this module used to FORCE every tier/model onto the codex family
// (opus → gpt-5.5, sonnet → gpt-5.3-codex), a codex-first-era artifact. That
// made the dashboard show "gpt-5.5" for a cycle that actually ran on Claude
// (observed on the full-Claude cycle cc0af0bb: live subprocesses were
// `claude -p --model claude-sonnet-4-6`, yet ModelChip rendered gpt-5.5).
//
// Now AgentForge is Claude-primary / one-product: this resolver displays the
// model that ACTUALLY ran. A concrete model id (claude-* or gpt-*/…-codex) is
// shown verbatim and its family inferred from the id. A bare capability tier
// (fable|opus|sonnet|haiku) or a lone effort hint — which is all the
// agent-YAML fallback provides — resolves to the PRIMARY (Claude) family's
// model id, because forcing the cycle onto codex was exactly the bug. Genuine
// codex runs still render their real gpt-* id because the runtime records the
// concrete model string on each run.
//
// The fable tier (v24) is Claude-served only — claude-fable-5 sits above
// opus and has no codex counterpart.
//
// The export names retain the historical `codex*` prefix to avoid churning
// the call sites; the behavior is provider-neutral.

export type CapabilityTier = 'fable' | 'opus' | 'sonnet' | 'haiku';
export type ModelFamily = 'claude' | 'codex';

export interface CodexModelProfile {
  modelId: string;
  effort: string;
  tier: CapabilityTier;
  family: ModelFamily;
}

/** Primary (Claude) family model ids — used when only a bare tier is known. */
const CLAUDE_IDS: Record<CapabilityTier, string> = {
  fable: 'claude-fable-5',
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
};

const DEFAULT_EFFORT: Record<CapabilityTier, string> = {
  fable: 'xhigh',
  opus: 'high',
  sonnet: 'high',
  haiku: 'medium',
};

/** Infer the capability tier from a concrete model id. */
function tierFromModelId(raw: string): CapabilityTier {
  if (raw.includes('fable')) return 'fable';
  if (raw.includes('opus')) return 'opus';
  if (raw.includes('haiku') || raw.includes('mini')) return 'haiku';
  if (raw.includes('sonnet') || raw.includes('codex')) return 'sonnet';
  // bare gpt-* without a codex/mini marker → treat as the top codex tier
  if (raw.startsWith('gpt-')) return 'opus';
  return 'sonnet';
}

export function codexProfileFor(
  value: string | null | undefined,
  effort?: string | null,
): CodexModelProfile | null {
  const raw = (value ?? '').toLowerCase().trim();
  const normalizedEffort = (effort ?? '').toLowerCase();
  if (!raw && !normalizedEffort) return null;

  // 1. Concrete codex / OpenAI model id → codex family, shown verbatim.
  if (raw.startsWith('gpt-') || raw.includes('codex')) {
    const tier = tierFromModelId(raw);
    return { modelId: value!, effort: effort ?? DEFAULT_EFFORT[tier], tier, family: 'codex' };
  }

  // 2. Concrete Claude model id → claude family, shown verbatim.
  if (raw.startsWith('claude-')) {
    const tier = tierFromModelId(raw);
    return { modelId: value!, effort: effort ?? DEFAULT_EFFORT[tier], tier, family: 'claude' };
  }

  // 3. Bare tier name or lone effort hint → resolve to the PRIMARY (Claude)
  //    family. This is the path the agent-YAML fallback takes (it only knows
  //    the tier), and forcing it onto codex is the bug this module fixes.
  //    A lone 'xhigh' resolves to opus (not fable): fable is by-name only.
  const tier: CapabilityTier | null =
    raw.includes('fable')
      ? 'fable'
      : raw.includes('opus')
        ? 'opus'
        : raw.includes('haiku')
          ? 'haiku'
          : raw.includes('sonnet')
            ? 'sonnet'
            : normalizedEffort === 'xhigh'
              ? 'opus'
              : normalizedEffort === 'medium'
                ? 'haiku'
                : normalizedEffort === 'high'
                  ? 'sonnet'
                  : null;
  if (!tier) return null;
  return {
    modelId: CLAUDE_IDS[tier],
    effort: effort ?? DEFAULT_EFFORT[tier],
    tier,
    family: 'claude',
  };
}

export function codexProfileLabel(
  value: string | null | undefined,
  effort?: string | null,
): string {
  const profile = codexProfileFor(value, effort);
  if (profile) return `${profile.modelId} / ${profile.effort}`;
  if (value && effort) return `${value} / ${effort}`;
  return value ?? '—';
}

export function codexTierFor(
  value: string | null | undefined,
  effort?: string | null,
): CapabilityTier | null {
  return codexProfileFor(value, effort)?.tier ?? null;
}
