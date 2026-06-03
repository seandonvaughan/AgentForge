import { describe, expect, it } from 'vitest';

import { codexProfileFor, codexProfileLabel, codexTierFor } from '../lib/modelProfiles.js';

describe('model profile resolution', () => {
  it('returns null for missing or empty model values', () => {
    expect(codexProfileFor(null)).toBeNull();
    expect(codexProfileFor('')).toBeNull();
    expect(codexProfileFor(undefined)).toBeNull();
  });

  it('maps opus identifiers and xhigh effort to the opus profile', () => {
    expect(codexProfileFor('opus')?.tier).toBe('opus');
    expect(codexProfileFor('opus')?.modelId).toBe('gpt-5.5');
    expect(codexProfileFor('opus')?.effort).toBe('xhigh');
    expect(codexProfileFor('gpt-5.5')?.tier).toBe('opus');
    expect(codexProfileFor('gpt-5.5')?.modelId).toBe('gpt-5.5');
    expect(codexProfileFor('gpt-5.5')?.effort).toBe('xhigh');
    expect(codexProfileFor('', 'xhigh')?.tier).toBe('opus');
    expect(codexProfileFor(null, 'xhigh')?.modelId).toBe('gpt-5.5');
  });

  it('maps sonnet identifiers and high effort to the sonnet profile', () => {
    expect(codexProfileFor('sonnet')?.tier).toBe('sonnet');
    expect(codexProfileFor('sonnet')?.modelId).toBe('gpt-5.3-codex');
    expect(codexProfileFor('sonnet')?.effort).toBe('high');
    expect(codexProfileFor('gpt-5.3-codex')?.tier).toBe('sonnet');
    expect(codexProfileFor('gpt-5.3-codex')?.modelId).toBe('gpt-5.3-codex');
    expect(codexProfileFor('gpt-5.3-codex')?.effort).toBe('high');
    expect(codexProfileFor('', 'high')?.tier).toBe('sonnet');
  });

  it('maps haiku identifiers and medium effort to the haiku profile', () => {
    expect(codexProfileFor('haiku')?.tier).toBe('haiku');
    expect(codexProfileFor('haiku')?.modelId).toBe('gpt-5.4-mini');
    expect(codexProfileFor('haiku')?.effort).toBe('medium');
    expect(codexProfileFor('gpt-5.4-mini')?.tier).toBe('haiku');
    expect(codexProfileFor('gpt-5.4-mini')?.modelId).toBe('gpt-5.4-mini');
    expect(codexProfileFor('gpt-5.4-mini')?.effort).toBe('medium');
    expect(codexProfileFor('', 'medium')?.tier).toBe('haiku');
  });

  it('lets the effort parameter override the profile effort', () => {
    expect(codexProfileFor('opus', 'high')?.tier).toBe('opus');
    expect(codexProfileFor('opus', 'high')?.effort).toBe('high');
    expect(codexProfileFor('sonnet', 'xhigh')?.tier).toBe('opus');
    expect(codexProfileFor('sonnet', 'xhigh')?.effort).toBe('xhigh');
  });

  it('returns null for unknown models and maps tiers with the helper', () => {
    expect(codexProfileFor('unknown-model')).toBeNull();
    expect(codexTierFor('opus')).toBe('opus');
    expect(codexTierFor('sonnet')).toBe('sonnet');
    expect(codexTierFor('haiku')).toBe('haiku');
    expect(codexTierFor('haiku')).toBe('haiku');
    expect(codexTierFor('unknown-model')).toBeNull();
  });

  it('formats profile labels and falls back for unresolved values', () => {
    expect(codexProfileLabel('sonnet', 'high')).toBe('gpt-5.3-codex / high');
    expect(codexProfileLabel('unknown-model', 'custom')).toBe('unknown-model / custom');
    expect(codexProfileLabel(null)).toBe('—');
  });
});
