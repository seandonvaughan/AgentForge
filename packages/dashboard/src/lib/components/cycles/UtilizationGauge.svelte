<script lang="ts">
  import { browser } from '$app/environment';

  type UtilizationBand = 'under' | 'in' | 'over';

  interface Props {
    actualUsd?: number | null;
    budgetUsd?: number | null;
    label?: string;
    class?: string;
  }

  const BUDGET_BAND_START = 0.85;
  const BUDGET_BAND_END = 1;

  let {
    actualUsd = 0,
    budgetUsd = 0,
    label = 'Spend utilization',
    class: className = '',
  }: Props = $props();

  let reduceMotion = $state(true);

  $effect(() => {
    if (!browser) return;
    if (typeof window.matchMedia !== 'function') {
      reduceMotion = false;
      return;
    }

    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const syncMotion = () => {
      reduceMotion = media.matches;
    };

    syncMotion();
    media.addEventListener?.('change', syncMotion);
    return () => media.removeEventListener?.('change', syncMotion);
  });

  const actual = $derived(safeAmount(actualUsd));
  const budget = $derived(safeAmount(budgetUsd));
  const ratio = $derived(budget > 0 ? actual / budget : 0);
  const utilizationPct = $derived(ratio * 100);
  const fillPct = $derived(clamp(utilizationPct, 0, 100));
  const band = $derived<UtilizationBand>(
    ratio > BUDGET_BAND_END ? 'over' : ratio >= BUDGET_BAND_START ? 'in' : 'under',
  );
  const bandMeta = $derived.by(() => {
    if (band === 'over') {
      return {
        label: 'Over budget',
        color: 'var(--color-danger, var(--af-danger, #e05353))',
      };
    }
    if (band === 'in') {
      return {
        label: 'Budget band',
        color: 'var(--color-warning, var(--af-warning, #e0a43a))',
      };
    }
    return {
      label: 'Under budget',
      color: 'var(--color-success, var(--af-success, #35c779))',
    };
  });
  const rootClass = $derived(
    ['utilization-gauge', reduceMotion ? 'reduce-motion' : '', className].filter(Boolean).join(' '),
  );

  function safeAmount(value: number | null | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
  }

  function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  function fmtUsd(value: number): string {
    if (value === 0) return '$0.00';
    if (value < 0.01) return `$${value.toFixed(4)}`;
    return `$${value.toFixed(2)}`;
  }

  function fmtPct(value: number): string {
    return `${value.toFixed(value >= 100 ? 0 : 1)}%`;
  }
</script>

<div
  class={rootClass}
  data-testid="utilization-gauge"
  data-band={band}
  data-fill-pct={fillPct.toFixed(1)}
  data-utilization-pct={utilizationPct.toFixed(1)}
  style="--gauge-band-color:{bandMeta.color}"
>
  <div class="gauge-head">
    <div>
      <div class="gauge-label">{label}</div>
      <div class="gauge-values af2-mono">
        {fmtUsd(actual)} <span>/ {budget > 0 ? fmtUsd(budget) : 'no budget'}</span>
      </div>
    </div>
    <div class="gauge-status" data-band={band}>{bandMeta.label}</div>
  </div>

  <div
    class="gauge-track"
    role="meter"
    aria-label={label}
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow={Math.round(fillPct)}
    aria-valuetext="{fmtPct(utilizationPct)} used"
  >
    <div class="gauge-band under"></div>
    <div class="gauge-band in"></div>
    <div
      class="gauge-fill"
      data-testid="utilization-gauge-fill"
      data-band={band}
      data-fill-pct={fillPct.toFixed(1)}
      style="width:{fillPct.toFixed(1)}%;background:{bandMeta.color}"
    ></div>
  </div>

  <div class="gauge-scale af2-mono" aria-hidden="true">
    <span>0</span>
    <span>{Math.round(BUDGET_BAND_START * 100)}%</span>
    <span>{Math.round(BUDGET_BAND_END * 100)}%</span>
  </div>
</div>

<style>
  .utilization-gauge {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 8px);
    color: var(--color-text, var(--af-text, #f5f5f5));
    font-size: 13px;
  }

  .gauge-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3, 12px);
  }

  .gauge-label {
    color: var(--color-muted, var(--af-text-muted, #888));
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .gauge-values {
    margin-top: 3px;
    color: var(--color-text, var(--af-text, #f5f5f5));
    font-size: 15px;
    font-weight: 600;
  }

  .gauge-values span {
    color: var(--color-muted, var(--af-text-muted, #888));
    font-size: 12px;
    font-weight: 500;
  }

  .gauge-status {
    border: 1px solid color-mix(in srgb, var(--gauge-band-color) 35%, transparent);
    border-radius: var(--radius-1, 6px);
    background: color-mix(in srgb, var(--gauge-band-color) 14%, transparent);
    color: var(--gauge-band-color);
    font-size: 11px;
    font-weight: 600;
    line-height: 1;
    padding: 6px 8px;
    white-space: nowrap;
  }

  .gauge-track {
    position: relative;
    display: grid;
    grid-template-columns: 85fr 15fr;
    height: 12px;
    overflow: hidden;
    border: 1px solid var(--color-border, var(--af-border, #2d2d34));
    border-radius: var(--radius-1, 6px);
    background: color-mix(in srgb, var(--color-surface, var(--af-panel, #18181d)) 88%, transparent);
  }

  .gauge-band {
    min-width: 0;
    height: 100%;
  }

  .gauge-band.under {
    background: color-mix(in srgb, var(--color-success, var(--af-success, #35c779)) 12%, transparent);
  }

  .gauge-band.in {
    background: color-mix(in srgb, var(--color-warning, var(--af-warning, #e0a43a)) 16%, transparent);
  }

  .gauge-fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: inherit;
    box-shadow: 0 0 18px color-mix(in srgb, var(--gauge-band-color) 24%, transparent);
    transition: width 420ms cubic-bezier(0.2, 0.7, 0.2, 1), background-color 180ms ease;
  }

  .gauge-scale {
    display: grid;
    grid-template-columns: 85fr 15fr;
    color: var(--color-dim, var(--af-dim, #666));
    font-size: 10px;
  }

  .gauge-scale span:nth-child(2) {
    transform: translateX(-50%);
  }

  .gauge-scale span:last-child {
    justify-self: end;
  }

  .af2-mono {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1, 'ss01' 1;
  }

  .reduce-motion .gauge-fill {
    transition: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .gauge-fill { transition: none; }
  }
</style>
