import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const CYCLE_DETAIL = resolve(import.meta.dirname, '../routes/cycles/[id]/+page.svelte');

function source(): string {
  return readFileSync(CYCLE_DETAIL, 'utf-8');
}

describe('cycle detail spend tab contract', () => {
  it('registers the Spend tab after Epic and fetches the spend report through the workspace-aware endpoint', () => {
    const s = source();

    expect(s).toContain("| 'overview' | 'pipeline' | 'items' | 'epic' | 'spend' | 'agents'");
    expect(s).toContain("{ id: 'epic',     label: 'Epic'");
    expect(s).toContain("{ id: 'spend',    label: 'Spend'");
    expect(s.indexOf("{ id: 'epic',     label: 'Epic'")).toBeLessThan(s.indexOf("{ id: 'spend',    label: 'Spend'"));
    expect(s).toContain('async function loadSpendReport(): Promise<void>');
    expect(s).toContain('if (!browser || !id) return;');
    expect(s).toContain("fetch(withWorkspace(`/api/v5/cycles/${id}/spend-report`))");
    expect(s).toContain("if (t === 'spend' && !spendReport && !spendLoading && !spendEmpty) void loadSpendReport();");
  });

  it('renders utilization, execution, overhead, and per-item planned-vs-actual totals', () => {
    const s = source();

    expect(s).toContain('{#snippet UtilizationGauge(report: SpendReport)}');
    expect(s).toContain('{#snippet SpendReportTable(report: SpendReport)}');
    expect(s).toContain('TOTAL SPEND');
    expect(s).toContain("{ label: 'Execution', value: formatUsd(report.executionUsd)");
    expect(s).toContain("{ label: 'Overhead', value: formatUsd(report.overheadUsd)");
    expect(s).toContain("{ label: 'Utilization', value: `${spendUtilizationPct(report).toFixed(1)}%`");
    expect(s).toContain('PLANNED VS ACTUAL');
    expect(s).toContain('{item.plannedUsd == null ?');
    expect(s).toContain('{formatUsd(item.actualUsd)}');
    expect(s).toContain('execution {formatUsd(report.executionUsd)} · overhead {formatUsd(report.overheadUsd)}');
    expect(s).toContain('{@render UtilizationGauge(spendReport)}');
    expect(s).toContain('{@render SpendReportTable(spendReport)}');
  });

  it('surfaces the 404 spend report empty state', () => {
    const s = source();

    expect(s).toContain('if (res.status === 404) {');
    expect(s).toContain('spendReport = null;');
    expect(s).toContain('spendEmpty = true;');
    expect(s).toContain('No spend report found for this cycle.');
  });
});
