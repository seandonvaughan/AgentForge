import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type { ModelTier } from '@agentforge/shared';
import type {
  ExecutionProviderKind,
  ProviderModelProfile,
  ProviderModelProfiles,
} from './types.js';
import { MODEL_IDS } from '../agent-runtime/types.js';

export const DEFAULT_CODEX_MODEL_ID = 'gpt-5.3-codex';
export const DEFAULT_OPUS_MODEL_ID = 'gpt-5.5';
export const DEFAULT_HAIKU_MODEL_ID = 'gpt-5.4-mini';

const CODEX_DEFAULTS: Record<ModelTier, ProviderModelProfile> = {
  opus: { modelId: DEFAULT_OPUS_MODEL_ID, effort: 'xhigh' },
  sonnet: { modelId: DEFAULT_CODEX_MODEL_ID, effort: 'high' },
  haiku: { modelId: DEFAULT_HAIKU_MODEL_ID, effort: 'medium' },
};

const OPENAI_DEFAULTS: Record<ModelTier, ProviderModelProfile> = {
  opus: { modelId: DEFAULT_OPUS_MODEL_ID, effort: 'xhigh' },
  sonnet: { modelId: DEFAULT_CODEX_MODEL_ID, effort: 'high' },
  haiku: { modelId: DEFAULT_HAIKU_MODEL_ID, effort: 'medium' },
};

const PROVIDER_ENV_PREFIX: Partial<Record<ExecutionProviderKind, string>> = {
  'codex-cli': 'CODEX',
  'openai-sdk': 'OPENAI',
};

interface ModelConfigFile {
  providers?: Record<string, {
    model?: string;
    effort?: string;
    tiers?: Partial<Record<ModelTier, { model?: string; modelId?: string; effort?: string }>>;
  }>;
}

export function resolveProviderModelProfiles(
  tier: ModelTier,
  agentEffort?: string,
  env: NodeJS.ProcessEnv = process.env,
  projectRoot: string = process.cwd(),
): ProviderModelProfiles {
  return {
    'anthropic-sdk': { modelId: MODEL_IDS[tier], ...(agentEffort ? { effort: agentEffort } : {}) },
    'claude-code-compat': { modelId: MODEL_IDS[tier], ...(agentEffort ? { effort: agentEffort } : {}) },
    'codex-cli': resolveOpenAiLikeProfile('codex-cli', tier, agentEffort, env, projectRoot),
    'openai-sdk': resolveOpenAiLikeProfile('openai-sdk', tier, agentEffort, env, projectRoot),
  };
}

export function resolveProviderModelProfile(
  providerKind: ExecutionProviderKind,
  tier: ModelTier,
  agentEffort?: string,
  env: NodeJS.ProcessEnv = process.env,
  projectRoot: string = process.cwd(),
): ProviderModelProfile {
  return resolveProviderModelProfiles(tier, agentEffort, env, projectRoot)[providerKind]
    ?? { modelId: MODEL_IDS[tier], ...(agentEffort ? { effort: agentEffort } : {}) };
}

export function getRequestModelProfile(
  providerKind: ExecutionProviderKind,
  request: { modelId: string; effort?: string; providerModelProfiles?: ProviderModelProfiles },
): ProviderModelProfile {
  return request.providerModelProfiles?.[providerKind]
    ?? {
      modelId: request.modelId,
      ...(request.effort !== undefined ? { effort: request.effort } : {}),
    };
}

function resolveOpenAiLikeProfile(
  providerKind: 'codex-cli' | 'openai-sdk',
  tier: ModelTier,
  agentEffort: string | undefined,
  env: NodeJS.ProcessEnv,
  projectRoot: string,
): ProviderModelProfile {
  const defaults = providerKind === 'codex-cli' ? CODEX_DEFAULTS[tier] : OPENAI_DEFAULTS[tier];
  const fileProfile = readConfigProfile(projectRoot, providerKind, tier);
  const envProfile = readEnvProfile(env, providerKind, tier);

  const effort = envProfile.effort ?? fileProfile.effort ?? agentEffort ?? defaults.effort;
  return {
    modelId: envProfile.modelId ?? fileProfile.modelId ?? defaults.modelId,
    ...(effort !== undefined ? { effort } : {}),
  };
}

function readEnvProfile(
  env: NodeJS.ProcessEnv,
  providerKind: 'codex-cli' | 'openai-sdk',
  tier: ModelTier,
): Partial<ProviderModelProfile> {
  const prefix = PROVIDER_ENV_PREFIX[providerKind];
  if (!prefix) return {};

  const tierPrefix = `AGENTFORGE_${prefix}_${tier.toUpperCase()}`;
  const globalPrefix = `AGENTFORGE_${prefix}`;
  const modelId = env[`${tierPrefix}_MODEL`] ?? env[`${globalPrefix}_MODEL`];
  const effort = env[`${tierPrefix}_EFFORT`] ?? env[`${globalPrefix}_EFFORT`];

  return {
    ...(modelId ? { modelId } : {}),
    ...(effort ? { effort } : {}),
  };
}

function readConfigProfile(
  projectRoot: string,
  providerKind: 'codex-cli' | 'openai-sdk',
  tier: ModelTier,
): Partial<ProviderModelProfile> {
  const configPath = join(projectRoot, '.agentforge', 'config', 'models.yaml');
  if (!existsSync(configPath)) return {};

  try {
    const parsed = yaml.load(readFileSync(configPath, 'utf8')) as ModelConfigFile | null | undefined;
    const providerConfig = parsed?.providers?.[providerKind];
    if (!providerConfig) return {};

    const tierConfig = providerConfig.tiers?.[tier];
    const modelId = tierConfig?.modelId ?? tierConfig?.model ?? providerConfig.model;
    const effort = tierConfig?.effort ?? providerConfig.effort;

    return {
      ...(modelId ? { modelId } : {}),
      ...(effort ? { effort } : {}),
    };
  } catch {
    return {};
  }
}
