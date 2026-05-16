<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import {
    type EventType,
    TYPE_COLORS,
    TYPE_LABELS,
    cycleAccentColor,
    formatCategory,
    formatTime,
    isSilentSystemMessage,
  } from '$lib/util/live-feed.js';
  import { Btn, Badge, Card, PulseDot } from '$lib/components/v2';

  const SSE_URL = '/api/v5/stream';
  const BUFFER_MAX = 500;

  // All real event-type categories from the feed
  const FILTER_OPTIONS: { id: 'all' | EventType; label: string }[] = [
    { id: 'all',            label: 'All' },
    { id: 'cycle_event',    label: 'cycle.*' },
    { id: 'agent_activity', label: 'agent.*' },
    { id: 'workflow_event', label: 'gate.*' },
    { id: 'cost_event',     label: 'cost.*' },
    { id: 'sprint_event',   label: 'sprint.*' },
    { id: 'branch_event',   label: 'branch.*' },
    { id: 'system',         label: 'system' },
  ];

  interface FeedEvent {
    id: string;
    type: EventType;
    category: string;
    message: string;
    data?: Record<string, unknown>;
    timestamp: string;
  }

  type FilterType = 'all' | EventType;

  let connected = $state(false);
  let paused = $state(false);
  let reconnecting = $state(false);
  let showRefreshBanner = $state(false);
  let events: FeedEvent[] = $state([]);
  let userScrolled = $state(false);
  let filterType: FilterType = $state('all');
  let search = $state('');
  let expandedIds: Set<string> = $state(new Set());
  let feedEl: HTMLDivElement | null = $state(null);

  let eventSource: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const filteredEvents = $derived.by(() => {
    let result = filterType === 'all' ? events : events.filter((e) => e.type === filterType);
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (e) =>
          e.type.toLowerCase().includes(q) ||
          e.category?.toLowerCase().includes(q) ||
          e.message?.toLowerCase().includes(q),
      );
    }
    return result;
  });

  function connect() {
    if (eventSource) { eventSource.close(); eventSource = null; }
    reconnecting = false;

    const es = new EventSource(SSE_URL);
    eventSource = es;

    es.onopen = () => { connected = true; reconnecting = false; };

    es.onmessage = (e) => {
      if (paused) return;
      if (browser && document.visibilityState === 'hidden') return;
      try {
        const parsed = JSON.parse(e.data) as FeedEvent & { clientId?: string };
        if (isSilentSystemMessage(parsed.type, parsed.message)) return;
        if (parsed.type === 'refresh_signal') { showRefreshBanner = true; }

        const next = [...events, { ...parsed, id: parsed.id ?? `${Date.now()}-${Math.random()}` }];
        events = next.length > BUFFER_MAX ? next.slice(next.length - BUFFER_MAX) : next;

        if (!userScrolled) requestAnimationFrame(scrollToBottom);
      } catch { /* bad parse */ }
    };

    es.onerror = () => {
      connected = false;
      reconnecting = true;
      es.close();
      eventSource = null;
      reconnectTimer = setTimeout(() => connect(), 3000);
    };
  }

  function scrollToBottom() {
    if (feedEl) feedEl.scrollTop = feedEl.scrollHeight;
  }

  function handleScroll() {
    if (!feedEl) return;
    const atBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 40;
    userScrolled = !atBottom;
  }

  function togglePause() {
    paused = !paused;
    if (!paused && !userScrolled) requestAnimationFrame(scrollToBottom);
  }

  function clearFeed() { events = []; }

  function toggleExpand(id: string) {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    expandedIds = next;
  }

  // Badge variant per type
  function typeBadgeVariant(type: string): 'purple' | 'info' | 'warning' | 'danger' | 'success' | 'muted' {
    if (type === 'agent_activity') return 'purple';
    if (type === 'cycle_event')    return 'info';
    if (type === 'cost_event')     return 'warning';
    if (type === 'workflow_event') return 'info';
    if (type === 'sprint_event')   return 'warning';
    if (type === 'branch_event')   return 'success';
    if (type === 'refresh_signal') return 'danger';
    return 'muted';
  }

  onMount(() => { connect(); });

  onDestroy(() => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (eventSource) eventSource.close();
  });
</script>

<svelte:head><title>Live Feed — AgentForge</title></svelte:head>

<!-- ── Page header ──────────────────────────────────────────────────────── -->
<div class="af2-page-header">
  <div class="af2-page-meta">
    <h1 class="af2-page-title">Live Activity Feed</h1>
    <p class="af2-page-sub">
      Real-time event stream from all autonomous agents and cycles
    </p>
  </div>
  <div class="af2-page-actions">
    <span class="live-status">
      {#if connected && !paused}
        <PulseDot color="var(--af-success)" size={6} />
        <span class="live-label" style="color:var(--af-success)">live · SSE</span>
      {:else if reconnecting}
        <PulseDot color="var(--af-warning)" size={6} ring={false} />
        <span class="live-label" style="color:var(--af-warning)">reconnecting…</span>
      {:else if paused}
        <span class="live-label" style="color:var(--af-dim)">paused</span>
      {:else}
        <span class="live-label" style="color:var(--af-danger)">offline</span>
      {/if}
    </span>
    <Btn size="sm" variant={paused ? 'primary' : 'ghost'} onclick={togglePause}>
      {paused ? 'Resume' : 'Pause'}
    </Btn>
    <Btn size="sm" onclick={clearFeed}>Clear</Btn>
  </div>
</div>

<!-- ── Banners ───────────────────────────────────────────────────────────── -->
{#if showRefreshBanner}
  <div class="banner banner--warn" style="margin-bottom:10px">
    <span>New updates available — data may be stale</span>
    <button class="banner-dismiss" onclick={() => { showRefreshBanner = false; }}>Dismiss</button>
  </div>
{/if}
{#if reconnecting}
  <div class="banner banner--info" style="margin-bottom:10px">
    Live stream disconnected — reconnecting automatically.
  </div>
{/if}

<!-- ── Filter bar ────────────────────────────────────────────────────────── -->
<Card style="margin-bottom:10px;padding:10px 14px">
  <div class="filter-bar">
    <span class="filter-label">FILTER</span>
    {#each FILTER_OPTIONS as opt}
      <button
        class="chip"
        class:chip--active={filterType === opt.id}
        onclick={() => { filterType = opt.id; }}
      >
        {opt.label}
      </button>
    {/each}
    <div class="search-wrap">
      <input
        type="search"
        class="search-input af2-mono"
        placeholder="Search…"
        bind:value={search}
      />
    </div>
    <span class="af2-mono event-count">{filteredEvents.length} events</span>
  </div>
</Card>

<!-- ── Event list ────────────────────────────────────────────────────────── -->
<Card noPad>
  {#if filteredEvents.length === 0}
    <div class="empty-state">
      <span class="empty-icon">⬡</span>
      <p>Waiting for events…</p>
      <p class="empty-sub">Connect agents to see activity here.</p>
    </div>
  {:else}
    <div class="feed" bind:this={feedEl} onscroll={handleScroll}>
      {#each filteredEvents as event (event.id)}
        {@const isCycle = event.type === 'cycle_event'}
        {@const accentColor = isCycle
          ? cycleAccentColor(event.category)
          : (TYPE_COLORS[event.type] ?? 'var(--af-dim)')}
        {@const isExpanded = expandedIds.has(event.id)}

        <div
          class="feed-row"
          class:feed-row--cycle={isCycle}
          style={isCycle ? `--cycle-accent:${accentColor}` : ''}
        >
          <!-- color dot -->
          <span
            class="feed-dot"
            style="background:{accentColor}"
          ></span>

          <!-- timestamp -->
          <span class="af2-mono feed-ts">{formatTime(event.timestamp)}</span>

          <!-- type badge -->
          <span class="feed-badge-wrap">
            <Badge variant={typeBadgeVariant(event.type)}>
              {TYPE_LABELS[event.type] ?? event.type}
            </Badge>
          </span>

          <!-- source/category -->
          {#if event.category && event.category !== event.type && event.category !== 'system'}
            <span
              class="af2-mono feed-cat"
              style={isCycle ? `color:${accentColor}` : ''}
            >
              {formatCategory(event.type, event.category)}
            </span>
          {:else}
            <span></span>
          {/if}

          <!-- message -->
          <span class="feed-msg">{event.message}</span>

          <!-- expand toggle (only if there's data) -->
          <button
            class="feed-expand"
            onclick={() => toggleExpand(event.id)}
            disabled={!event.data}
          >
            {isExpanded ? '▾' : '›'}
          </button>
        </div>

        {#if isExpanded && event.data}
          <div class="feed-detail">
            <pre class="af2-mono feed-json">{JSON.stringify(event.data, null, 2)}</pre>
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</Card>

{#if userScrolled && filteredEvents.length > 0}
  <button
    class="scroll-bottom"
    onclick={() => { userScrolled = false; scrollToBottom(); }}
  >
    ↓ Scroll to latest
  </button>
{/if}

<style>
  /* ── Page header ──────────────────────────────────────────────────────── */
  .af2-page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 16px;
    gap: 16px;
  }

  .af2-page-title {
    font-size: 20px;
    font-weight: 600;
    color: var(--af-text);
    margin: 0 0 4px;
  }

  .af2-page-sub {
    font-size: 12px;
    color: var(--af-dim);
    margin: 0;
  }

  .af2-page-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .live-status {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .live-label {
    font-size: 11px;
    font-family: var(--af-font-mono, monospace);
  }

  /* ── Banners ──────────────────────────────────────────────────────────── */
  .banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 14px;
    border-radius: 6px;
    font-size: 12px;
    border: 1px solid;
  }

  .banner--warn {
    background: color-mix(in srgb, var(--af-warning) 8%, transparent);
    border-color: color-mix(in srgb, var(--af-warning) 25%, transparent);
    color: var(--af-warning);
  }

  .banner--info {
    background: color-mix(in srgb, var(--af-accent) 8%, transparent);
    border-color: color-mix(in srgb, var(--af-accent) 25%, transparent);
    color: var(--af-accent2);
  }

  .banner-dismiss {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 11px;
    color: inherit;
    opacity: 0.7;
  }

  /* ── Filter bar ───────────────────────────────────────────────────────── */
  .filter-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .filter-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: var(--af-dim);
    white-space: nowrap;
  }

  .chip {
    background: transparent;
    border: 1px solid var(--af-border2);
    border-radius: 99px;
    padding: 3px 10px;
    font-size: 11px;
    color: var(--af-muted);
    cursor: pointer;
    transition: border-color 150ms, color 150ms;
    font-family: var(--af-font-mono, monospace);
    white-space: nowrap;
  }

  .chip:hover { border-color: var(--af-border3); color: var(--af-text); }

  .chip--active {
    border-color: var(--af-purple);
    color: var(--af-purple);
    background: color-mix(in srgb, var(--af-purple) 8%, transparent);
  }

  .search-wrap {
    flex: 1;
    min-width: 120px;
    max-width: 280px;
  }

  .search-input {
    width: 100%;
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 11px;
    color: var(--af-text);
    outline: none;
    box-sizing: border-box;
    transition: border-color 150ms;
  }

  .search-input:focus { border-color: var(--af-purple); }
  .search-input::placeholder { color: var(--af-faint); }

  .event-count {
    font-size: 11px;
    color: var(--af-dim);
    margin-left: auto;
    white-space: nowrap;
  }

  /* ── Feed container ───────────────────────────────────────────────────── */
  .feed {
    height: calc(100vh - 280px);
    min-height: 320px;
    overflow-y: auto;
  }

  /* ── Feed rows ────────────────────────────────────────────────────────── */
  .feed-row {
    display: grid;
    grid-template-columns: 8px 76px 64px 100px 1fr 20px;
    gap: 10px;
    align-items: center;
    padding: 8px 16px;
    border-bottom: 1px solid color-mix(in srgb, var(--af-border) 60%, transparent);
    cursor: pointer;
    transition: background 120ms;
  }

  .feed-row:hover { background: var(--af-surface2); }
  .feed-row:last-child { border-bottom: none; }

  .feed-row--cycle {
    border-left: 2px solid var(--cycle-accent, var(--af-sonnet));
    padding-left: 14px;
  }

  .feed-row--cycle:hover {
    background: color-mix(in srgb, var(--cycle-accent, var(--af-sonnet)) 5%, transparent);
  }

  .feed-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .feed-ts {
    font-size: 10px;
    color: var(--af-dim);
    white-space: nowrap;
  }

  .feed-badge-wrap {
    display: flex;
    align-items: center;
  }

  .feed-cat {
    font-size: 10px;
    color: var(--af-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .feed-msg {
    font-size: 12px;
    color: var(--af-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .feed-expand {
    background: none;
    border: none;
    color: var(--af-faint);
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 0;
    width: 20px;
    text-align: center;
  }

  .feed-expand:disabled {
    opacity: 0.2;
    cursor: default;
  }

  /* ── Expanded JSON detail ─────────────────────────────────────────────── */
  .feed-detail {
    padding: 0 16px 12px 38px;
    background: var(--af-surface2);
    border-bottom: 1px solid color-mix(in srgb, var(--af-border) 60%, transparent);
  }

  .feed-json {
    margin: 0;
    padding: 10px 14px;
    background: var(--af-bg);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    font-size: 11px;
    color: var(--af-muted);
    white-space: pre-wrap;
    word-break: break-all;
    line-height: 1.6;
    max-height: 300px;
    overflow: auto;
  }

  /* ── Empty state ──────────────────────────────────────────────────────── */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 64px 24px;
    gap: 8px;
    color: var(--af-dim);
    font-size: 12px;
  }

  .empty-icon { font-size: 32px; opacity: 0.25; }

  .empty-state p { margin: 0; }

  .empty-sub { font-size: 11px; color: var(--af-faint); }

  /* ── Scroll to bottom pill ────────────────────────────────────────────── */
  .scroll-bottom {
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: var(--af-purple);
    color: #fff;
    border: none;
    border-radius: 99px;
    padding: 8px 16px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    z-index: 10;
  }

  .af2-mono {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1;
  }
</style>
