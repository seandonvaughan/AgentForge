<script lang="ts">
  interface Props {
    data?: number[];
    color?: string;
    w?: number;
    h?: number;
    gradient?: boolean;
    strokeWidth?: number;
  }

  let {
    data = [],
    color = 'var(--af-purple)',
    w = 80,
    h = 24,
    gradient = false,
    strokeWidth = 1.4,
  }: Props = $props();

  // Stable gradient ID per instance — safe for SSR since SVG defs are local
  const gid = `sg-${Math.random().toString(36).slice(2, 8)}`;

  const points = $derived.by(() => {
    if (data.length === 0) return { pts: [], line: '', area: '' };
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const pts = data.map((v, i) => [
      (i / (data.length - 1)) * w,
      h - ((v - min) / range) * (h - 2) - 1,
    ] as [number, number]);
    const line = pts.map(p => p.join(',')).join(' ');
    const area = `M0,${h} L${pts.map(p => p.join(',')).join(' L')} L${w},${h} Z`;
    return { pts, line, area };
  });
</script>

{#if data.length > 0}
  <svg
    width={w}
    height={h}
    viewBox="0 0 {w} {h}"
    style="display:block"
    aria-hidden="true"
  >
    {#if gradient}
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%"   stop-color={color} stop-opacity="0.35" />
          <stop offset="100%" stop-color={color} stop-opacity="0" />
        </linearGradient>
      </defs>
      <path d={points.area} fill="url(#{gid})" />
    {/if}

    <polyline
      points={points.line}
      fill="none"
      stroke={color}
      stroke-width={strokeWidth}
      stroke-linejoin="round"
      stroke-linecap="round"
    />

    {#if gradient && points.pts.length > 0}
      {@const last = points.pts[points.pts.length - 1]}
      <circle cx={last[0]} cy={last[1]} r="2" fill={color} />
    {/if}
  </svg>
{/if}
