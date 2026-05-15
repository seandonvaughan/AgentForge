<script lang="ts">
  import '../app.css';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import Topbar from '$lib/components/Topbar.svelte';
  import ApprovalModal from '$lib/components/ApprovalModal.svelte';
  import { wsStore } from '$lib/stores/ws.js';
  import { approvalsStore } from '$lib/stores/approvals.js';
  import { loadAgents } from '$lib/stores/agents.js';
  import { loadSessions } from '$lib/stores/sessions.js';
  import { loadCosts } from '$lib/stores/costs.js';
  import { loadVersion } from '$lib/stores/version.js';
  import { onMount, onDestroy } from 'svelte';

  onMount(() => {
    // Kick off all data loads in parallel
    Promise.all([loadAgents(), loadSessions({ limit: 100 }), loadCosts(), loadVersion()]);

    // Connect WebSocket — auto-reconnects internally
    wsStore.connect();

    // Connect SSE for cycle approval notifications + start polling fallback
    approvalsStore.connectSSE();
  });

  onDestroy(() => {
    wsStore.disconnect();
    approvalsStore.disconnectSSE();
  });
</script>

<div class="app-layout">
  <Topbar />
  <Sidebar />
  <main class="main-content">
    <slot />
  </main>
</div>

<!-- Global approval modal — rendered above all pages, opened via approvalsStore.open() -->
<ApprovalModal />
