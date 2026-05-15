<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    children?: Snippet;
    hover?: boolean;
    accent?: boolean;
    noPad?: boolean;
    onclick?: (e: MouseEvent) => void;
    style?: string;
    class?: string;
  }

  let {
    children,
    hover = false,
    accent = false,
    noPad = false,
    onclick,
    style = '',
    class: className = '',
  }: Props = $props();

  const borderColor = $derived(
    accent ? 'color-mix(in srgb,var(--af-accent) 25%,transparent)' : 'var(--af-border)'
  );

  const inlineStyle = $derived(
    `background:var(--af-surface);` +
    `border:1px solid ${borderColor};` +
    `border-radius:10px;` +
    `padding:${noPad ? '0' : '16px'};` +
    `overflow:${noPad ? 'hidden' : 'unset'};` +
    style
  );
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div
  class={['af2-card', hover && 'af2-hover-card', className].filter(Boolean).join(' ')}
  style={inlineStyle}
  {onclick}
>
  {@render children?.()}
</div>

<style>
  .af2-hover-card {
    transition: border-color 180ms ease, background 180ms ease;
    cursor: pointer;
  }
  .af2-hover-card:hover {
    border-color: var(--af-border3) !important;
    background: var(--af-surface2) !important;
  }
</style>
