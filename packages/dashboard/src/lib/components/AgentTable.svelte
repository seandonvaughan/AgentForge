<script lang="ts">
  import { agents, agentsLoading } from '$lib/stores/agents.js';
  import { goto } from '$app/navigation';
  import type { Agent } from '$lib/stores/agents.js';

  function agentNavId(a: Agent): string {
    return a.agentId || a.id || '';
  }

  function agentLabel(a: Agent): string {
    return a.name || a.agentId || a.id || '—';
  }
</script>

<div class="card" style="margin-bottom:24px">
  <div class="card-header">
    <span class="card-title">Agents</span>
    <a href="/agents" class="btn btn-ghost btn-sm">View all</a>
  </div>
  {#if $agentsLoading}
    <div class="skeleton" style="height:120px"></div>
  {:else if $agents.length === 0}
    <div class="empty-state">No agents registered yet.</div>
  {:else}
    <table class="data-table">
      <thead>
        <tr>
          <th>Agent</th>
          <th>Model</th>
          <th>Sessions</th>
          <th>Success</th>
          <th>Cost</th>
        </tr>
      </thead>
      <tbody>
        {#each $agents.slice(0, 10) as agent (agent.agentId ?? agent.id)}
          <tr on:click={() => goto(`/agents/${agentNavId(agent)}`)}>
            <td style="font-weight:600;">{agentLabel(agent)}</td>
            <td>
              {#if agent.model}
                <span class="badge {agent.model}">{agent.model}</span>
              {:else}
                <span class="badge muted">—</span>
              {/if}
            </td>
            <td style="font-family:var(--font-mono);">{agent.sessionCount ?? 0}</td>
            <td>
              {#if (agent.sessionCount ?? 0) > 0 && agent.successCount != null}
                <span class="badge success">
                  {Math.round((agent.successCount / (agent.sessionCount ?? 1)) * 100)}%
                </span>
              {:else}
                <span class="badge muted">—</span>
              {/if}
            </td>
            <td style="font-family:var(--font-mono);">${(agent.totalCostUsd ?? 0).toFixed(4)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
