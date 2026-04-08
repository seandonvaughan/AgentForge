<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { agents, agentsLoading, agentsError, loadAgents } from '$lib/stores/agents.js';

  let search = $state('');
  let filterModel: '' | 'opus' | 'sonnet' | 'haiku' = $state('');

  onMount(() => loadAgents());

  let filtered = $derived($agents.filter(a => {
    const q = search.toLowerCase();
    const label = (a.name ?? a.agentId ?? a.id ?? '').toLowerCase();
    const desc = (a.description ?? '').toLowerCase();
    const nameMatch = label.includes(q) || desc.includes(q);
    const modelMatch = filterModel === '' || a.model === filterModel;
    return nameMatch && modelMatch;
  }));

  function agentLabel(a: (typeof $agents)[0]): string {
    return a.name || a.agentId || a.id || '—';
  }

  function agentNavId(a: (typeof $agents)[0]): string {
    return a.agentId || a.id || '';
  }
</script>

<svelte:head><title>Agents — AgentForge</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Agents</h1>
    <p class="page-subtitle">{$agents.length} agent{$agents.length === 1 ? '' : 's'} registered</p>
  </div>
  <button class="btn btn-ghost btn-sm" onclick={loadAgents} disabled={$agentsLoading}>
    {$agentsLoading ? 'Loading…' : 'Refresh'}
  </button>
</div>

<div class="filters">
  <input
    class="search-input"
    type="search"
    placeholder="Search agents…"
    bind:value={search}
    aria-label="Search agents"
  />
  <div class="filter-pills">
    {#each (['', 'opus', 'sonnet', 'haiku'] as const) as tier}
      <button
        class="pill {filterModel === tier ? 'active' : ''} {tier || 'all'}"
        onclick={() => (filterModel = tier)}
      >
        {tier || 'All'}
      </button>
    {/each}
  </div>
</div>

{#if $agentsLoading}
  <div class="card">
    {#each Array(6) as _}
      <div class="skeleton" style="height:20px; width:100%; margin-bottom:10px;"></div>
    {/each}
  </div>
{:else if $agentsError}
  <div class="empty-state">
    {$agentsError}
    <button class="btn btn-ghost btn-sm" style="margin-top:var(--space-3)" onclick={loadAgents}>Retry</button>
  </div>
{:else if filtered.length === 0}
  <div class="empty-state">No agents found{search ? ` for "${search}"` : ''}.</div>
{:else}
  <div class="card" style="padding:0; overflow:hidden;">
    <table class="data-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Agent ID</th>
          <th>Model</th>
          <th>Role</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {#each filtered as agent (agent.agentId ?? agent.id)}
          <tr onclick={() => goto(`/agents/${agentNavId(agent)}`)}>
            <td style="font-weight:600; white-space:nowrap;">{agentLabel(agent)}</td>
            <td style="font-family:var(--font-mono); font-size:var(--text-xs); color:var(--color-text-muted); white-space:nowrap;">
              {agent.agentId || agent.id || '—'}
            </td>
            <td>
              {#if agent.model}
                <span class="badge {agent.model}">{agent.model}</span>
              {:else}
                <span class="badge muted">—</span>
              {/if}
            </td>
            <td style="color:var(--color-text-muted); white-space:nowrap;">{agent.role ?? '—'}</td>
            <td class="description-cell">{agent.description ?? '—'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .filters {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    margin-bottom: var(--space-5);
    flex-wrap: wrap;
  }
  .search-input {
    flex: 1;
    min-width: 200px;
    padding: var(--space-2) var(--space-3);
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    font-size: var(--text-sm);
    outline: none;
  }
  .search-input:focus { border-color: var(--color-brand); }
  .filter-pills { display: flex; gap: var(--space-2); }
  .pill {
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    font-weight: 600;
    cursor: pointer;
    border: 1px solid var(--color-border);
    background: transparent;
    color: var(--color-text-muted);
    transition: all var(--duration-fast);
  }
  .pill:hover { background: var(--color-surface-2); color: var(--color-text); }
  .pill.active.all   { background: rgba(91,138,245,0.12); color: var(--color-brand); border-color: rgba(91,138,245,0.4); }
  .pill.active.opus  { background: rgba(245,200,66,0.12); color: var(--color-opus); border-color: rgba(245,200,66,0.4); }
  .pill.active.sonnet { background: rgba(74,158,255,0.12); color: var(--color-sonnet); border-color: rgba(74,158,255,0.4); }
  .pill.active.haiku { background: rgba(76,175,130,0.12); color: var(--color-haiku); border-color: rgba(76,175,130,0.4); }
  .description-cell {
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    max-width: 360px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
