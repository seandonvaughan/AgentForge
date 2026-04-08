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
    /** Original cycleId or agentId from the JSONL source field. */
    source?: string;
    summary?: string;
    tags?: string[];
  }

  let entries: MemoryEntry[] = [];
  let agents: string[] = [];
  let types: string[] = [];
  let loading = true;
  let error: string | null = null;
  let deleting: Set<string> = new Set();
  let deleteError: string | null = null;
  /** IDs of rows currently expanded to show full JSON value. */
  let expanded: Set<string> = new Set();

  // Search and filter state
  let searchQuery = '';
  let agentFilter = 'all';
  let typeFilter = 'all';

  // Derived: entries after client-side search + agent + type filter
  $: filteredEntries = entries.filter(e => {
    const matchesSearch = searchQuery.trim() === '' || [
      e.key,
      typeof e.value === 'string' ? e.value : JSON.stringify(e.value),
      e.summary ?? '',
      (e.tags ?? []).join(' '),
    ].join(' ').toLowerCase().includes(searchQuery.trim().toLowerCase());

    const matchesAgent = agentFilter === 'all' || e.agentId === agentFilter;
    const matchesType  = typeFilter  === 'all' || e.type === typeFilter;

    return matchesSearch && matchesAgent && matchesType;
  });

  async function load() {
    loading = true;
    error = null;
    try {
      const res = await fetch('/api/v5/memory');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as {
        data?: MemoryEntry[];
        agents?: string[];
        types?: string[];
      };
      entries = json.data ?? [];
      agents  = json.agents ?? [];
      types   = json.types ?? [];
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
      expanded = new Set([...expanded].filter(x => x !== id));
    } catch (e) {
      deleteError = `Failed to delete: ${e}`;
    } finally {
      deleting = new Set([...deleting].filter(x => x !== id));
    }
  }

  function toggleExpand(id: string) {
    if (expanded.has(id)) {
      expanded = new Set([...expanded].filter(x => x !== id));
    } else {
      expanded = new Set([...expanded, id]);
    }
  }

  function formatValue(v: unknown): string {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'string') return v.length > 120 ? v.slice(0, 118) + '…' : v;
    return JSON.stringify(v).slice(0, 120);
  }

  function formatValueFull(v: unknown): string {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
  }

  function formatDate(iso?: string): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleString();
  }

  /** Determines whether a source string looks like a UUID cycle ID. */
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function isCycleId(s?: string): boolean {
    return !!s && UUID_RE.test(s);
  }

  /** Short identifier for display (first 8 chars of a UUID, else full). */
  function shortSource(s?: string): string {
    if (!s) return '';
    return UUID_RE.test(s) ? s.slice(0, 8) : s;
  }

  /**
   * Badge class for a memory entry type.
   * Maps the five canonical types to project colour variables, falling back
   * to "muted" for unknown / legacy entries.
   */
  const TYPE_BADGE: Record<string, string> = {
    'cycle-outcome':  'sonnet',    // blue   — cycle completion records
    'gate-verdict':   'warning',   // orange — pass/fail gate decisions
    'review-finding': 'danger',    // red    — code review issues
    'failure-pattern':'opus',      // gold   — recurring error patterns
    'learned-fact':   'haiku',     // green  — distilled knowledge
  };

  function typeBadgeClass(entry: MemoryEntry): string {
    return TYPE_BADGE[entry.type ?? ''] ?? 'muted';
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
  <button class="btn btn-ghost btn-sm" onclick={load} disabled={loading}>
    {loading ? 'Loading…' : 'Refresh'}
  </button>
</div>

<!-- Type filter chips -->
{#if types.length > 0}
  <div class="type-chips">
    <button
      class="chip {typeFilter === 'all' ? 'active' : ''}"
      onclick={() => typeFilter = 'all'}
    >All</button>
    {#each types as t}
      <button
        class="chip {typeFilter === t ? 'active' : ''} chip-{TYPE_BADGE[t] ?? 'muted'}"
        onclick={() => typeFilter = typeFilter === t ? 'all' : t}
      >{t}</button>
    {/each}
  </div>
{/if}

<!-- Search + agent filter -->
<div class="filter-bar">
  <input
    class="search-input"
    type="search"
    placeholder="Search keys, values, tags…"
    bind:value={searchQuery}
    aria-label="Search memory entries"
  />
  {#if agents.length > 0}
    <select class="agent-select" bind:value={agentFilter} aria-label="Filter by source">
      <option value="all">All sources</option>
      {#each agents as agent}
        <option value={agent}>{shortSource(agent)}</option>
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
        <tr><th>Key</th><th>Type</th><th>Value</th><th>Source</th><th>Updated</th><th></th></tr>
      </thead>
      <tbody>
        {#each Array(8) as _}
          <tr>
            <td><div class="skeleton" style="height: 14px; width: 120px;"></div></td>
            <td><div class="skeleton" style="height: 14px; width: 80px;"></div></td>
            <td><div class="skeleton" style="height: 14px; width: 200px;"></div></td>
            <td><div class="skeleton" style="height: 14px; width: 80px;"></div></td>
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
    <button class="btn btn-ghost btn-sm" style="margin-top: var(--space-3)" onclick={load}>Retry</button>
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
          <th>Source</th>
          <th>Updated</th>
          <th style="width: 64px;"></th>
        </tr>
      </thead>
      <tbody>
        {#each filteredEntries as entry (entry.id)}
          <tr
            class:deleting-row={deleting.has(entry.id)}
            class:expanded-row={expanded.has(entry.id)}
            onclick={() => toggleExpand(entry.id)}
            style="cursor: pointer;"
            role="button"
            tabindex="0"
            onkeydown={(e) => e.key === 'Enter' && toggleExpand(entry.id)}
            aria-expanded={expanded.has(entry.id)}
          >
            <td>
              <code class="key-cell">{entry.key}</code>
              {#if entry.tags && entry.tags.length > 0}
                <div class="tag-row">
                  {#each entry.tags as tag}
                    <span class="tag-chip">{tag}</span>
                  {/each}
                </div>
              {/if}
            </td>
            <td>
              <span class="badge {typeBadgeClass(entry)}">{entry.type ?? typeof entry.value}</span>
            </td>
            <td class="value-cell">
              {#if expanded.has(entry.id)}
                <pre class="value-expanded">{formatValueFull(entry.value)}</pre>
              {:else}
                {formatValue(entry.value)}
              {/if}
            </td>
            <td class="source-cell" onclick={(e) => e.stopPropagation()}>
              {#if entry.source}
                {#if isCycleId(entry.source)}
                  <a
                    class="source-link"
                    href="/cycles?highlight={entry.source}"
                    title="View cycle {entry.source}"
                  >{shortSource(entry.source)}</a>
                {:else}
                  <a
                    class="source-link agent-link"
                    href="/agents/{encodeURIComponent(entry.source)}"
                    title="View agent {entry.source}"
                  >{entry.source}</a>
                {/if}
              {:else}
                <span style="color: var(--color-text-faint);">—</span>
              {/if}
            </td>
            <td style="color: var(--color-text-muted); white-space: nowrap; font-size: var(--text-xs);">
              {formatDate(entry.updatedAt ?? entry.createdAt)}
            </td>
            <td onclick={(e) => e.stopPropagation()}>
              <button
                class="btn btn-ghost btn-sm delete-btn"
                onclick={() => deleteEntry(entry.id)}
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
  /* ── Type filter chips ── */
  .type-chips {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
    margin-bottom: var(--space-3);
  }
  .chip {
    padding: var(--space-1) var(--space-3);
    border-radius: 999px;
    border: 1px solid var(--color-border);
    background: transparent;
    color: var(--color-text-muted);
    font-size: var(--text-xs);
    cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
    white-space: nowrap;
  }
  .chip:hover { background: var(--color-surface-hover, rgba(255,255,255,0.05)); }
  .chip.active {
    background: var(--color-brand);
    border-color: var(--color-brand);
    color: #fff;
  }
  /* Per-type active colouring so non-active chips still hint at their colour */
  .chip-sonnet  { border-color: rgba(74,158,255,0.35);  color: var(--color-sonnet);  }
  .chip-warning { border-color: rgba(245,166,35,0.35);  color: var(--color-warning); }
  .chip-danger  { border-color: rgba(224,90,90,0.35);   color: var(--color-danger);  }
  .chip-opus    { border-color: rgba(245,200,66,0.35);  color: var(--color-opus);    }
  .chip-haiku   { border-color: rgba(76,175,130,0.35);  color: var(--color-haiku);   }
  .chip-sonnet.active  { background: var(--color-sonnet);  border-color: var(--color-sonnet);  color: #fff; }
  .chip-warning.active { background: var(--color-warning); border-color: var(--color-warning); color: #fff; }
  .chip-danger.active  { background: var(--color-danger);  border-color: var(--color-danger);  color: #fff; }
  .chip-opus.active    { background: var(--color-opus);    border-color: var(--color-opus);    color: #000; }
  .chip-haiku.active   { background: var(--color-haiku);   border-color: var(--color-haiku);   color: #fff; }

  /* ── Search / agent filter bar ── */
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

  /* ── Error banner ── */
  .error-banner {
    background: rgba(224,90,90,0.1);
    border: 1px solid rgba(224,90,90,0.3);
    color: var(--color-danger);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    margin-bottom: var(--space-4);
  }

  /* ── Table cells ── */
  .key-cell {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-brand);
    word-break: break-all;
  }
  .tag-row {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    margin-top: 3px;
  }
  .tag-chip {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 999px;
    background: var(--color-surface-raised, rgba(255,255,255,0.06));
    border: 1px solid var(--color-border);
    color: var(--color-text-faint);
    white-space: nowrap;
  }
  .value-cell {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    max-width: 280px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .value-expanded {
    white-space: pre-wrap;
    word-break: break-word;
    max-width: 400px;
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-text);
    background: var(--color-surface-raised, rgba(255,255,255,0.04));
    border-radius: var(--radius-sm);
    padding: var(--space-2);
    overflow: auto;
    max-height: 200px;
  }
  .source-cell { white-space: nowrap; }
  .source-link {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-brand);
    text-decoration: none;
    border-bottom: 1px dotted var(--color-brand);
  }
  .source-link:hover { border-bottom-style: solid; }
  .agent-link { color: var(--color-haiku); border-bottom-color: var(--color-haiku); }

  /* ── Row states ── */
  .expanded-row td { background: rgba(255,255,255,0.02); }
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
