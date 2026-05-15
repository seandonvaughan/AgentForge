<script lang="ts">
  interface Segment {
    value: number;
    color: string;
    label?: string;
  }

  interface Props {
    segments?: Segment[];
    h?: number;
    label?: string;
  }

  let { segments = [], h = 6, label }: Props = $props();

  const total = $derived(segments.reduce((s, x) => s + x.value, 0) || 1);
</script>

{#if label}
  <div class="dist-label">{label}</div>
{/if}

<div
  class="dist-bar"
  style="height:{h}px"
  role="img"
  aria-label={label ?? 'Distribution bar'}
>
  {#each segments as seg, i (i)}
    <div
      class="dist-segment"
      style="width:{(seg.value / total) * 100}%;background:{seg.color}"
      title={seg.label ?? ''}
    ></div>
  {/each}
</div>

<style>
  .dist-label {
    font-size: 10px;
    color: var(--af-dim);
    margin-bottom: 4px;
  }

  .dist-bar {
    display: flex;
    border-radius: 999px;
    overflow: hidden;
    background: var(--af-border);
  }

  .dist-segment {
    transition: width 400ms ease;
  }
</style>
