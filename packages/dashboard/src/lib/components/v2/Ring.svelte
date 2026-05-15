<script lang="ts">
  interface Props {
    value?: number;
    max?: number;
    size?: number;
    stroke?: number;
    color?: string;
    track?: string;
    label?: string;
    sub?: string;
  }

  let {
    value = 0,
    max = 100,
    size = 44,
    stroke = 3,
    color = 'var(--af-accent)',
    track = 'var(--af-border)',
    label,
    sub,
  }: Props = $props();

  const r = $derived((size - stroke) / 2);
  const circumference = $derived(2 * Math.PI * r);
  const pct = $derived(Math.max(0, Math.min(1, value / max)));
  const dashOffset = $derived(circumference * (1 - pct));
  const labelFontSize = $derived(size > 60 ? '14px' : '10px');
</script>

<div class="ring-wrap" style="width:{size}px;height:{size}px">
  <svg
    width={size}
    height={size}
    viewBox="0 0 {size} {size}"
    style="display:block"
    aria-label={label ? `${label}: ${value} of ${max}` : undefined}
    role={label ? 'img' : undefined}
  >
    <!-- Track -->
    <circle
      cx={size / 2}
      cy={size / 2}
      r={r}
      fill="none"
      stroke={track}
      stroke-width={stroke}
    />
    <!-- Progress arc -->
    <circle
      cx={size / 2}
      cy={size / 2}
      r={r}
      fill="none"
      stroke={color}
      stroke-width={stroke}
      stroke-dasharray={circumference}
      stroke-dashoffset={dashOffset}
      stroke-linecap="round"
      transform="rotate(-90 {size / 2} {size / 2})"
      class="ring-arc"
    />
  </svg>

  {#if label}
    <div class="ring-center" aria-hidden="true">
      <span class="ring-label af2-mono" style="font-size:{labelFontSize}">{label}</span>
      {#if sub}
        <span class="ring-sub">{sub}</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .ring-wrap {
    position: relative;
  }

  .ring-arc {
    transition: stroke-dashoffset 700ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  @media (prefers-reduced-motion: reduce) {
    .ring-arc { transition: none; }
  }

  .ring-center {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }

  .ring-label {
    font-weight: 600;
    color: var(--af-text);
  }

  .ring-sub {
    font-size: 8px;
    color: var(--af-dim);
  }

  .af2-mono {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1, 'ss01' 1;
  }
</style>
