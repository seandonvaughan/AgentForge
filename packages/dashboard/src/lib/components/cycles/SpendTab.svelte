<script module lang="ts">
  export interface SpendReportPerItem {
    itemId: string;
    title: string;
    plannedUsd: number | null;
    actualUsd: number;
    status: string;
  }

  export interface SpendReport {
    schemaVersion: 1;
    cycleId: string;
    epicId?: string;
    objective?: string;
    budgetUsd: number;
    totalUsd: number;
    executionUsd: number;
    overheadUsd: number;
    utilization: number;
    perItem: SpendReportPerItem[];
    generatedAt: string;
  }
</script>

<script lang="ts">
  import { browser } from '$app/environment';

  interface Props {
    report?: SpendReport | null;
    class?: string;
  }

  let { report = null, class: className = '' }: Props = $props();

  interface SpendRow {
    itemId: string;
    title: string;
    plannedLabel: string;
    actualLabel: string;
    deltaLabel: string;
    deltaClass: string;
    status: string;
  }

  const rows = $derived.by<SpendRow[]>(() => {
    return (report?.perItem ?? []).map((item) => {
      const delta = item.plannedUsd === null ? null : item.actualUsd - item.plannedUsd;
      return {
        itemId: item.itemId,
        title: item.title,
        plannedLabel: item.plannedUsd === null ? '-' : formatUsd(item.plannedUsd),
        actualLabel: formatUsd(item.actualUsd),
        deltaLabel: delta === null ? '-' : formatDeltaUsd(delta),
        deltaClass: deltaClass(delta),
        status: item.status,
      };
    });
  });

  const generatedLabel = $derived.by(() => {
    if (!browser || !report?.generatedAt) return '';
    const date = new Date(report.generatedAt);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString();
  });

  const totalCards = $derived.by(() => {
    if (!report) return [];
    return [
      { label: 'Total', value: formatUsd(report.totalUsd), sub: `of ${formatUsd(report.budgetUsd)} budget` },
      { label: 'Execution', value: formatUsd(report.executionUsd), sub: 'agent item work' },
      { label: 'Overhead', value: formatUsd(report.overheadUsd), sub: 'planning, review, gate' },
      { label: 'Utilization', value: formatPercent(report.utilization), sub: utilizationLabel(report.utilization) },
    ];
  });

  function formatUsd(value: number): string {
    return `$${value.toFixed(2)}`;
  }

  function formatDeltaUsd(value: number): string {
    if (value === 0) return '$0.00';
    return `${value > 0 ? '+' : '-'}$${Math.abs(value).toFixed(2)}`;
  }

  function formatPercent(value: number): string {
    return `${(value * 100).toFixed(0)}%`;
  }

  function deltaClass(value: number | null): string {
    if (value === null || value === 0) return 'neutral';
    return value > 0 ? 'over' : 'under';
  }

  function utilizationLabel(value: number): string {
    if (value >= 1) return 'budget exceeded';
    if (value >= 0.85) return 'near budget';
    return 'within budget';
  }
</script>

<section class={['spend-tab', className].filter(Boolean).join(' ')} aria-label="Spend report">
  {#if !report}
    <div class="spend-empty" data-testid="spend-empty">
      <div class="spend-empty-title">No spend report</div>
      <div class="spend-empty-copy">Planned vs actual spend will appear after this cycle writes a spend-report artifact.</div>
    </div>
  {:else}
    <div class="spend-header">
      <div>
        <h2>Spend report</h2>
        <p>
          {report.cycleId}
          {#if report.epicId}
            <span> / {report.epicId}</span>
          {/if}
        </p>
      </div>
      {#if generatedLabel}
        <span class="generated af2-mono">Generated {generatedLabel}</span>
      {/if}
    </div>

    <div class="spend-totals" aria-label="Spend totals">
      {#each totalCards as card (card.label)}
        <div class="total-card">
          <span class="total-label">{card.label}</span>
          <span class="total-value af2-mono">{card.value}</span>
          <span class="total-sub">{card.sub}</span>
        </div>
      {/each}
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Title</th>
            <th class="num">Planned</th>
            <th class="num">Actual</th>
            <th class="num">Delta</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {#if rows.length === 0}
            <tr>
              <td colspan="6" class="empty-row">No item-level spend rows in this report.</td>
            </tr>
          {:else}
            {#each rows as row (row.itemId)}
              <tr>
                <td class="item-id af2-mono">{row.itemId}</td>
                <td class="item-title">{row.title}</td>
                <td class="num af2-mono">{row.plannedLabel}</td>
                <td class="num af2-mono">{row.actualLabel}</td>
                <td class={['num', 'af2-mono', 'delta', row.deltaClass].join(' ')}>{row.deltaLabel}</td>
                <td><span class="status-chip">{row.status}</span></td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  .spend-tab {
    display: flex;
    flex-direction: column;
    gap: 16px;
    color: var(--af-text);
  }

  .spend-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
  }

  h2 {
    margin: 0;
    font-size: 18px;
    line-height: 1.25;
    letter-spacing: 0;
  }

  p {
    margin: 4px 0 0;
    color: var(--af-dim);
    font-size: 12px;
  }

  .generated {
    color: var(--af-dim);
    font-size: 11px;
    white-space: nowrap;
  }

  .spend-totals {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
  }

  .total-card {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 4px;
    border: 1px solid var(--af-border);
    border-radius: 8px;
    background: var(--af-surface);
    padding: 12px;
  }

  .total-label,
  .total-sub {
    color: var(--af-dim);
    font-size: 11px;
  }

  .total-value {
    color: var(--af-text);
    font-size: 18px;
    font-weight: 650;
    line-height: 1.2;
  }

  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--af-border);
    border-radius: 8px;
    background: var(--af-surface);
  }

  table {
    width: 100%;
    min-width: 720px;
    border-collapse: collapse;
    font-size: 12px;
  }

  th,
  td {
    border-bottom: 1px solid var(--af-border);
    padding: 10px 12px;
    text-align: left;
    vertical-align: middle;
  }

  th {
    color: var(--af-dim);
    font-size: 10px;
    font-weight: 650;
    text-transform: uppercase;
  }

  tbody tr:last-child td {
    border-bottom: 0;
  }

  .num {
    text-align: right;
  }

  .item-id {
    width: 120px;
    color: var(--af-text);
    font-size: 11px;
  }

  .item-title {
    min-width: 220px;
  }

  .delta.over {
    color: var(--af-danger);
  }

  .delta.under {
    color: var(--af-success);
  }

  .delta.neutral {
    color: var(--af-dim);
  }

  .status-chip {
    display: inline-flex;
    max-width: 180px;
    align-items: center;
    border: 1px solid var(--af-border);
    border-radius: 999px;
    padding: 3px 8px;
    color: var(--af-text);
    font-size: 11px;
    line-height: 1;
  }

  .empty-row {
    color: var(--af-dim);
    text-align: center;
  }

  .spend-empty {
    border: 1px dashed var(--af-border);
    border-radius: 8px;
    background: var(--af-surface);
    padding: 20px;
  }

  .spend-empty-title {
    color: var(--af-text);
    font-size: 14px;
    font-weight: 650;
  }

  .spend-empty-copy {
    margin-top: 6px;
    color: var(--af-dim);
    font-size: 12px;
  }

  @media (max-width: 760px) {
    .spend-header {
      align-items: flex-start;
      flex-direction: column;
    }

    .spend-totals {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
