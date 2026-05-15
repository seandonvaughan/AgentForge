<script lang="ts">
  interface Tab {
    id: string;
    label: string;
    count?: number;
  }

  interface Props {
    tabs: Tab[];
    active: string;
    onselect: (id: string) => void;
  }

  let { tabs, active, onselect }: Props = $props();

  let containerEl: HTMLDivElement | undefined = $state();
  let indicatorLeft = $state(0);
  let indicatorWidth = $state(0);

  // Slide the underline to the active tab
  $effect(() => {
    if (!containerEl) return;
    const btn = containerEl.querySelector<HTMLButtonElement>(`[data-tab="${active}"]`);
    if (btn) {
      indicatorLeft = btn.offsetLeft;
      indicatorWidth = btn.offsetWidth;
    }
  });

  const reducedMotion = $derived(
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );

  const transition = $derived(reducedMotion ? 'none' : 'all 250ms cubic-bezier(.2,.7,.2,1)');
</script>

<div
  bind:this={containerEl}
  class="tabs-strip"
  role="tablist"
>
  {#each tabs as tab (tab.id)}
    <button
      role="tab"
      aria-selected={active === tab.id}
      data-tab={tab.id}
      class="tab-btn"
      class:tab-active={active === tab.id}
      onclick={() => onselect(tab.id)}
    >
      {tab.label}
      {#if tab.count != null}
        <span class="tab-count" class:tab-count-active={active === tab.id}>
          {tab.count}
        </span>
      {/if}
    </button>
  {/each}

  <!-- Animated underline -->
  <div
    class="tab-indicator"
    style="left:{indicatorLeft}px;width:{indicatorWidth}px;transition:{transition};"
    aria-hidden="true"
  ></div>
</div>

<style>
  .tabs-strip {
    position: relative;
    display: flex;
    border-bottom: 1px solid var(--af-border);
    margin-bottom: 14px;
    gap: 0;
  }

  .tab-btn {
    background: none;
    border: none;
    color: var(--af-dim);
    font-size: 12px;
    font-weight: 500;
    padding: 10px 16px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: color 150ms ease;
    font-family: inherit;
  }

  .tab-btn:hover { color: var(--af-muted); }
  .tab-active { color: var(--af-text); }

  .tab-count {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--af-border);
    color: var(--af-dim);
  }

  .tab-count-active {
    background: color-mix(in srgb, var(--af-accent2) 13%, transparent);
    color: var(--af-accent2);
  }

  .tab-indicator {
    position: absolute;
    bottom: -1px;
    height: 2px;
    background: var(--af-grad-h, linear-gradient(90deg, var(--af-accent), var(--af-purple)));
    border-radius: 1px;
  }
</style>
