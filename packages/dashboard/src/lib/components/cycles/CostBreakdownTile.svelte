<script lang="ts">
  /**
   * CostBreakdownTile.svelte
   *
   * Renders a proportional 4-bar cost breakdown (input / output / cache-creation
   * / cache-read) plus an optional tool-use row. Total in the lower-right matches
   * breakdown.totalUsd.
   *
   * Props:
   *   cycleId     — string, used to fetch /api/v5/cycles/:id/cost-breakdown
   *   class       — optional extra CSS class on the root element
   *
   * Shows "—" placeholder bars for cycles where hasBreakdown is false (older data).
   * Never errors on fetch failures — degrades to a "No breakdown data" state.
   *
   * Mobile breakpoint (<520 px): bars stack vertically.
   */

  interface CostBreakdown {
    inputTokens:   { count: number; usd: number };
    outputTokens:  { count: number; usd: number };
    cacheCreation: { tokens: number; usd: number };
    cacheRead:     { tokens: number; usd: number };
    toolUse:       Record<string, { invocations: number; usd: number }>;
    totalUsd:      number;
  }

  interface CostBreakdownResponse {
    cycleId:      string;
    hasBreakdown: boolean;
    breakdown:    CostBreakdown;
    timestamp:    string;
  }

  interface Props {
    cycleId: string;
    class?: string;
  }

  let { cycleId, class: className = '' }: Props = $props();

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let loading = $state(true);
  let data = $state<CostBreakdownResponse | null>(null);
  let fetchError = $state(false);

  // ---------------------------------------------------------------------------
  // Data fetch — runs when cycleId changes
  // ---------------------------------------------------------------------------

  $effect(() => {
    const id = cycleId;
    loading = true;
    fetchError = false;
    data = null;

    fetch(`/api/v5/cycles/${encodeURIComponent(id)}/cost-breakdown`)
      .then(async res => {
        if (!res.ok) {
          fetchError = true;
          return;
        }
        data = (await res.json()) as CostBreakdownResponse;
      })
      .catch(() => {
        fetchError = true;
      })
      .finally(() => {
        loading = false;
      });
  });

  // ---------------------------------------------------------------------------
  // Derived — bar segments
  // ---------------------------------------------------------------------------

  interface BarSegment {
    label:  string;
    usd:    number;
    pct:    number;
    color:  string;
    tokens: number;
  }

  const segments = $derived.by<BarSegment[]>(() => {
    if (data === null || !data.hasBreakdown) return [];
    const bd = data.breakdown;
    const total = bd.totalUsd;
    if (total <= 0) return [];

    const toUsd = (v: number) => v;

    const raw: Array<{ label: string; usd: number; color: string; tokens: number }> = [
      { label: 'Input',          usd: toUsd(bd.inputTokens.usd),   color: 'var(--af-accent)',   tokens: bd.inputTokens.count },
      { label: 'Output',         usd: toUsd(bd.outputTokens.usd),  color: 'var(--af-accent2)',  tokens: bd.outputTokens.count },
      { label: 'Cache create',   usd: toUsd(bd.cacheCreation.usd), color: 'var(--af-warning)',  tokens: bd.cacheCreation.tokens },
      { label: 'Cache read',     usd: toUsd(bd.cacheRead.usd),     color: 'var(--af-success)',  tokens: bd.cacheRead.tokens },
    ];

    // Tool use aggregate
    const toolUsd = Object.values(bd.toolUse).reduce((s, t) => s + t.usd, 0);
    if (toolUsd > 0) {
      raw.push({ label: 'Tool use', usd: toolUsd, color: 'var(--af-text-muted)', tokens: 0 });
    }

    return raw
      .filter(s => s.usd > 0)
      .map(s => ({ ...s, pct: (s.usd / total) * 100 }));
  });

  const toolEntries = $derived.by<Array<{ name: string; invocations: number; usd: number }>>(() => {
    if (data === null || !data.hasBreakdown) return [];
    return Object.entries(data.breakdown.toolUse)
      .map(([name, v]) => ({ name, invocations: v.invocations, usd: v.usd }))
      .sort((a, b) => b.usd - a.usd);
  });

  function fmtUsd(v: number): string {
    if (v === 0) return '$0.00';
    if (v < 0.001) return `$${v.toFixed(5)}`;
    if (v < 0.01)  return `$${v.toFixed(4)}`;
    return `$${v.toFixed(3)}`;
  }

  function fmtTokens(n: number): string {
    if (n === 0) return '';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
    if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K tok`;
    return `${n} tok`;
  }
</script>

<div class={['cost-breakdown-tile', className].filter(Boolean).join(' ')}>
  <div class="tile-header">
    <span class="tile-title">COST BREAKDOWN</span>
    <span class="tile-tag af2-mono">by token type</span>
  </div>

  {#if loading}
    <div class="tile-placeholder">
      <div class="placeholder-row">
        <div class="ph-label"></div>
        <div class="ph-bar"></div>
        <div class="ph-amt"></div>
      </div>
      <div class="placeholder-row">
        <div class="ph-label"></div>
        <div class="ph-bar short"></div>
        <div class="ph-amt"></div>
      </div>
      <div class="placeholder-row">
        <div class="ph-label"></div>
        <div class="ph-bar shorter"></div>
        <div class="ph-amt"></div>
      </div>
    </div>
  {:else if fetchError}
    <div class="tile-empty muted">Could not load cost breakdown.</div>
  {:else if data !== null && !data.hasBreakdown}
    <div class="tile-empty muted">— No per-token breakdown for this cycle.</div>
    {#if data.breakdown.totalUsd > 0}
      <div class="legacy-total af2-mono">
        Total: {fmtUsd(data.breakdown.totalUsd)}
      </div>
    {/if}
  {:else if data !== null && segments.length === 0}
    <div class="tile-empty muted">— Breakdown present but all costs are $0.00.</div>
  {:else if data !== null}
    <!-- Bar chart -->
    <div class="bars">
      {#each segments as seg (seg.label)}
        <div class="bar-row">
          <span class="bar-label">{seg.label}</span>
          <div class="bar-track">
            <div
              class="bar-fill"
              style="width:{seg.pct}%;background:{seg.color}"
            ></div>
          </div>
          <div class="bar-meta">
            <span class="bar-usd af2-mono">{fmtUsd(seg.usd)}</span>
            {#if seg.tokens > 0}
              <span class="bar-tokens muted">{fmtTokens(seg.tokens)}</span>
            {/if}
          </div>
        </div>
      {/each}
    </div>

    <!-- Tool use detail (if any) -->
    {#if toolEntries.length > 0}
      <div class="tool-section">
        <div class="tool-section-label muted">Tool use detail</div>
        {#each toolEntries as t (t.name)}
          <div class="tool-row">
            <span class="tool-name af2-mono">{t.name}</span>
            <span class="tool-invocations muted">{t.invocations}×</span>
            <span class="tool-usd af2-mono">{fmtUsd(t.usd)}</span>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Total -->
    <div class="tile-total">
      <span class="total-label">Total spend</span>
      <span class="total-value af2-mono">{fmtUsd(data.breakdown.totalUsd)}</span>
    </div>
  {/if}
</div>

<style>
  .cost-breakdown-tile {
    font-size: 13px;
  }

  /* Header */
  .tile-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .tile-title {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: var(--af-text-muted, #888);
    text-transform: uppercase;
  }
  .tile-tag {
    font-size: 10px;
    color: var(--af-text-muted, #888);
  }

  /* Skeleton loading */
  .tile-placeholder {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .placeholder-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ph-label {
    width: 80px;
    height: 10px;
    border-radius: 4px;
    background: var(--af-border, #333);
    animation: pulse 1.4s ease-in-out infinite;
  }
  .ph-bar {
    flex: 1;
    height: 8px;
    border-radius: 4px;
    background: var(--af-border, #333);
    animation: pulse 1.4s ease-in-out infinite;
  }
  .ph-bar.short   { max-width: 60%; }
  .ph-bar.shorter { max-width: 35%; }
  .ph-amt {
    width: 52px;
    height: 10px;
    border-radius: 4px;
    background: var(--af-border, #333);
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.4; }
    50%       { opacity: 0.8; }
  }

  /* Empty/error states */
  .tile-empty {
    padding: 6px 0;
    font-size: 12px;
  }
  .muted { color: var(--af-text-muted, #888); }
  .legacy-total {
    margin-top: 4px;
    font-size: 13px;
    color: var(--af-text, #e0e0e0);
  }

  /* Bars */
  .bars {
    display: flex;
    flex-direction: column;
    gap: 7px;
    margin-bottom: 10px;
  }
  .bar-row {
    display: grid;
    grid-template-columns: 96px 1fr auto;
    align-items: center;
    gap: 8px;
  }
  .bar-label {
    font-size: 11px;
    color: var(--af-text-muted, #888);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bar-track {
    height: 6px;
    background: var(--af-surface2, #1e1e1e);
    border-radius: 3px;
    overflow: hidden;
  }
  .bar-fill {
    height: 100%;
    border-radius: 3px;
    transition: width 400ms ease;
    min-width: 2px;
  }
  .bar-meta {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 1px;
    min-width: 64px;
  }
  .bar-usd {
    font-size: 12px;
    color: var(--af-text, #e0e0e0);
  }
  .bar-tokens {
    font-size: 10px;
  }

  /* Tool use detail */
  .tool-section {
    border-top: 1px solid var(--af-border, #333);
    margin-top: 8px;
    padding-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 10px;
  }
  .tool-section-label {
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    margin-bottom: 2px;
  }
  .tool-row {
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    gap: 8px;
  }
  .tool-name {
    font-size: 11px;
    color: var(--af-text, #e0e0e0);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tool-invocations {
    font-size: 11px;
  }
  .tool-usd {
    font-size: 11px;
    color: var(--af-text, #e0e0e0);
    min-width: 52px;
    text-align: right;
  }

  /* Total row */
  .tile-total {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-top: 8px;
    border-top: 1px solid var(--af-border, #333);
    font-size: 12px;
  }
  .total-label { color: var(--af-text-muted, #888); }
  .total-value {
    font-size: 13px;
    font-weight: 600;
    color: var(--af-text, #e0e0e0);
  }

  /* Mobile: stack bars vertically at narrow viewport */
  @media (max-width: 520px) {
    .bar-row {
      grid-template-columns: 1fr;
      gap: 3px;
    }
    .bar-label { font-size: 10px; }
    .bar-track { height: 5px; }
    .bar-meta  { flex-direction: row; gap: 6px; align-items: center; }
  }
</style>
