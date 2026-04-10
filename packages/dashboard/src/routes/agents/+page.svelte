<script lang="ts">
  import { goto } from '$app/navigation';
  import type { PageData } from './$types';
  import type { AgentListItem } from './+page.server';

  let { data }: { data: PageData } = $props();

  let search = $state('');
  let filterModel: '' | 'opus' | 'sonnet' | 'haiku' = $state('');

  // refreshedAgents is null until the user clicks Refresh; then it holds the
  // live API result. liveAgents always prefers the API result when available,
  // falling back to the SSR-loaded data from +page.server.ts.
  let refreshedAgents = $state<AgentListItem[] | null>(null);
  let refreshing = $state(false);
  let refreshError = $state<string | null>(null);

  let liveAgents = $derived(refreshedAgents ?? data.agents ?? []);

  async function refresh() {
    refreshing = true;
    refreshError = null;
    try {
      const res = await fetch('/api/v5/agents');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data?: AgentListItem[] };
      refreshedAgents = json.data ?? [];
    } catch (e) {
      refreshError = e instanceof Error ? e.message : 'Refresh failed';
    } finally {
      refreshing = false;
    }
  }

  let filtered = $derived(liveAgents.filter(a => {
    const q = search.toLowerCase();
    const label = (a.name ?? a.agentId ?? '').toLowerCase();
    const desc = (a.description ?? '').toLowerCase();
    const nameMatch = !q || label.includes(q) || desc.includes(q);
    const modelMatch = filterModel === '' || a.model === filterModel;
    return nameMatch && modelMatch;
  }));
</script>

<svelte:head><title>Agents — AgentForge</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Agents</h1>
    <p class="page-subtitle">{liveAgents.length} agent{liveAgents.length === 1 ? '' : 's'} registered</p>
  </div>
  <div style="display:flex; align-items:center; gap: var(--space-2);">
    {#if refreshError}
      <span style="font-size:var(--text-xs); color:var(--color-danger);">{refreshError}</span>
    {/if}
    <button class="btn btn-ghost btn-sm" onclick={refresh} disabled={refreshing}>
      {refreshing ? 'Refreshing…' : 'Refresh'}
    </button>
  </div>
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

{#if liveAgents.length === 0 && !refreshing}
  <div class="empty-state">
    No agents found in <code>.agentforge/agents/</code>.
  </div>
{:else if filtered.length === 0}
  <div class="empty-state">No agents match{search ? ` "${search}"` : ''}.</div>
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
        {#each filtered as agent (agent.agentId)}
          <tr
            role="button"
            tabindex="0"
            onclick={() => goto(`/agents/${agent.agentId}`)}
            onkeydown={e => e.key === 'Enter' && goto(`/agents/${agent.agentId}`)}
          >
            <td style="font-weight:600; white-space:nowrap;">{agent.name}</td>
            <td style="font-family:var(--font-mono); font-size:var(--text-xs); color:var(--color-text-muted); white-space:nowrap;">
              {agent.agentId}
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
  .pill.active.all    { background: rgba(91,138,245,0.12); color: var(--color-brand);  border-color: rgba(91,138,245,0.4); }
  .pill.active.opus   { background: rgba(245,200,66,0.12); color: var(--color-opus);   border-color: rgba(245,200,66,0.4); }
  .pill.active.sonnet { background: rgba(74,158,255,0.12); color: var(--color-sonnet); border-color: rgba(74,158,255,0.4); }
  .pill.active.haiku  { background: rgba(76,175,130,0.12); color: var(--color-haiku);  border-color: rgba(76,175,130,0.4); }
  .description-cell {
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    max-width: 360px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
