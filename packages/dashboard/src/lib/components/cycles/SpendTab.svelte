<script lang="ts">
  /**
   * SpendTab.svelte
   *
   * Per-item planned-vs-actual spend table for the cycles/[id] detail page.
   * Fetches GET /api/v5/cycles/:id/spend-report via getSpendReport.
   *
   * States:
   *   loading     — shows skeleton rows
   *   fetchError  — "Could not load spend report"
   *   null report — 404: report not yet produced; shows a notice
   *   data        — per-item table + execution/overhead/utilization totals
   *
   * Props:
   *   cycleId — cycle id to fetch the report for
   *   class   — optional extra CSS class on the root element
   *
   * No document.* or EventSource access — $effect is browser-only by design.
   */

  import { getSpendReport, type SpendReport } from '$lib/api/epic.js';
  import {
    buildSpendRows,
    buildSpendTotals,
    type SpendRow,
    type SpendTotals,
  } from '$lib/util/spend-report.js';

  interface Props {
    cycleId: string;
    class?: string;
  }

  let { cycleId, class: className = '' }: Props = $props();

  let report = $state<SpendReport | null>(null);
  let loading = $state(true);
  let fetchError = $state(false);

  $effect(() => {
    const id = cycleId;
    loading = true;
    fetchError = false;
    report = null;

    getSpendReport(id)
      .then(r => { report = r; })
      .catch(() => { fetchError = true; })
      .finally(() => { loading = false; });
  });

  const rows = $derived.by<SpendRow[]>(() => {
    if (report === null) return [];
    return buildSpendRows(report);
  });

  const totals = $derived.by<SpendTotals | null>(() => {
    if (report === null) return null;
    return buildSpendTotals(report);
  });

  function deltaClass(delta: number): string {
    if (delta > 0) return 'neg'; // over-budget is bad
    if (delta < 0) return 'pos'; // under-budget is good
    return '';
  }
</script>

<div class={['spend-tab', className].filter(Boolean).join(' ')}>
  {#if loading}
    <div class="skeleton-section">
      <div class="sk-header"></div>
      <div class="sk-row"></div>
      <div class="sk-row"></div>
      <div class="sk-row"></div>
    </div>

  {:else if fetchError}
    <div class="state-msg muted">Could not load spend report.</div>

  {:else if report === null}
    <div class="state-msg no-report">
      <span>No spend report yet — the report is generated after the execute phase completes.</span>
    </div>

  {:else}
    <!-- Per-item breakdown table -->
    <div class="section">
      <div class="section-label">PER-ITEM BREAKDOWN</div>
      <table class="spend-table">
        <thead>
          <tr>
            <th class="col-title">Item</th>
            <th class="col-num">Planned</th>
            <th class="col-num">Actual</th>
            <th class="col-num">Delta</th>
            <th class="col-num">&#916;%</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.itemId)}
            <tr>
              <td class="col-title item-title">{row.title}</td>
              <td class="col-num af2-mono">{row.plannedFormatted}</td>
              <td class="col-num af2-mono">{row.actualFormatted}</td>
              <td class="col-num af2-mono {deltaClass(row.delta)}">{row.deltaFormatted}</td>
              <td class="col-num af2-mono {deltaClass(row.delta)}">{row.deltaPctFormatted}</td>
            </tr>
          {/each}
          {#if rows.length === 0}
            <tr>
              <td colspan="5" class="no-items muted">No items in this report.</td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>

    <!-- Execution / overhead / utilization totals -->
    {#if totals !== null}
      <div class="totals-section">
        <div class="section-label">TOTALS</div>
        <div class="totals-grid">
          <div class="total-row">
            <span class="total-label muted">Execution</span>
            <span class="total-value af2-mono">{totals.executionFormatted}</span>
          </div>
          <div class="total-row">
            <span class="total-label muted">Overhead</span>
            <span class="total-value af2-mono">{totals.overheadFormatted}</span>
          </div>
          <div class="total-row">
            <span class="total-label muted">Utilization</span>
            <span class="total-value af2-mono util">{totals.utilizationFormatted}</span>
          </div>
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .spend-tab {
    font-size: 13px;
  }

  /* ── State messages ───────────────────────────────────────────────────────── */

  .state-msg {
    padding: 12px 0;
    font-size: 13px;
  }

  .no-report {
    color: var(--af-text-muted, #888);
  }

  .muted { color: var(--af-text-muted, #888); }

  /* ── Loading skeleton ─────────────────────────────────────────────────────── */

  .skeleton-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .sk-header {
    height: 12px;
    width: 160px;
    border-radius: 4px;
    background: var(--af-border, #333);
    animation: pulse 1.4s ease-in-out infinite;
    margin-bottom: 4px;
  }

  .sk-row {
    height: 28px;
    border-radius: 4px;
    background: var(--af-border, #333);
    animation: pulse 1.4s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 0.4; }
    50%       { opacity: 0.8; }
  }

  /* ── Section ──────────────────────────────────────────────────────────────── */

  .section {
    margin-bottom: 20px;
  }

  .section-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: var(--af-text-muted, #888);
    text-transform: uppercase;
    margin-bottom: 8px;
  }

  /* ── Table ────────────────────────────────────────────────────────────────── */

  .spend-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  .spend-table th,
  .spend-table td {
    padding: 6px 8px;
    text-align: left;
    border-bottom: 1px solid var(--af-border, #2a2a2a);
  }

  .spend-table th {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--af-text-muted, #888);
    background: var(--af-surface, #141414);
  }

  .col-title {
    text-align: left;
    min-width: 120px;
  }

  .col-num {
    text-align: right;
    white-space: nowrap;
    min-width: 72px;
  }

  .item-title {
    color: var(--af-text, #e0e0e0);
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .no-items {
    padding: 12px 8px;
    text-align: center;
    font-size: 12px;
  }

  /* Under-budget = green (good); over-budget = red (bad) */
  .pos { color: var(--af-success); }
  .neg { color: var(--af-danger, #e05353); }

  /* ── Totals ───────────────────────────────────────────────────────────────── */

  .totals-section {
    padding-top: 4px;
  }

  .totals-grid {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .total-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12px;
  }

  .total-label {
    font-size: 11px;
  }

  .total-value {
    font-size: 13px;
    color: var(--af-text, #e0e0e0);
  }

  .util {
    color: var(--af-accent);
  }

  /* ── Monospace ────────────────────────────────────────────────────────────── */

  .af2-mono {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1;
  }

  /* ── Mobile ───────────────────────────────────────────────────────────────── */

  @media (max-width: 520px) {
    .spend-table {
      font-size: 11px;
    }

    .col-num {
      min-width: 56px;
    }

    .item-title {
      max-width: 120px;
    }
  }
</style>
