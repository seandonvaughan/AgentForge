import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const PAGE_PATH = resolve(import.meta.dirname, '../+page.svelte');

function src(): string {
  return readFileSync(PAGE_PATH, 'utf8');
}

describe('/cycles list epic badge', () => {
  it('fetches decomposition metadata in the browser for cycle rows', () => {
    const s = src();

    expect(s).toContain("import { browser } from '$app/environment'");
    expect(s).toContain('async function getDecomposition');
    expect(s).toContain('/api/v5/cycles/${encodeURIComponent(cycleId)}/plan');
    expect(s).toContain('if (!browser) return null;');
  });

  it('renders an epic badge with a child count when decomposition metadata exists', () => {
    const s = src();

    expect(s).toContain('{@const epic = epicMetaFor(c)}');
    expect(s).toContain('{#if epic}');
    expect(s).toContain('class="epic-badge"');
    expect(s).toContain('Epic objective cycle');
    expect(s).toContain('{epic.childCount} children');
  });

  it('does not badge normal rows without epic decomposition markers', () => {
    const s = src();

    expect(s).toContain('const epicItems = items.filter');
    expect(s).toContain("typeof item['parentEpicId'] === 'string'");
    expect(s).toContain("typeof item['wave'] === 'number'");
    expect(s).toContain('if (epicItems.length > 0) return epicItems.length;');
    expect(s).toContain('return null;');
  });
});
