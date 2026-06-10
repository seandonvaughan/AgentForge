<script lang="ts">
  /**
   * /memory — v25 rebuild: filters around the REAL memory types.
   *
   * Sections:
   *   1. Page header
   *   2. KPI tiles: real per-type counts (LEARNED notes, outcomes, facts, …)
   *   3. Filter bar: real-type chips, source select, date range, telemetry
   *      toggle, full-text search
   *   4. Entry list — flat, or grouped by agent in the LEARNED view —
   *      with per-row /agents/<agentId> links and cycle/item ids
   *   5. Detail pane on the right (full value + agent-memory fields)
   *
   * Data:
   *   SSR seed from +page.server.ts (includes memory/agents/*.jsonl)
   *   GET /api/v5/memory?type=&kind=&search=&since=&includeTelemetry= (client refresh)
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
  let chipFilter = $state('all');
  let agentFilter = $state('all');
  let sinceFilter = $state('');
  // v25 — telemetry (lesson-attribution, step-scores) hidden by default; the
  // toggle re-fetches with ?includeTelemetry=1.
  let includeTelemetry = $state(false);

  // Detail pane
  let selectedEntry: MemoryEntrySSR | null = $state(null);

  let pollHandle: ReturnType<typeof setInterval> | null = null;
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;

  // ── Filter chips around the REAL types in the store ─────────────────────────
  interface FilterChip {
    id: string;
    label: string;
    /** Server-side ?type= value. */
    type?: string;
    /** Server-side ?kind= value (agent-memory sub-kind). */
    kind?: string;
    color: string;
  }
  const FILTER_CHIPS: FilterChip[] = [
    { id: 'learned',        label: 'LEARNED notes',   type: 'agent-memory', kind: 'self-note',    color: 'var(--af-purple)' },
    { id: 'outcomes',       label: 'Outcomes',        type: 'agent-memory', kind: 'item-outcome', color: 'var(--af-accent2)' },
    { id: 'learned-fact',   label: 'Learned facts',   type: 'learned-fact',                       color: 'var(--af-purple)' },
    { id: 'review-finding', label: 'Review findings', type: 'review-finding',                     color: 'var(--af-success)' },
    { id: 'gate-verdict',   label: 'Gate verdicts',   type: 'gate-verdict',                       color: 'var(--af-success)' },
    { id: 'cycle-outcome',  label: 'Cycle outcomes',  type: 'cycle-outcome',                      color: 'var(--af-warning)' },
  ];

  const KIND_VARIANTS: Record<string, 'success' | 'danger' | 'info' | 'warning' | 'purple' | 'muted'> = {
    'agent-memory':    'purple',
    'failure-pattern': 'danger',
    'review-finding':  'success',
    'gate-verdict':    'success',
    'cycle-outcome':   'warning',
    'learned-fact':    'purple',
    'lesson-attribution': 'muted',
    'step-scores':     'muted',
  };

  function badgeVariant(type: string | undefined): 'success' | 'danger' | 'info' | 'warning' | 'purple' | 'muted' {
    return KIND_VARIANTS[type ?? ''] ?? 'muted';
  }

  // ── Data loading ──────────────────────────────────────────────────────────────

  async function loadEntries(silent = false): Promise<void> {
    if (!silent) loading = true;
    error = null;
    try {
      const params = new URLSearchParams();
      const chip = FILTER_CHIPS.find(c => c.id === chipFilter);
      if (chip?.type) params.set('type', chip.type);
      if (chip?.kind) params.set('kind', chip.kind);
      if (searchQuery.trim()) params.set('search', searchQuery.trim().toLowerCase());
      if (sinceFilter) params.set('since', sinceFilter);
      if (includeTelemetry) params.set('includeTelemetry', '1');
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

  function setChip(id: string): void {
    chipFilter = id;
    void loadEntries(true);
  }

  function setAgent(v: string): void {
    agentFilter = v;
    void loadEntries(true);
  }

  function toggleTelemetry(): void {
    includeTelemetry = !includeTelemetry;
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

  // KPI counts of the REAL types from the loaded corpus.
  const counts = $derived({
    total:    entries.length,
    learned:  entries.filter(e => e.type === 'agent-memory' && e.kind === 'self-note').length,
    outcomes: entries.filter(e => e.type === 'agent-memory' && e.kind === 'item-outcome').length,
    facts:    entries.filter(e => e.type === 'learned-fact').length,
    findings: entries.filter(e => e.type === 'review-finding').length,
    verdicts: entries.filter(e => e.type === 'gate-verdict').length,
  });

  // LEARNED view: self-notes grouped by owning agent (largest group first).
  const learnedGroups = $derived.by(() => {
    const map = new Map<string, MemoryEntrySSR[]>();
    for (const e of filteredEntries) {
      if (e.type !== 'agent-memory' || e.kind !== 'self-note') continue;
      const key = e.agentId ?? 'unknown';
      const arr = map.get(key) ?? [];
      arr.push(e);
      map.set(key, arr);
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  });

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

  function entryColor(e: MemoryEntrySSR): string {
    if (e.type === 'agent-memory') {
      return e.kind === 'self-note' ? 'var(--af-purple)' : 'var(--af-accent2)';
    }
    const t = e.type ?? '';
    if (t.includes('failure')) return 'var(--af-danger)';
    if (t.includes('verdict') || t.includes('finding')) return 'var(--af-success)';
    if (t === 'cycle-outcome') return 'var(--af-warning)';
    return 'var(--af-purple)';
  }

  function entryTypeLabel(e: MemoryEntrySSR): string {
    if (e.type === 'agent-memory') {
      return e.kind === 'self-note' ? 'LEARNED' : (e.kind ?? 'agent-memory');
    }
    return e.type ?? 'memory';
  }

  function toggleSelected(entry: MemoryEntrySSR): void {
    selectedEntry = selectedEntry?.id === entry.id ? null : entry;
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
        LEARNED notes, item outcomes, facts and verdicts ·
        <span class="font-mono">{entries.length}</span> entries loaded
      </p>
    </div>
    <div class="mem-actions">
      <Btn size="sm" onClick={() => void loadEntries()}>Refresh</Btn>
    </div>
  </div>
</header>

<!-- ── KPI tiles (real type counts) ───────────────────────────────────────────── -->
<div class="kpi-grid">
  <KpiTile
    label="Total"
    value={counts.total}
    color="var(--af-text)"
  />
  <KpiTile
    label="LEARNED notes"
    value={counts.learned}
    color="var(--af-purple)"
  />
  <KpiTile
    label="Outcomes"
    value={counts.outcomes}
    color="var(--af-accent2)"
  />
  <KpiTile
    label="Learned facts"
    value={counts.facts}
    color="var(--af-purple)"
  />
  <KpiTile
    label="Review findings"
    value={counts.findings}
    color="var(--af-success)"
  />
  <KpiTile
    label="Gate verdicts"
    value={counts.verdicts}
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

  <!-- Real-type chips -->
  <span class="filter-label">SHOW</span>
  <button
    class="kind-chip font-mono"
    class:kind-chip-active={chipFilter === 'all'}
    onclick={() => setChip('all')}
  >All</button>
  {#each FILTER_CHIPS as chip (chip.id)}
    <button
      class="kind-chip font-mono"
      class:kind-chip-active={chipFilter === chip.id}
      style="--chip-color:{chip.color}"
      onclick={() => setChip(chip.id)}
    >{chip.label}</button>
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

  <!-- Telemetry toggle (lesson-attribution + step-scores hidden by default) -->
  <button
    class="kind-chip font-mono telemetry-toggle"
    class:kind-chip-active={includeTelemetry}
    title="Include lesson-attribution and step-scores telemetry entries"
    onclick={toggleTelemetry}
  >{includeTelemetry ? '✓ ' : ''}telemetry</button>

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
          {#if searchQuery || chipFilter !== 'all'}
            No entries match the current filters.
          {:else}
            No memory entries yet — run some cycles to populate the knowledge base.
          {/if}
        </div>
      {:else if chipFilter === 'learned'}
        <!-- ── LEARNED view: self-notes grouped by agent ─────────────────────── -->
        {#each learnedGroups as [groupAgent, groupEntries] (groupAgent)}
          <section class="learned-group">
            <div class="learned-group-head">
              <a class="agent-link font-mono" href="/agents/{groupAgent}">{groupAgent}</a>
              <span class="learned-group-count font-mono">{groupEntries.length} note{groupEntries.length === 1 ? '' : 's'}</span>
            </div>
            {#each groupEntries as entry (entry.id)}
              <div class="entry-card" class:entry-card-active={selectedEntry?.id === entry.id} style="border-left-color:var(--af-purple)">
                <div class="entry-card-head">
                  <div class="entry-card-meta">
                    <Badge variant="purple">LEARNED</Badge>
                    {#if entry.cycleId}
                      <span class="font-mono entry-ids" title="cycle">{entry.cycleId.slice(0, 8)}</span>
                    {/if}
                    {#if entry.itemId}
                      <span class="font-mono entry-ids" title="item">{entry.itemId}</span>
                    {/if}
                  </div>
                  <span class="font-mono entry-time">{fmtRel(entry.createdAt)}</span>
                </div>
                <button class="entry-card-btn" onclick={() => toggleSelected(entry)}>
                  <div class="entry-card-body">
                    {entry.summary ?? (typeof entry.value === 'string' ? entry.value.slice(0, 180) : '')}
                  </div>
                </button>
              </div>
            {/each}
          </section>
        {/each}
      {:else}
        <!-- ── Flat view ─────────────────────────────────────────────────────── -->
        {#each filteredEntries as entry (entry.id)}
          <div
            class="entry-card"
            class:entry-card-active={selectedEntry?.id === entry.id}
            style="border-left-color:{entryColor(entry)}"
          >
            <div class="entry-card-head">
              <div class="entry-card-meta">
                <Badge variant={badgeVariant(entry.type)}>{entryTypeLabel(entry)}</Badge>
                {#if entry.outcome}
                  <span class="font-mono entry-ids" class:outcome-failed={entry.outcome === 'failed'}>{entry.outcome}</span>
                {/if}
                {#if entry.agentId}
                  <a class="agent-link font-mono" href="/agents/{entry.agentId}">{entry.agentId.slice(0, 24)}</a>
                {:else if entry.source}
                  <span class="font-mono entry-source">from {entry.source.slice(0, 24)}</span>
                {/if}
                {#if entry.cycleId}
                  <span class="font-mono entry-ids" title="cycle">{entry.cycleId.slice(0, 8)}</span>
                {/if}
                {#if entry.itemId}
                  <span class="font-mono entry-ids" title="item">{entry.itemId}</span>
                {/if}
              </div>
              <div class="entry-card-right">
                <span class="font-mono entry-time">{fmtRel(entry.createdAt)}</span>
              </div>
            </div>
            <button class="entry-card-btn" onclick={() => toggleSelected(entry)}>
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
          </div>
        {/each}
      {/if}
    </div>

    <!-- ── Detail pane ─────────────────────────────────────────────────────────── -->
    {#if selectedEntry}
      <div class="detail-pane">
        <Card>
          <div class="detail-head">
            <Badge variant={badgeVariant(selectedEntry.type)}>{entryTypeLabel(selectedEntry)}</Badge>
            <button class="detail-close" onclick={() => { selectedEntry = null; }} aria-label="Close detail">✕</button>
          </div>
          <div class="detail-key font-mono">{selectedEntry.key}</div>
          <div class="detail-meta font-mono">
            {#if selectedEntry.agentId}
              Agent: <a class="agent-link" href="/agents/{selectedEntry.agentId}">{selectedEntry.agentId}</a>
            {:else if selectedEntry.source}
              Source: {selectedEntry.source}
            {/if}
            {#if selectedEntry.createdAt}
              · {new Date(selectedEntry.createdAt).toLocaleString()}
            {/if}
          </div>
          {#if selectedEntry.cycleId || selectedEntry.itemId || selectedEntry.outcome}
            <div class="detail-meta font-mono">
              {#if selectedEntry.cycleId}Cycle: {selectedEntry.cycleId}{/if}
              {#if selectedEntry.itemId}&nbsp;· Item: {selectedEntry.itemId}{/if}
              {#if selectedEntry.outcome}&nbsp;· Outcome: {selectedEntry.outcome}{/if}
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
    grid-template-columns: repeat(6, 1fr);
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
  .telemetry-toggle { margin-left: 4px; }

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

  /* ── LEARNED grouped view ────────────────────────────────────────────────────── */
  .learned-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 6px;
  }
  .learned-group-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    padding: 2px 2px 0;
  }
  .learned-group-count {
    font-size: 11px;
    color: var(--af-dim);
  }

  .agent-link {
    font-size: 11px;
    color: var(--af-purple);
    text-decoration: none;
  }
  .agent-link:hover { text-decoration: underline; }

  /* ── Entry card ──────────────────────────────────────────────────────────────── */
  .entry-card {
    background: var(--af-surface);
    border: 1px solid var(--af-border);
    border-left: 3px solid var(--af-purple);
    border-radius: 8px;
    padding: 12px 14px;
    text-align: left;
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

  /* The clickable body (toggles the detail pane) — links in the header stay
     outside this button so we never nest interactive elements. */
  .entry-card-btn {
    display: block;
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    text-align: left;
    cursor: pointer;
    color: inherit;
    font: inherit;
  }

  .entry-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }
  .entry-card-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .entry-source {
    font-size: 11px;
    color: var(--af-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 180px;
  }
  .entry-ids {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--af-surface2);
    border: 1px solid var(--af-border);
    color: var(--af-dim);
    white-space: nowrap;
  }
  .outcome-failed { color: var(--af-danger); border-color: color-mix(in srgb, var(--af-danger) 40%, transparent); }
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
