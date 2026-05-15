<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import type { PageData } from './$types';
  import { Card, Badge, Btn, KpiTile } from '$lib/components/v2';

  let { data }: { data: PageData } = $props();

  type NotificationKind = 'info' | 'warning' | 'action_required';

  interface Notification {
    id: string;
    ts: string;
    kind: NotificationKind;
    title: string;
    body: string;
    link: string | null;
    read: boolean;
    createdAt: string;
  }

  interface NotifMeta { total: number; unread: number; limit: number; timestamp: string; }
  interface NotificationsResponse { data: Notification[]; meta: NotifMeta; }

  let notifications: Notification[] = $state((data.data ?? []) as Notification[]);
  let meta: NotifMeta = $state((data.meta ?? { total: 0, unread: 0, limit: 100, timestamp: '' }) as NotifMeta);
  let loading = $state(notifications.length === 0);
  let error: string | null = $state(null);
  let selected: Notification | null = $state(null);
  let filterKind: 'all' | 'unread' | NotificationKind = $state('all');
  let markingAll = $state(false);
  let interval: ReturnType<typeof setInterval> | null = null;

  async function fetchNotifications() {
    if (browser && document.visibilityState === 'hidden') return;
    const params = new URLSearchParams({ limit: '100' });
    if (filterKind === 'unread') params.set('unread', 'true');
    try {
      const res = await fetch(`/api/v5/notifications?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as NotificationsResponse;
      notifications = body.data as Notification[];
      meta = body.meta as NotifMeta;
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load notifications';
    } finally { loading = false; }
  }

  async function markRead(id: string) {
    try {
      await fetch(`/api/v5/notifications/${id}/read`, { method: 'PATCH' });
      notifications = notifications.map(n => n.id === id ? { ...n, read: true } : n);
      if (selected?.id === id) selected = { ...selected, read: true };
      meta = { ...meta, unread: Math.max(0, meta.unread - 1) };
    } catch { /* silent */ }
  }

  async function markAllRead() {
    markingAll = true;
    const unread = notifications.filter(n => !n.read);
    await Promise.allSettled(unread.map(n => fetch(`/api/v5/notifications/${n.id}/read`, { method: 'PATCH' })));
    await fetchNotifications();
    markingAll = false;
  }

  function selectNotification(n: Notification) {
    selected = n;
    if (!n.read) markRead(n.id);
  }

  function kindVariant(kind: NotificationKind): 'info' | 'warning' | 'danger' {
    if (kind === 'info') return 'info';
    if (kind === 'warning') return 'warning';
    return 'danger';
  }

  function kindLabel(kind: NotificationKind): string {
    if (kind === 'info') return 'INFO';
    if (kind === 'warning') return 'WARNING';
    return 'ACTION';
  }

  function kindDotColor(kind: NotificationKind): string {
    if (kind === 'info') return 'var(--af-accent2)';
    if (kind === 'warning') return 'var(--af-warning)';
    return 'var(--af-danger)';
  }

  function fmtRel(iso: string): string {
    try {
      const diff = Date.now() - new Date(iso).getTime();
      const s = Math.floor(diff / 1000);
      if (s < 60) return `${s}s ago`;
      const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
      return new Date(iso).toLocaleDateString();
    } catch { return iso; }
  }

  function fmtAbs(iso: string): string {
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  }

  const FILTER_OPTIONS = [
    { id: 'all', label: 'All' }, { id: 'unread', label: 'Unread' },
    { id: 'info', label: 'Info' }, { id: 'warning', label: 'Warning' }, { id: 'action_required', label: 'Action' },
  ];

  const filteredNotifications = $derived(notifications.filter(n => {
    if (filterKind === 'all') return true;
    if (filterKind === 'unread') return !n.read;
    return n.kind === filterKind;
  }));

  const unreadCount = $derived(notifications.filter(n => !n.read).length);

  onMount(() => {
    if (notifications.length === 0) fetchNotifications();
    interval = setInterval(fetchNotifications, 20_000);
    if (browser) document.addEventListener('visibilitychange', fetchNotifications);
  });

  onDestroy(() => {
    if (interval) clearInterval(interval);
    if (browser) document.removeEventListener('visibilitychange', fetchNotifications);
  });
</script>

<div class="page">
  <div class="page-header">
    <div>
      <div class="crumbs">Workspace / Notifications</div>
      <h1 class="page-title">
        Notifications
        {#if unreadCount > 0}
          <span class="unread-badge font-mono">{unreadCount}</span>
        {/if}
      </h1>
      <p class="page-sub"><span class="font-mono">{unreadCount}</span> unread</p>
    </div>
    <div class="header-actions">
      {#if unreadCount > 0}
        <Btn size="sm" onclick={markAllRead} disabled={markingAll}>
          {markingAll ? 'Marking...' : 'Mark all read'}
        </Btn>
      {/if}
    </div>
  </div>

  <div class="kpi-row">
    <KpiTile label="Total" value={notifications.length} color="var(--af-text)" />
    <KpiTile label="Unread" value={unreadCount} color={unreadCount > 0 ? 'var(--af-purple)' : 'var(--af-dim)'} live={unreadCount > 0} />
    <KpiTile label="Action Required" value={notifications.filter(n => n.kind === 'action_required' && !n.read).length} color="var(--af-danger)" />
  </div>

  <div class="filter-bar">
    {#each FILTER_OPTIONS as opt}
      <button class="filter-chip" class:active={filterKind === opt.id} onclick={() => { filterKind = opt.id as typeof filterKind; }}>
        {opt.label}
        {#if opt.id === 'unread' && unreadCount > 0}
          <span class="chip-count font-mono">{unreadCount}</span>
        {/if}
      </button>
    {/each}
  </div>

  {#if loading}
    <Card><div class="state-center"><div class="spinner"></div><span style="font-size:12px;color:var(--af-dim);margin-top:8px">Loading...</span></div></Card>
  {:else if error}
    <Card><div class="state-center"><span style="font-size:22px;color:var(--af-danger)">&#9888;</span><span style="font-size:12px;color:var(--af-danger);margin-top:6px">{error}</span></div></Card>
  {:else if filteredNotifications.length === 0}
    <Card>
      <div class="state-center">
        <span style="font-size:28px;color:var(--af-faint)">&#128276;</span>
        <div style="font-size:13px;color:var(--af-text);font-weight:600;margin-top:8px">
          {filterKind === 'unread' ? 'All caught up.' : 'No notifications.'}
        </div>
        <div style="font-size:11px;color:var(--af-dim);margin-top:4px">
          {filterKind === 'unread' ? 'No unread notifications.' : 'Notifications appear here when system events occur.'}
        </div>
      </div>
    </Card>
  {:else}
    <div class="inbox">
      <Card noPad style="overflow:hidden">
        <div class="inbox-list-header">
          <span class="section-title">INBOX · <span class="font-mono">{filteredNotifications.length}</span></span>
        </div>
        <div class="inbox-list">
          {#each filteredNotifications as n (n.id)}
            <button class="notif-row" class:unread={!n.read} class:selected={selected?.id === n.id} onclick={() => selectNotification(n)}>
              <span class="notif-dot" style="background:{!n.read ? kindDotColor(n.kind) : 'transparent'};border:{n.read ? '1px solid var(--af-border3)' : 'none'}"></span>
              <div class="notif-row-content">
                <div class="notif-row-top">
                  <Badge variant={kindVariant(n.kind)} style="font-size:9px">{kindLabel(n.kind)}</Badge>
                  <span class="notif-ts font-mono">{fmtRel(n.ts)}</span>
                </div>
                <div class="notif-title" class:notif-title-unread={!n.read}>{n.title}</div>
                <div class="notif-preview">{n.body.slice(0, 80)}{n.body.length > 80 ? '...' : ''}</div>
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
              {#if !selected.read}
                <span style="width:6px;height:6px;border-radius:50%;background:{kindDotColor(selected.kind)};display:inline-block"></span>
                <span style="font-size:10px;color:var(--af-dim)">unread</span>
              {/if}
            </div>
            <h2 class="detail-title">{selected.title}</h2>
            <div class="detail-ts font-mono">{fmtAbs(selected.ts)}</div>
          </div>
          <div class="detail-body">{selected.body}</div>
          {#if selected.link}
            <div style="margin-top:14px">
              <a class="detail-link font-mono" href={selected.link} target="_blank" rel="noopener">{selected.link} &#8599;</a>
            </div>
          {/if}
          {#if !selected.read}
            <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--af-border)">
              <Btn size="sm" onclick={() => markRead(selected!.id)}>Mark as read</Btn>
            </div>
          {/if}
        </Card>
      {:else}
        <Card>
          <div class="state-center" style="padding:40px 20px">
            <span style="font-size:22px;color:var(--af-faint)">&#128276;</span>
            <div style="font-size:12px;color:var(--af-dim);margin-top:8px">Select a notification to view details.</div>
          </div>
        </Card>
      {/if}
    </div>
  {/if}
</div>

<style>
  .page { display: flex; flex-direction: column; gap: 12px; padding: 20px 24px; max-width: 1200px; }
  .page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 2px; }
  .crumbs { font-size: 10px; color: var(--af-faint); letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 4px; }
  .page-title { margin: 0; font-size: 20px; font-weight: 700; color: var(--af-text); display: flex; align-items: center; gap: 8px; }
  .unread-badge { font-size: 11px; background: var(--af-purple); color: #fff; padding: 1px 7px; border-radius: 999px; font-weight: 700; }
  .page-sub { margin: 4px 0 0; font-size: 12px; color: var(--af-dim); }
  .header-actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; padding-top: 4px; }
  .kpi-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .filter-bar { display: flex; gap: 6px; flex-wrap: wrap; }
  .filter-chip { display: flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px; font-size: 11px; cursor: pointer; background: transparent; border: 1px solid var(--af-border2); color: var(--af-dim); font-family: inherit; font-weight: 500; transition: all 120ms ease; }
  .filter-chip:hover { border-color: var(--af-border3); color: var(--af-muted); }
  .filter-chip.active { background: var(--af-surface2); border-color: var(--af-border3); color: var(--af-text); }
  .chip-count { font-size: 10px; background: var(--af-purple); color: #fff; padding: 0 5px; border-radius: 999px; font-weight: 700; }
  .inbox { display: grid; grid-template-columns: 360px 1fr; gap: 12px; align-items: start; }
  .inbox-list-header { padding: 10px 14px; border-bottom: 1px solid var(--af-border); }
  .section-title { font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--af-dim); }
  .inbox-list { max-height: 70vh; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--af-border) transparent; }
  .notif-row { width: 100%; display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--af-border); cursor: pointer; background: transparent; border-left: 2px solid transparent; text-align: left; color: var(--af-text); font-family: inherit; transition: background 120ms ease; }
  .notif-row:hover { background: var(--af-surface); }
  .notif-row.unread { background: color-mix(in srgb, var(--af-purple) 4%, transparent); }
  .notif-row.selected { background: var(--af-surface2); border-left-color: var(--af-purple); }
  .notif-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; margin-top: 6px; }
  .notif-row-content { flex: 1; min-width: 0; }
  .notif-row-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 3px; }
  .notif-ts { font-size: 10px; color: var(--af-dim); }
  .notif-title { font-size: 12px; font-weight: 400; color: var(--af-muted); margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .notif-title-unread { font-weight: 600; color: var(--af-text); }
  .notif-preview { font-size: 11px; color: var(--af-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail-header { margin-bottom: 14px; padding-bottom: 14px; border-bottom: 1px solid var(--af-border); }
  .detail-title { margin: 0 0 6px; font-size: 16px; font-weight: 600; color: var(--af-text); line-height: 1.4; }
  .detail-ts { font-size: 11px; color: var(--af-dim); }
  .detail-body { font-size: 13px; color: var(--af-muted); line-height: 1.65; }
  .detail-link { font-size: 11px; color: var(--af-accent2); text-decoration: none; word-break: break-all; }
  .detail-link:hover { text-decoration: underline; }
  .state-center { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 20px; text-align: center; }
  .spinner { width: 24px; height: 24px; border: 2px solid var(--af-border2); border-top-color: var(--af-purple); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .font-mono { font-family: var(--af-font-mono); font-feature-settings: 'tnum' 1; }
  @media (max-width: 800px) { .inbox { grid-template-columns: 1fr; } .kpi-row { grid-template-columns: repeat(3, 1fr); } }
</style>
