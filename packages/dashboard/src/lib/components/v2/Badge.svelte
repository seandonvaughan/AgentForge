<script lang="ts">
  import type { Snippet } from 'svelte';

  type Variant = 'success' | 'warning' | 'danger' | 'info' | 'purple' | 'muted';

  interface Props {
    variant?: Variant;
    children?: Snippet;
    style?: string;
  }

  let { variant = 'muted', children, style = '' }: Props = $props();

  // colour triples: [text, bg, border]
  const map: Record<Variant, [string, string, string]> = {
    success: ['var(--af-success)', 'color-mix(in srgb,var(--af-success) 8%,transparent)', 'color-mix(in srgb,var(--af-success) 20%,transparent)'],
    warning: ['var(--af-warning)', 'color-mix(in srgb,var(--af-warning) 8%,transparent)', 'color-mix(in srgb,var(--af-warning) 20%,transparent)'],
    danger:  ['var(--af-danger)',  'color-mix(in srgb,var(--af-danger) 8%,transparent)',  'color-mix(in srgb,var(--af-danger) 20%,transparent)'],
    info:    ['var(--af-accent2)', 'color-mix(in srgb,var(--af-accent2) 8%,transparent)', 'color-mix(in srgb,var(--af-accent2) 20%,transparent)'],
    purple:  ['var(--af-purple)',  'color-mix(in srgb,var(--af-purple) 8%,transparent)',  'color-mix(in srgb,var(--af-purple) 20%,transparent)'],
    muted:   ['var(--af-dim)',     'transparent',                                          'var(--af-border3)'],
  };

  const [c, bg, border] = $derived(map[variant] ?? map.muted);

  const inlineStyle = $derived(
    `font-size:10px;font-weight:600;letter-spacing:0.05em;` +
    `padding:2px 7px;border-radius:4px;` +
    `color:${c};background:${bg};border:1px solid ${border};` +
    `text-transform:uppercase;display:inline-flex;align-items:center;` +
    style
  );
</script>

<span style={inlineStyle}>{@render children?.()}</span>
