<script lang="ts">
  export let value: number = 0; // 0–100
  export let label: string = '';
  export let color: string = 'var(--color-brand)';

  const r = 40;
  const cx = 50;
  const cy = 55;
  const sweep = 240; // degrees total arc

  function polarToCartesian(angleDeg: number): { x: number; y: number } {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  // Arc starts at -120° from top (i.e. 240° from north) and ends at +120° from top
  const startAngle = -120; // degrees from top (12 o'clock)
  const endAngle   = 120;

  // Convert to SVG coordinate angles (SVG 0° = 3 o'clock, so add 90)
  const startSvg = startAngle + 90; // = -30
  const endSvg   = endAngle   + 90; // = 210

  // Background track: full arc
  const trackStart = polarToCartesian(startSvg);
  const trackEnd   = polarToCartesian(endSvg);

  // Filled arc: proportion of sweep based on value
  $: fillAngle = startSvg + (sweep * Math.min(Math.max(value, 0), 100)) / 100;
  $: fillEnd   = polarToCartesian(fillAngle);
  $: fillLarge = fillAngle - startSvg > 180 ? 1 : 0;

  function arcPath(x1: number, y1: number, x2: number, y2: number, large: number): string {
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  }

  const trackPath = arcPath(trackStart.x, trackStart.y, trackEnd.x, trackEnd.y, 1);
</script>

<div class="gauge-wrap">
  <svg viewBox="0 0 100 110" width="100" height="110" aria-label="{label}: {value}%">
    <!-- Track -->
    <path
      d={trackPath}
      fill="none"
      stroke="var(--color-surface-3)"
      stroke-width="6"
      stroke-linecap="round"
    />
    <!-- Fill -->
    {#if value > 0}
      <path
        d={arcPath(trackStart.x, trackStart.y, fillEnd.x, fillEnd.y, fillLarge)}
        fill="none"
        stroke={color}
        stroke-width="6"
        stroke-linecap="round"
      />
    {/if}
    <!-- Value text -->
    <text x={cx} y={cy - 4} text-anchor="middle" font-size="14" font-weight="700" fill="var(--color-text)" font-family="var(--font-mono)">
      {value}%
    </text>
  </svg>
  <div class="gauge-label">{label}</div>
</div>

<style>
  .gauge-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
  }
  .gauge-label {
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--color-text-muted);
    text-align: center;
  }
</style>
