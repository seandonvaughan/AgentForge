<script module lang="ts">
  export interface SpendReportItemView {
    itemId: string;
    title: string;
    plannedUsd: number | null;
    actualUsd: number;
    status: string;
  }

  export interface SpendReportView {
    schemaVersion: 1;
    cycleId: string;
    epicId?: string;
    objective?: string;
    budgetUsd: number;
    totalUsd: number;
    executionUsd: number;
    overheadUsd: number;
    utilization: number;
    perItem: SpendReportItemView[];
    generatedAt: string;
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    report?: SpendReportView | null;
    view?: SpendReportView | null;
    class?: string;
    className?: string;
  }

  let { report = null, view = null, class: classProp = '', className = '' }: Props = $props();
  let mounted = $state(false);

  onMount(() => {
    mounted = true;
  });

  const activeReport = $derived(report ?? view);
  const rows = $derived(activeReport?.perItem ?? []);
  const plannedTotal = $derived.by(() =>
    rows.reduce((sum, item) => sum + (typeof item.plannedUsd === 'number' ? item.plannedUsd : 0), 0),
  );
  const completedCount = $derived(rows.filter((item) => item.status === 'completed').length);
  const rootClass = $derived(['spend-report-table', classProp, className].filter(Boolean).join(' '));

  function formatUsd(value: number): string {
    return `$${value.toFixed(2)}`;
  }

  function formatPlanned(value: number | null): string {
    return typeof value === 'number' ? formatUsd(value) : 'Not planned';
  }

  function formatDelta(item: SpendReportItemView): string {
    if (typeof item.plannedUsd !== 'number') return 'n/a';
    const delta = item.actualUsd - item.plannedUsd;
    if (delta > 0) return `+${formatUsd(delta)}`;
    if (delta < 0) return `-${formatUsd(Math.abs(delta))}`;
    return formatUsd(delta);
  }

  function deltaTone(item: SpendReportItemView): 'neutral' | 'under' | 'over' {
    if (typeof item.plannedUsd !== 'number') return 'neutral';
    const delta = item.actualUsd - item.plannedUsd;
    if (delta > 0) return 'over';
    if (delta < 0) return 'under';
    return 'neutral';
  }

  function formatUtilization(value: number): string {
    return `${Math.round(value * 100)}%`;
  }
</script>

{#if mounted}
  <section class={rootClass} aria-labelledby="spend-report-title">
    <div class="spend-header">
      <div>
        <p class="eyebrow">Spend</p>
        <h2 id="spend-report-title">Planned vs actual</h2>
      </div>
      {#if activeReport}
        <span class="cycle-chip">{activeReport.cycleId}</span>
      {/if}
    </div>

    {#if activeReport === null}
      <div class="empty-state">Spend report not available.</div>
    {:else}
      <dl class="totals" aria-label="Spend totals">
        <div>
          <dt>Planned</dt>
          <dd>{formatUsd(plannedTotal)}</dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd>{formatUsd(activeReport.totalUsd)}</dd>
        </div>
        <div>
          <dt>Execution</dt>
          <dd>{formatUsd(activeReport.executionUsd)}</dd>
        </div>
        <div>
          <dt>Overhead</dt>
          <dd>{formatUsd(activeReport.overheadUsd)}</dd>
        </div>
        <div>
          <dt>Utilization</dt>
          <dd>{formatUtilization(activeReport.utilization)}</dd>
        </div>
        <div>
          <dt>Budget</dt>
          <dd>{formatUsd(activeReport.budgetUsd)}</dd>
        </div>
      </dl>

      <div class="table-wrap">
        <table aria-label="Spend report items">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Planned</th>
              <th scope="col">Actual</th>
              <th scope="col">Delta</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {#if rows.length === 0}
              <tr>
                <td colspan="5" class="empty-row">No item spend has been recorded.</td>
              </tr>
            {:else}
              {#each rows as item (item.itemId)}
                <tr data-testid="spend-report-row-{item.itemId}">
                  <th scope="row">
                    <span class="item-id">{item.itemId}</span>
                    <span class="item-title">{item.title}</span>
                  </th>
                  <td class="money">{formatPlanned(item.plannedUsd)}</td>
                  <td class="money actual">{formatUsd(item.actualUsd)}</td>
                  <td class="money delta {deltaTone(item)}">{formatDelta(item)}</td>
                  <td><span class="status-pill">{item.status}</span></td>
                </tr>
              {/each}
            {/if}
          </tbody>
        </table>
      </div>

      <p class="summary">
        {completedCount}/{rows.length} items completed. Total spend is {formatUsd(activeReport.totalUsd)}
        of {formatUsd(activeReport.budgetUsd)}.
      </p>
    {/if}
  </section>
{/if}

<style>
  .spend-report-table {
    display: grid;
    gap: var(--space-4, 16px);
    color: var(--af-text, #e8edf2);
  }

  .spend-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3, 12px);
  }

  .eyebrow {
    margin: 0 0 4px;
    color: var(--af-text-muted, #94a3b8);
    font-size: 11px;
    font-weight: 650;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 700;
    letter-spacing: 0;
  }

  .cycle-chip,
  .status-pill {
    display: inline-flex;
    align-items: center;
    min-height: 22px;
    border: 1px solid var(--af-border3, #314055);
    border-radius: var(--radius-1, 4px);
    background: color-mix(in srgb, var(--af-surface2, #18202b) 72%, transparent);
    color: var(--af-text-muted, #94a3b8);
    font-family: var(--af-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 11px;
    line-height: 1;
    white-space: nowrap;
  }

  .cycle-chip {
    padding: 0 8px;
  }

  .totals {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 1px;
    overflow: hidden;
    margin: 0;
    border: 1px solid var(--af-border, #263244);
    border-radius: var(--radius-2, 8px);
    background: var(--af-border, #263244);
  }

  .totals > div {
    min-width: 0;
    padding: 10px 12px;
    background: var(--af-surface, #101722);
  }

  dt {
    color: var(--af-text-muted, #94a3b8);
    font-size: 11px;
    font-weight: 650;
    text-transform: uppercase;
  }

  dd {
    margin: 4px 0 0;
    font-family: var(--af-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 14px;
    font-weight: 700;
  }

  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--af-border, #263244);
    border-radius: var(--radius-2, 8px);
    background: var(--af-surface, #101722);
  }

  table {
    width: 100%;
    min-width: 680px;
    border-collapse: collapse;
    font-size: 13px;
  }

  th,
  td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--af-border, #263244);
    text-align: left;
    vertical-align: top;
  }

  thead th {
    color: var(--af-text-muted, #94a3b8);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
  }

  tbody tr:last-child th,
  tbody tr:last-child td {
    border-bottom: 0;
  }

  .item-id,
  .money {
    font-family: var(--af-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  }

  .item-id {
    display: block;
    font-size: 12px;
    font-weight: 700;
  }

  .item-title {
    display: block;
    margin-top: 3px;
    color: var(--af-text-muted, #94a3b8);
    font-size: 12px;
    font-weight: 500;
  }

  .money {
    white-space: nowrap;
  }

  .actual {
    color: var(--af-text, #e8edf2);
    font-weight: 700;
  }

  .delta.neutral {
    color: var(--af-text-muted, #94a3b8);
  }

  .delta.under {
    color: var(--af-success, #4ade80);
  }

  .delta.over {
    color: var(--af-danger, #f87171);
  }

  .status-pill {
    padding: 0 7px;
    text-transform: uppercase;
  }

  .summary,
  .empty-state,
  .empty-row {
    color: var(--af-text-muted, #94a3b8);
    font-size: 13px;
  }

  .summary {
    margin: -4px 0 0;
  }

  .empty-state,
  .empty-row {
    padding: 14px;
  }

  @media (max-width: 760px) {
    .totals {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
