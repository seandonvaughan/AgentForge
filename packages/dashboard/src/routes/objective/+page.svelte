<script module lang="ts">
  import { budgetBand, formatUsd, type BudgetBand } from '$lib/util/objective-mode';

  export const BUDGET_PREVIEW_MIN_SPENDABLE_USD = 5;
  const FLOOR_BAND = budgetBand(0);
  export const BUDGET_PREVIEW_FLOOR_USD =
    FLOOR_BAND.reserveUsd + FLOOR_BAND.multiplier * BUDGET_PREVIEW_MIN_SPENDABLE_USD;

  export interface BudgetBandPreview extends BudgetBand {
    belowFloor: boolean;
    warning: string | null;
    formatted: {
      budget: string;
      spendable: string;
      lower: string;
      upper: string;
      band: string;
    };
  }

  export function buildBudgetBandPreview(budgetUsd: number): BudgetBandPreview {
    const band = budgetBand(budgetUsd);
    const belowFloor = band.budgetUsd < BUDGET_PREVIEW_FLOOR_USD;

    return {
      ...band,
      belowFloor,
      warning: belowFloor
        ? `Budget is below the sane floor of ${formatUsd(BUDGET_PREVIEW_FLOOR_USD)}. Increase it before launch.`
        : null,
      formatted: {
        budget: formatUsd(band.budgetUsd),
        spendable: formatUsd(band.spendableUsd),
        lower: formatUsd(band.lowerUsd),
        upper: formatUsd(band.upperUsd),
        band: `${formatUsd(band.lowerUsd)}-${formatUsd(band.upperUsd)}`,
      },
    };
  }
</script>

<script lang="ts">
  import { browser } from '$app/environment';
  import { onMount } from 'svelte';
  import { Card } from '$lib/components/v2';

  let budgetUsd = $state<number>(66);
  let previewReady = $state<boolean>(false);

  const preview: BudgetBandPreview = $derived.by(() => buildBudgetBandPreview(budgetUsd));

  onMount(() => {
    if (browser) previewReady = true;
  });
</script>

<svelte:head><title>Objective Budget - AgentForge</title></svelte:head>

<div class="page-head">
  <div>
    <div class="crumbs af2-mono">Workspace / Objective</div>
    <h1 class="page-title">Objective budget</h1>
    <p class="page-sub">Size launch budget against the spendable execution band.</p>
  </div>
</div>

<div class="objective-grid">
  <Card>
    <div class="section-title">BUDGET BAND PREVIEW</div>

    <div class="field">
      <label class="field-label" for="objectiveBudgetUsd">Budget (USD)</label>
      <div class="slider-row">
        <input
          id="objectiveBudgetUsd"
          type="range"
          min="0"
          max="500"
          step="1"
          bind:value={budgetUsd}
          class="slider"
        />
        <input
          type="number"
          min="0"
          step="0.5"
          bind:value={budgetUsd}
          class="num"
          aria-label="Objective budget in USD"
        />
      </div>
    </div>

    {#if previewReady}
      <div class="preview" aria-live="polite" data-testid="budget-preview">
        <div class="preview-main">
          <div>
            <div class="preview-key">Spendable</div>
            <div class="preview-value af2-mono">{preview.formatted.spendable}</div>
          </div>
          <div>
            <div class="preview-key">0.7-1.0 x spendable band</div>
            <div class="preview-value af2-mono">{preview.formatted.band}</div>
          </div>
        </div>

        <div class="preview-meta af2-mono">
          spendable = ({preview.formatted.budget} - {formatUsd(preview.reserveUsd)}) / {preview.multiplier}
        </div>

        {#if preview.warning}
          <div class="warning-row" data-testid="budget-floor-warning">
            <span class="warning-icon">!</span>
            <span>{preview.warning}</span>
          </div>
        {/if}
      </div>
    {:else}
      <div class="hint">Budget preview initializes in the browser.</div>
    {/if}
  </Card>
</div>

<style>
  .page-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 14px;
  }
  .crumbs {
    font-size: 11px;
    color: var(--af-dim);
    letter-spacing: 0.04em;
    margin-bottom: 4px;
  }
  .page-title {
    font-size: 22px;
    font-weight: 700;
    margin: 0;
    color: var(--af-text);
  }
  .page-sub {
    font-size: 12px;
    color: var(--af-dim);
    margin: 4px 0 0;
  }
  .objective-grid {
    max-width: 720px;
  }
  .section-title {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--af-dim);
    text-transform: uppercase;
    margin-bottom: 12px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .field-label {
    font-size: 10px;
    color: var(--af-dim);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .slider-row {
    display: grid;
    grid-template-columns: 1fr 80px;
    gap: 8px;
    align-items: center;
  }
  .slider {
    width: 100%;
    accent-color: var(--af-purple);
  }
  .num {
    background: var(--af-surface);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    padding: 6px 10px;
    color: var(--af-text);
    font-size: 12px;
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    height: 32px;
    width: 100%;
    box-sizing: border-box;
    text-align: right;
  }
  .num:focus {
    outline: none;
    border-color: var(--af-purple);
  }
  .preview {
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px solid var(--af-border);
  }
  .preview-main {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  @media (max-width: 560px) {
    .preview-main {
      grid-template-columns: 1fr;
    }
  }
  .preview-key {
    font-size: 10px;
    color: var(--af-dim);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .preview-value {
    margin-top: 4px;
    font-size: 24px;
    font-weight: 700;
    color: var(--af-text);
  }
  .preview-meta {
    margin-top: 12px;
    font-size: 11px;
    color: var(--af-muted);
  }
  .warning-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    background: color-mix(in srgb, var(--af-warning) 6%, transparent);
    border: 1px solid color-mix(in srgb, var(--af-warning) 25%, transparent);
    border-radius: 6px;
    font-size: 12px;
    color: var(--af-text);
    margin-top: 12px;
  }
  .warning-icon {
    color: var(--af-warning);
    font-size: 14px;
    font-weight: 700;
  }
  .hint {
    margin-top: 12px;
    color: var(--af-dim);
    font-size: 11px;
  }
  .af2-mono {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1, 'ss01' 1;
  }
</style>
