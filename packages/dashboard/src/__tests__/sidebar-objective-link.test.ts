import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SIDEBAR = resolve(import.meta.dirname, '../lib/components/Sidebar.svelte');

function source(): string {
  return readFileSync(SIDEBAR, 'utf-8');
}

describe('Sidebar objective navigation', () => {
  it('renders an Objective link to /objective near the cycles group', () => {
    const s = source();

    expect(s).toContain("{ href: '/cycles', label: 'Cycles' },");
    expect(s).toContain("{ href: '/objective', label: 'Objective' },");
    expect(s.indexOf("{ href: '/cycles', label: 'Cycles' },")).toBeLessThan(
      s.indexOf("{ href: '/objective', label: 'Objective' },"),
    );
    expect(s.indexOf("{ href: '/objective', label: 'Objective' },")).toBeLessThan(
      s.indexOf("{ href: '/cycles/new', label: 'Launch' },"),
    );
  });

  it('browser-guards active route state', () => {
    const s = source();

    expect(s).toContain("import { browser } from '$app/environment';");
    expect(s).toContain("const activePathname = $derived(browser ? page.url.pathname : '');");
    expect(s).toContain('class:active={activePathname === item.href}');
  });
});
