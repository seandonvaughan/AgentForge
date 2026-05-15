<script lang="ts">
  import '../app.css';
  import Layout from '$lib/components/v2/layout/Layout.svelte';
  import ApprovalModal from '$lib/components/ApprovalModal.svelte';
  import { wsStore } from '$lib/stores/ws.js';
  import { approvalsStore } from '$lib/stores/approvals.js';
  import { loadAgents } from '$lib/stores/agents.js';
  import { loadSessions } from '$lib/stores/sessions.js';
  import { loadCosts } from '$lib/stores/costs.js';
  import { loadVersion } from '$lib/stores/version.js';
  import { onMount, onDestroy } from 'svelte';
  import type { Snippet } from 'svelte';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();

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

<Layout>
  {@render children()}
</Layout>

<!-- Global approval modal — rendered above all pages, opened via approvalsStore.open() -->
<ApprovalModal />
