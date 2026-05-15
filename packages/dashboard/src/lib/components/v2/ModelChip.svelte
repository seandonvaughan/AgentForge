<script lang="ts">
  type Model = 'opus' | 'sonnet' | 'haiku' | string;
  type Size = 'sm' | 'md';

  interface Props {
    model?: Model;
    size?: Size;
  }

  let { model = '', size = 'sm' }: Props = $props();

  const color = $derived(
    model === 'opus'   ? 'var(--af-opus)'   :
    model === 'sonnet' ? 'var(--af-sonnet)' :
    model === 'haiku'  ? 'var(--af-haiku)'  :
    'var(--af-dim)'
  );

  const fontSize = $derived(size === 'sm' ? '9px' : '10px');

  const inlineStyle = $derived(
    `font-family:var(--af-font-mono);` +
    `font-feature-settings:'tnum' 1,'ss01' 1;` +
    `font-size:${fontSize};font-weight:600;letter-spacing:0.06em;` +
    `padding:2px 6px;border-radius:3px;` +
    `color:${color};` +
    `background:color-mix(in srgb,${color} 8%,transparent);` +
    `border:1px solid color-mix(in srgb,${color} 20%,transparent);` +
    `text-transform:uppercase;display:inline-flex;align-items:center;`
  );
</script>

{#if model}
  <span style={inlineStyle}>{model}</span>
{:else}
  <span style="color:var(--af-faint)">—</span>
{/if}
