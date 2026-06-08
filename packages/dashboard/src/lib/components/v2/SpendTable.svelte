<script lang="ts">
  import Badge from './Badge.svelte';

  /**
   * Per-item planned-vs-actual row. Structurally mirrors `SpendReportPerItem`
   * from @agentforge/core's spend-report artifact — duplicated locally because
   * v2 atoms carry ZERO workspace dependencies (pure presentational).
   */
  export interface SpendTableRow {
    itemId: string;
    title?: string;
    plannedUsd: number | null;
    actualUsd: number;
    status: string;
  }

  /**
   * Structural mirror of `SpendReportArtifact` (a.k.a. SpendReport). Only the
   * fields this atom renders are declared; consumers pass the artifact verbatim.
   */
  export interface SpendTableReport {
    budgetUsd: number;
    totalUsd: number;
    executionUsd: number;
    overheadUsd: number;
    /** totalUsd / budgetUsd, expressed as a fraction (0.5 === 50%). */
    utilization: number;
    perItem: SpendTableRow[];
  }

  interface Props {
    report: SpendTableReport;
    class?: string;
  }

  let { report, class: className = '' }: Props = $props();

  const rows = $derived(report?.perItem ?? []);

  function fmtUsd(n: number | null | undefined): string {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    return `$${n.toFixed(2)}`;
  }

  function fmtPct(fraction: number | null | undefined): string {
    if (fraction === null || fraction === undefined || Number.isNaN(fraction)) return '—';
    return `${(fraction * 100).toFixed(0)}%`;
  }

  type Variant = 'success' | 'warning' | 'danger' | 'info' | 'purple' | 'muted';

  // Status → Badge variant. String.includes (not regex) on the lowercased
  // status keeps this allocation-free and ReDoS-proof.
  function statusVariant(status: string): Variant {
    const s = (status ?? '').toLowerCase();
    if (s.includes('pass') || s.includes('complete') || s.includes('success') || s.includes('done'))
      return 'success';
    if (s.includes('fail') || s.includes('error') || s.includes('block')) return 'danger';
    if (s.includes('run') || s.includes('progress') || s.includes('active')) return 'info';
    if (s.includes('skip')) return 'muted';
    return 'muted';
  }

  // Delta heuristic: an actual above the planned estimate overran (danger);
  // at-or-under planned is on-budget (success). No planned baseline → neutral.
  function actualColor(row: SpendTableRow): string {
    if (row.plannedUsd === null || row.plannedUsd === undefined) return 'var(--af-text)';
    if (row.actualUsd > row.plannedUsd) return 'var(--af-danger)';
    return 'var(--af-success)';
  }

  // Utilization tint: over budget is danger, near-full is warning, else success.
  const utilColor = $derived(
    report && report.utilization > 1
      ? 'var(--af-danger)'
      : report && report.utilization >= 0.85
        ? 'var(--af-warning)'
        : 'var(--af-success)',
  );
</script>

<div class={['af2-spend-table', className].filter(Boolean).join(' ')}>
  <table class="af2-st">
    <thead>
      <tr>
        <th class="st-item">Item</th>
        <th class="st-num">Planned</th>
        <th class="st-num">Actual</th>
        <th class="st-status">Status</th>
      </tr>
    </thead>
    <tbody>
      {#if rows.length === 0}
        <tr>
          <td class="st-empty" colspan="4">No spend recorded for this cycle.</td>
        </tr>
      {:else}
        {#each rows as row (row.itemId)}
          <tr>
            <td class="st-item">
              <span class="st-title">{row.title || row.itemId}</span>
              <span class="st-id af2-mono">{row.itemId}</span>
            </td>
            <td class="st-num af2-mono">{fmtUsd(row.plannedUsd)}</td>
            <td class="st-num af2-mono" style="color:{actualColor(row)}">{fmtUsd(row.actualUsd)}</td>
            <td class="st-status">
              <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
            </td>
          </tr>
        {/each}
      {/if}
    </tbody>
    <tfoot>
      <tr class="st-totals">
        <td class="st-foot-label">Totals</td>
        <td class="st-num af2-mono" colspan="3">
          <span class="st-foot-metric">
            <span class="st-foot-key">Execution</span>
            <span class="st-foot-val">{fmtUsd(report?.executionUsd ?? 0)}</span>
          </span>
          <span class="st-foot-metric">
            <span class="st-foot-key">Overhead</span>
            <span class="st-foot-val">{fmtUsd(report?.overheadUsd ?? 0)}</span>
          </span>
          <span class="st-foot-metric">
            <span class="st-foot-key">Total</span>
            <span class="st-foot-val">{fmtUsd(report?.totalUsd ?? 0)} / {fmtUsd(report?.budgetUsd ?? 0)}</span>
          </span>
          <span class="st-foot-metric">
            <span class="st-foot-key">Utilization</span>
            <span class="st-foot-val" style="color:{utilColor}">{fmtPct(report?.utilization)}</span>
          </span>
        </td>
      </tr>
    </tfoot>
  </table>
</div>

<style>
  .af2-spend-table {
    width: 100%;
    overflow-x: auto;
  }

  .af2-st {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    color: var(--af-text);
  }

  .af2-st thead th {
    text-align: left;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--af-dim);
    padding: 6px 10px;
    border-bottom: 1px solid var(--af-border);
  }

  .af2-st tbody td {
    padding: 8px 10px;
    border-bottom: 1px solid var(--af-border2);
    vertical-align: top;
  }

  .st-num {
    text-align: right;
    white-space: nowrap;
  }

  .st-status {
    width: 1%;
    white-space: nowrap;
  }

  .st-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .st-title {
    font-weight: 500;
  }

  .st-id {
    font-size: 10px;
    color: var(--af-faint);
  }

  .st-empty {
    text-align: center;
    color: var(--af-dim);
    padding: 16px 10px;
  }

  .st-totals td {
    padding: 10px;
    border-top: 1px solid var(--af-border);
    background: color-mix(in srgb, var(--af-surface2) 60%, transparent);
  }

  .st-foot-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--af-dim);
  }

  .st-totals .st-num {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    justify-content: flex-end;
  }

  .st-foot-metric {
    display: inline-flex;
    align-items: baseline;
    gap: 5px;
  }

  .st-foot-key {
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--af-faint);
  }

  .st-foot-val {
    font-weight: 600;
  }

  .af2-mono {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1, 'ss01' 1;
  }
</style>
