<script lang="ts">
  import { codexProfileFor } from '$lib/modelProfiles';

  type Model = 'fable' | 'opus' | 'sonnet' | 'haiku' | string;
  type Size = 'sm' | 'md';

  interface Props {
    model?: Model;
    tier?: Model;
    effort?: string | null;
    size?: Size;
  }

  let { model = '', tier = '', effort = null, size = 'sm' }: Props = $props();

  const profile = $derived(codexProfileFor(model || tier, effort));
  const displayModel = $derived(profile?.modelId ?? model);
  const displayEffort = $derived(effort ?? profile?.effort ?? null);
  const colorKey = $derived(tier || profile?.tier || model);
  const isCodexProfile = $derived(displayModel.toLowerCase().includes('codex') || displayModel.toLowerCase().startsWith('gpt-'));

  const color = $derived(
    colorKey === 'fable'  ? 'var(--af-fable, var(--af-opus))' :
    colorKey === 'opus'   ? 'var(--af-opus)'   :
    colorKey === 'sonnet' ? 'var(--af-sonnet)' :
    colorKey === 'haiku'  ? 'var(--af-haiku)'  :
    'var(--af-dim)'
  );

  const fontSize = $derived(size === 'sm' ? '9px' : '10px');
  const effortSize = $derived(size === 'sm' ? '8px' : '9px');

  const inlineStyle = $derived(
    `font-family:var(--af-font-mono);` +
    `font-feature-settings:'tnum' 1,'ss01' 1;` +
    `font-size:${fontSize};font-weight:600;letter-spacing:${isCodexProfile ? '0.01em' : '0.06em'};` +
    `padding:2px 6px;border-radius:3px;` +
    `color:${color};` +
    `background:color-mix(in srgb,${color} 8%,transparent);` +
    `border:1px solid color-mix(in srgb,${color} 20%,transparent);` +
    `text-transform:${isCodexProfile ? 'none' : 'uppercase'};display:inline-flex;align-items:center;gap:5px;` +
    `white-space:nowrap;line-height:1.3;`
  );

  const effortStyle = $derived(
    `font-size:${effortSize};font-weight:700;letter-spacing:0.05em;` +
    `text-transform:uppercase;color:color-mix(in srgb,${color} 80%,var(--af-text));`
  );
</script>

{#if displayModel}
  <span style={inlineStyle}>
    <span>{displayModel}</span>
    {#if displayEffort}
      <span aria-hidden="true">·</span>
      <span style={effortStyle}>{displayEffort}</span>
    {/if}
  </span>
{:else}
  <span style="color:var(--af-faint)">—</span>
{/if}
