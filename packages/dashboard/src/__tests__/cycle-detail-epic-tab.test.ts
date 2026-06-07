import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const CYCLE_DETAIL = resolve(import.meta.dirname, '../routes/cycles/[id]/+page.svelte');

function source(): string {
  return readFileSync(CYCLE_DETAIL, 'utf-8');
}

describe('cycle detail epic tab contract', () => {
  it('registers the Epic tab and fetches decomposition through the workspace-aware endpoint', () => {
    const s = source();

    expect(s).toContain("| 'overview' | 'pipeline' | 'items' | 'epic' | 'agents'");
    expect(s).toContain("{ id: 'epic',     label: 'Epic'");
    expect(s).toContain('async function loadEpic(): Promise<void>');
    expect(s).toContain('if (!browser || !id) return;');
    expect(s).toContain("fetch(withWorkspace(`/api/v5/cycles/${id}/decomposition`))");
    expect(s).toContain("if (t === 'epic' && !epicData && !epicLoading) void loadEpic();");
  });

  it('renders EpicWaveList with waves, child fields, cost, files, and status', () => {
    const s = source();

    expect(s).toContain('{#snippet EpicWaveList(waves: WaveGroup<EpicChild>[])}');
    expect(s).toContain('{#each waves as wave (wave.wave)}');
    expect(s).toContain('{wave.label}');
    expect(s).toContain('{#each wave.children as child (child.id)}');
    expect(s).toContain('{child.title ??');
    expect(s).toContain('{#each child.files as file (file)}');
    expect(s).toContain('Badge variant={epicStatusVariant(child.status)}');
    expect(s).toContain('formatUsd(child.costUsd ?? child.estimatedCostUsd ?? 0)');
    expect(s).toContain('{@render EpicWaveList(epicWaveGroups)}');
  });

  it('surfaces the 404 decomposition empty state', () => {
    const s = source();

    expect(s).toContain('if (res.status === 404) {');
    expect(s).toContain('epicData = null;');
    expect(s).toContain('epicEmpty = true;');
    expect(s).toContain('No epic decomposition found for this cycle.');
  });
});
