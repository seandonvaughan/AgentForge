// Provider-accurate model profile resolver for the /agents SSR loaders.
//
// HISTORY: this module used to FORCE every capability tier onto the codex
// family (opus → gpt-5.5, sonnet → gpt-5.3-codex, haiku → gpt-5.4-mini,
// provider 'codex-cli') — a codex-first-era artifact. AgentForge is now
// Claude-primary / one-product (see $lib/modelProfiles.ts for the same
// decision on the client side): a bare capability tier resolves to the
// PRIMARY (Claude) family model id. The fable tier (v24) is Claude-served
// only — claude-fable-5 sits above opus and has no codex counterpart.
//
// Explicit overrides (env vars or .agentforge/config/models.yaml) are still
// honoured; the returned `provider` is inferred from the RESOLVED model id so
// a genuine codex override renders as codex, not as Claude.
//
// The exported function name retains the historical `Codex` prefix to limit
// call-site churn; the behaviour is provider-neutral.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CapabilityTier, CodexModelProfile, ModelProvider } from './agents-utils.js';

/** Claude-primary defaults per capability tier (model id + reasoning effort). */
const DEFAULT_TIER_PROFILES: Record<CapabilityTier, { modelId: string; effort: string }> = {
  fable: { modelId: 'claude-fable-5', effort: 'xhigh' },
  opus: { modelId: 'claude-opus-4-8', effort: 'high' },
  sonnet: { modelId: 'claude-sonnet-4-6', effort: 'high' },
  haiku: { modelId: 'claude-haiku-4-5', effort: 'medium' },
};

/** Provider sections recognised in .agentforge/config/models.yaml. */
const CONFIG_PROVIDERS = ['claude', 'codex-cli'] as const;
type ConfigProvider = (typeof CONFIG_PROVIDERS)[number];

interface ProviderProfileConfig {
  modelId?: string;
  effort?: string;
  tiers: Partial<Record<CapabilityTier, { modelId?: string; effort?: string }>>;
}

type ModelProfileConfig = Partial<Record<ConfigProvider, ProviderProfileConfig>>;

/** Infer the serving provider family from a resolved model id. */
function providerForModelId(modelId: string): ModelProvider {
  const lower = modelId.toLowerCase();
  if (lower.startsWith('gpt-') || lower.includes('codex')) return 'codex-cli';
  return 'claude';
}

export function resolveDashboardCodexProfile(
  root: string,
  tier: CapabilityTier,
  agentEffort: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): CodexModelProfile {
  const config = readModelProfileConfig(root);
  // Claude (primary) section wins when both define the same tier.
  const tierConfig = config.claude?.tiers[tier] ?? config['codex-cli']?.tiers[tier] ?? {};
  const tierPrefix = `AGENTFORGE_CODEX_${tier.toUpperCase()}`;

  const modelId =
    env[`${tierPrefix}_MODEL`] ??
    env.AGENTFORGE_CODEX_MODEL ??
    tierConfig.modelId ??
    config.claude?.modelId ??
    config['codex-cli']?.modelId ??
    DEFAULT_TIER_PROFILES[tier].modelId;

  const effort =
    env[`${tierPrefix}_EFFORT`] ??
    env.AGENTFORGE_CODEX_EFFORT ??
    agentEffort ??
    tierConfig.effort ??
    config.claude?.effort ??
    config['codex-cli']?.effort ??
    DEFAULT_TIER_PROFILES[tier].effort;

  return {
    provider: providerForModelId(modelId),
    tier,
    modelId,
    effort,
  };
}

function readModelProfileConfig(root: string): ModelProfileConfig {
  const configPath = join(root, '.agentforge', 'config', 'models.yaml');
  if (!existsSync(configPath)) return {};

  try {
    return parseModelProfileConfig(readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

function parseModelProfileConfig(content: string): ModelProfileConfig {
  const config: ModelProfileConfig = {};
  let inProviders = false;
  let currentProvider: ConfigProvider | null = null;
  let inTiers = false;
  let currentTier: CapabilityTier | null = null;

  for (const rawLine of content.split('\n')) {
    const withoutComment = rawLine.replace(/\s+#.*$/, '');
    if (!withoutComment.trim()) continue;

    const indent = withoutComment.match(/^\s*/)?.[0].length ?? 0;
    const match = withoutComment.trim().match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    const value = stripYamlValue(match[2]);

    if (indent === 0) {
      inProviders = key === 'providers';
      currentProvider = null;
      inTiers = false;
      currentTier = null;
      continue;
    }

    if (!inProviders) continue;

    if (indent === 2) {
      currentProvider = isConfigProvider(key) ? key : null;
      if (currentProvider && !config[currentProvider]) config[currentProvider] = { tiers: {} };
      inTiers = false;
      currentTier = null;
      continue;
    }

    const providerConfig = currentProvider ? config[currentProvider] : undefined;
    if (!providerConfig) continue;

    if (indent === 4) {
      inTiers = key === 'tiers';
      currentTier = null;
      if (!inTiers && value) assignProfileValue(providerConfig, key, value);
      continue;
    }

    if (!inTiers) continue;

    if (indent === 6) {
      currentTier = isCapabilityTier(key) ? key : null;
      if (currentTier && !providerConfig.tiers[currentTier]) providerConfig.tiers[currentTier] = {};
      continue;
    }

    if (indent === 8 && currentTier && value) {
      const tierConfig = providerConfig.tiers[currentTier] ?? {};
      assignProfileValue(tierConfig, key, value);
      providerConfig.tiers[currentTier] = tierConfig;
    }
  }

  return config;
}

function assignProfileValue(
  target: { modelId?: string; effort?: string },
  key: string,
  value: string,
): void {
  if (key === 'model' || key === 'modelId') target.modelId = value;
  if (key === 'effort') target.effort = value;
}

function stripYamlValue(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '');
}

function isConfigProvider(value: string): value is ConfigProvider {
  return value === 'claude' || value === 'codex-cli';
}

function isCapabilityTier(value: string): value is CapabilityTier {
  return value === 'fable' || value === 'opus' || value === 'sonnet' || value === 'haiku';
}
