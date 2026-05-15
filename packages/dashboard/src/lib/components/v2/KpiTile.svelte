<script lang="ts">
  import Card from './Card.svelte';
  import PulseDot from './PulseDot.svelte';
  import Sparkline from './Sparkline.svelte';

  interface Props {
    label?: string;
    value?: string | number;
    sub?: string;
    delta?: string;
    color?: string;
    live?: boolean;
    sparkline?: number[];
  }

  let {
    label = '',
    value = '',
    sub,
    delta,
    color = 'var(--af-text)',
    live = false,
    sparkline,
  }: Props = $props();

  // Positive delta gets success colour; negative or neutral stays as-is
  const deltaColor = $derived(
    delta && delta.startsWith('+') ? 'var(--af-success)' :
    delta && delta.startsWith('-') ? 'var(--af-danger)' :
    'var(--af-muted)'
  );
</script>

<Card hover style="padding:10px 14px">
  <div class="kpi-header">
    <span class="kpi-label">{label}</span>
    <div class="kpi-right">
      {#if delta}
        <span class="kpi-delta af2-mono" style="color:{deltaColor};background:color-mix(in srgb,{deltaColor} 8%,transparent)">
          {delta}
        </span>
      {/if}
      {#if live}
        <PulseDot color="var(--af-purple)" size={5} />
      {/if}
    </div>
  </div>

  <div class="kpi-value af2-mono" style="color:{color}">{value}</div>

  {#if sub}
    <div class="kpi-sub af2-mono">{sub}</div>
  {/if}

  {#if sparkline && sparkline.length > 0}
    <div class="kpi-spark">
      <Sparkline data={sparkline} color={color} w={120} h={20} />
    </div>
  {/if}
</Card>

<style>
  .kpi-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }

  .kpi-label {
    font-size: 10px;
    color: var(--af-dim);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 600;
  }

  .kpi-right {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .kpi-delta {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
  }

  .kpi-value {
    font-size: 20px;
    font-weight: 600;
    margin-top: 4px;
    letter-spacing: -0.02em;
  }

  .kpi-sub {
    font-size: 10px;
    color: var(--af-dim);
    margin-top: 2px;
  }

  .kpi-spark {
    margin-top: 8px;
  }

  .af2-mono {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1, 'ss01' 1;
  }
</style>
