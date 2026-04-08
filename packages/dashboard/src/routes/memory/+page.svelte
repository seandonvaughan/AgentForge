<script lang="ts">
  import { onMount } from 'svelte';

  interface MemoryEntry {
    id: string;
    key: string;
    value: unknown;
    type?: string;
    createdAt?: string;
    updatedAt?: string;
    agentId?: string;
    summary?: string;
    tags?: string[];
  }

  let entries: MemoryEntry[] = [];
  let agents: string[] = [];
  let loading = true;
  let error: string | null = null;
  let deleting: Set<string> = new Set();
  let deleteError: string | null = null;

  // Search and filter state
  let searchQuery = '';
  let agentFilter = 'all';

  // Derived: entries after client-side search + agent filter
  $: filteredEntries = entries.filter(e => {
    const matchesSearch = searchQuery.trim() === '' || [
      e.key,
      typeof e.value === 'string' ? e.value : JSON.stringify(e.value),
      e.summary ?? '',
      (e.tags ?? []).join(' '),
    ].join(' ').toLowerCase().includes(searchQuery.trim().toLowerCase());

    const matchesAgent = agentFilter === 'all' || e.agentId === agentFilter;

    return matchesSearch && matchesAgent;
  });

  async function load() {
    loading = true;
    error = null;
    try {
      const res = await fetch('/api/v5/memory');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data?: MemoryEntry[]; agents?: string[] };
      entries = json.data ?? [];
      agents = json.agents ?? [];
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  async function deleteEntry(id: string) {
    deleting = new Set([...deleting, id]);
    deleteError = null;
    try {
      const res = await fetch(`/api/v5/memory/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      entries = entries.filter(e => e.id !== id);
    } catch (e) {
      deleteError = `Failed to delete: ${e}`;
    } finally {
      deleting = new Set([...deleting].filter(x => x !== id));
    }
  }

  function formatValue(v: unknown): string {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'string') return v.length > 80 ? v.slice(0, 78) + '…' : v;
    return JSON.stringify(v).slice(0, 80);
  }

  function formatDate(iso?: string): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleString();
  }

  const TYPE_BADGE: Record<string, string> = {
    string: 'muted',
    number: 'sonnet',
    boolean: 'haiku',
    object: 'opus',
    array: 'warning',
  };

  function typeBadge(entry: MemoryEntry): string {
    const t = entry.type ?? typeof entry.value;
    return TYPE_BADGE[t] ?? 'muted';
  }

  onMount(load);
</script>

<svelte:head><title>Memory — AgentForge</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Memory</h1>
    <p class="page-subtitle">
      {filteredEntries.length}{filteredEntries.length !== entries.length ? ` of ${entries.length}` : ''} entr{filteredEntries.length === 1 ? 'y' : 'ies'}
    </p>
  </div>
  <button class="btn btn-ghost btn-sm" on:click={load} disabled={loading}>
    {loading ? 'Loading…' : 'Refresh'}
  </button>
</div>

<div class="filter-bar">
  <input
    class="search-input"
    type="search"
    placeholder="Search keys, values, tags…"
    bind:value={searchQuery}
    aria-label="Search memory entries"
  />
  {#if agents.length > 0}
    <select class="agent-select" bind:value={agentFilter} aria-label="Filter by agent">
      <option value="all">All agents</option>
      {#each agents as agent}
        <option value={agent}>{agent}</option>
      {/each}
    </select>
  {/if}
</div>

{#if deleteError}
  <div class="error-banner">{deleteError}</div>
{/if}

{#if loading}
  <div class="card" style="padding: 0; overflow: hidden;">
    <table class="data-table">
      <thead>
        <tr><th>Key</th><th>Type</th><th>Value</th><th>Updated</th><th></th></tr>
      </thead>
      <tbody>
        {#each Array(8) as _}
          <tr>
            <td><div class="skeleton" style="height: 14px; width: 120px;"></div></td>
            <td><div class="skeleton" style="height: 14px; width: 50px;"></div></td>
            <td><div class="skeleton" style="height: 14px; width: 200px;"></div></td>
            <td><div class="skeleton" style="height: 14px; width: 100px;"></div></td>
            <td></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{:else if error}
  <div class="empty-state">
    Failed to load memory.
    <button class="btn btn-ghost btn-sm" style="margin-top: var(--space-3)" on:click={load}>Retry</button>
  </div>
{:else if entries.length === 0}
  <div class="empty-state">No memory entries found.</div>
{:else if filteredEntries.length === 0}
  <div class="empty-state">No entries match your search.</div>
{:else}
  <div class="card" style="padding: 0; overflow: hidden;">
    <table class="data-table">
      <thead>
        <tr>
          <th>Key</th>
          <th>Type</th>
          <th>Value</th>
          <th>Updated</th>
          <th style="width: 64px;"></th>
        </tr>
      </thead>
      <tbody>
        {#each filteredEntries as entry (entry.id)}
          <tr class:deleting-row={deleting.has(entry.id)}>
            <td>
              <code class="key-cell">{entry.key}</code>
              {#if entry.agentId}
                <div class="agent-sub">{entry.agentId}</div>
              {/if}
            </td>
            <td>
              <span class="badge {typeBadge(entry)}">{entry.type ?? typeof entry.value}</span>
            </td>
            <td class="value-cell">{formatValue(entry.value)}</td>
            <td style="color: var(--color-text-muted); white-space: nowrap;">{formatDate(entry.updatedAt ?? entry.createdAt)}</td>
            <td>
              <button
                class="btn btn-ghost btn-sm delete-btn"
                on:click={() => deleteEntry(entry.id)}
                disabled={deleting.has(entry.id)}
                aria-label="Delete {entry.key}"
              >
                {deleting.has(entry.id) ? '…' : '✕'}
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .filter-bar {
    display: flex;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
    flex-wrap: wrap;
  }
  .search-input {
    flex: 1;
    min-width: 200px;
    padding: var(--space-2) var(--space-3);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    font-size: var(--text-sm);
    outline: none;
  }
  .search-input:focus {
    border-color: var(--color-brand);
    box-shadow: 0 0 0 2px rgba(var(--color-brand-rgb, 99,102,241), 0.15);
  }
  .agent-select {
    padding: var(--space-2) var(--space-3);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    font-size: var(--text-sm);
    cursor: pointer;
    outline: none;
  }
  .agent-select:focus { border-color: var(--color-brand); }
  .error-banner {
    background: rgba(224,90,90,0.1);
    border: 1px solid rgba(224,90,90,0.3);
    color: var(--color-danger);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    margin-bottom: var(--space-4);
  }
  .key-cell {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-brand);
  }
  .agent-sub {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    margin-top: 2px;
    font-family: var(--font-mono);
  }
  .value-cell {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .delete-btn {
    color: var(--color-danger);
    border-color: transparent;
    padding: var(--space-1) var(--space-2);
    min-width: 28px;
    justify-content: center;
  }
  .delete-btn:hover { background: rgba(224,90,90,0.1); border-color: rgba(224,90,90,0.3); }
  .deleting-row { opacity: 0.5; pointer-events: none; }
</style>
