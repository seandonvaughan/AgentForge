/**
 * selectCapabilityTier — execute-phase converts a validated item.tier into the
 * per-call capabilityTier passed to ctx.runtime.run. Invalid/absent → undefined
 * (dispatch keeps the agent's configured tier).
 */
import { describe, it, expect } from 'vitest';
import { selectCapabilityTier } from '../execute-phase.js';

describe('selectCapabilityTier', () => {
  it('returns the tier when it is a valid ModelTier', () => {
    expect(selectCapabilityTier({ tier: 'haiku' })).toBe('haiku');
    expect(selectCapabilityTier({ tier: 'opus' })).toBe('opus');
    expect(selectCapabilityTier({ tier: 'sonnet' })).toBe('sonnet');
  });

  it('returns undefined when tier is absent or invalid', () => {
    expect(selectCapabilityTier({})).toBeUndefined();
    expect(selectCapabilityTier({ tier: 'gpt-5' })).toBeUndefined();
    expect(selectCapabilityTier({ tier: undefined })).toBeUndefined();
  });
});
