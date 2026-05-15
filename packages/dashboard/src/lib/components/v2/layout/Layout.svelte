<script lang="ts">
  import type { Snippet } from 'svelte';
  import Topbar from './Topbar.svelte';
  import StatusLine from './StatusLine.svelte';
  import Sidebar from './Sidebar.svelte';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();

  // ── Sidebar pin state sync ─────────────────────────────────────────────
  // The Sidebar handles its own pinned state in localStorage. We derive the
  // column width here by reading the same key so the CSS grid tracks it.
  function readPinned(): boolean {
    if (typeof localStorage === 'undefined') return true;
    const stored = localStorage.getItem('af2-sidebar-pinned');
    return stored === null ? true : stored === 'true';
  }

  let sidebarPinned = $state(readPinned());

  // Listen for sidebar state changes (localStorage key writes from Sidebar)
  $effect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === 'af2-sidebar-pinned') {
        sidebarPinned = e.newValue === 'true';
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  });

  // Reduced-motion check
  const reducedMotion = $derived(
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );

  const gridTransition = $derived(
    reducedMotion ? 'none' : 'grid-template-columns 200ms cubic-bezier(.2,.7,.2,1)'
  );

  // Column width: when sidebar is NOT pinned (collapsed + hovering as overlay),
  // the grid column stays at 48px — the sidebar floats above via position:absolute.
  const colWidth = $derived(sidebarPinned ? '220px' : '48px');
</script>

<div
  class="v2-layout"
  style="
    grid-template-columns:{colWidth} 1fr;
    transition:{gridTransition};
  "
>
  <Topbar />
  <StatusLine />
  <Sidebar />
  <main class="v2-main">
    {@render children()}
  </main>
</div>

<style>
  .v2-layout {
    display: grid;
    /* columns set inline via Svelte binding above */
    grid-template-rows: 44px 22px 1fr;
    grid-template-areas:
      "topbar  topbar"
      "status  status"
      "sidebar main";
    height: 100vh;
    overflow: hidden;
    background: var(--af-bg);
    color: var(--af-text);
    font-family: 'Inter', system-ui, sans-serif;
  }

  .v2-main {
    grid-area: main;
    overflow: auto;
    padding: 14px 18px 18px;
    background: var(--af-bg);
  }
</style>
