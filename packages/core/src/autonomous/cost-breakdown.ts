// packages/core/src/autonomous/cost-breakdown.ts
//
// Pure functions for computing and merging per-run cost breakdowns.
// No I/O, no module-level state.
//
// Wave 2 will call extractBreakdownFromAgentRun() from RuntimeAdapter /
// execute-phase agent-run recorder and wire the results into CycleResult.cost.breakdown.

import { MODEL_PRICING } from '../agent-runtime/types.js';
import { resolveOpenAiPricing } from '../runtime/openai-pricing.js';
import type { ExecutionProviderKind } from '../runtime/types.js';
import type { ModelTier } from '@agentforge/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostBreakdown {
  inputTokens:   { count: number; usd: number };
  outputTokens:  { count: number; usd: number };
  cacheCreation: { tokens: number; usd: number };
  cacheRead:     { tokens: number; usd: number };
  toolUse: Record<string, { invocations: number; usd: number }>;
  totalUsd: number;
}

/**
 * Minimal description of an agent run sufficient to price it.
 * Mirrors the shape returned by RuntimeAdapter.run() plus optional
 * cache-token fields that the transports already carry.
 */
export interface AgentRun {
  model: string;
  /** Internal AgentForge tier. Takes precedence when provider IDs are tierless. */
  capabilityTier?: ModelTier;
  /**
   * Provider that actually executed this run (item 1's resolved value). Selects
   * the pricing table: Anthropic tier pricing vs OpenAI/Codex pricing. When
   * omitted, defaults to Anthropic pricing for backward compatibility.
   */
  resolvedProvider?: ExecutionProviderKind;
  /**
   * Concrete model id the resolved provider ran (item 1's resolved value).
   * For OpenAI/Codex providers this keys the OpenAI pricing table; falls back
   * to `model` when omitted.
   */
  resolvedModelId?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /** Optional tool-use accounting keyed by tool name. */
  toolInvocations?: Record<string, { invocations: number; usd: number }>;
}

// ---------------------------------------------------------------------------
// Cache pricing multipliers (Anthropic public rates)
//   cache-read    tokens: 10 % of normal input price
//   cache-creation tokens: 125 % of normal input price
// ---------------------------------------------------------------------------
const CACHE_READ_MULTIPLIER       = 0.10;
const CACHE_CREATION_MULTIPLIER   = 1.25;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a model string to a pricing tier.
 *
 * Matches on model-name substrings so that both the full Anthropic model ID
 * (e.g. `claude-opus-4-8`) and the short tier alias (`opus`) resolve correctly.
 * Falls back to `sonnet` if no match is found rather than throwing, keeping
 * the function safe for unknown future model IDs.
 */
function resolveModelTier(model: string, capabilityTier?: ModelTier): ModelTier {
  if (capabilityTier === 'opus' || capabilityTier === 'sonnet' || capabilityTier === 'haiku') {
    return capabilityTier;
  }

  const lower = model.toLowerCase();
  if (lower.includes('opus'))   return 'opus';
  if (lower.includes('haiku'))  return 'haiku';
  return 'sonnet';
}

/** Providers billed via the OpenAI/Codex pricing table. */
function isOpenAiFamily(provider: ExecutionProviderKind | undefined): boolean {
  return provider === 'openai-sdk' || provider === 'codex-cli';
}

/**
 * Per-component USD rates for a run, resolved from the table that matches the
 * provider that actually ran. All rates are per-million-token.
 *
 * Anthropic: cache-read = input × 0.10, cache-creation = input × 1.25.
 * OpenAI/Codex: cache-read = the published `cachedInput` rate (falls back to the
 * standard input rate); cache-creation carries no premium (OpenAI bills cache
 * writes at the standard input rate), so its rate equals the input rate.
 */
interface ComponentRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

function resolveComponentRates(run: AgentRun): ComponentRates {
  if (isOpenAiFamily(run.resolvedProvider)) {
    const pricing = resolveOpenAiPricing(run.resolvedModelId ?? run.model);
    return {
      input: pricing.input,
      output: pricing.output,
      cacheRead: pricing.cachedInput ?? pricing.input,
      cacheCreation: pricing.input,
    };
  }

  const tier = resolveModelTier(run.model, run.capabilityTier);
  // MODEL_PRICING is a Record<ModelTier, ...> so the lookup is always defined.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const pricing = MODEL_PRICING[tier]!;
  return {
    input: pricing.input,
    output: pricing.output,
    cacheRead: pricing.input * CACHE_READ_MULTIPLIER,
    cacheCreation: pricing.input * CACHE_CREATION_MULTIPLIER,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a CostBreakdown from a single agent run.
 *
 * The component rates come from the table matching `resolvedProvider` (Anthropic
 * tier pricing vs OpenAI/Codex pricing — see resolveComponentRates); when
 * `resolvedProvider` is omitted the Anthropic path is used for compatibility.
 *
 * Pricing formula:
 *   regular input = max(0, input_tokens - cache_read - cache_creation)
 *   cost = (regularInput   / 1M) * rates.input
 *        + (cacheRead       / 1M) * rates.cacheRead
 *        + (cacheCreation   / 1M) * rates.cacheCreation
 *        + (outputTokens    / 1M) * rates.output
 */
export function extractBreakdownFromAgentRun(run: AgentRun): CostBreakdown {
  const rates = resolveComponentRates(run);

  const inputTokens         = run.usage.input_tokens ?? 0;
  const outputTokens        = run.usage.output_tokens ?? 0;
  const cacheReadTokens     = run.usage.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = run.usage.cache_creation_input_tokens ?? 0;

  const regularInput = Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens);

  const inputUsd         = (regularInput       / 1_000_000) * rates.input;
  const outputUsd        = (outputTokens        / 1_000_000) * rates.output;
  const cacheReadUsd     = (cacheReadTokens     / 1_000_000) * rates.cacheRead;
  const cacheCreationUsd = (cacheCreationTokens / 1_000_000) * rates.cacheCreation;

  const toolUse: Record<string, { invocations: number; usd: number }> =
    run.toolInvocations ? { ...run.toolInvocations } : {};

  const toolUsd = Object.values(toolUse).reduce((sum, t) => sum + t.usd, 0);

  const totalUsd = inputUsd + outputUsd + cacheReadUsd + cacheCreationUsd + toolUsd;

  return {
    inputTokens:   { count: regularInput,        usd: inputUsd },
    outputTokens:  { count: outputTokens,         usd: outputUsd },
    cacheCreation: { tokens: cacheCreationTokens, usd: cacheCreationUsd },
    cacheRead:     { tokens: cacheReadTokens,     usd: cacheReadUsd },
    toolUse,
    totalUsd,
  };
}

/**
 * Element-wise sum of two CostBreakdown objects.
 *
 * toolUse entries are merged by key; entries present in only one operand are
 * included unchanged.
 */
export function mergeBreakdowns(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  // Merge toolUse maps
  const mergedToolUse: Record<string, { invocations: number; usd: number }> = {};
  const allKeys = new Set([...Object.keys(a.toolUse), ...Object.keys(b.toolUse)]);
  for (const key of allKeys) {
    const aEntry = a.toolUse[key] ?? { invocations: 0, usd: 0 };
    const bEntry = b.toolUse[key] ?? { invocations: 0, usd: 0 };
    mergedToolUse[key] = {
      invocations: aEntry.invocations + bEntry.invocations,
      usd: aEntry.usd + bEntry.usd,
    };
  }

  return {
    inputTokens: {
      count: a.inputTokens.count + b.inputTokens.count,
      usd:   a.inputTokens.usd   + b.inputTokens.usd,
    },
    outputTokens: {
      count: a.outputTokens.count + b.outputTokens.count,
      usd:   a.outputTokens.usd   + b.outputTokens.usd,
    },
    cacheCreation: {
      tokens: a.cacheCreation.tokens + b.cacheCreation.tokens,
      usd:    a.cacheCreation.usd    + b.cacheCreation.usd,
    },
    cacheRead: {
      tokens: a.cacheRead.tokens + b.cacheRead.tokens,
      usd:    a.cacheRead.usd    + b.cacheRead.usd,
    },
    toolUse: mergedToolUse,
    totalUsd: a.totalUsd + b.totalUsd,
  };
}
