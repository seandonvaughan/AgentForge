import { describe, expect, it } from 'vitest';

import { aggregateProviderUsage } from '../execute-phase.js';

describe('aggregateProviderUsage', () => {
  it('aggregates item counts and cost by resolvedProvider with unknown fallback', () => {
    const usage = aggregateProviderUsage([
      { resolvedProvider: 'codex-cli', costUsd: 0.1 },
      { resolvedProvider: 'codex-cli', costUsd: 0.2 },
      { resolvedProvider: 'anthropic-sdk', costUsd: 0.5 },
      { costUsd: 0.05 },
      { resolvedProvider: '' },
    ]);

    expect(usage).toEqual({
      'codex-cli': { items: 2, costUsd: 0.3 },
      'anthropic-sdk': { items: 1, costUsd: 0.5 },
      unknown: { items: 2, costUsd: 0.05 },
    });

    const total = Object.values(usage).reduce((sum, entry) => sum + entry.costUsd, 0);
    expect(total).toBeCloseTo(0.85, 6);
  });

  it('returns an empty map when no items are present', () => {
    expect(aggregateProviderUsage([])).toEqual({});
  });
});
