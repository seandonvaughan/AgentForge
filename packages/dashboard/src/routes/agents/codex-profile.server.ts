import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CapabilityTier, CodexModelProfile } from './agents-utils.js';

const DEFAULT_CODEX_MODEL_ID = 'gpt-5.3-codex';

const DEFAULT_CODEX_PROFILES: Record<CapabilityTier, { modelId: string; effort: string }> = {
  opus: { modelId: DEFAULT_CODEX_MODEL_ID, effort: 'xhigh' },
  sonnet: { modelId: DEFAULT_CODEX_MODEL_ID, effort: 'high' },
  haiku: { modelId: DEFAULT_CODEX_MODEL_ID, effort: 'medium' },
};

interface CodexProfileConfig {
  modelId?: string;
  effort?: string;
  tiers: Partial<Record<CapabilityTier, { modelId?: string; effort?: string }>>;
}

export function resolveDashboardCodexProfile(
  root: string,
  tier: CapabilityTier,
  agentEffort: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): CodexModelProfile {
  const config = readCodexProfileConfig(root);
  const tierConfig = config.tiers[tier] ?? {};
  const tierPrefix = `AGENTFORGE_CODEX_${tier.toUpperCase()}`;

  const modelId =
    env[`${tierPrefix}_MODEL`] ??
    env.AGENTFORGE_CODEX_MODEL ??
    tierConfig.modelId ??
    config.modelId ??
    DEFAULT_CODEX_PROFILES[tier].modelId;

  const effort =
    env[`${tierPrefix}_EFFORT`] ??
    env.AGENTFORGE_CODEX_EFFORT ??
    tierConfig.effort ??
    config.effort ??
    agentEffort ??
    DEFAULT_CODEX_PROFILES[tier].effort;

  return {
    provider: 'codex-cli',
    tier,
    modelId,
    effort,
  };
}

function readCodexProfileConfig(root: string): CodexProfileConfig {
  const empty: CodexProfileConfig = { tiers: {} };
  const configPath = join(root, '.agentforge', 'config', 'models.yaml');
  if (!existsSync(configPath)) return empty;

  try {
    return parseCodexProfileConfig(readFileSync(configPath, 'utf8'));
  } catch {
    return empty;
  }
}

function parseCodexProfileConfig(content: string): CodexProfileConfig {
  const config: CodexProfileConfig = { tiers: {} };
  let inProviders = false;
  let inCodex = false;
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
      inCodex = false;
      inTiers = false;
      currentTier = null;
      continue;
    }

    if (!inProviders) continue;

    if (indent === 2) {
      inCodex = key === 'codex-cli';
      inTiers = false;
      currentTier = null;
      continue;
    }

    if (!inCodex) continue;

    if (indent === 4) {
      inTiers = key === 'tiers';
      currentTier = null;
      if (!inTiers && value) assignProfileValue(config, key, value);
      continue;
    }

    if (!inTiers) continue;

    if (indent === 6) {
      currentTier = isCapabilityTier(key) ? key : null;
      if (currentTier && !config.tiers[currentTier]) config.tiers[currentTier] = {};
      continue;
    }

    if (indent === 8 && currentTier && value) {
      const tierConfig = config.tiers[currentTier] ?? {};
      assignProfileValue(tierConfig, key, value);
      config.tiers[currentTier] = tierConfig;
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

function isCapabilityTier(value: string): value is CapabilityTier {
  return value === 'opus' || value === 'sonnet' || value === 'haiku';
}
