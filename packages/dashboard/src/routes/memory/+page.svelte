<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

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
  /** IDs of entries that arrived in the most-recent load (highlighted briefly). */
  let newIds: Set<string> = new Set();
  let newCount = 0; // count of new entries from last SSE-triggered refresh
  /** ID of the entry whose JSON was most recently copied to clipboard (cleared after 2s). */
  let copiedId: string | null = null;

  // Search and filter state
  let searchQuery = '';
  let agentFilter = 'all';
  let typeFilter = 'all';

  // SSE live-update state
  let eventSource: EventSource | null = null;
  let sseConnected = false;
  let sseReconnecting = false;
  let sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastRefreshedAt: Date | null = null;

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

  // Derived: per-type entry counts for the stats bar
  $: typeCounts = entries.reduce<Record<string, number>>((acc, e) => {
    const t = e.type ?? 'unknown';
    acc[t] = (acc[t] ?? 0) + 1;
    return acc;
  }, {});

  async function load(silent = false) {
    if (!silent) loading = true;
    error = null;

    // Snapshot existing IDs so we can detect new arrivals
    const prevIds = new Set(entries.map(e => e.id));

    try {
      const res = await fetch('/api/v5/memory');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as {
        data?: MemoryEntry[];
        agents?: string[];
        types?: string[];
      };
      const fresh = json.data ?? [];
      entries = fresh;
      agents  = json.agents ?? [];
      types   = json.types ?? [];
      lastRefreshedAt = new Date();

      // Compute which entries are genuinely new since the last load
      const arrivals = fresh.filter(e => !prevIds.has(e.id));
      if (arrivals.length > 0 && prevIds.size > 0) {
        newCount = arrivals.length;
        newIds = new Set(arrivals.map(e => e.id));
        // Clear the highlight after the animation completes
        setTimeout(() => { newIds = new Set(); newCount = 0; }, 3500);
      }
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  // ── SSE live-update connection ───────────────────────────────────────────
  function connectSSE() {
    if (eventSource) { eventSource.close(); eventSource = null; }
    sseReconnecting = false;

    const es = new EventSource('/api/v5/stream');
    eventSource = es;

    es.onopen = () => {
      sseConnected = true;
      sseReconnecting = false;
    };

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data as string) as {
          type: string;
          category?: string;
          message?: string;
        };

        // Skip heartbeats
        if (event.type === 'system' && event.message === 'heartbeat') return;

        // Reload memory when a cycle completes (that's when memory is written)
        // or when the server emits a refresh signal
        const shouldRefresh =
          event.type === 'refresh_signal' ||
          (event.type === 'cycle_event' && (
            event.category === 'cycle.complete' ||
            event.category === 'cycle.completed' ||
            event.category === 'cycle.failed'
          ));

        if (shouldRefresh) {
          // Silent refresh — don't show the skeleton, just diff new entries
          load(true);
        }
      } catch { /* ignore malformed events */ }
    };

    es.onerror = () => {
      sseConnected = false;
      sseReconnecting = true;
      es.close();
      eventSource = null;
      // Exponential-ish backoff: reconnect after 5s
      sseReconnectTimer = setTimeout(() => connectSSE(), 5000);
    };
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

  /** Copy the full formatted value to the clipboard and show brief feedback. */
  async function copyValue(entry: MemoryEntry, e: MouseEvent) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(formatValueFull(entry.value));
      copiedId = entry.id;
      setTimeout(() => { copiedId = null; }, 2000);
    } catch { /* clipboard API unavailable in this context */ }
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

  /**
   * Returns an HTML string with JSON tokens wrapped in span elements for
   * syntax highlighting. No external dependencies — pure regex substitution.
   */
  function highlightJSON(v: unknown): string {
    const raw = formatValueFull(v);
    // Escape HTML entities first so we can safely inject spans
    const escaped = raw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return escaped.replace(
      /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      (match) => {
        if (/^"/.test(match)) {
          return `<span class="${/:$/.test(match) ? 'json-key' : 'json-string'}">${match}</span>`;
        }
        if (/^(true|false|null)$/.test(match)) return `<span class="json-keyword">${match}</span>`;
        return `<span class="json-number">${match}</span>`;
      }
    );
  }

  function formatDate(iso?: string): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleString();
  }

  function formatRelative(iso?: string): string {
    if (!iso) return '—';
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return formatDate(iso);
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
   * Badge class and left-border color for a memory entry type.
   * Maps the five canonical types to project colour variables.
   */
  const TYPE_CONFIG: Record<string, { badge: string; color: string; label: string }> = {
    'cycle-outcome':   { badge: 'sonnet',  color: 'var(--color-sonnet)',  label: 'Cycle Outcome'   },
    'gate-verdict':    { badge: 'warning', color: 'var(--color-warning)', label: 'Gate Verdict'    },
    'review-finding':  { badge: 'danger',  color: 'var(--color-danger)',  label: 'Review Finding'  },
    'failure-pattern': { badge: 'opus',    color: 'var(--color-opus)',    label: 'Failure Pattern' },
    'learned-fact':    { badge: 'haiku',   color: 'var(--color-haiku)',   label: 'Learned Fact'    },
    'json':            { badge: 'muted',   color: 'var(--color-text-faint)', label: 'JSON'         },
    'text':            { badge: 'muted',   color: 'var(--color-text-faint)', label: 'Text'         },
  };
  const FALLBACK_CONFIG = { badge: 'muted', color: 'var(--color-text-faint)', label: '' };

  function getTypeConfig(entry: MemoryEntry) {
    return TYPE_CONFIG[entry.type ?? ''] ?? FALLBACK_CONFIG;
  }

  onMount(() => {
    load();
    connectSSE();
  });

  onDestroy(() => {
    if (sseReconnectTimer) clearTimeout(sseReconnectTimer);
    if (eventSource) { eventSource.close(); }
  });
</script>

<svelte:head><title>Memory — AgentForge</title></svelte:head>

<!-- ── Page header ─────────────────────────────────────────────────────── -->
<div class="page-header">
  <div>
    <h1 class="page-title">Memory</h1>
    <p class="page-subtitle">
      {filteredEntries.length}{filteredEntries.length !== entries.length ? ` of ${entries.length}` : ''} entr{filteredEntries.length === 1 ? 'y' : 'ies'}
      {#if lastRefreshedAt}
        · updated {formatRelative(lastRefreshedAt.toISOString())}
      {/if}
    </p>
  </div>
  <div class="header-actions">
    <!-- SSE connection indicator -->
    <span class="sse-indicator" title={sseConnected ? 'Live — refreshes on cycle completion' : sseReconnecting ? 'Reconnecting…' : 'Disconnected'}>
      <span class="sse-dot {sseConnected ? 'live' : sseReconnecting ? 'reconnecting' : 'offline'}"></span>
      <span class="sse-label">{sseConnected ? 'Live' : sseReconnecting ? 'Reconnecting' : 'Offline'}</span>
    </span>
    <button class="btn btn-ghost btn-sm" onclick={() => load()} disabled={loading}>
      {loading ? 'Loading…' : 'Refresh'}
    </button>
  </div>
</div>

<!-- ── New entries banner ──────────────────────────────────────────────── -->
{#if newCount > 0}
  <div class="new-banner" role="status">
    <span class="new-banner__dot"></span>
    {newCount} new {newCount === 1 ? 'entry' : 'entries'} from latest cycle
  </div>
{/if}

<!-- ── Stats bar (unified type filter + counts) ────────────────────────── -->
{#if !loading && entries.length > 0}
  <div class="stats-bar" role="group" aria-label="Filter by memory type">
    <!-- "All" chip — always the first pill -->
    <button
      class="stats-chip stats-chip--all"
      class:stats-chip--active={typeFilter === 'all'}
      style="--chip-color: var(--color-text-muted);"
      onclick={() => typeFilter = 'all'}
      title="Show all types"
      aria-pressed={typeFilter === 'all'}
    >
      <span class="stats-chip__count">{entries.length}</span>
      <span class="stats-chip__label">All</span>
    </button>
    {#each Object.entries(typeCounts) as [type, count] (type)}
      {@const cfg = TYPE_CONFIG[type] ?? FALLBACK_CONFIG}
      <button
        class="stats-chip"
        class:stats-chip--active={typeFilter === type}
        style="--chip-color: {cfg.color};"
        onclick={() => typeFilter = typeFilter === type ? 'all' : type}
        title="Filter by {type}"
        aria-pressed={typeFilter === type}
      >
        <span class="stats-chip__count">{count}</span>
        <span class="stats-chip__label">{cfg.label || type}</span>
      </button>
    {/each}
  </div>
{/if}

<!-- ── Search + agent filter ──────────────────────────────────────────── -->
<div class="filter-bar">
  <div class="search-wrapper">
    <svg class="search-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" stroke-width="1.3"/>
      <path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    </svg>
    <input
      class="search-input"
      type="search"
      placeholder="Search keys, values, tags…"
      bind:value={searchQuery}
      aria-label="Search memory entries"
    />
  </div>
  {#if agents.length > 0}
    <select class="agent-select" bind:value={agentFilter} aria-label="Filter by source">
      <option value="all">All sources</option>
      {#each agents as agent (agent)}
        <option value={agent}>{shortSource(agent)}</option>
      {/each}
    </select>
  {/if}
</div>

{#if deleteError}
  <div class="error-banner">{deleteError}</div>
{/if}

<!-- ── Table ──────────────────────────────────────────────────────────── -->
{#if loading}
  <div class="card" style="padding: 0; overflow: hidden;">
    <table class="data-table">
      <thead>
        <tr><th>Key</th><th>Type</th><th>Value</th><th>Source</th><th>Age</th><th></th></tr>
      </thead>
      <tbody>
        {#each Array(8) as _, i}
          <tr>
            <td><div class="skeleton" style="height: 14px; width: {80 + (i * 17 % 60)}px;"></div></td>
            <td><div class="skeleton" style="height: 18px; width: 90px; border-radius: 4px;"></div></td>
            <td><div class="skeleton" style="height: 14px; width: {160 + (i * 23 % 80)}px;"></div></td>
            <td><div class="skeleton" style="height: 14px; width: 72px;"></div></td>
            <td><div class="skeleton" style="height: 14px; width: 60px;"></div></td>
            <td></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{:else if error}
  <div class="empty-state">
    <span class="empty-icon">⚠</span>
    <p>Failed to load memory.</p>
    <button class="btn btn-ghost btn-sm" style="margin-top: var(--space-3)" onclick={() => load()}>Retry</button>
  </div>
{:else if entries.length === 0}
  <div class="empty-state">
    <span class="empty-icon">◈</span>
    <p>No memory entries yet.</p>
    <p style="font-size: var(--text-xs); color: var(--color-text-faint); margin-top: var(--space-1);">
      Entries appear when cycles complete and write to .agentforge/memory/
    </p>
  </div>
{:else if filteredEntries.length === 0}
  <div class="empty-state">
    <span class="empty-icon">∅</span>
    <p>No entries match your search.</p>
    <button class="btn btn-ghost btn-sm" style="margin-top: var(--space-3)"
      onclick={() => { searchQuery = ''; agentFilter = 'all'; typeFilter = 'all'; }}>
      Clear filters
    </button>
  </div>
{:else}
  <div class="card mem-card">
    <table class="data-table mem-table">
      <thead>
        <tr>
          <th>Key</th>
          <th>Type</th>
          <th>Value</th>
          <th>Source</th>
          <th>Age</th>
          <th style="width: 36px;"></th>
        </tr>
      </thead>
      <tbody>
        {#each filteredEntries as entry (entry.id)}
          {@const cfg = getTypeConfig(entry)}
          {@const isNew = newIds.has(entry.id)}
          {@const isExpanded = expanded.has(entry.id)}
          <tr
            class="mem-row"
            class:mem-row--deleting={deleting.has(entry.id)}
            class:mem-row--expanded={isExpanded}
            class:mem-row--new={isNew}
            style="--row-accent: {cfg.color};"
            onclick={() => toggleExpand(entry.id)}
            role="button"
            tabindex="0"
            onkeydown={(e) => e.key === 'Enter' && toggleExpand(entry.id)}
            aria-expanded={isExpanded}
          >
            <!-- Key column — expand chevron gives visual affordance for the clickable row -->
            <td class="col-key">
              <div class="key-wrap">
                <div class="key-header">
                  <code class="key-cell">{entry.key}</code>
                  <span class="expand-icon" aria-hidden="true">{isExpanded ? '▾' : '▸'}</span>
                </div>
                {#if entry.tags && entry.tags.length > 0}
                  <div class="tag-row">
                    {#each entry.tags as tag (tag)}
                      <span class="tag-chip">{tag}</span>
                    {/each}
                  </div>
                {/if}
              </div>
            </td>

            <!-- Type chip column -->
            <td class="col-type">
              <span class="badge {cfg.badge}">{cfg.label || (entry.type ?? typeof entry.value)}</span>
            </td>

            <!-- Value column — always shows truncated preview; full JSON in detail row below -->
            <td class="col-value">
              <span class="value-preview">{formatValue(entry.value)}</span>
            </td>

            <!-- Source link column — stopPropagation so click doesn't toggle expand -->
            <td class="col-source" onclick={(e) => e.stopPropagation()}>
              {#if entry.source}
                {#if isCycleId(entry.source)}
                  <a
                    class="source-link source-link--cycle"
                    href="/cycles?highlight={entry.source}"
                    title="View cycle {entry.source}"
                  >
                    <span class="source-prefix">cycle</span>
                    {shortSource(entry.source)}
                  </a>
                {:else}
                  <a
                    class="source-link source-link--agent"
                    href="/agents/{encodeURIComponent(entry.source)}"
                    title="View agent {entry.source}"
                  >
                    <span class="source-prefix">agent</span>
                    {entry.source}
                  </a>
                {/if}
              {:else}
                <span class="source-none">—</span>
              {/if}
            </td>

            <!-- Age column -->
            <td class="col-age">
              {formatRelative(entry.updatedAt ?? entry.createdAt)}
            </td>

            <!-- Delete button -->
            <td class="col-delete" onclick={(e) => e.stopPropagation()}>
              <button
                class="delete-btn"
                onclick={() => deleteEntry(entry.id)}
                disabled={deleting.has(entry.id)}
                aria-label="Delete {entry.key}"
              >
                {deleting.has(entry.id) ? '…' : '×'}
              </button>
            </td>
          </tr>

          <!-- Full-width detail row — visible only when expanded ──────────── -->
          {#if isExpanded}
            <tr class="mem-detail-row" style="--row-accent: {cfg.color};">
              <td colspan="6" class="mem-detail-cell">
                <div class="mem-detail">

                  <!-- Metadata strip: id, dates, tags -->
                  <div class="detail-meta">
                    <span class="detail-meta-item">
                      <span class="detail-label">ID</span>
                      <code class="detail-code">{entry.id}</code>
                    </span>
                    {#if entry.createdAt}
                      <span class="detail-meta-item">
                        <span class="detail-label">Created</span>
                        <time datetime={entry.createdAt}>{formatDate(entry.createdAt)}</time>
                      </span>
                    {/if}
                    {#if entry.updatedAt && entry.updatedAt !== entry.createdAt}
                      <span class="detail-meta-item">
                        <span class="detail-label">Updated</span>
                        <time datetime={entry.updatedAt}>{formatDate(entry.updatedAt)}</time>
                      </span>
                    {/if}
                    {#if entry.source}
                      <span class="detail-meta-item">
                        <span class="detail-label">Source</span>
                        {#if isCycleId(entry.source)}
                          <a class="source-link source-link--cycle" href="/cycles?highlight={entry.source}" title="View cycle {entry.source}">
                            <span class="source-prefix">cycle</span>{shortSource(entry.source)}
                          </a>
                        {:else}
                          <a class="source-link source-link--agent" href="/agents/{encodeURIComponent(entry.source)}" title="View agent {entry.source}">
                            <span class="source-prefix">agent</span>{entry.source}
                          </a>
                        {/if}
                      </span>
                    {/if}
                  </div>

                  <!-- Summary line (when present) -->
                  {#if entry.summary}
                    <p class="detail-summary">{entry.summary}</p>
                  {/if}

                  <!-- Full value JSON with syntax highlighting + copy button -->
                  <div class="detail-value-wrap">
                    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                    <pre class="value-expanded"><code>{@html highlightJSON(entry.value)}</code></pre>
                    <button
                      class="copy-btn"
                      onclick={(e) => copyValue(entry, e)}
                      aria-label="Copy JSON value for {entry.key}"
                    >{copiedId === entry.id ? '✓ Copied' : 'Copy'}</button>
                  </div>

                </div>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  /* ── Header ──────────────────────────────────────────────────────────────── */
  .header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .sse-indicator {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    cursor: default;
  }
  .sse-dot {
    width: 7px;
    height: 7px;
    border-radius: var(--radius-full);
    flex-shrink: 0;
  }
  .sse-dot.live {
    background: var(--color-success);
    box-shadow: 0 0 5px var(--color-success);
    animation: mem-pulse 2s ease-in-out infinite;
  }
  .sse-dot.reconnecting {
    background: var(--color-warning);
    animation: mem-blink 1s step-end infinite;
  }
  .sse-dot.offline {
    background: var(--color-danger);
  }
  .sse-label {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
  }

  @keyframes mem-pulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 4px var(--color-success); }
    50%       { opacity: 0.6; box-shadow: 0 0 8px var(--color-success); }
  }
  @keyframes mem-blink {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.2; }
  }

  /* ── New entries banner ───────────────────────────────────────────────────── */
  .new-banner {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    background: rgba(76, 175, 130, 0.08);
    border: 1px solid rgba(76, 175, 130, 0.25);
    border-radius: var(--radius-md);
    font-size: var(--text-xs);
    color: var(--color-haiku);
    margin-bottom: var(--space-3);
    animation: slideIn 0.25s ease;
  }
  .new-banner__dot {
    width: 6px;
    height: 6px;
    border-radius: var(--radius-full);
    background: var(--color-haiku);
    flex-shrink: 0;
  }

  @keyframes slideIn {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  /* ── Stats bar ────────────────────────────────────────────────────────────── */
  .stats-bar {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
    margin-bottom: var(--space-3);
  }
  .stats-chip {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    border: 1px solid color-mix(in srgb, var(--chip-color) 30%, transparent);
    background: color-mix(in srgb, var(--chip-color) 6%, transparent);
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .stats-chip:hover {
    background: color-mix(in srgb, var(--chip-color) 12%, transparent);
    border-color: color-mix(in srgb, var(--chip-color) 50%, transparent);
  }
  .stats-chip--active {
    background: color-mix(in srgb, var(--chip-color) 18%, transparent);
    border-color: var(--chip-color);
  }
  .stats-chip__count {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 700;
    color: var(--chip-color);
  }
  .stats-chip__label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    white-space: nowrap;
  }

  /* ── Filter bar ───────────────────────────────────────────────────────────── */
  .filter-bar {
    display: flex;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
    flex-wrap: wrap;
  }
  .search-wrapper {
    flex: 1;
    min-width: 200px;
    position: relative;
    display: flex;
    align-items: center;
  }
  .search-icon {
    position: absolute;
    left: var(--space-3);
    width: 14px;
    height: 14px;
    color: var(--color-text-faint);
    pointer-events: none;
    flex-shrink: 0;
  }
  .search-input {
    width: 100%;
    padding: var(--space-2) var(--space-3) var(--space-2) calc(var(--space-3) + 14px + var(--space-2));
    background: var(--color-surface-1);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    font-size: var(--text-sm);
    outline: none;
    transition: border-color 0.15s;
  }
  .search-input:focus {
    border-color: var(--color-brand);
    box-shadow: 0 0 0 2px rgba(91,138,245,0.12);
  }
  .agent-select {
    padding: var(--space-2) var(--space-3);
    background: var(--color-surface-1);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    font-size: var(--text-sm);
    cursor: pointer;
    outline: none;
    transition: border-color 0.15s;
  }
  .agent-select:focus { border-color: var(--color-brand); }

  /* ── Error banner ─────────────────────────────────────────────────────────── */
  .error-banner {
    background: rgba(224,90,90,0.08);
    border: 1px solid rgba(224,90,90,0.25);
    color: var(--color-danger);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    margin-bottom: var(--space-4);
  }

  /* ── Empty states ─────────────────────────────────────────────────────────── */
  .empty-icon {
    font-size: 28px;
    opacity: 0.25;
    margin-bottom: var(--space-2);
    display: block;
  }

  /* ── Memory table card ────────────────────────────────────────────────────── */
  .mem-card {
    padding: 0;
    overflow: hidden;
  }
  /* Remove global card hover transform for the table card */
  .mem-card:hover {
    transform: none;
    box-shadow: none;
  }

  .mem-table { table-layout: auto; }

  /* ── Memory rows — type-accented left border ─────────────────────────────── */
  .mem-row {
    border-left: 2px solid transparent;
    cursor: pointer;
    transition: background 0.12s, border-left-color 0.12s;
  }
  .mem-row:hover {
    background: var(--color-bg-card-hover);
    border-left-color: var(--row-accent);
  }
  .mem-row--expanded {
    background: rgba(255,255,255,0.02);
    border-left-color: var(--row-accent);
  }
  .mem-row--deleting {
    opacity: 0.45;
    pointer-events: none;
  }
  /* New entries: brief glow animation */
  .mem-row--new {
    animation: rowHighlight 3s ease-out forwards;
  }
  @keyframes rowHighlight {
    0%   { background: color-mix(in srgb, var(--row-accent) 12%, transparent); }
    40%  { background: color-mix(in srgb, var(--row-accent) 8%, transparent); }
    100% { background: transparent; }
  }

  /* ── Column widths ───────────────────────────────────────────────────────── */
  .col-key   { width: 18%; vertical-align: top; padding-top: var(--space-3); }
  .col-type  { width: 14%; white-space: nowrap; vertical-align: top; padding-top: var(--space-3); }
  .col-value { width: 40%; vertical-align: top; padding-top: var(--space-3); }
  .col-source{ width: 14%; white-space: nowrap; vertical-align: top; padding-top: var(--space-3); }
  .col-age   {
    width: 10%;
    white-space: nowrap;
    vertical-align: top;
    padding-top: var(--space-3);
    color: var(--color-text-faint);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
  .col-delete{ width: 36px; vertical-align: top; padding-top: var(--space-2); }

  /* ── Key cell ────────────────────────────────────────────────────────────── */
  .key-wrap { display: flex; flex-direction: column; gap: 3px; }
  .key-cell {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-brand);
    word-break: break-all;
  }
  .tag-row { display: flex; flex-wrap: wrap; gap: 3px; }
  .tag-chip {
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 999px;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    color: var(--color-text-faint);
    white-space: nowrap;
    letter-spacing: 0.02em;
  }

  /* ── Value cell ──────────────────────────────────────────────────────────── */
  .value-preview {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 360px;
  }
  .value-expanded {
    white-space: pre-wrap;
    word-break: break-word;
    max-width: 480px;
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.65;
    color: var(--color-text);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: var(--space-3) var(--space-4);
    overflow: auto;
    max-height: 240px;
  }

  /* ── Source link ─────────────────────────────────────────────────────────── */
  .source-link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    text-decoration: none;
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    transition: background 0.12s, border-color 0.12s;
  }
  .source-prefix {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    opacity: 0.6;
  }
  .source-link--cycle {
    color: var(--color-sonnet);
    border-color: rgba(74,158,255,0.2);
    background: rgba(74,158,255,0.06);
  }
  .source-link--cycle:hover {
    border-color: rgba(74,158,255,0.4);
    background: rgba(74,158,255,0.12);
  }
  .source-link--agent {
    color: var(--color-haiku);
    border-color: rgba(76,175,130,0.2);
    background: rgba(76,175,130,0.06);
  }
  .source-link--agent:hover {
    border-color: rgba(76,175,130,0.4);
    background: rgba(76,175,130,0.12);
  }
  .source-none { color: var(--color-text-faint); }

  /* ── Delete button ───────────────────────────────────────────────────────── */
  .delete-btn {
    background: transparent;
    border: none;
    color: var(--color-text-faint);
    font-size: var(--text-base);
    cursor: pointer;
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    line-height: 1;
    transition: color 0.12s, background 0.12s;
  }
  .delete-btn:hover {
    color: var(--color-danger);
    background: rgba(224,90,90,0.08);
  }
  .delete-btn:disabled { opacity: 0.4; cursor: default; }

  /* ── Expand chevron in key column ───────────────────────────────────────── */
  .key-header {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }
  .expand-icon {
    font-size: 10px;
    color: var(--color-text-faint);
    flex-shrink: 0;
    transition: color 0.12s;
  }
  .mem-row:hover .expand-icon,
  .mem-row--expanded .expand-icon {
    color: var(--color-text-muted);
  }

  /* ── Detail row (full-width expanded content) ────────────────────────────── */
  .mem-detail-row {
    background: var(--color-surface-1);
    border-left: 3px solid var(--row-accent);
    /* Override global tbody tr:hover cursor — detail rows are not clickable */
    cursor: default !important;
  }
  .mem-detail-row:hover {
    background: var(--color-surface-1) !important;
  }
  .mem-detail-cell {
    padding: 0 !important;
  }
  .mem-detail {
    padding: var(--space-3) var(--space-4) var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    border-top: 1px solid var(--color-border);
    border-bottom: 1px solid var(--color-border);
  }

  /* ── Detail metadata strip ───────────────────────────────────────────────── */
  .detail-meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-5);
    align-items: center;
  }
  .detail-meta-item {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }
  .detail-label {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-faint);
    flex-shrink: 0;
  }
  .detail-code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    background: var(--color-surface-2);
    padding: 1px 5px;
    border-radius: var(--radius-sm);
  }

  /* ── Detail value block with copy button ─────────────────────────────────── */
  .detail-value-wrap {
    position: relative;
  }
  .detail-value-wrap .value-expanded {
    max-width: 100%;
    margin: 0;
    padding-right: var(--space-12, 3rem); /* room for copy button */
  }
  .copy-btn {
    position: absolute;
    top: var(--space-2);
    right: var(--space-2);
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    color: var(--color-text-muted);
    font-size: var(--text-xs);
    padding: 2px var(--space-2);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
    white-space: nowrap;
  }
  .copy-btn:hover {
    background: var(--color-surface-1);
    border-color: var(--color-brand);
    color: var(--color-brand);
  }

  /* ── JSON syntax highlighting ────────────────────────────────────────────── */
  .value-expanded code {
    /* Inherit font/size from the enclosing pre; reset defaults */
    font: inherit;
    background: none;
    padding: 0;
    border: none;
    display: block;
  }
  .value-expanded :global(.json-key)     { color: var(--color-brand); }
  .value-expanded :global(.json-string)  { color: var(--color-haiku); }
  .value-expanded :global(.json-number)  { color: var(--color-opus); }
  .value-expanded :global(.json-keyword) { color: var(--color-warning); }

  /* ── Summary line in expanded detail ────────────────────────────────────── */
  .detail-summary {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    line-height: 1.55;
    padding: var(--space-2) var(--space-3);
    background: var(--color-surface-2);
    border-left: 2px solid var(--color-border-strong);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    font-style: italic;
  }

  /* ── Stats-bar "All" chip variant ────────────────────────────────────────── */
  .stats-chip--all {
    border-style: dashed;
  }
  .stats-chip--all.stats-chip--active {
    border-style: solid;
    border-color: var(--color-text-muted);
    background: color-mix(in srgb, var(--color-text-muted) 10%, transparent);
  }

  /* ── Reduced motion ──────────────────────────────────────────────────────── */
  @media (prefers-reduced-motion: reduce) {
    .sse-dot.live { animation: none; }
    .sse-dot.reconnecting { animation: none; }
    .mem-row--new { animation: none; }
    .new-banner { animation: none; }
  }

  /* ── Mobile ──────────────────────────────────────────────────────────────── */
  @media (max-width: 768px) {
    .col-source { display: none; }
    .col-age    { display: none; }
    .value-preview { max-width: 200px; }
    .value-expanded { max-width: 100%; }
    .stats-bar  { display: none; }
    .detail-meta { flex-direction: column; gap: var(--space-1); }
    .copy-btn { position: static; margin-top: var(--space-2); }
    .detail-value-wrap .value-expanded { padding-right: var(--space-3); }
  }
</style>
