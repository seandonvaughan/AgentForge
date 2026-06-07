import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const componentPath = resolve(import.meta.dirname, '../EpicEmptyState.svelte');

describe('EpicEmptyState', () => {
  it('renders the empty artifact message', () => {
    const source = readFileSync(componentPath, 'utf8');

    expect(source).toContain('No decomposition or spend report has been generated for this cycle yet.');
    expect(source).toContain('<p class="epic-empty-message">{message}</p>');
  });

  it('accepts class overrides for consumers', () => {
    const source = readFileSync(componentPath, 'utf8');

    expect(source).toContain('class?: string;');
    expect(source).toContain("class: className = ''");
    expect(source).toContain("['epic-empty-state', className].filter(Boolean).join(' ')");
  });
});
