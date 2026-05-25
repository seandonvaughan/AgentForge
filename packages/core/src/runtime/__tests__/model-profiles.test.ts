import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolveProviderModelProfile, resolveProviderModelProfiles } from '../model-profiles.js';

describe('Codex/OpenAI model profiles', () => {
  it('maps AgentForge tiers to Codex model and effort defaults', () => {
    expect(resolveProviderModelProfile('codex-cli', 'opus', undefined, {}, '.')).toEqual({
      modelId: 'gpt-5.5',
      effort: 'xhigh',
    });
    expect(resolveProviderModelProfile('codex-cli', 'sonnet', undefined, {}, '.')).toEqual({
      modelId: 'gpt-5.3-codex',
      effort: 'high',
    });
    expect(resolveProviderModelProfile('codex-cli', 'haiku', undefined, {}, '.')).toEqual({
      modelId: 'gpt-5.4-mini',
      effort: 'medium',
    });
    expect(resolveProviderModelProfile('openai-sdk', 'opus', undefined, {}, '.')).toEqual({
      modelId: 'gpt-5.5',
      effort: 'xhigh',
    });
    expect(resolveProviderModelProfile('openai-sdk', 'haiku', undefined, {}, '.')).toEqual({
      modelId: 'gpt-5.4-mini',
      effort: 'medium',
    });
  });

  it('keeps Anthropic provider profiles on Claude model ids', () => {
    const profiles = resolveProviderModelProfiles('sonnet', 'high', {}, '.');
    expect(profiles['anthropic-sdk']).toEqual({
      modelId: 'claude-sonnet-4-6',
      effort: 'high',
    });
    expect(profiles['claude-code-compat']).toEqual({
      modelId: 'claude-sonnet-4-6',
      effort: 'high',
    });
  });

  it('uses per-agent effort for Codex/OpenAI profiles when env and config do not override it', () => {
    const projectRootWithoutConfig = join(tmpdir(), 'agentforge-no-model-config');
    expect(resolveProviderModelProfile('codex-cli', 'sonnet', 'low', {}, projectRootWithoutConfig)).toEqual({
      modelId: 'gpt-5.3-codex',
      effort: 'low',
    });
    expect(resolveProviderModelProfile('openai-sdk', 'sonnet', 'low', {}, projectRootWithoutConfig)).toEqual({
      modelId: 'gpt-5.3-codex',
      effort: 'low',
    });
  });

  it('supports provider-wide and tier-specific Codex env overrides', () => {
    const env = {
      AGENTFORGE_CODEX_MODEL: 'gpt-5-codex',
      AGENTFORGE_CODEX_HAIKU_MODEL: 'codex-mini-latest',
      AGENTFORGE_CODEX_HAIKU_EFFORT: 'low',
    };

    expect(resolveProviderModelProfile('codex-cli', 'sonnet', undefined, env, '.')).toEqual({
      modelId: 'gpt-5-codex',
      effort: 'high',
    });
    expect(resolveProviderModelProfile('codex-cli', 'haiku', undefined, env, '.')).toEqual({
      modelId: 'codex-mini-latest',
      effort: 'low',
    });
  });

  it('lets runtime agent effort caps override configured Codex tier effort', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-model-config-'));
    try {
      const configDir = join(projectRoot, '.agentforge', 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'models.yaml'),
        [
          'providers:',
          '  codex-cli:',
          '    tiers:',
          '      opus:',
          '        model: gpt-5.5',
          '        effort: xhigh',
          '',
        ].join('\n'),
      );

      expect(resolveProviderModelProfile('codex-cli', 'opus', 'high', {}, projectRoot)).toEqual({
        modelId: 'gpt-5.5',
        effort: 'high',
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps env effort overrides above runtime agent effort caps', () => {
    const env = {
      AGENTFORGE_CODEX_OPUS_EFFORT: 'medium',
    };

    expect(resolveProviderModelProfile('codex-cli', 'opus', 'high', env, '.')).toEqual({
      modelId: 'gpt-5.5',
      effort: 'medium',
    });
  });
});
