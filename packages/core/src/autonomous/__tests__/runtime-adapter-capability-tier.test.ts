/**
 * cappedCallTier — the per-call adaptive model tier, bounded by the operator's
 * modelCap. Caps must compose: a learned 'opus' recommendation under a 'sonnet'
 * modelCap must dispatch as 'sonnet', never above the cap.
 */
import { describe, it, expect } from 'vitest';
import { cappedCallTier } from '../runtime-adapter.js';

describe('cappedCallTier', () => {
  it('returns the requested tier when no modelCap is set', () => {
    expect(cappedCallTier('opus', undefined)).toBe('opus');
    expect(cappedCallTier('haiku', undefined)).toBe('haiku');
  });

  it('caps a higher requested tier down to the modelCap', () => {
    expect(cappedCallTier('opus', 'sonnet')).toBe('sonnet');
    expect(cappedCallTier('opus', 'haiku')).toBe('haiku');
    expect(cappedCallTier('sonnet', 'haiku')).toBe('haiku');
  });

  it('leaves a requested tier at or below the cap unchanged', () => {
    expect(cappedCallTier('haiku', 'sonnet')).toBe('haiku');
    expect(cappedCallTier('sonnet', 'sonnet')).toBe('sonnet');
    expect(cappedCallTier('sonnet', 'opus')).toBe('sonnet');
  });
});
