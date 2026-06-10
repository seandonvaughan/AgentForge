import { describe, expect, it } from 'vitest';

import { codexProfileFor, codexProfileLabel, codexTierFor } from '../lib/modelProfiles.js';

describe('model profile resolution (provider-accurate)', () => {
  it('returns null for missing or empty model values', () => {
    expect(codexProfileFor(null)).toBeNull();
    expect(codexProfileFor('')).toBeNull();
    expect(codexProfileFor(undefined)).toBeNull();
  });

  it('bare opus tier / xhigh effort resolve to the PRIMARY Claude opus model', () => {
    expect(codexProfileFor('opus')?.tier).toBe('opus');
    expect(codexProfileFor('opus')?.modelId).toBe('claude-opus-4-8');
    expect(codexProfileFor('opus')?.family).toBe('claude');
    expect(codexProfileFor('', 'xhigh')?.tier).toBe('opus');
    expect(codexProfileFor(null, 'xhigh')?.modelId).toBe('claude-opus-4-8');
  });

  it('bare sonnet tier / high effort resolve to the PRIMARY Claude sonnet model', () => {
    expect(codexProfileFor('sonnet')?.tier).toBe('sonnet');
    expect(codexProfileFor('sonnet')?.modelId).toBe('claude-sonnet-4-6');
    expect(codexProfileFor('sonnet')?.family).toBe('claude');
    expect(codexProfileFor('', 'high')?.tier).toBe('sonnet');
  });

  it('bare haiku tier / medium effort resolve to the PRIMARY Claude haiku model', () => {
    expect(codexProfileFor('haiku')?.tier).toBe('haiku');
    expect(codexProfileFor('haiku')?.modelId).toBe('claude-haiku-4-5');
    expect(codexProfileFor('', 'medium')?.tier).toBe('haiku');
  });

  it('concrete Claude model ids are shown verbatim as the claude family (the bug fix)', () => {
    expect(codexProfileFor('claude-opus-4-8')?.modelId).toBe('claude-opus-4-8');
    expect(codexProfileFor('claude-opus-4-8')?.tier).toBe('opus');
    expect(codexProfileFor('claude-opus-4-8')?.family).toBe('claude');
    // Previously 'claude-sonnet-4-6' was rewritten to 'gpt-5.3-codex' (the bug).
    expect(codexProfileFor('claude-sonnet-4-6')?.modelId).toBe('claude-sonnet-4-6');
    expect(codexProfileFor('claude-sonnet-4-6')?.tier).toBe('sonnet');
    expect(codexProfileFor('claude-sonnet-4-6')?.family).toBe('claude');
    expect(codexProfileFor('claude-haiku-4-5')?.modelId).toBe('claude-haiku-4-5');
    expect(codexProfileFor('claude-haiku-4-5')?.family).toBe('claude');
  });

  it('concrete codex/gpt model ids are shown verbatim as the codex family', () => {
    expect(codexProfileFor('gpt-5.5')?.modelId).toBe('gpt-5.5');
    expect(codexProfileFor('gpt-5.5')?.family).toBe('codex');
    expect(codexProfileFor('gpt-5.3-codex')?.modelId).toBe('gpt-5.3-codex');
    expect(codexProfileFor('gpt-5.3-codex')?.tier).toBe('sonnet');
    expect(codexProfileFor('gpt-5.3-codex')?.family).toBe('codex');
    expect(codexProfileFor('gpt-5.4-mini')?.modelId).toBe('gpt-5.4-mini');
    expect(codexProfileFor('gpt-5.4-mini')?.tier).toBe('haiku');
  });

  it('lets the effort parameter override the default effort; a concrete name wins over effort', () => {
    expect(codexProfileFor('opus', 'xhigh')?.effort).toBe('xhigh');
    // The model name 'sonnet' wins over the 'xhigh' effort hint (was 'opus' before).
    expect(codexProfileFor('sonnet', 'xhigh')?.tier).toBe('sonnet');
    expect(codexProfileFor('sonnet', 'xhigh')?.effort).toBe('xhigh');
  });

  it('returns null for unknown models and maps tiers with the helper', () => {
    expect(codexProfileFor('unknown-model')).toBeNull();
    expect(codexTierFor('opus')).toBe('opus');
    expect(codexTierFor('sonnet')).toBe('sonnet');
    expect(codexTierFor('haiku')).toBe('haiku');
    expect(codexTierFor('claude-opus-4-8')).toBe('opus');
    expect(codexTierFor('unknown-model')).toBeNull();
  });

  it('fable tier (v24) is Claude-served only: claude-fable-5, by name, never codex', () => {
    expect(codexProfileFor('fable')?.modelId).toBe('claude-fable-5');
    expect(codexProfileFor('fable')?.tier).toBe('fable');
    expect(codexProfileFor('fable')?.family).toBe('claude');
    expect(codexProfileFor('fable')?.effort).toBe('xhigh');
    expect(codexProfileFor('claude-fable-5')?.modelId).toBe('claude-fable-5');
    expect(codexProfileFor('claude-fable-5')?.tier).toBe('fable');
    // A lone xhigh hint resolves to opus — fable is by-name only.
    expect(codexProfileFor('', 'xhigh')?.tier).toBe('opus');
  });

  it('formats profile labels and falls back for unresolved values', () => {
    expect(codexProfileLabel('sonnet', 'high')).toBe('claude-sonnet-4-6 / high');
    expect(codexProfileLabel('claude-opus-4-8', 'high')).toBe('claude-opus-4-8 / high');
    expect(codexProfileLabel('gpt-5.5')).toBe('gpt-5.5 / high');
    expect(codexProfileLabel('unknown-model', 'custom')).toBe('unknown-model / custom');
    expect(codexProfileLabel(null)).toBe('—');
  });
});
