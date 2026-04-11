<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    type EventType,
    TYPE_COLORS,
    TYPE_LABELS,
    cycleAccentColor,
    formatCategory,
    formatTime,
    isSilentSystemMessage,
  } from '$lib/util/live-feed.js';

  const SSE_URL = '/api/v5/stream';

  interface FeedEvent {
    id: string;
    type: EventType;
    category: string;
    message: string;
    data?: Record<string, unknown>;
    timestamp: string;
  }

  type FilterType = 'all' | EventType;

  // Svelte 5 rune-based reactive state (replaces writable stores)
  let connected = $state(false);
  let reconnecting = $state(false);
  let showRefreshBanner = $state(false);
  let events: FeedEvent[] = $state([]);
  let userScrolled = $state(false);
  let filterType: FilterType = $state('all');
  let feedEl: HTMLDivElement | null = $state(null);

  // Non-reactive refs — don't need to be $state
  let eventSource: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Replaces `$: filteredEvents = ...` reactive declaration
  let filteredEvents = $derived(
    filterType === 'all'
      ? events
      : events.filter((e) => e.type === filterType)
  );

  function connect() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }

    reconnecting = false;
    const es = new EventSource(SSE_URL);
    eventSource = es;

    es.onopen = () => {
      connected = true;
      reconnecting = false;
    };

    es.onmessage = (e) => {
      try {
        const parsed = JSON.parse(e.data) as FeedEvent & { clientId?: string };

        // Skip heartbeat and connection-ack system messages — they are internal
        // protocol noise that adds no value to the operator's activity feed.
        if (isSilentSystemMessage(parsed.type, parsed.message)) return;

        if (parsed.type === 'refresh_signal') {
          showRefreshBanner = true;
        }

        const next = [...events, { ...parsed, id: parsed.id ?? `${Date.now()}` }];
        // Keep at most 500 events
        events = next.length > 500 ? next.slice(next.length - 500) : next;

        if (!userScrolled) {
          requestAnimationFrame(scrollToBottom);
        }
      } catch {
        // bad parse — ignore
      }
    };

    es.onerror = () => {
      connected = false;
      reconnecting = true;
      es.close();
      eventSource = null;
      // Reconnect after 3s
      reconnectTimer = setTimeout(() => connect(), 3000);
    };
  }

  function scrollToBottom() {
    if (feedEl) {
      feedEl.scrollTop = feedEl.scrollHeight;
    }
  }

  function handleScroll() {
    if (!feedEl) return;
    const atBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 40;
    userScrolled = !atBottom;
  }

  function handleRefreshClick() {
    showRefreshBanner = false;
    userScrolled = false;
    scrollToBottom();
  }

  function clearFeed() {
    events = [];
  }

  onMount(() => {
    connect();
  });

  onDestroy(() => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (eventSource) eventSource.close();
  });
</script>

<svelte:head><title>Live Feed — AgentForge</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Live Activity Feed</h1>
    <p class="page-subtitle">Real-time event stream from the AgentForge autonomous team</p>
  </div>
  <div style="display:flex; align-items:center; gap: var(--space-3);">
    <span class="status-dot {connected ? 'live' : reconnecting ? 'reconnecting' : 'offline'}"></span>
    <span class="status-label">
      {#if connected}Live{:else if reconnecting}Reconnecting…{:else}Offline{/if}
    </span>
    <button class="btn-ghost" onclick={clearFeed}>Clear</button>
  </div>
</div>

{#if showRefreshBanner}
  <div class="refresh-banner">
    <span>New updates available — data may be stale</span>
    <button class="btn-ghost small" onclick={handleRefreshClick}>Dismiss</button>
  </div>
{/if}

<div class="toolbar">
  <label class="filter-label" for="type-filter">Filter by type:</label>
  <select id="type-filter" class="filter-select" bind:value={filterType}>
    <option value="all">All events</option>
    <option value="agent_activity">Agent Activity</option>
    <option value="sprint_event">Sprint Events</option>
    <option value="cost_event">Cost Events</option>
    <option value="workflow_event">Workflow Events</option>
    <option value="branch_event">Branch Events</option>
    <option value="system">System</option>
    <option value="refresh_signal">Refresh Signals</option>
    <option value="cycle_event">Cycle Events</option>
  </select>
  <span class="event-count">{filteredEvents.length} event{filteredEvents.length !== 1 ? 's' : ''}</span>
</div>

<div
  class="feed-container"
  bind:this={feedEl}
  onscroll={handleScroll}
>
  {#if filteredEvents.length === 0}
    <div class="empty-state">
      <span class="empty-icon">⬡</span>
      <p>Waiting for events…</p>
      <p class="muted">Connect your agents to start seeing activity here.</p>
    </div>
  {:else}
    {#each filteredEvents as event (event.id)}
      {@const isCycle = event.type === 'cycle_event'}
      {@const accentColor = isCycle ? cycleAccentColor(event.category) : (TYPE_COLORS[event.type] ?? 'var(--color-text-muted)')}
      <div
        class="feed-row"
        class:feed-row--cycle={isCycle}
        style={isCycle ? `--cycle-accent: ${accentColor};` : ''}
      >
        <span class="timestamp">{formatTime(event.timestamp)}</span>
        <span
          class="type-badge"
          style="background: {TYPE_COLORS[event.type] ?? 'var(--color-text-muted)'}22; color: {TYPE_COLORS[event.type] ?? 'var(--color-text-muted)'}; border-color: {TYPE_COLORS[event.type] ?? 'var(--color-border)'}44;"
        >
          {TYPE_LABELS[event.type] ?? event.type}
        </span>
        {#if event.category && event.category !== event.type && event.category !== 'system'}
          <span
            class="category-tag"
            class:category-tag--cycle={isCycle}
            style={isCycle ? `color: ${accentColor};` : ''}
          >{formatCategory(event.type, event.category)}</span>
        {/if}
        <span class="event-message">{event.message}</span>
      </div>
    {/each}
  {/if}
</div>

{#if userScrolled && filteredEvents.length > 0}
  <button class="scroll-to-bottom" onclick={() => { userScrolled = false; scrollToBottom(); }}>
    ↓ Scroll to latest
  </button>
{/if}

<style>
  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: var(--space-4);
  }

  .page-title {
    font-size: var(--text-xl);
    font-weight: 600;
    color: var(--color-text);
    margin: 0 0 var(--space-1) 0;
  }

  .page-subtitle {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    margin: 0;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: var(--radius-full);
    display: inline-block;
  }

  .status-dot.live { background: var(--color-success); box-shadow: 0 0 6px var(--color-success); }
  .status-dot.reconnecting { background: var(--color-warning); animation: pulse 1.2s infinite; }
  .status-dot.offline { background: var(--color-danger); }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  .status-label {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
  }

  .btn-ghost {
    background: transparent;
    border: 1px solid var(--color-border);
    color: var(--color-text-muted);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: border-color var(--duration-fast), color var(--duration-fast);
  }

  .btn-ghost:hover {
    border-color: var(--color-border-strong);
    color: var(--color-text);
  }

  .btn-ghost.small {
    padding: 2px var(--space-2);
    font-size: var(--text-xs);
  }

  .refresh-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-2) var(--space-4);
    background: var(--color-danger)22;
    border: 1px solid var(--color-danger)44;
    border-radius: var(--radius-md);
    margin-bottom: var(--space-3);
    font-size: var(--text-sm);
    color: var(--color-danger);
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
    padding: var(--space-2) var(--space-4);
    background: var(--color-bg-card);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  .filter-label {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    white-space: nowrap;
  }

  .filter-select {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    color: var(--color-text);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .event-count {
    margin-left: auto;
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    font-variant-numeric: tabular-nums;
  }

  .feed-container {
    background: var(--color-bg-elevated);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    height: calc(100vh - 240px);
    overflow-y: auto;
    padding: var(--space-2) 0;
    position: relative;
  }

  .feed-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 4px var(--space-4);
    border-bottom: 1px solid var(--color-border)44;
    transition: background var(--duration-fast);
  }

  .feed-row:hover {
    background: var(--color-surface-1);
  }

  .feed-row:last-child {
    border-bottom: none;
  }

  /* Cycle events get a left accent border whose color reflects their status */
  .feed-row--cycle {
    border-left: 2px solid var(--cycle-accent, var(--color-sonnet));
    padding-left: calc(var(--space-4) - 2px);
  }

  .feed-row--cycle:hover {
    background: color-mix(in srgb, var(--cycle-accent, var(--color-sonnet)) 6%, transparent);
  }

  .timestamp {
    color: var(--color-text-faint);
    font-size: var(--text-xs);
    white-space: nowrap;
    min-width: 72px;
  }

  .type-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: var(--radius-full);
    border: 1px solid transparent;
    white-space: nowrap;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    min-width: 58px;
    text-align: center;
  }

  .category-tag {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    white-space: nowrap;
  }

  /* Cycle category labels get status-aware color (set inline) and slight weight */
  .category-tag--cycle {
    font-weight: 500;
    font-size: 10px;
    letter-spacing: 0.02em;
  }

  .event-message {
    color: var(--color-text);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: var(--space-2);
    color: var(--color-text-muted);
  }

  .empty-icon {
    font-size: 32px;
    opacity: 0.3;
  }

  .empty-state p {
    margin: 0;
    font-size: var(--text-sm);
  }

  .empty-state .muted {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
  }

  .scroll-to-bottom {
    position: fixed;
    bottom: var(--space-6);
    right: var(--space-6);
    background: var(--color-brand);
    color: white;
    border: none;
    border-radius: var(--radius-full);
    padding: var(--space-2) var(--space-4);
    font-size: var(--text-sm);
    font-weight: 600;
    cursor: pointer;
    box-shadow: var(--shadow-md);
    transition: background var(--duration-fast);
  }

  .scroll-to-bottom:hover {
    background: var(--color-brand-hover);
  }
</style>
