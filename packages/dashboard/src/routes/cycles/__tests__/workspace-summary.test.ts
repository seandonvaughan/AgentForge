import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE_PATH = resolve(__dirname, '../+page.svelte');

function src(): string {
  return readFileSync(PAGE_PATH, 'utf-8');
}

describe('cycles workspace metrics panel contracts', () => {
  it('renders from the cycles route file', () => {
    expect(existsSync(PAGE_PATH)).toBe(true);
  });

  it('loads the multi-workspace summary endpoint', () => {
    expect(src()).toContain('/api/v5/workspaces/summary');
    expect(src()).toContain('loadWorkspaceSummary');
  });

  it('exposes workspace switching controls in the cycles UI', () => {
    const s = src();
    expect(s).toContain('switchWorkspace');
    expect(s).toContain('WORKSPACE SCOPE');
    expect(s).toContain('ws-switch-chip');
    expect(s).toContain('currentWorkspaceId');
  });

  it('shows side-by-side workspace cards with key metrics', () => {
    const s = src();
    expect(s).toContain('ws-summary-grid');
    expect(s).toContain('ws.totalCostUsd');
    expect(s).toContain('ws.sessionCount');
    expect(s).toContain('ws.activeAgents');
  });

  it('guards document access with browser from $app/environment', () => {
    const s = src();
    expect(s).toContain("from '$app/environment'");
    expect(s).toContain('if (browser)');
    expect(s).toContain('document.visibilityState');
  });
});
