<script lang="ts">
  import '../app.css';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import Topbar from '$lib/components/Topbar.svelte';
  import { wsStore } from '$lib/stores/ws.js';
  import { loadAgents } from '$lib/stores/agents.js';
  import { loadSessions } from '$lib/stores/sessions.js';
  import { loadCosts } from '$lib/stores/costs.js';
  import { loadVersion } from '$lib/stores/version.js';
  import { onMount } from 'svelte';

  onMount(() => {
    // Kick off all data loads in parallel
    Promise.all([loadAgents(), loadSessions({ limit: 100 }), loadCosts(), loadVersion()]);

    // Connect WebSocket — auto-reconnects internally
    wsStore.connect();

    return () => wsStore.disconnect();
  });
</script>

<div class="app-layout">
  <Topbar />
  <Sidebar />
  <main class="main-content">
    <slot />
  </main>
</div>
