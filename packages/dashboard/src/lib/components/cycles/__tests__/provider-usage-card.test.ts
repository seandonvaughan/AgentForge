import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const CARD_PATH = resolve(import.meta.dirname, '../ProviderUsageCard.svelte');
const PAGE_PATH = resolve(import.meta.dirname, '../../../../routes/cycles/[id]/+page.svelte');

function cardSrc(): string {
  return readFileSync(CARD_PATH, 'utf8');
}

function pageSrc(): string {
  return readFileSync(PAGE_PATH, 'utf8');
}

describe('ProviderUsageCard source contract', () => {
  it('exists at the expected path', () => {
    expect(existsSync(CARD_PATH)).toBe(true);
  });

  it('declares props via $props and stays on Svelte 5 runes (no legacy $:)', () => {
    const source = cardSrc();
    expect(source).toContain('$props()');
    expect(source).not.toMatch(/^\s*\$:/m);
  });

  it('iterates real provider usage data (anti-fake: each-block over provider entries)', () => {
    const source = cardSrc();
    expect(source).toContain('Object.entries(providerUsage)');
    expect(source).toContain('{#each providerRows as row');
  });

  it('references heartbeatStaleness to drive health badge/dot state', () => {
    const source = cardSrc();
    expect(source).toContain('heartbeatStaleness');
    expect(source).toContain("if (heartbeatStaleness === 'healthy')");
    expect(source).toContain('<Badge variant={health.badgeVariant}>');
  });
});

describe('Cycle detail page observability wiring contract', () => {
  it('imports and renders ProviderUsageCard', () => {
    const source = pageSrc();
    expect(source).toContain("import ProviderUsageCard from '$lib/components/cycles/ProviderUsageCard.svelte';");
    expect(source).toContain('<ProviderUsageCard');
  });

  it('fetches /cycles/${id}/observability and handles 404 as empty state', () => {
    const source = pageSrc();
    expect(source).toContain('/api/v5/cycles/${id}/observability');
    expect(source).toContain('res.status === 204 || res.status === 404');
    expect(source).toContain('observability = null;');
  });
});
