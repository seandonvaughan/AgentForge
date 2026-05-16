<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import type { PageData } from './$types';
  import type { InboxRowSSR, InboxKind } from './+page.server.js';
  import { Card, Badge, Btn, KpiTile } from '$lib/components/v2';

  let { data }: { data: PageData } = $props();

  interface InboxMeta {
    total: number;
    unread: number;
    recipient: string;
    limit: number;
    offset: number;
    timestamp: string;
  }
  interface InboxResponse {
    data: InboxRowSSR[];
    meta: InboxMeta;
  }

  let messages: InboxRowSSR[] = $state(data.data ?? []);
  let meta: InboxMeta = $state(
    (data.meta ?? {
      total: 0,
      unread: 0,
      recipient: '@user',
      limit: 100,
      offset: 0,
      timestamp: '',
    }) as InboxMeta,
  );
  let loading = $state(messages.length === 0);
  let error: string | null = $state(null);
  let selected: InboxRowSSR | null = $state(null);
  let filter: 'all' | 'unread' = $state('all');
  let pollHandle: ReturnType<typeof setInterval> | null = null;

  function buildUrl(): string {
    const params = new URLSearchParams({ recipient: '@user', limit: '100' });
    if (filter === 'unread') params.set('status', 'unread');
    return `/api/v5/inbox?${params.toString()}`;
  }

  async function fetchInbox(): Promise<void> {
    if (browser && document.visibilityState === 'hidden') return;
    try {
      const res = await fetch(buildUrl());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as InboxResponse;
      messages = body.data;
      meta = body.meta;
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load inbox';
    } finally {
      loading = false;
    }
  }

  async function markRead(id: string): Promise<void> {
    try {
      await fetch(`/api/v5/inbox/${id}/read?recipient=%40user`, { method: 'PATCH' });
      messages = messages.map((m) =>
        m.id === id ? { ...m, status: 'read', readAt: new Date().toISOString() } : m,
      );
      if (selected?.id === id) {
        selected = { ...selected, status: 'read', readAt: new Date().toISOString() };
      }
      meta = { ...meta, unread: Math.max(0, meta.unread - 1) };
    } catch {
      /* silent — surfacing the failure isn't useful when the UI already moved on */
    }
  }

  function selectMessage(msg: InboxRowSSR): void {
    selected = msg;
    if (msg.status === 'unread') void markRead(msg.id);
  }

  function kindVariant(kind: InboxKind): 'info' | 'warning' | 'danger' {
    if (kind === 'info') return 'info';
    if (kind === 'warning') return 'warning';
    return 'danger';
  }

  function kindLabel(kind: InboxKind): string {
    if (kind === 'info') return 'INFO';
    if (kind === 'warning') return 'WARNING';
    return 'ACTION';
  }

  function kindDotColor(kind: InboxKind): string {
    if (kind === 'info') return 'var(--af-accent2)';
    if (kind === 'warning') return 'var(--af-warning)';
    return 'var(--af-danger)';
  }

  function fmtRel(iso: string): string {
    try {
      const diff = Date.now() - new Date(iso).getTime();
      const s = Math.floor(diff / 1000);
      if (s < 60) return `${s}s ago`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      return new Date(iso).toLocaleDateString();
    } catch {
      return iso;
    }
  }

  function fmtAbs(iso: string): string {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  const FILTER_OPTIONS: { id: 'all' | 'unread'; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'unread', label: 'Unread' },
  ];

  const filteredMessages = $derived(messages);
  const unreadCount = $derived(messages.filter((m) => m.status === 'unread').length);
  const actionRequiredCount = $derived(
    messages.filter((m) => m.kind === 'action_required' && m.status === 'unread').length,
  );

  onMount(() => {
    if (messages.length === 0) void fetchInbox();
    pollHandle = setInterval(() => {
      void fetchInbox();
    }, 20_000);
    if (browser) document.addEventListener('visibilitychange', fetchInbox);
  });

  onDestroy(() => {
    if (pollHandle) clearInterval(pollHandle);
    if (browser) document.removeEventListener('visibilitychange', fetchInbox);
  });

  function changeFilter(next: 'all' | 'unread'): void {
    filter = next;
    loading = true;
    void fetchInbox();
  }
</script>

<div class="page">
  <div class="page-header">
    <div>
      <div class="crumbs">Workspace / Inbox</div>
      <h1 class="page-title">
        Inbox
        {#if unreadCount > 0}
          <span class="unread-badge font-mono">{unreadCount}</span>
        {/if}
      </h1>
      <p class="page-sub">
        Recipient <span class="font-mono">@user</span> ·
        <span class="font-mono">{unreadCount}</span> unread
      </p>
    </div>
  </div>

  <div class="kpi-row">
    <KpiTile label="Total" value={messages.length} color="var(--af-text)" />
    <KpiTile
      label="Unread"
      value={unreadCount}
      color={unreadCount > 0 ? 'var(--af-purple)' : 'var(--af-dim)'}
      live={unreadCount > 0}
    />
    <KpiTile label="Action Required" value={actionRequiredCount} color="var(--af-danger)" />
  </div>

  <div class="filter-bar">
    {#each FILTER_OPTIONS as opt (opt.id)}
      <button
        class="filter-chip"
        class:active={filter === opt.id}
        onclick={() => changeFilter(opt.id)}
      >
        {opt.label}
        {#if opt.id === 'unread' && unreadCount > 0}
          <span class="chip-count font-mono">{unreadCount}</span>
        {/if}
      </button>
    {/each}
  </div>

  {#if loading}
    <Card>
      <div class="state-center">
        <div class="spinner"></div>
        <span style="font-size:12px;color:var(--af-dim);margin-top:8px">Loading...</span>
      </div>
    </Card>
  {:else if error}
    <Card>
      <div class="state-center">
        <span style="font-size:22px;color:var(--af-danger)">&#9888;</span>
        <span style="font-size:12px;color:var(--af-danger);margin-top:6px">{error}</span>
      </div>
    </Card>
  {:else if filteredMessages.length === 0}
    <Card>
      <div class="state-center">
        <span style="font-size:28px;color:var(--af-faint)">&#128231;</span>
        <div style="font-size:13px;color:var(--af-text);font-weight:600;margin-top:8px">
          {filter === 'unread' ? 'No unread messages.' : 'Inbox empty.'}
        </div>
        <div style="font-size:11px;color:var(--af-dim);margin-top:4px">
          {filter === 'unread'
            ? 'All caught up.'
            : 'System events and agent mentions land here.'}
        </div>
      </div>
    </Card>
  {:else}
    <div class="inbox">
      <Card noPad style="overflow:hidden">
        <div class="inbox-list-header">
          <span class="section-title">
            INBOX · <span class="font-mono">{filteredMessages.length}</span>
          </span>
        </div>
        <div class="inbox-list">
          {#each filteredMessages as msg (msg.id)}
            <button
              class="msg-row"
              class:unread={msg.status === 'unread'}
              class:selected={selected?.id === msg.id}
              onclick={() => selectMessage(msg)}
            >
              <span
                class="msg-dot"
                style="background:{msg.status === 'unread'
                  ? kindDotColor(msg.kind)
                  : 'transparent'};border:{msg.status === 'unread'
                  ? 'none'
                  : '1px solid var(--af-border3)'}"
              ></span>
              <div class="msg-row-content">
                <div class="msg-row-top">
                  <Badge variant={kindVariant(msg.kind)} style="font-size:9px">
                    {kindLabel(msg.kind)}
                  </Badge>
                  <span class="msg-ts font-mono">{fmtRel(msg.createdAt)}</span>
                </div>
                <div
                  class="msg-source"
                  class:msg-source-unread={msg.status === 'unread'}
                >
                  {msg.sourceType ?? 'system'}
                </div>
                <div class="msg-preview">
                  {msg.body.slice(0, 100)}{msg.body.length > 100 ? '...' : ''}
                </div>
              </div>
            </button>
          {/each}
        </div>
      </Card>

      {#if selected}
        <Card style="align-self:start">
          <div class="detail-header">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
              <Badge variant={kindVariant(selected.kind)}>{kindLabel(selected.kind)}</Badge>
              {#if selected.status === 'unread'}
                <span
                  style="width:6px;height:6px;border-radius:50%;background:{kindDotColor(
                    selected.kind,
                  )};display:inline-block"
                ></span>
                <span style="font-size:10px;color:var(--af-dim)">unread</span>
              {/if}
            </div>
            <h2 class="detail-title">{selected.sourceType ?? 'system'}</h2>
            <div class="detail-ts font-mono">{fmtAbs(selected.createdAt)}</div>
          </div>
          <div class="detail-body">{selected.body}</div>
          {#if selected.sourceId}
            <div style="margin-top:14px">
              <span class="detail-source font-mono">
                source: {selected.sourceId}
              </span>
            </div>
          {/if}
          {#if selected.status === 'unread'}
            <div
              style="margin-top:16px;padding-top:14px;border-top:1px solid var(--af-border)"
            >
              <Btn size="sm" onclick={() => markRead(selected!.id)}>Mark as read</Btn>
            </div>
          {/if}
        </Card>
      {:else}
        <Card>
          <div class="state-center" style="padding:40px 20px">
            <span style="font-size:22px;color:var(--af-faint)">&#128231;</span>
            <div style="font-size:12px;color:var(--af-dim);margin-top:8px">
              Select a message to view details.
            </div>
          </div>
        </Card>
      {/if}
    </div>
  {/if}
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 20px 24px;
    max-width: 1200px;
  }
  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 2px;
  }
  .crumbs {
    font-size: 10px;
    color: var(--af-faint);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    margin-bottom: 4px;
  }
  .page-title {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    color: var(--af-text);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .unread-badge {
    font-size: 11px;
    background: var(--af-purple);
    color: #fff;
    padding: 1px 7px;
    border-radius: 999px;
    font-weight: 700;
  }
  .page-sub {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--af-dim);
  }
  .kpi-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
  }
  .filter-bar {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .filter-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    border-radius: 999px;
    font-size: 11px;
    cursor: pointer;
    background: transparent;
    border: 1px solid var(--af-border2);
    color: var(--af-dim);
    font-family: inherit;
    font-weight: 500;
    transition: all 120ms ease;
  }
  .filter-chip:hover {
    border-color: var(--af-border3);
    color: var(--af-muted);
  }
  .filter-chip.active {
    background: var(--af-surface2);
    border-color: var(--af-border3);
    color: var(--af-text);
  }
  .chip-count {
    font-size: 10px;
    background: var(--af-purple);
    color: #fff;
    padding: 0 5px;
    border-radius: 999px;
    font-weight: 700;
  }
  .inbox {
    display: grid;
    grid-template-columns: 360px 1fr;
    gap: 12px;
    align-items: start;
  }
  .inbox-list-header {
    padding: 10px 14px;
    border-bottom: 1px solid var(--af-border);
  }
  .section-title {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--af-dim);
  }
  .inbox-list {
    max-height: 70vh;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--af-border) transparent;
  }
  .msg-row {
    width: 100%;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--af-border);
    cursor: pointer;
    background: transparent;
    border-left: 2px solid transparent;
    text-align: left;
    color: var(--af-text);
    font-family: inherit;
    transition: background 120ms ease;
  }
  .msg-row:hover {
    background: var(--af-surface);
  }
  .msg-row.unread {
    background: color-mix(in srgb, var(--af-purple) 4%, transparent);
  }
  .msg-row.selected {
    background: var(--af-surface2);
    border-left-color: var(--af-purple);
  }
  .msg-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    margin-top: 6px;
  }
  .msg-row-content {
    flex: 1;
    min-width: 0;
  }
  .msg-row-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 3px;
  }
  .msg-ts {
    font-size: 10px;
    color: var(--af-dim);
  }
  .msg-source {
    font-size: 12px;
    font-weight: 400;
    color: var(--af-muted);
    margin-bottom: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .msg-source-unread {
    font-weight: 600;
    color: var(--af-text);
  }
  .msg-preview {
    font-size: 11px;
    color: var(--af-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .detail-header {
    margin-bottom: 14px;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--af-border);
  }
  .detail-title {
    margin: 0 0 6px;
    font-size: 16px;
    font-weight: 600;
    color: var(--af-text);
    line-height: 1.4;
  }
  .detail-ts {
    font-size: 11px;
    color: var(--af-dim);
  }
  .detail-body {
    font-size: 13px;
    color: var(--af-muted);
    line-height: 1.65;
    white-space: pre-wrap;
  }
  .detail-source {
    font-size: 11px;
    color: var(--af-dim);
    word-break: break-all;
  }
  .state-center {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 60px 20px;
    text-align: center;
  }
  .spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--af-border2);
    border-top-color: var(--af-purple);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .font-mono {
    font-family: var(--af-font-mono);
    font-feature-settings: 'tnum' 1;
  }
  @media (max-width: 800px) {
    .inbox {
      grid-template-columns: 1fr;
    }
    .kpi-row {
      grid-template-columns: repeat(3, 1fr);
    }
  }
</style>
