<script lang="ts">
  import type { Snippet } from 'svelte';

  type Variant = 'primary' | 'purple' | 'ghost' | 'danger';
  type Size = 'sm' | 'md' | 'lg';

  interface Props {
    variant?: Variant;
    size?: Size;
    disabled?: boolean;
    href?: string;
    onClick?: (e: MouseEvent) => void;
    onclick?: (e: MouseEvent) => void;
    children?: Snippet;
    leading?: Snippet;
    trailing?: Snippet;
    type?: 'button' | 'submit' | 'reset';
    class?: string;
    /** Extra inline CSS appended after the variant styles (caller overrides). */
    style?: string;
  }

  let {
    variant = 'ghost',
    size = 'md',
    disabled = false,
    href,
    onClick,
    onclick,
    children,
    leading,
    trailing,
    type = 'button',
    class: className = '',
    style: extraStyle = '',
  }: Props = $props();

  const fontSize = $derived(size === 'sm' ? '11px' : size === 'lg' ? '13px' : '12px');
  const padding = $derived(size === 'sm' ? '4px 10px' : size === 'lg' ? '8px 18px' : '6px 12px');
  const height = $derived(size === 'sm' ? '26px' : size === 'lg' ? '36px' : '30px');

  // Variant colour map expressed as CSS variable strings
  const variantStyles: Record<Variant, string> = {
    primary: 'background:var(--af-accent);border-color:var(--af-accent);color:#fff',
    purple:  'background:linear-gradient(135deg,#6366f1,#a855f7);border-color:transparent;color:#fff',
    ghost:   'background:var(--af-surface);border-color:var(--af-border2);color:var(--af-muted)',
    danger:  'background:transparent;border-color:color-mix(in srgb,var(--af-danger) 33%,transparent);color:var(--af-danger)',
  };

  const inlineStyle = $derived([
    `display:inline-flex;align-items:center;gap:6px`,
    `border:1px solid;border-radius:6px`,
    `font-weight:500;letter-spacing:-0.005em`,
    `white-space:nowrap;text-decoration:none`,
    `cursor:${disabled ? 'not-allowed' : 'pointer'}`,
    `opacity:${disabled ? 0.5 : 1}`,
    `transition:all 150ms ease`,
    `font-size:${fontSize}`,
    `padding:${padding}`,
    `height:${height}`,
    variantStyles[variant],
    extraStyle,
  ].filter(Boolean).join(';'));

  let buttonEl = $state<HTMLButtonElement | undefined>();
  const clickHandler = $derived(onClick ?? onclick);

  $effect(() => {
    if (!buttonEl || !clickHandler) return;
    buttonEl.addEventListener('click', clickHandler);
    return () => buttonEl?.removeEventListener('click', clickHandler);
  });
</script>

{#if href}
  <a {href} style={inlineStyle} class={className} aria-disabled={disabled}>
    {@render leading?.()}
    {@render children?.()}
    {@render trailing?.()}
  </a>
{:else}
  <button bind:this={buttonEl} {type} {disabled} style={inlineStyle} class={className}>
    {@render leading?.()}
    {@render children?.()}
    {@render trailing?.()}
  </button>
{/if}
