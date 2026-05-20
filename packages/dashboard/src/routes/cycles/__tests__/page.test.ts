import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../+page.svelte');

function src(): string {
  return readFileSync(PAGE_PATH, 'utf-8');
}

describe('cycles index page — file presence', () => {
  it('exists at the route path', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });
});

describe('cycles index page — multi-workspace contracts', () => {
  it('uses Svelte 5 runes and no legacy $: labels', () => {
    const s = src();
    expect(s).toContain('$state');
    expect(s).toContain('$derived');
    expect(s).toContain('$effect');
    expect(s).not.toMatch(/^\s*\$:/m);
  });

  it('declares workspace scope toggle options', () => {
    const s = src();
    expect(s).toContain("type WorkspaceScope = 'selected' | 'all'");
    expect(s).toContain('Current workspace');
    expect(s).toContain('All workspaces');
    expect(s).toContain('scope: all workspaces');
  });

  it('loads cycles across all workspaces when scope=all', () => {
    const s = src();
    expect(s).toContain("workspaceScope === 'all'");
    expect(s).toContain('loadWorkspaces');
    expect(s).toContain('/api/v5/cycles${qs}');
    expect(s).toContain('workspaceId=');
  });

  it('tracks row selection by workspace-aware key', () => {
    const s = src();
    expect(s).toContain('cycleRowKey');
    expect(s).toContain('rowKey');
    expect(s).toContain('selectedRows');
  });

  it('guards visibility/document access with browser import', () => {
    const s = src();
    expect(s).toContain("from '$app/environment'");
    expect(s).toContain('browser');
    expect(s).toContain('visibilitychange');
    expect(s).toContain('document.visibilityState');
  });
});
