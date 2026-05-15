<script lang="ts">
  interface Props {
    data?: number[];
    color?: string;
    w?: number;
    h?: number;
    gap?: number;
  }

  let {
    data = [],
    color = 'var(--af-purple)',
    w = 80,
    h = 24,
    gap = 1.5,
  }: Props = $props();

  const bars = $derived.by(() => {
    if (data.length === 0) return [];
    const max = Math.max(...data) || 1;
    const bw = (w - (data.length - 1) * gap) / data.length;
    return data.map((v, i) => ({
      x: i * (bw + gap),
      y: h - Math.max(1, (v / max) * (h - 1)),
      bw,
      bh: Math.max(1, (v / max) * (h - 1)),
    }));
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
    {#each bars as bar, i (i)}
      <rect
        x={bar.x}
        y={bar.y}
        width={bar.bw}
        height={bar.bh}
        fill={color}
        rx="0.5"
      />
    {/each}
  </svg>
{/if}
