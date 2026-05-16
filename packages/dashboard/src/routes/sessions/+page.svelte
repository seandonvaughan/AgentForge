<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { withWorkspace } from '$lib/stores/workspace';
  import { relativeTime, formatDuration } from '$lib/util/relative-time';
  import {
    Card, Badge, Btn, KpiTile, ModelChip, PulseDot,
  } from '$lib/components/v2';

  // ── types ──────────────────────────────────────────────────────────────
  type SessionStatus = 'running' | 'completed' | 'failed';

  interface Session {
    id:           string;
    agentId:      string;
    model:        string;
    task:         string;
    status:       SessionStatus;
    cycle?:       string;
    startedAt:    string;
    completedAt?: string;
    durationMs?:  number;
    inputTokens:  number;
    outputTokens: number;
    costUsd:      number;
    transcript?:  string;
    // snake_case aliases
    agent_id?:    string;
    started_at?:  string;
    completed_at?: string;
    cost_usd?:    number;
  }

  interface PageMeta {
    total:  number;
    limit:  number;
    offset: number;
  }

  const PAGE_SIZE = 50;

  // ── filter state ──────────────────────────────────────────────────────
  let agentFilter  = $state('');
  let statusFilter = $state<SessionStatus | ''>('');
  let cycleFilter  = $state('');
  let searchQ      = $state('');
  let offset       = $state(0);

  // ── data state ────────────────────────────────────────────────────────
  let sessions     = $state<Session[]>([]);
  let meta         = $state<PageMeta>({ total: 0, limit: PAGE_SIZE, offset: 0 });
  let loading      = $state(true);
  let error        = $state<string | null>(null);
  let selected     = $state<Session | null>(null);  // drawer
  let drawerOpen   = $state(false);
  let pollTimer:   ReturnType<typeof setInterval> | null = null;

  // ── computed ──────────────────────────────────────────────────────────
  let stats = $derived({
    total:     meta.total,
    running:   sessions.filter(s => s.status === 'running').length,
    completed: sessions.filter(s => s.status === 'completed').length,
    failed:    sessions.filter(s => s.status === 'failed').length,
    totalCost: sessions.reduce((s, x) => s + (x.costUsd ?? x.cost_usd ?? 0), 0),
    avgCost:   sessions.length
      ? sessions.reduce((s, x) => s + (x.costUsd ?? x.cost_usd ?? 0), 0) / sessions.length
      : 0,
  });

  let hasRunning = $derived(stats.running > 0);

  // ── data ──────────────────────────────────────────────────────────────
  async function load(silent = false) {
    if (document.visibilityState === 'hidden') return;
    if (!silent) loading = true;
    error = null;
    try {
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(offset));
      if (statusFilter) params.set('status', statusFilter);
      if (agentFilter)  params.set('agentId', agentFilter);
      if (cycleFilter)  params.set('cycle', cycleFilter);

      const res = await fetch(withWorkspace(`/api/v5/sessions?${params}`));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data?: Session[]; meta?: PageMeta; total?: number };
      sessions = (json.data ?? []).map(normalise);
      meta = json.meta ?? { total: json.total ?? sessions.length, limit: PAGE_SIZE, offset };
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  function normalise(raw: Session): Session {
    return {
      ...raw,
      agentId:   raw.agentId ?? raw.agent_id ?? '—',
      startedAt: raw.startedAt ?? raw.started_at ?? '',
      costUsd:   raw.costUsd ?? raw.cost_usd ?? 0,
      completedAt: raw.completedAt ?? raw.completed_at,
      inputTokens:  raw.inputTokens  ?? 0,
      outputTokens: raw.outputTokens ?? 0,
    };
  }

  function applyFilters() {
    offset = 0;
    load();
  }

  function prevPage() { if (offset >= PAGE_SIZE) { offset -= PAGE_SIZE; load(); } }
  function nextPage() { if (offset + PAGE_SIZE < meta.total) { offset += PAGE_SIZE; load(); } }

  function openDrawer(s: Session) {
    selected = s;
    drawerOpen = true;
  }

  function closeDrawer() {
    drawerOpen = false;
  }

  // ── formatters ────────────────────────────────────────────────────────
  function modelTier(model: string): 'opus' | 'sonnet' | 'haiku' {
    if (model.includes('opus'))   return 'opus';
    if (model.includes('haiku'))  return 'haiku';
    return 'sonnet';
  }

  function fmtCost(n: number): string {
    return `$${(n ?? 0).toFixed(4)}`;
  }

  function calcDuration(s: Session): string {
    if (s.durationMs != null) return formatDuration(s.durationMs);
    const start = s.startedAt || s.started_at;
    const end   = s.completedAt || s.completed_at;
    if (!start || !end) return '—';
    try {
      return formatDuration(new Date(end).getTime() - new Date(start).getTime());
    } catch { return '—'; }
  }

  function statusVariant(st: SessionStatus): 'purple' | 'success' | 'danger' {
    if (st === 'running')   return 'purple';
    if (st === 'completed') return 'success';
    return 'danger';
  }

  function fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
    return String(n ?? 0);
  }

  onMount(() => {
    load();
    // Poll when sessions are running; pause when hidden
    pollTimer = setInterval(() => {
      if (hasRunning) load(true);
    }, 5_000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') load(true);
    });
  });

  onDestroy(() => { if (pollTimer) clearInterval(pollTimer); });
</script>

<svelte:head><title>Sessions — AgentForge</title></svelte:head>

<!-- ── Page header ─────────────────────────────────────────────────────── -->
<div class="ph">
  <div>
    <h1 class="ph-title">Sessions</h1>
    <p class="ph-sub">
      <span class="font-mono">{meta.total}</span> sessions ·
      <span class="font-mono">{stats.running}</span> running ·
      total <span class="font-mono">{fmtCost(stats.totalCost)}</span>
    </p>
  </div>
  <div class="ph-actions">
    {#if hasRunning}
      <PulseDot color="var(--af-purple)" size={6} />
    {/if}
    <Btn variant="ghost" size="sm" onclick={() => load()} disabled={loading}>
      {loading ? 'Loading…' : 'Refresh'}
    </Btn>
  </div>
</div>

<!-- ── KPI strip ───────────────────────────────────────────────────────── -->
<div class="kpi-strip">
  <KpiTile label="Total"      value={meta.total}                      color="var(--af-text)" />
  <KpiTile label="Running"    value={stats.running}                   color="var(--af-purple)"  live={stats.running > 0} />
  <KpiTile label="Completed"  value={stats.completed}                 color="var(--af-success)" />
  <KpiTile label="Avg cost"   value={fmtCost(stats.avgCost)}          color="var(--af-warning)" />
  <KpiTile label="Total spend" value={fmtCost(stats.totalCost)}       color="var(--af-accent2)" />
</div>

<!-- ── Filters ─────────────────────────────────────────────────────────── -->
<div class="filter-row">
  <!-- Search -->
  <div class="search-box">
    <span class="search-icon">⌕</span>
    <input
      class="search-input"
      type="search"
      bind:value={searchQ}
      onkeydown={(e) => { if (e.key === 'Enter') applyFilters(); }}
      placeholder="Agent or task…"
      spellcheck="false"
      autocomplete="off"
    />
  </div>

  <!-- Status chips -->
  <span class="filter-sep">STATUS</span>
  {#each ['all', 'running', 'completed', 'failed'] as st}
    <button
      class="chip"
      class:chip-active={(statusFilter === '' && st === 'all') || statusFilter === st}
      onclick={() => { statusFilter = st === 'all' ? '' : (st as SessionStatus); applyFilters(); }}
    >
      {st}
    </button>
  {/each}

  <!-- Model chips -->
  <span class="filter-sep filter-sep-gap">MODEL</span>
  {#each ['any', 'opus', 'sonnet', 'haiku'] as m}
    <button
      class="chip"
      class:chip-active={(agentFilter === '' && m === 'any') || agentFilter.includes(m)}
      style={m === 'opus' ? 'color:var(--af-opus)' : m === 'sonnet' ? 'color:var(--af-sonnet)' : m === 'haiku' ? 'color:var(--af-haiku)' : ''}
      onclick={() => { agentFilter = m === 'any' ? '' : m; applyFilters(); }}
    >
      {m}
    </button>
  {/each}

  <span class="flex-1"></span>
  <span class="result-count font-mono">
    {sessions.length} of {meta.total}
  </span>
</div>

<!-- ── Error ───────────────────────────────────────────────────────────── -->
{#if error}
  <div class="err-banner">
    {error}
    <button class="err-close" onclick={() => load()}>Retry</button>
  </div>
{/if}

<!-- ── Loading skeleton ────────────────────────────────────────────────── -->
{#if loading && sessions.length === 0}
  <Card noPad>
    {#each Array(6) as _}
      <div class="skel-row">
        <div class="skel" style="width:110px"></div>
        <div class="skel" style="width:260px"></div>
        <div class="skel" style="width:56px"></div>
        <div class="skel" style="width:64px;height:18px;border-radius:9px"></div>
        <div class="skel" style="width:56px"></div>
        <div class="skel" style="width:72px"></div>
        <div class="skel" style="width:80px"></div>
      </div>
    {/each}
  </Card>

<!-- ── Empty state ─────────────────────────────────────────────────────── -->
{:else if sessions.length === 0 && !error}
  <div class="empty">
    <span class="empty-icon">◎</span>
    <p>No sessions yet — invoke an agent to see history here.</p>
  </div>

<!-- ── Table ───────────────────────────────────────────────────────────── -->
{:else}
  <Card noPad>
    <table class="tbl">
      <thead>
        <tr>
          <th>Agent</th>
          <th>Task</th>
          <th>Model</th>
          <th>Cycle</th>
          <th>Status</th>
          <th>Duration</th>
          <th>Cost</th>
          <th>Tokens in / out</th>
          <th>Started</th>
        </tr>
      </thead>
      <tbody>
        {#each sessions as s (s.id)}
          <tr
            class:row-running={s.status === 'running'}
            class:row-selected={selected?.id === s.id && drawerOpen}
            onclick={() => openDrawer(s)}
          >
            <!-- Agent -->
            <td>
              <div class="agent-cell">
                {#if s.status === 'running'}
                  <PulseDot color="var(--af-purple)" size={5} />
                {/if}
                <span class="agent-chip font-mono">{s.agentId}</span>
              </div>
            </td>

            <!-- Task -->
            <td class="task-cell">
              <span class="task-text">{s.task || '—'}</span>
            </td>

            <!-- Model -->
            <td>
              <ModelChip model={modelTier(s.model ?? '')} />
            </td>

            <!-- Cycle -->
            <td>
              {#if s.cycle}
                <a
                  class="cycle-link font-mono"
                  href="/cycles/{encodeURIComponent(s.cycle)}"
                  onclick={(e) => e.stopPropagation()}
                >
                  {s.cycle.slice(0, 8)}
                </a>
              {:else}
                <span class="dim">—</span>
              {/if}
            </td>

            <!-- Status -->
            <td>
              <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
            </td>

            <!-- Duration -->
            <td>
              <span class="font-mono dim11">{calcDuration(s)}</span>
            </td>

            <!-- Cost -->
            <td>
              <span class="font-mono">{fmtCost(s.costUsd)}</span>
            </td>

            <!-- Tokens -->
            <td>
              <span class="font-mono dim11">
                {fmtTokens(s.inputTokens)} / {fmtTokens(s.outputTokens)}
              </span>
            </td>

            <!-- Started -->
            <td>
              <span class="dim11">{relativeTime(s.startedAt)}</span>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>

    <!-- Pagination -->
    {#if meta.total > PAGE_SIZE}
      <div class="pagination">
        <Btn variant="ghost" size="sm" onclick={prevPage} disabled={offset === 0}>← Prev</Btn>
        <span class="page-info font-mono">
          {offset + 1}–{Math.min(offset + PAGE_SIZE, meta.total)} of {meta.total}
        </span>
        <Btn variant="ghost" size="sm" onclick={nextPage} disabled={offset + PAGE_SIZE >= meta.total}>Next →</Btn>
      </div>
    {:else}
      <div class="tbl-footer font-mono">
        {sessions.length} session{sessions.length === 1 ? '' : 's'}
      </div>
    {/if}
  </Card>
{/if}

<!-- ── Drawer ──────────────────────────────────────────────────────────── -->
{#if drawerOpen && selected}
  <!-- Backdrop -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="drawer-backdrop" onclick={closeDrawer}></div>

  <div class="drawer">
    <!-- Drawer header -->
    <div class="drawer-header">
      <div>
        <div class="drawer-title-row">
          {#if selected.status === 'running'}
            <PulseDot color="var(--af-purple)" size={6} />
          {/if}
          <span class="drawer-agent font-mono">{selected.agentId}</span>
          <Badge variant={statusVariant(selected.status)}>{selected.status}</Badge>
        </div>
        <p class="drawer-sub">started {relativeTime(selected.startedAt)}</p>
      </div>
      <button class="close-btn" onclick={closeDrawer} aria-label="Close drawer">✕</button>
    </div>

    <!-- Drawer body -->
    <div class="drawer-body">
      <!-- Metrics -->
      <Card style="margin-bottom:10px">
        <p class="section-label">METRICS</p>
        <div class="metrics-grid">
          <div class="metric">
            <span class="metric-label">Model</span>
            <ModelChip model={modelTier(selected.model ?? '')} size="md" />
          </div>
          <div class="metric">
            <span class="metric-label">Duration</span>
            <span class="metric-value font-mono">{calcDuration(selected)}</span>
          </div>
          <div class="metric">
            <span class="metric-label">Cost</span>
            <span class="metric-value font-mono">{fmtCost(selected.costUsd)}</span>
          </div>
          <div class="metric">
            <span class="metric-label">Tokens in</span>
            <span class="metric-value font-mono">{fmtTokens(selected.inputTokens)}</span>
          </div>
          <div class="metric">
            <span class="metric-label">Tokens out</span>
            <span class="metric-value font-mono">{fmtTokens(selected.outputTokens)}</span>
          </div>
          {#if selected.cycle}
            <div class="metric">
              <span class="metric-label">Cycle</span>
              <a class="cycle-link font-mono" href="/cycles/{encodeURIComponent(selected.cycle)}">{selected.cycle.slice(0,8)}</a>
            </div>
          {/if}
        </div>
      </Card>

      <!-- Task -->
      <Card style="margin-bottom:10px">
        <p class="section-label">TASK</p>
        <p class="detail-body">{selected.task || '—'}</p>
      </Card>

      <!-- Transcript / Output -->
      <Card noPad style="overflow:hidden">
        <div class="transcript-header">
          <span class="section-label" style="margin:0">OUTPUT / TRANSCRIPT</span>
        </div>
        <pre class="transcript font-mono">{selected.transcript ??
`▶ Loading session ${selected.id}…
▶ Agent: ${selected.agentId}
▶ Model: ${selected.model || 'unknown'}
▶ Status: ${selected.status}

Task: ${selected.task || '(no task recorded)'}

${selected.status === 'running' ? '⏳ in progress…' : `✓ ${selected.status} — ${calcDuration(selected)}`}
`}</pre>
      </Card>
    </div>
  </div>
{/if}

<style>
  /* ── Page header ─────────────────────────────────────────────────────── */
  .ph {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 16px;
    gap: 16px;
  }

  .ph-title {
    font-size: 20px;
    font-weight: 600;
    color: var(--af-text);
    margin: 0 0 4px;
  }

  .ph-sub {
    font-size: 12px;
    color: var(--af-dim);
    margin: 0;
  }

  .ph-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  /* ── KPI strip ───────────────────────────────────────────────────────── */
  .kpi-strip {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 8px;
    margin-bottom: 12px;
  }

  /* ── Filter row ──────────────────────────────────────────────────────── */
  .filter-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }

  .flex-1 { flex: 1; }

  .filter-sep {
    font-size: 10px;
    color: var(--af-dim);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    white-space: nowrap;
    user-select: none;
  }

  .filter-sep-gap { margin-left: 4px; }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 10px;
    border-radius: 9999px;
    border: 1px solid var(--af-border2);
    background: transparent;
    color: var(--af-dim);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: background 120ms, border-color 120ms, color 120ms;
    font-family: inherit;
  }

  .chip:hover { background: var(--af-surface2); color: var(--af-text); }

  .chip-active {
    background: var(--af-surface2);
    border-color: var(--af-border3);
    color: var(--af-text);
  }

  .result-count { font-size: 11px; color: var(--af-faint); }

  /* ── Search box ──────────────────────────────────────────────────────── */
  .search-box {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    transition: border-color 120ms;
    min-width: 200px;
  }

  .search-box:focus-within { border-color: var(--af-accent); }

  .search-icon { color: var(--af-faint); font-size: 14px; user-select: none; }

  .search-input {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    font-size: 12px;
    font-family: var(--af-font-mono);
    color: var(--af-text);
  }

  .search-input::placeholder { color: var(--af-faint); font-family: inherit; }
  .search-input::-webkit-search-cancel-button { display: none; }

  /* ── Error ───────────────────────────────────────────────────────────── */
  .err-banner {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    background: color-mix(in srgb, var(--af-danger) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--af-danger) 25%, transparent);
    border-radius: 6px;
    color: var(--af-danger);
    font-size: 12px;
    margin-bottom: 12px;
  }

  .err-close {
    background: none; border: none; color: inherit; cursor: pointer; opacity: 0.6;
    font-size: 12px; padding: 0;
  }

  .err-close:hover { opacity: 1; }

  /* ── Skeleton ────────────────────────────────────────────────────────── */
  .skel-row {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 11px 14px;
    border-bottom: 1px solid var(--af-border);
  }

  .skel-row:last-child { border-bottom: none; }

  .skel {
    height: 12px;
    background: var(--af-surface2);
    border-radius: 3px;
    animation: shimmer 1.5s ease-in-out infinite;
  }

  @keyframes shimmer {
    0%, 100% { opacity: 0.4; }
    50%       { opacity: 0.7; }
  }

  /* ── Empty state ─────────────────────────────────────────────────────── */
  .empty {
    text-align: center;
    padding: 48px 24px;
    color: var(--af-dim);
    font-size: 12px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }

  .empty-icon { font-size: 28px; opacity: 0.2; }

  /* ── Table ───────────────────────────────────────────────────────────── */
  .tbl {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  .tbl thead tr { border-bottom: 1px solid var(--af-border); }

  .tbl th {
    text-align: left;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--af-dim);
    padding: 10px 14px;
    white-space: nowrap;
  }

  .tbl td {
    padding: 9px 14px;
    border-bottom: 1px solid var(--af-border);
    vertical-align: middle;
  }

  .tbl tbody tr:last-child td { border-bottom: none; }

  .tbl tbody tr {
    cursor: pointer;
    transition: background 100ms;
  }

  .tbl tbody tr:hover { background: color-mix(in srgb, var(--af-surface2) 70%, transparent); }

  .row-running { background: color-mix(in srgb, var(--af-purple) 5%, transparent); }
  .row-selected { background: color-mix(in srgb, var(--af-accent) 7%, transparent); }

  /* ── Agent cell ──────────────────────────────────────────────────────── */
  .agent-cell {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .agent-chip {
    font-size: 11px;
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    padding: 2px 7px;
    border-radius: 4px;
    color: var(--af-text);
    white-space: nowrap;
  }

  /* ── Task cell ───────────────────────────────────────────────────────── */
  .task-cell { max-width: 320px; }

  .task-text {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--af-text);
  }

  /* ── Cycle link ──────────────────────────────────────────────────────── */
  .cycle-link {
    font-size: 11px;
    color: var(--af-accent2);
    text-decoration: none;
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    padding: 2px 7px;
    border-radius: 4px;
    white-space: nowrap;
    transition: border-color 120ms;
  }

  .cycle-link:hover { border-color: var(--af-accent); }

  /* ── Pagination ──────────────────────────────────────────────────────── */
  .pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 10px;
    border-top: 1px solid var(--af-border);
  }

  .page-info {
    font-size: 11px;
    color: var(--af-dim);
  }

  .tbl-footer {
    padding: 8px 14px;
    border-top: 1px solid var(--af-border);
    font-size: 10px;
    color: var(--af-faint);
    text-align: right;
  }

  /* ── Drawer ──────────────────────────────────────────────────────────── */
  .drawer-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 99;
    animation: fade-in 180ms ease;
  }

  @keyframes fade-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(640px, 92vw);
    background: var(--af-bg);
    border-left: 1px solid var(--af-border);
    display: flex;
    flex-direction: column;
    z-index: 100;
    box-shadow: -12px 0 60px rgba(0, 0, 0, 0.5);
    animation: slide-in 220ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  @keyframes slide-in {
    from { transform: translateX(100%); }
    to   { transform: translateX(0); }
  }

  .drawer-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 14px 20px;
    border-bottom: 1px solid var(--af-border);
    flex-shrink: 0;
  }

  .drawer-title-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }

  .drawer-agent {
    font-size: 14px;
    font-weight: 600;
    color: var(--af-text);
  }

  .drawer-sub {
    font-size: 11px;
    color: var(--af-dim);
    margin: 0;
  }

  .close-btn {
    width: 28px;
    height: 28px;
    border-radius: 5px;
    background: var(--af-surface);
    border: 1px solid var(--af-border2);
    color: var(--af-muted);
    cursor: pointer;
    font-size: 14px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 120ms, color 120ms;
  }

  .close-btn:hover { background: var(--af-surface2); color: var(--af-text); }

  .drawer-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
  }

  /* ── Metrics grid ────────────────────────────────────────────────────── */
  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    margin-top: 8px;
  }

  .metric {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .metric-label {
    font-size: 10px;
    color: var(--af-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }

  .metric-value {
    font-size: 13px;
    color: var(--af-text);
  }

  /* ── Transcript ──────────────────────────────────────────────────────── */
  .transcript-header {
    padding: 8px 14px;
    border-bottom: 1px solid var(--af-border);
  }

  .transcript {
    margin: 0;
    padding: 14px;
    font-size: 11px;
    color: var(--af-muted);
    line-height: 1.7;
    overflow: auto;
    max-height: 400px;
    white-space: pre-wrap;
    background: var(--af-surface);
  }

  /* ── Detail body ─────────────────────────────────────────────────────── */
  .detail-body {
    font-size: 12px;
    color: var(--af-muted);
    line-height: 1.6;
    margin: 0;
  }

  .section-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--af-dim);
    margin: 0 0 8px;
  }

  /* ── Utility ─────────────────────────────────────────────────────────── */
  .font-mono { font-family: var(--af-font-mono); }
  .dim       { color: var(--af-dim); font-size: 11px; }
  .dim11     { font-size: 11px; color: var(--af-dim); }

  /* ── Responsive ──────────────────────────────────────────────────────── */
  @media (max-width: 900px) {
    .kpi-strip { grid-template-columns: repeat(3, 1fr); }
    .filter-row { gap: 4px; }
  }
</style>
