<script lang="ts">
  import { agents, agentsLoading } from '$lib/stores/agents.js';
  import { sessions, sessionsLoading } from '$lib/stores/sessions.js';
  import { totalUsd, costsLoading } from '$lib/stores/costs.js';

  let successRate = $derived((() => {
    if (!$sessions.length) return 0;
    const completed = $sessions.filter((s: { status: string }) => s.status === 'completed').length;
    return Math.round(completed / $sessions.length * 100);
  })());
</script>

<div class="stat-grid">
  <div class="stat-card">
    {#if $agentsLoading}
      <div class="skeleton" style="height:32px; width:60px; margin-bottom:4px;"></div>
    {:else}
      <div class="stat-value">{$agents.length}</div>
    {/if}
    <div class="stat-label">Total Agents</div>
  </div>
  <div class="stat-card">
    {#if $sessionsLoading}
      <div class="skeleton" style="height:32px; width:60px; margin-bottom:4px;"></div>
    {:else}
      <div class="stat-value">{$sessions.length}</div>
    {/if}
    <div class="stat-label">Sessions</div>
  </div>
  <div class="stat-card">
    {#if $costsLoading}
      <div class="skeleton" style="height:32px; width:80px; margin-bottom:4px;"></div>
    {:else}
      <div class="stat-value">${$totalUsd.toFixed(4)}</div>
    {/if}
    <div class="stat-label">Total Spend</div>
  </div>
  <div class="stat-card">
    {#if $sessionsLoading}
      <div class="skeleton" style="height:32px; width:60px; margin-bottom:4px;"></div>
    {:else}
      <div class="stat-value">{successRate}%</div>
    {/if}
    <div class="stat-label">Success Rate</div>
  </div>
</div>
