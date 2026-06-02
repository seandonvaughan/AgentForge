/**
 * applyAdaptiveModel — overrides item.tier from the AdaptiveRouter ONLY on a
 * real learned signal; otherwise keeps the static policy tier. Fail-safe and
 * gated by AGENTFORGE_NO_QUALITY_BIAS.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { applyAdaptiveModel } from '../assign-phase.js';

type Rec = { model: 'opus' | 'sonnet' | 'haiku'; reason: string };

function stubRouter(rec: Rec | (() => never)) {
  return {
    recommendQualityAware: () => (typeof rec === 'function' ? rec() : rec),
  } as unknown as import('../../../intelligence/adaptive-routing.js').AdaptiveRouter;
}

afterEach(() => {
  delete process.env['AGENTFORGE_NO_QUALITY_BIAS'];
});

describe('applyAdaptiveModel', () => {
  it('overrides tier on a pareto-utility signal', () => {
    const item: any = { id: 'i1', title: 't', assignee: 'coder', tags: ['feature'], tier: 'sonnet' };
    applyAdaptiveModel(item, stubRouter({ model: 'haiku', reason: 'pareto-utility' }));
    expect(item.tier).toBe('haiku');
    expect(item.tierSource).toBe('adaptive');
    expect(item.tierReason).toBe('pareto-utility');
  });

  it('keeps the static tier on cold-start', () => {
    const item: any = { id: 'i1', title: 't', assignee: 'coder', tags: ['feature'], tier: 'sonnet' };
    applyAdaptiveModel(item, stubRouter({ model: 'opus', reason: 'cold-start' }));
    expect(item.tier).toBe('sonnet');
    expect(item.tierSource).toBe('policy');
    expect(item.tierReason).toBe('cold-start');
  });

  it('keeps the static tier and records reason on wave2-fallback', () => {
    const item: any = { id: 'i1', title: 't', assignee: 'coder', tags: ['feature'], tier: 'sonnet' };
    applyAdaptiveModel(item, stubRouter({ model: 'opus', reason: 'wave2-fallback' }));
    expect(item.tier).toBe('sonnet');
    expect(item.tierSource).toBe('policy');
    expect(item.tierReason).toBe('wave2-fallback');
  });

  it('does not override when AGENTFORGE_NO_QUALITY_BIAS=1', () => {
    process.env['AGENTFORGE_NO_QUALITY_BIAS'] = '1';
    const item: any = { id: 'i1', title: 't', assignee: 'coder', tags: ['feature'], tier: 'sonnet' };
    applyAdaptiveModel(item, stubRouter(() => { throw new Error('should not be called'); }));
    expect(item.tier).toBe('sonnet');
    expect(item.tierSource).toBe('policy');
    expect(item.tierReason).toBeUndefined();
  });

  it('is fail-safe: a throwing router leaves the static tier', () => {
    const item: any = { id: 'i1', title: 't', assignee: 'coder', tags: ['feature'], tier: 'sonnet' };
    applyAdaptiveModel(item, stubRouter(() => { throw new Error('boom'); }));
    expect(item.tier).toBe('sonnet');
    expect(item.tierSource).toBe('policy');
  });
});
