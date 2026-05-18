<script lang="ts">
  /**
   * CostQualityScatter.svelte
   *
   * Pure SVG scatter plot: cost (x-axis) vs quality score (y-axis),
   * coloured by agent_id. No external chart deps.
   *
   * Props:
   *   points — array of { agentId, costUsd, qualityScore }
   *   w, h   — viewport width / height (default 480 × 280)
   */

  interface ScatterPoint {
    agentId: string;
    costUsd: number;
    qualityScore: number;
  }

  interface Props {
    points?: ScatterPoint[];
    w?: number;
    h?: number;
  }

  let { points = [], w = 480, h = 280 }: Props = $props();

  // Margins for axes
  const ML = 48; // left  (y-axis labels)
  const MB = 36; // bottom (x-axis labels)
  const MT = 16;
  const MR = 16;

  const PW = $derived(w - ML - MR);
  const PH = $derived(h - MT - MB);

  // Palette for agent IDs — cycle through fixed colours
  const PALETTE = [
    'var(--af-accent)',
    'var(--af-accent2)',
    'var(--af-warning)',
    'var(--af-success)',
    'var(--af-purple)',
    '#e87c5b',
    '#5bc2e8',
    '#b55be8',
  ];

  // Assign a colour per unique agent id
  const agentColors = $derived.by(() => {
    const m = new Map<string, string>();
    let i = 0;
    for (const p of points) {
      if (!m.has(p.agentId)) {
        m.set(p.agentId, PALETTE[i % PALETTE.length]);
        i++;
      }
    }
    return m;
  });

  // Data ranges
  const xMin = $derived(points.length > 0 ? Math.min(...points.map(p => p.costUsd)) : 0);
  const xMax = $derived(points.length > 0 ? Math.max(...points.map(p => p.costUsd)) : 1);
  const yMin = 0;
  const yMax = 100;

  function toSx(cost: number): number {
    const range = xMax - xMin || 1;
    return ML + ((cost - xMin) / range) * PW;
  }

  function toSy(score: number): number {
    return MT + PH - ((score - yMin) / (yMax - yMin)) * PH;
  }

  // Y axis ticks: 0 25 50 75 100
  const yTicks = [0, 25, 50, 75, 100];

  // X axis ticks: 3 evenly spaced
  const xTicks = $derived.by<number[]>(() => {
    if (points.length === 0) return [0, 0.5, 1];
    const step = (xMax - xMin) / 3;
    return [xMin, xMin + step, xMin + 2 * step, xMax];
  });

  function fmtCost(v: number): string {
    if (v < 0.01) return `$${v.toFixed(4)}`;
    return `$${v.toFixed(2)}`;
  }
</script>

<div class="scatter-wrap" style="width:{w}px;max-width:100%;overflow:hidden">
  {#if points.length === 0}
    <div class="scatter-empty">No data for the selected window.</div>
  {:else}
    <svg
      width={w}
      height={h}
      viewBox="0 0 {w} {h}"
      style="display:block;width:100%;height:auto"
      aria-label="Cost vs Quality scatter plot"
      role="img"
    >
      <!-- Grid lines (y) -->
      {#each yTicks as tick (tick)}
        {@const sy = toSy(tick)}
        <line
          x1={ML}
          y1={sy}
          x2={w - MR}
          y2={sy}
          stroke="var(--af-border)"
          stroke-width="0.5"
          stroke-dasharray={tick === 0 ? undefined : '3,3'}
        />
        <text
          x={ML - 6}
          y={sy + 4}
          text-anchor="end"
          class="axis-label"
        >{tick}</text>
      {/each}

      <!-- X axis ticks -->
      {#each xTicks as tick (tick)}
        {@const sx = toSx(tick)}
        <line
          x1={sx}
          y1={MT + PH}
          x2={sx}
          y2={MT + PH + 4}
          stroke="var(--af-border)"
          stroke-width="0.8"
        />
        <text
          x={sx}
          y={h - 6}
          text-anchor="middle"
          class="axis-label"
        >{fmtCost(tick)}</text>
      {/each}

      <!-- Axis labels -->
      <text
        x={ML - 36}
        y={MT + PH / 2}
        text-anchor="middle"
        transform="rotate(-90,{ML - 36},{MT + PH / 2})"
        class="axis-title"
      >Quality</text>
      <text
        x={ML + PW / 2}
        y={h}
        text-anchor="middle"
        class="axis-title"
      >Cost (USD)</text>

      <!-- Data points -->
      {#each points as pt (pt.agentId + pt.costUsd + pt.qualityScore)}
        {@const sx = toSx(pt.costUsd)}
        {@const sy = toSy(pt.qualityScore)}
        {@const col = agentColors.get(pt.agentId) ?? 'var(--af-accent)'}
        <circle
          cx={sx}
          cy={sy}
          r="5"
          fill={col}
          fill-opacity="0.7"
          stroke={col}
          stroke-width="1"
        >
          <title>{pt.agentId}: quality={pt.qualityScore.toFixed(1)}, cost={fmtCost(pt.costUsd)}</title>
        </circle>
      {/each}
    </svg>

    <!-- Legend -->
    <div class="legend">
      {#each agentColors.entries() as [agent, col] (agent)}
        <span class="legend-item">
          <svg width="10" height="10" style="display:inline-block;vertical-align:middle" aria-hidden="true">
            <circle cx="5" cy="5" r="4" fill={col} />
          </svg>
          <span class="legend-label">{agent}</span>
        </span>
      {/each}
    </div>
  {/if}
</div>

<style>
  .scatter-wrap {
    position: relative;
  }

  .scatter-empty {
    height: 120px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    color: var(--af-dim);
  }

  .axis-label {
    font-size: 9px;
    fill: var(--af-dim);
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
  }

  .axis-title {
    font-size: 10px;
    fill: var(--af-faint);
    font-family: inherit;
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 14px;
    margin-top: 6px;
  }

  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .legend-label {
    font-size: 10px;
    color: var(--af-dim);
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
  }
</style>
