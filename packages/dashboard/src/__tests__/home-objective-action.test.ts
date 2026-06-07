import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const HOME_PAGE = resolve(import.meta.dirname, '../routes/+page.svelte');

function source(): string {
  return readFileSync(HOME_PAGE, 'utf-8');
}

describe('Command Center objective quick action', () => {
  it('renders a v2 quick-action card for launching an objective cycle', () => {
    const s = source();

    expect(s).toContain('<section class="cc-quick-actions" aria-label="Quick actions">');
    expect(s).toContain('<a class="cc-objective-action" href="/objective" aria-label="Launch objective cycle">');
    expect(s).toContain('<Card hover accent');
    expect(s).toContain('Launch objective');
  });

  it('links the quick action to the objective launcher and keeps browser globals guarded', () => {
    const s = source();

    expect(s).toMatch(/<a class="cc-objective-action" href="\/objective"/);
    expect(s).toContain("import { browser } from '$app/environment';");
    expect(s).toContain("if (browser && document.visibilityState !== 'visible') return;");
  });
});
