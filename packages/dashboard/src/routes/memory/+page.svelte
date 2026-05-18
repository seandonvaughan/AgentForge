<script lang="ts">
  /**
   * /memory — v2 design rebuild: filterable knowledge browser.
   *
   * Sections:
   *   1. Page header
   *   2. KPI tiles: counts by kind
   *   3. Filter bar: kind chips, source select, date range, full-text search
   *   4. Entry list with Badge + hit count + timestamp
   *   5. Detail pane on the right (shows full value, markdown-rendered when possible)
   *
   * Data:
   *   SSR seed from +page.server.ts
   *   GET /api/v5/memory?kind=&search=&since=&limit= (client refresh)
   */
  import { onMount, onDestroy } from 'svelte';
  import { Btn, Badge, Card, KpiTile } from '$lib/components/v2';
  import { withWorkspace } from '$lib/stores/workspace';
  import type { PageData } from './$types';
  import type { MemoryEntrySSR } from './+page.server';

  let { data }: { data: PageData } = $props();

  // ── State ────────────────────────────────────────────────────────────────────

  let entries: MemoryEntrySSR[] = $state((data.entries ?? []) as MemoryEntrySSR[]);
  let agents: string[] = $state(data.agents ?? []);
  let types: string[] = $state(data.types ?? []);
  let loading = $state(entries.length === 0);
  let error: string | null = $state(null);

  // Filter state
  let searchQuery = $state('');
  let kindFilter = $state('all');
  let agentFilter = $state('all');
  let sinceFilter = $state('');

  // Detail pane
  let selectedEntry: MemoryEntrySSR | null = $state(null);

  let pollHandle: ReturnType<typeof setInterval> | null = null;
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;

  // Kind → prototype mapping (for display + filter chips)
  const KIND_VARIANTS: Record<string, 'success' | 'danger' | 'info' | 'warning' | 'purple' | 'muted'> = {
    pattern:           'purple',
    failure:           'danger',
    'failure-pattern': 'danger',
    decision:          'info',
    metric:            'warning',
    finding:           'success',
    'review-finding':  'success',
    verdict:           'success',
    'gate-verdict':    'success',
    'cycle-outcome':   'muted',
    'learned-fact':    'purple',
  };

  function badgeVariant(type: string | undefined): 'success' | 'danger' | 'info' | 'warning' | 'purple' | 'muted' {
    return KIND_VARIANTS[type ?? ''] ?? 'muted';
  }

  // Canonical kinds for the filter bar
  const FILTER_KINDS = ['pattern', 'failure', 'decision', 'metric', 'finding', 'verdict'];

  // ── Data loading ──────────────────────────────────────────────────────────────

  async function loadEntries(silent = false): Promise<void> {
    if (!silent) loading = true;
    error = null;
    try {
      const params = new URLSearchParams();
      if (kindFilter !== 'all') params.set('type', kindFilter);
      if (searchQuery.trim()) params.set('search', searchQuery.trim().toLowerCase());
      if (sinceFilter) params.set('since', sinceFilter);
      params.set('limit', '200');
      const qs = params.toString() ? `?${params.toString()}` : '';
      const res = await fetch(withWorkspace(`/api/v5/memory${qs}`));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as {
        data?: MemoryEntrySSR[];
        entries?: MemoryEntrySSR[];
        agents?: string[];
        types?: string[];
        meta?: { total?: number };
      };
      entries = (json.data ?? json.entries ?? []) as MemoryEntrySSR[];
      if (json.agents) agents = json.agents;
      if (json.types) types = json.types;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load memory entries';
    } finally {
      loading = false;
    }
  }

  function onSearchInput(): void {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => void loadEntries(true), 350);
  }

  function setKind(k: string): void {
    kindFilter = k;
    void loadEntries(true);
  }

  function setAgent(v: string): void {
    agentFilter = v;
    void loadEntries(true);
  }

  onMount(() => {
    void loadEntries();
    pollHandle = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void loadEntries(true);
    }, 30_000);
  });
  onDestroy(() => {
    if (pollHandle) clearInterval(pollHandle);
    if (searchDebounce) clearTimeout(searchDebounce);
  });

  // ── Derived ──────────────────────────────────────────────────────────────────

  // Client-side filter (fast path — server already applied heavy filters)
  const filteredEntries = $derived(entries.filter(e => {
    const haystack = [
      e.key,
      typeof e.value === 'string' ? e.value : JSON.stringify(e.value),
      e.summary ?? '',
      (e.tags ?? []).join(' '),
    ].join(' ').toLowerCase();

    const matchSearch = !searchQuery.trim() || haystack.includes(searchQuery.trim().toLowerCase());
    const matchAgent = agentFilter === 'all' || e.agentId === agentFilter || e.source === agentFilter;
    return matchSearch && matchAgent;
  }));

  // KPI counts from full entries (before client filter)
  const kindCounts = $derived(FILTER_KINDS.reduce<Record<string, number>>((acc, k) => {
    acc[k] = entries.filter(e => {
      const t = e.type ?? '';
      return t === k || t.includes(k);
    }).length;
    return acc;
  }, {}));

  function fmtRel(ts: string | undefined): string {
    if (!ts) return '—';
    const d = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
    if (d < 60) return `${d}s ago`;
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
  }

  function displayValue(e: MemoryEntrySSR): string {
    if (e.summary) return e.summary;
    if (typeof e.value === 'string' && e.value.length > 0) {
      // Try to pretty-print JSON
      try {
        const parsed = JSON.parse(e.value);
        return JSON.stringify(parsed, null, 2);
      } catch {
        return e.value;
      }
    }
    return '(no content)';
  }

  function kindColor(type: string | undefined): string {
    const t = type ?? '';
    if (t.includes('failure') || t === 'failure') return 'var(--af-danger)';
    if (t.includes('decision') || t === 'decision') return 'var(--af-accent2)';
    if (t.includes('metric') || t === 'metric') return 'var(--af-warning)';
    if (t.includes('verdict') || t.includes('finding') || t === 'pattern') return 'var(--af-success)';
    return 'var(--af-purple)';
  }
</script>

<svelte:head><title>Memory — AgentForge</title></svelte:head>

<!-- ── Page header ────────────────────────────────────────────────────────────── -->
<header class="mem-header">
  <div class="mem-crumbs font-mono">Workspace · Memory</div>
  <div class="mem-headline-row">
    <div>
      <h1 class="mem-title">Memory</h1>
      <p class="mem-subtitle">
        Learned patterns, failure modes, and decisions ·
        <span class="font-mono">{entries.length}</span> entries loaded
      </p>
    </div>
    <div class="mem-actions">
      <Btn size="sm" onClick={() => void loadEntries()}>Refresh</Btn>
    </div>
  </div>
</header>

<!-- ── KPI tiles ──────────────────────────────────────────────────────────────── -->
<div class="kpi-grid">
  <KpiTile
    label="Total"
    value={entries.length}
    color="var(--af-text)"
  />
  <KpiTile
    label="Patterns"
    value={kindCounts['pattern'] ?? 0}
    color="var(--af-purple)"
  />
  <KpiTile
    label="Failures"
    value={kindCounts['failure'] ?? 0}
    color="var(--af-danger)"
  />
  <KpiTile
    label="Decisions"
    value={kindCounts['decision'] ?? 0}
    color="var(--af-accent2)"
  />
  <KpiTile
    label="Verdicts"
    value={kindCounts['verdict'] ?? 0}
    color="var(--af-success)"
  />
</div>

<!-- ── Filter bar ─────────────────────────────────────────────────────────────── -->
<div class="filter-bar">
  <!-- Search -->
  <div class="search-wrap">
    <span class="search-icon">⌕</span>
    <input
      class="search-input font-mono"
      type="text"
      placeholder="Search memory…"
      bind:value={searchQuery}
      oninput={onSearchInput}
    />
  </div>

  <!-- Kind chips -->
  <span class="filter-label">KIND</span>
  <button
    class="kind-chip font-mono"
    class:kind-chip-active={kindFilter === 'all'}
    onclick={() => setKind('all')}
  >all</button>
  {#each FILTER_KINDS as k}
    <button
      class="kind-chip font-mono"
      class:kind-chip-active={kindFilter === k}
      style="--chip-color:{kindColor(k)}"
      onclick={() => setKind(k)}
    >{k}</button>
  {/each}

  <!-- Agent select -->
  {#if agents.length > 0}
    <select
      class="agent-select font-mono"
      value={agentFilter}
      onchange={(e) => setAgent((e.target as HTMLSelectElement).value)}
    >
      <option value="all">All sources</option>
      {#each agents as ag}
        <option value={ag}>{ag}</option>
      {/each}
    </select>
  {/if}

  <!-- Date range -->
  <input
    class="date-input font-mono"
    type="date"
    title="Show entries since…"
    bind:value={sinceFilter}
    onchange={() => void loadEntries(true)}
  />

  <span class="filter-count font-mono">{filteredEntries.length} of {entries.length}</span>
</div>

<!-- ── Main content ───────────────────────────────────────────────────────────── -->
{#if loading}
  <div class="entry-list">
    {#each Array(5) as _}
      <div class="skeleton" style="height:72px;border-radius:8px;"></div>
    {/each}
  </div>

{:else if error}
  <div class="error-banner">
    {error}
    <Btn size="sm" onClick={() => void loadEntries()} style="margin-left:12px">Retry</Btn>
  </div>

{:else}
  <div class="content-layout">
    <!-- ── Entry list ──────────────────────────────────────────────────────────── -->
    <div class="entry-list">
      {#if filteredEntries.length === 0}
        <div class="empty-state">
          {#if searchQuery || kindFilter !== 'all'}
            No entries match the current filters.
          {:else}
            No memory entries yet — run some cycles to populate the knowledge base.
          {/if}
        </div>
      {:else}
        {#each filteredEntries as entry (entry.id)}
          <button
            class="entry-card"
            class:entry-card-active={selectedEntry?.id === entry.id}
            style="border-left-color:{kindColor(entry.type)}"
            onclick={() => { selectedEntry = selectedEntry?.id === entry.id ? null : entry; }}
          >
            <div class="entry-card-head">
              <div class="entry-card-meta">
                <Badge variant={badgeVariant(entry.type)}>{entry.type ?? 'memory'}</Badge>
                {#if entry.source}
                  <span class="font-mono entry-source">from {entry.source.slice(0, 24)}</span>
                {/if}
              </div>
              <div class="entry-card-right">
                <span class="font-mono entry-time">{fmtRel(entry.createdAt)}</span>
              </div>
            </div>
            <div class="entry-card-body">
              {entry.summary ?? (typeof entry.value === 'string' ? entry.value.slice(0, 180) : '')}
            </div>
            {#if entry.tags && entry.tags.length > 0}
              <div class="entry-tags">
                {#each entry.tags.slice(0, 4) as tag}
                  <span class="tag font-mono">{tag}</span>
                {/each}
              </div>
            {/if}
          </button>
        {/each}
      {/if}
    </div>

    <!-- ── Detail pane ─────────────────────────────────────────────────────────── -->
    {#if selectedEntry}
      <div class="detail-pane">
        <Card>
          <div class="detail-head">
            <Badge variant={badgeVariant(selectedEntry.type)}>{selectedEntry.type ?? 'memory'}</Badge>
            <button class="detail-close" onclick={() => { selectedEntry = null; }} aria-label="Close detail">✕</button>
          </div>
          <div class="detail-key font-mono">{selectedEntry.key}</div>
          {#if selectedEntry.source}
            <div class="detail-meta font-mono">
              Source: {selectedEntry.source}
              {#if selectedEntry.createdAt}
                · {new Date(selectedEntry.createdAt).toLocaleString()}
              {/if}
            </div>
          {/if}
          {#if selectedEntry.tags && selectedEntry.tags.length > 0}
            <div class="detail-tags">
              {#each selectedEntry.tags as tag}
                <span class="tag font-mono">{tag}</span>
              {/each}
            </div>
          {/if}
          <div class="detail-value-wrap">
            <pre class="detail-value font-mono">{displayValue(selectedEntry)}</pre>
          </div>
          {#if selectedEntry.metadata && Object.keys(selectedEntry.metadata).length > 0}
            <details class="detail-meta-block">
              <summary class="font-mono">Metadata</summary>
              <pre class="detail-value font-mono">{JSON.stringify(selectedEntry.metadata, null, 2)}</pre>
            </details>
          {/if}
        </Card>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* ── Page header ─────────────────────────────────────────────────────────────── */
  .mem-header {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 14px;
  }
  .mem-crumbs {
    font-size: 11px;
    color: var(--af-dim);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .mem-headline-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .mem-title {
    margin: 0;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--af-text);
  }
  .mem-subtitle {
    font-size: 12px;
    color: var(--af-muted);
    margin: 2px 0 0;
  }
  .mem-actions { display: flex; align-items: center; gap: 8px; }

  /* ── KPI grid ────────────────────────────────────────────────────────────────── */
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 10px;
    margin-bottom: 14px;
  }
  @media (max-width: 900px) { .kpi-grid { grid-template-columns: repeat(3, 1fr); } }

  /* ── Filter bar ──────────────────────────────────────────────────────────────── */
  .filter-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 12px;
    padding: 10px 12px;
    background: var(--af-surface);
    border: 1px solid var(--af-border);
    border-radius: 8px;
  }
  .search-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }
  .search-icon {
    position: absolute;
    left: 8px;
    font-size: 14px;
    color: var(--af-dim);
    pointer-events: none;
  }
  .search-input {
    padding: 6px 8px 6px 26px;
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    color: var(--af-text);
    font-size: 12px;
    width: 240px;
    outline: none;
  }
  .search-input:focus { border-color: var(--af-purple); }

  .filter-label {
    font-size: 10px;
    color: var(--af-dim);
    letter-spacing: 0.06em;
    font-weight: 600;
  }

  .kind-chip {
    padding: 4px 10px;
    border-radius: 99px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    background: transparent;
    border: 1px solid var(--af-border2);
    color: var(--af-dim);
    transition: all 150ms;
  }
  .kind-chip:hover { color: var(--af-text); border-color: var(--af-border3); }
  .kind-chip-active {
    background: var(--chip-color, var(--af-purple));
    color: var(--af-surface);
    border-color: var(--chip-color, var(--af-purple));
    opacity: 1;
  }

  .agent-select {
    padding: 5px 8px;
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    color: var(--af-text);
    font-size: 11px;
    outline: none;
  }

  .date-input {
    padding: 5px 8px;
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    color: var(--af-text);
    font-size: 11px;
    outline: none;
  }

  .filter-count {
    margin-left: auto;
    font-size: 11px;
    color: var(--af-dim);
  }

  /* ── Content layout ──────────────────────────────────────────────────────────── */
  .content-layout {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 14px;
    align-items: start;
  }
  @media (max-width: 900px) {
    .content-layout { grid-template-columns: 1fr; }
  }

  /* ── Entry list ──────────────────────────────────────────────────────────────── */
  .entry-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* ── Entry card ──────────────────────────────────────────────────────────────── */
  .entry-card {
    background: var(--af-surface);
    border: 1px solid var(--af-border);
    border-left: 3px solid var(--af-purple);
    border-radius: 8px;
    padding: 12px 14px;
    text-align: left;
    cursor: pointer;
    transition: border-color 150ms, background 150ms;
    width: 100%;
  }
  .entry-card:hover {
    background: var(--af-surface2);
    border-color: var(--af-border2);
  }
  .entry-card-active {
    border-color: var(--af-purple) !important;
    background: color-mix(in srgb, var(--af-purple) 5%, var(--af-surface));
  }

  .entry-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }
  .entry-card-meta { display: flex; align-items: center; gap: 8px; }
  .entry-source {
    font-size: 11px;
    color: var(--af-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 180px;
  }
  .entry-card-right { display: flex; align-items: center; gap: 10px; }
  .entry-time { font-size: 11px; color: var(--af-faint); }

  .entry-card-body {
    font-size: 13px;
    color: var(--af-text);
    line-height: 1.55;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    text-overflow: ellipsis;
  }

  .entry-tags {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    margin-top: 8px;
  }
  .tag {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--af-surface2);
    border: 1px solid var(--af-border);
    color: var(--af-dim);
  }

  /* ── Detail pane ─────────────────────────────────────────────────────────────── */
  .detail-pane {
    width: 380px;
    position: sticky;
    top: 16px;
  }
  @media (max-width: 900px) { .detail-pane { width: 100%; position: static; } }

  .detail-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  .detail-close {
    background: none;
    border: none;
    color: var(--af-dim);
    font-size: 14px;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .detail-close:hover { color: var(--af-text); background: var(--af-surface2); }

  .detail-key {
    font-size: 13px;
    font-weight: 600;
    color: var(--af-text);
    margin-bottom: 6px;
    word-break: break-all;
  }
  .detail-meta {
    font-size: 10px;
    color: var(--af-dim);
    margin-bottom: 8px;
  }
  .detail-tags {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }

  .detail-value-wrap {
    background: var(--af-surface2);
    border: 1px solid var(--af-border);
    border-radius: 6px;
    padding: 10px;
    max-height: 400px;
    overflow-y: auto;
    margin-top: 10px;
  }
  .detail-value {
    font-size: 11px;
    color: var(--af-text);
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
    line-height: 1.55;
    font-family: var(--af-font-mono, monospace);
  }

  .detail-meta-block {
    margin-top: 10px;
  }
  .detail-meta-block summary {
    font-size: 11px;
    color: var(--af-dim);
    cursor: pointer;
    padding: 4px 0;
  }

  /* ── Empty + error + skeleton ────────────────────────────────────────────────── */
  .empty-state {
    padding: 32px 16px;
    text-align: center;
    font-size: 13px;
    color: var(--af-faint);
  }
  .error-banner {
    display: flex;
    align-items: center;
    padding: 14px 16px;
    background: color-mix(in srgb, var(--af-danger) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--af-danger) 30%, transparent);
    border-radius: 8px;
    color: var(--af-danger);
    font-size: 13px;
    margin-bottom: 14px;
  }
  .skeleton {
    background: linear-gradient(90deg, var(--af-surface) 0%, var(--af-surface2) 50%, var(--af-surface) 100%);
    background-size: 200% 100%;
    animation: skel 1.4s ease-in-out infinite;
    margin-bottom: 8px;
  }
  @keyframes skel {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
</style>
