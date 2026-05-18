<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import type { PageData } from './$types';
  import { Card, Btn } from '$lib/components/v2';

  let { data }: { data: PageData } = $props();

  interface AuditEntry {
    id: string;
    ts: string;
    actor: string;
    action: string;
    target: string;
    details: Record<string, unknown>;
  }

  interface AuditMeta { total: number; limit: number; timestamp: string; }
  interface AuditResponse { data: AuditEntry[]; meta: AuditMeta; }

  let entries: AuditEntry[] = $state((data.data ?? []) as AuditEntry[]);
  let meta: AuditMeta = $state((data.meta ?? { total: 0, limit: 100, timestamp: '' }) as AuditMeta);
  let loading = $state(entries.length === 0);
  let error: string | null = $state(null);
  let expanded: Set<string> = $state(new Set());
  let actorFilter = $state('');
  let actionFilter = $state('');
  let sinceFilter = $state('');
  let targetFilter = $state('');
  let currentSince: string | undefined = $state(undefined);
  let interval: ReturnType<typeof setInterval> | null = null;

  async function fetchEntries(since?: string) {
    if (browser && document.visibilityState === 'hidden') return;
    loading = true; error = null;
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (since) params.set('since', since);
      if (actorFilter.trim()) params.set('actor', actorFilter.trim());
      const res = await fetch(`/api/v5/audit?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as AuditResponse;
      entries = body.data as AuditEntry[];
      meta = body.meta as AuditMeta;
      currentSince = since;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load audit log';
    } finally { loading = false; }
  }

  function applyFilters() { fetchEntries(sinceFilter.trim() || undefined); }
  function clearFilters() { actorFilter = ''; actionFilter = ''; sinceFilter = ''; targetFilter = ''; fetchEntries(undefined); }

  function toggleExpanded(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id); else next.add(id);
    expanded = next;
  }

  function actionColor(action: string): string {
    const cat = action.split('_')[0].toLowerCase();
    if (cat === 'create') return 'var(--af-success)';
    if (cat === 'delete') return 'var(--af-danger)';
    if (cat === 'update') return 'var(--af-sonnet)';
    if (cat === 'test') return 'var(--af-purple)';
    return 'var(--af-muted)';
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
    } catch { return iso; }
  }

  function exportCsv() {
    const filtered = filteredEntries;
    const rows = [['ts','actor','action','target','id'], ...filtered.map(e => [e.ts,e.actor,e.action,e.target,e.id])];
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `audit-log-${new Date().toISOString().slice(0,10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const filteredEntries = $derived(entries.filter(e => {
    if (actionFilter && !e.action.toLowerCase().includes(actionFilter.toLowerCase())) return false;
    if (targetFilter && !e.target.toLowerCase().includes(targetFilter.toLowerCase())) return false;
    return true;
  }));

  onMount(() => {
    if (entries.length === 0) fetchEntries();
    interval = setInterval(() => fetchEntries(currentSince), 30_000);
    if (browser) document.addEventListener('visibilitychange', () => fetchEntries(currentSince));
  });

  onDestroy(() => {
    if (interval) clearInterval(interval);
    if (browser) document.removeEventListener('visibilitychange', () => fetchEntries(currentSince));
  });
</script>

<div class="page">
  <div class="page-header">
    <div>
      <div class="crumbs">Workspace / Audit log</div>
      <h1 class="page-title">Audit log</h1>
      <p class="page-sub">Complete trail of every administrative and autonomous action</p>
    </div>
    <div class="header-actions">
      <Btn size="sm" onClick={exportCsv}>Export CSV</Btn>
      <Btn size="sm" onClick={() => fetchEntries(currentSince)}>&#8635; Refresh</Btn>
    </div>
  </div>

  <Card style="padding:12px 16px;">
    <div class="filter-bar">
      <div class="filter-group">
        <label class="filter-label" for="audit-actor">Actor</label>
        <input id="audit-actor" class="filter-input font-mono" type="text" placeholder="system, user..." bind:value={actorFilter} onkeydown={(e) => { if (e.key === 'Enter') applyFilters(); }} />
      </div>
      <div class="filter-group">
        <label class="filter-label" for="audit-action">Action</label>
        <input id="audit-action" class="filter-input font-mono" type="text" placeholder="CREATE_WEBHOOK..." bind:value={actionFilter} />
      </div>
      <div class="filter-group">
        <label class="filter-label" for="audit-target">Target</label>
        <input id="audit-target" class="filter-input font-mono" type="text" placeholder="ID or name..." bind:value={targetFilter} />
      </div>
      <div class="filter-group">
        <label class="filter-label" for="audit-since">Since (ISO)</label>
        <input id="audit-since" class="filter-input font-mono" type="text" placeholder="2026-05-01T00:00:00Z" bind:value={sinceFilter} />
      </div>
      <div class="filter-btns">
        <Btn size="sm" variant="primary" onClick={applyFilters}>Apply</Btn>
        <Btn size="sm" variant="ghost" onClick={clearFilters}>Clear</Btn>
      </div>
    </div>
  </Card>

  {#if loading}
    <Card><div class="state-center"><div class="spinner"></div><span style="font-size:12px;color:var(--af-dim);margin-top:8px">Loading audit log...</span></div></Card>
  {:else if error}
    <Card><div class="state-center"><span style="font-size:22px;color:var(--af-danger)">&#9888;</span><span style="font-size:12px;color:var(--af-danger);margin-top:6px">{error}</span></div></Card>
  {:else if filteredEntries.length === 0}
    <Card>
      <div class="state-center">
        <span style="font-size:28px;color:var(--af-faint)">&#128203;</span>
        <div style="font-size:13px;color:var(--af-text);font-weight:600;margin-top:8px">No audit entries found.</div>
        <div style="font-size:11px;color:var(--af-dim);margin-top:4px">Entries appear when administrative or autonomous actions are taken.</div>
      </div>
    </Card>
  {:else}
    <Card noPad>
      <div class="table-header">
        <span class="section-title">EVENTS · <span class="font-mono">{filteredEntries.length}</span></span>
        <span class="font-mono" style="font-size:10px;color:var(--af-dim)">append-only · newest first</span>
      </div>
      <table class="audit-table">
        <thead>
          <tr>{#each ['Time','Actor','Action','Target',''] as h}<th class="th">{h}</th>{/each}</tr>
        </thead>
        <tbody>
          {#each filteredEntries as entry (entry.id)}
            <tr class="audit-row" class:expanded-row={expanded.has(entry.id)} onclick={() => toggleExpanded(entry.id)}>
              <td class="td font-mono" style="color:var(--af-dim);font-size:11px;white-space:nowrap">{fmtRel(entry.ts)}</td>
              <td class="td font-mono" style="font-size:11px;color:var(--af-text)">{entry.actor}</td>
              <td class="td"><span class="action-chip font-mono" style="color:{actionColor(entry.action)}">{entry.action}</span></td>
              <td class="td" style="font-size:11px;color:var(--af-muted);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{entry.target}</td>
              <td class="td" style="color:var(--af-faint);font-size:12px;text-align:right">{expanded.has(entry.id) ? '&#9660;' : '&#8250;'}</td>
            </tr>
            {#if expanded.has(entry.id)}
              <tr class="detail-row">
                <td colspan="5" class="detail-td">
                  <pre class="detail-json font-mono">{JSON.stringify(entry.details, null, 2)}</pre>
                  <div class="detail-meta font-mono"><span style="color:var(--af-faint)">id:</span> {entry.id} <span style="color:var(--af-faint);margin-left:12px">ts:</span> {entry.ts}</div>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </Card>
  {/if}
</div>

<style>
  .page { display: flex; flex-direction: column; gap: 12px; padding: 20px 24px; max-width: 1200px; }
  .page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 2px; }
  .crumbs { font-size: 10px; color: var(--af-faint); letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 4px; }
  .page-title { margin: 0; font-size: 20px; font-weight: 700; color: var(--af-text); }
  .page-sub { margin: 4px 0 0; font-size: 12px; color: var(--af-dim); }
  .header-actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; padding-top: 4px; }
  .filter-bar { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
  .filter-group { display: flex; flex-direction: column; gap: 4px; }
  .filter-label { font-size: 10px; color: var(--af-dim); letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600; }
  .filter-input { height: 30px; background: var(--af-surface); border: 1px solid var(--af-border2); border-radius: 5px; padding: 0 10px; font-size: 11px; color: var(--af-text); width: 180px; outline: none; font-family: var(--af-font-mono); }
  .filter-input:focus { border-color: var(--af-border3); box-shadow: 0 0 0 2px color-mix(in srgb, var(--af-purple) 20%, transparent); }
  .filter-btns { display: flex; gap: 6px; }
  .table-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--af-border); }
  .section-title { font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--af-dim); }
  .audit-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .th { text-align: left; font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--af-dim); padding: 8px 14px; border-bottom: 1px solid var(--af-border); white-space: nowrap; }
  .td { padding: 9px 14px; border-bottom: 1px solid var(--af-border); vertical-align: middle; }
  .audit-row { cursor: pointer; transition: background 120ms ease; }
  .audit-row:hover { background: var(--af-surface); }
  .expanded-row { background: color-mix(in srgb, var(--af-purple) 5%, transparent); }
  .action-chip { font-size: 11px; font-weight: 600; }
  .detail-row .detail-td { padding: 0; border-bottom: 1px solid var(--af-border); }
  .detail-json { margin: 0; padding: 12px 16px; font-size: 11px; color: var(--af-muted); line-height: 1.7; overflow-x: auto; white-space: pre-wrap; background: var(--af-surface2); max-height: 300px; overflow-y: auto; }
  .detail-meta { padding: 6px 16px 10px; font-size: 10px; color: var(--af-dim); border-top: 1px solid var(--af-border); }
  .state-center { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 20px; text-align: center; }
  .spinner { width: 24px; height: 24px; border: 2px solid var(--af-border2); border-top-color: var(--af-purple); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .font-mono { font-family: var(--af-font-mono); font-feature-settings: 'tnum' 1; }
</style>
