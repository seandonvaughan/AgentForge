<script lang="ts">
  import StatGrid from '$lib/components/StatGrid.svelte';
  import AgentTable from '$lib/components/AgentTable.svelte';
  import RecentSessions from '$lib/components/RecentSessions.svelte';
  import { agents, agentsLoading } from '$lib/stores/agents.js';
  import { sessions, sessionsLoading } from '$lib/stores/sessions.js';
  import { totalUsd, costsLoading } from '$lib/stores/costs.js';
  import { wsConnected } from '$lib/stores/ws.js';
  import { withWorkspace } from '$lib/stores/workspace';
  import { onMount } from 'svelte';

  const API_BASE = '';

  // Derived stats — use $derived() for Svelte 5 compatibility
  let agentCount = $derived($agents.length);
  let activeAgents = $derived($agents.filter((a: any) => a.status === 'active').length);
  let sessionCount = $derived($sessions.length);
  let spend = $derived($totalUsd);
  let isLoading = $derived($agentsLoading || $sessionsLoading || $costsLoading);

  // API health state
  let apiStatus: 'checking' | 'ok' | 'error' = $state('checking');
  let apiVersion = $state('');
  let apiCheckedAt = $state('');

  async function checkApiHealth() {
    apiStatus = 'checking';
    try {
      const res = await fetch(`${API_BASE}/api/v5/health`);
      if (res.ok) {
        const body = await res.json();
        apiVersion = body.version ?? '';
        apiStatus = 'ok';
      } else {
        apiStatus = 'error';
      }
    } catch {
      apiStatus = 'error';
    }
    apiCheckedAt = new Date().toLocaleTimeString();
  }

  // ── Cycles state (v6.5) ──────────────────────────────────────────────────
  interface CycleSummary {
    cycleId: string;
    stage?: string;
    status?: string;
    sprintVersion?: string;
    costUsd?: number;
    totalCost?: number;
    startedAt?: string | number;
  }
  let recentCycles: CycleSummary[] = $state([]);
  let runningCycle: CycleSummary | null = $state(null);
  let runningElapsed = $state(0);
  let runningTimer: ReturnType<typeof setInterval> | null = null;

  const TERMINAL_STATUSES = new Set(['complete', 'completed', 'success', 'failed', 'error', 'cancelled']);

  function isRunning(c: CycleSummary): boolean {
    const s = (c.status ?? '').toLowerCase();
    if (!s) return true; // assume running if status missing
    return !TERMINAL_STATUSES.has(s);
  }

  function getCost(c: CycleSummary): number {
    return c.costUsd ?? c.totalCost ?? 0;
  }

  function shortCycleId(id: string): string {
    return id.length > 10 ? id.slice(0, 10) : id;
  }

  async function loadCycles() {
    try {
      const res = await fetch(withWorkspace(`${API_BASE}/api/v5/cycles?limit=5`));
      if (!res.ok) return;
      const body = await res.json();
      const list: CycleSummary[] = body.cycles ?? body.data ?? body ?? [];
      recentCycles = list;
      const top = list[0];
      if (top && isRunning(top)) {
        runningCycle = top;
        const startMs = top.startedAt
          ? (typeof top.startedAt === 'number' ? top.startedAt : new Date(top.startedAt).getTime())
          : Date.now();
        if (runningTimer) clearInterval(runningTimer);
        runningTimer = setInterval(() => {
          runningElapsed = Math.floor((Date.now() - startMs) / 1000);
        }, 1000);
        runningElapsed = Math.floor((Date.now() - startMs) / 1000);
      } else {
        runningCycle = null;
        if (runningTimer) { clearInterval(runningTimer); runningTimer = null; }
      }
    } catch { /* silent */ }
  }

  function fmtElapsed(sec: number): string {
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = (sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  // Branch stats state
  let branchReport: { total: number; active: number; merged: number; conflict: number; mergeQueue: number } | null = $state(null);

  async function loadBranchReport() {
    try {
      const res = await fetch(`${API_BASE}/api/v5/branches/report`);
      if (res.ok) {
        const body = await res.json();
        branchReport = body.data;
      }
    } catch { /* silently fail if server not running */ }
  }

  onMount(() => {
    checkApiHealth();
    loadBranchReport();
    loadCycles();
    const cyclesPoll = setInterval(loadCycles, 5000);
    return () => {
      clearInterval(cyclesPoll);
      if (runningTimer) clearInterval(runningTimer);
    };
  });

  const sections = [
    {
      href: '/live',
      label: 'Live Feed',
      description: 'Real-time SSE event stream from all agents and workflows',
      icon: '⬤',
      accent: 'var(--color-success)',
    },
    {
      href: '/branches',
      label: 'Branches',
      description: 'Agent git branches, merge queue, and conflict status',
      icon: '⎇',
      accent: 'var(--color-primary)',
    },
    {
      href: '/agents',
      label: 'Agents',
      description: 'Registered agents, roles, capabilities, and model assignments',
      icon: '◈',
      accent: 'var(--color-warning)',
    },
    {
      href: '/sessions',
      label: 'Sessions',
      description: 'All agent execution sessions with cost, status, and output',
      icon: '▣',
      accent: 'var(--color-text-muted)',
    },
    {
      href: '/cost',
      label: 'Cost Analytics',
      description: 'Token spend by agent, model, and time period',
      icon: '◎',
      accent: '#e879f9',
    },
    {
      href: '/org',
      label: 'Org Graph',
      description: 'Organizational structure, delegation chains, and team topology',
      icon: '◉',
      accent: '#38bdf8',
    },
  ];
</script>

<svelte:head><title>AgentForge v6.1 — Command Center</title></svelte:head>

<!-- ── Version banner ─────────────────────────────────────────────────────── -->
<div class="version-banner">
  <span class="version-badge-pill">agentforge v6.1.0</span>
  <span class="sprint-label">v6.1 — Sprint Intelligence + Agent Roster + Session Persistence</span>
  <span class="test-badge">3360+ tests</span>
</div>

<!-- ── Page header ─────────────────────────────────────────────────────────── -->
<div class="page-header">
  <div>
    <h1 class="page-title">Command Center</h1>
    <p class="page-subtitle">AgentForge v6.1 — Real-time agent operations platform</p>
  </div>
  <div style="display:flex; align-items:center; gap: var(--space-3);">
    {#if isLoading}
      <span style="font-size:var(--text-xs); color:var(--color-text-muted);">Loading…</span>
    {/if}
    <span class="badge {$wsConnected ? 'success' : 'muted'}" style="font-size:var(--text-xs);">
      {$wsConnected ? 'WebSocket Live' : 'WebSocket Offline'}
    </span>
  </div>
</div>

<!-- ── Autonomous Command Center (v6.5) ───────────────────────────────────── -->
<div class="autonomous-section">
  <div class="hero-card">
    <div class="hero-body">
      <div class="hero-eyebrow">AUTONOMOUS LOOP</div>
      <h2 class="hero-title">Plan → Execute → Test → Commit → PR</h2>
      <p class="hero-desc">
        Launch a fully autonomous Claude Code session that picks the next sprint item,
        implements it, verifies tests, commits, and opens a PR.
      </p>
      <a href="/cycles/new" class="btn btn-primary hero-cta">Launch New Cycle →</a>
    </div>

    {#if runningCycle}
      <div class="running-panel">
        <div class="running-header">
          <span class="running-dot pulse"></span>
          <span class="running-title">Cycle running: {shortCycleId(runningCycle.cycleId)}</span>
        </div>
        <div class="running-row">
          <span class="badge {runningCycle.stage ? 'sonnet' : 'muted'}">{runningCycle.stage ?? '—'}</span>
          <span class="running-elapsed">{fmtElapsed(runningElapsed)}</span>
        </div>
        <div class="mini-burn-label">
          <span>${getCost(runningCycle).toFixed(2)}</span>
        </div>
        <div class="mini-burn-bar">
          <div class="mini-burn-fill" style="width: {Math.min(100, (getCost(runningCycle) / 25) * 100)}%"></div>
        </div>
        <a href="/cycles/{runningCycle.cycleId}" class="running-link">View detail →</a>
      </div>
    {/if}
  </div>

  <div class="recent-cycles-card">
    <div class="recent-header">
      <span class="card-title">Recent Cycles</span>
      <a href="/cycles" class="see-all-link">See all →</a>
    </div>
    {#if recentCycles.length === 0}
      <div class="recent-empty">No cycles yet — launch your first one above.</div>
    {:else}
      <ul class="recent-list">
        {#each recentCycles as c (c.cycleId)}
          <li class="recent-item">
            <span class="recent-id">{shortCycleId(c.cycleId)}</span>
            <span class="badge {isRunning(c) ? 'sonnet' : (c.status === 'failed' || c.status === 'error' ? 'danger' : 'success')}">
              {c.stage ?? c.status ?? '—'}
            </span>
            <span class="recent-version">{c.sprintVersion ?? '—'}</span>
            <span class="recent-cost">${getCost(c).toFixed(2)}</span>
            <a href="/cycles/{c.cycleId}" class="recent-view">view</a>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<!-- ── System status + quick stats ────────────────────────────────────────── -->
<div class="status-row">
  <!-- API health card -->
  <div class="status-card {apiStatus === 'ok' ? 'status-ok' : apiStatus === 'error' ? 'status-err' : 'status-checking'}">
    <div class="status-card-header">
      <span class="status-dot"></span>
      <span class="status-label">API Server</span>
      {#if apiVersion}
        <span class="status-version">v{apiVersion}</span>
      {/if}
    </div>
    <div class="status-detail">
      {#if apiStatus === 'checking'}
        Connecting to {API_BASE}…
      {:else if apiStatus === 'ok'}
        Online — <a href="/live" style="color:inherit; text-decoration:underline;">View live feed</a>
      {:else}
        Unreachable — start the API server
      {/if}
    </div>
    {#if apiCheckedAt}
      <div class="status-time">Checked {apiCheckedAt}</div>
    {/if}
  </div>

  <!-- Quick stat chips -->
  <div class="quick-stats">
    <div class="stat-chip">
      <span class="stat-chip-value">{agentCount}</span>
      <span class="stat-chip-label">Agents</span>
    </div>
    <div class="stat-chip">
      <span class="stat-chip-value">{activeAgents}</span>
      <span class="stat-chip-label">Active</span>
    </div>
    <div class="stat-chip">
      <span class="stat-chip-value">{branchReport?.active ?? '—'}</span>
      <span class="stat-chip-label">Open Branches</span>
    </div>
    <div class="stat-chip">
      <span class="stat-chip-value">{branchReport?.mergeQueue ?? '—'}</span>
      <span class="stat-chip-label">Pending Merges</span>
    </div>
    <div class="stat-chip">
      <span class="stat-chip-value">${spend.toFixed(4)}</span>
      <span class="stat-chip-label">Total Spend</span>
    </div>
  </div>
</div>

<!-- ── Navigation cards ────────────────────────────────────────────────────── -->
<div class="nav-cards">
  {#each sections as s}
    <a href={s.href} class="nav-card">
      <div class="nav-card-icon" style="color:{s.accent}">{s.icon}</div>
      <div class="nav-card-body">
        <div class="nav-card-title">{s.label}</div>
        <div class="nav-card-desc">{s.description}</div>
      </div>
      <div class="nav-card-arrow">›</div>
    </a>
  {/each}
</div>

<!-- ── Live metrics grid ───────────────────────────────────────────────────── -->
<StatGrid />

<!-- ── Agent table + recent sessions ─────────────────────────────────────── -->
<AgentTable />
<RecentSessions />

<style>
  /* ── Version banner ──────────────────────────────────────────────────────── */
  .version-banner {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    background: rgba(99,102,241,0.06);
    border: 1px solid rgba(99,102,241,0.2);
    border-radius: var(--radius-md);
    margin-bottom: var(--space-4);
    flex-wrap: wrap;
  }

  .version-badge-pill {
    font-size: var(--text-xs);
    font-weight: 700;
    color: #818cf8;
    background: rgba(99,102,241,0.12);
    border: 1px solid rgba(99,102,241,0.3);
    padding: 2px 10px;
    border-radius: 999px;
    font-family: var(--font-mono, monospace);
    letter-spacing: 0.02em;
  }

  .sprint-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    font-weight: 500;
  }

  .test-badge {
    font-size: var(--text-xs);
    color: rgb(34,197,94);
    background: rgba(34,197,94,0.1);
    border: 1px solid rgba(34,197,94,0.25);
    padding: 2px 8px;
    border-radius: 999px;
    font-family: var(--font-mono, monospace);
    margin-left: auto;
  }

  /* ── Status row ──────────────────────────────────────────────────────────── */
  .status-row {
    display: flex;
    gap: var(--space-4);
    margin-bottom: var(--space-5);
    flex-wrap: wrap;
    align-items: flex-start;
  }

  .status-card {
    flex: 0 0 280px;
    padding: var(--space-4);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-surface);
  }

  .status-card.status-ok {
    border-color: rgba(34, 197, 94, 0.4);
    background: rgba(34, 197, 94, 0.05);
  }

  .status-card.status-err {
    border-color: rgba(239, 68, 68, 0.4);
    background: rgba(239, 68, 68, 0.05);
  }

  .status-card.status-checking {
    border-color: rgba(234, 179, 8, 0.3);
    background: rgba(234, 179, 8, 0.03);
  }

  .status-card-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
    font-weight: 600;
    font-size: var(--text-sm);
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
    flex-shrink: 0;
  }

  .status-ok .status-dot   { background: rgb(34, 197, 94); }
  .status-err .status-dot  { background: rgb(239, 68, 68); }
  .status-checking .status-dot { background: rgb(234, 179, 8); }

  .status-label {
    color: var(--color-text);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .status-version {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    background: var(--color-surface-elevated, rgba(255,255,255,0.06));
    padding: 1px 6px;
    border-radius: 4px;
    font-family: var(--font-mono, monospace);
  }

  .status-detail {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    line-height: 1.4;
  }

  .status-time {
    margin-top: var(--space-2);
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    opacity: 0.7;
  }

  /* ── Quick stats ─────────────────────────────────────────────────────────── */
  .quick-stats {
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
    align-items: stretch;
  }

  .stat-chip {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: var(--space-3) var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    min-width: 90px;
    gap: var(--space-1);
  }

  .stat-chip-value {
    font-size: var(--text-xl, 1.25rem);
    font-weight: 700;
    color: var(--color-text);
    font-family: var(--font-mono, monospace);
    line-height: 1;
  }

  .stat-chip-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-align: center;
    white-space: nowrap;
  }

  /* ── Navigation cards ────────────────────────────────────────────────────── */
  .nav-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }

  .nav-card {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4);
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    text-decoration: none;
    color: inherit;
    transition: border-color 0.15s, background 0.15s;
  }

  .nav-card:hover {
    border-color: var(--color-primary, #6366f1);
    background: var(--color-surface-hover, rgba(255,255,255,0.04));
  }

  .nav-card-icon {
    font-size: 1.4rem;
    flex-shrink: 0;
    width: 2rem;
    text-align: center;
    line-height: 1;
  }

  .nav-card-body {
    flex: 1;
    min-width: 0;
  }

  .nav-card-title {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--color-text);
    margin-bottom: 2px;
  }

  .nav-card-desc {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    line-height: 1.4;
  }

  .nav-card-arrow {
    font-size: 1.2rem;
    color: var(--color-text-muted);
    flex-shrink: 0;
  }

  /* ── Autonomous section (v6.5) ─────────────────────────────────────────── */
  .autonomous-section {
    display: grid;
    grid-template-columns: 2fr 1fr;
    gap: var(--space-4);
    margin-bottom: var(--space-5);
  }
  @media (max-width: 980px) {
    .autonomous-section { grid-template-columns: 1fr; }
  }

  .hero-card {
    display: flex;
    gap: var(--space-5);
    padding: var(--space-6);
    background: linear-gradient(135deg, rgba(91,138,245,0.08), rgba(74,158,255,0.04));
    border: 1px solid rgba(91,138,245,0.3);
    border-radius: var(--radius-lg);
  }

  .hero-body { flex: 1; min-width: 0; }
  .hero-eyebrow {
    font-size: var(--text-xs);
    font-weight: 700;
    letter-spacing: 0.12em;
    color: var(--color-brand);
    margin-bottom: var(--space-2);
  }
  .hero-title {
    font-size: var(--text-xl);
    font-weight: 700;
    color: var(--color-text);
    margin: 0 0 var(--space-2) 0;
  }
  .hero-desc {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    line-height: 1.5;
    margin: 0 0 var(--space-4) 0;
    max-width: 540px;
  }
  .hero-cta {
    padding: var(--space-3) var(--space-5);
    font-weight: 600;
  }

  .running-panel {
    flex: 0 0 220px;
    padding: var(--space-3);
    background: var(--color-bg-card);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .running-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .running-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-info);
    flex-shrink: 0;
  }
  .running-title {
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    color: var(--color-text);
    font-weight: 600;
  }
  .running-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .running-elapsed {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }
  .mini-burn-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    font-family: var(--font-mono);
  }
  .mini-burn-bar {
    width: 100%;
    height: 4px;
    background: var(--color-surface-2);
    border-radius: var(--radius-full);
    overflow: hidden;
  }
  .mini-burn-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--color-success), var(--color-info));
  }
  .running-link {
    font-size: var(--text-xs);
    color: var(--color-brand);
    text-decoration: none;
    margin-top: var(--space-1);
  }
  .running-link:hover { text-decoration: underline; }

  .recent-cycles-card {
    padding: var(--space-4);
    background: var(--color-bg-card);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
  }
  .recent-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--color-border);
    padding-bottom: var(--space-2);
    margin-bottom: var(--space-3);
  }
  .see-all-link {
    font-size: var(--text-xs);
    color: var(--color-brand);
    text-decoration: none;
  }
  .see-all-link:hover { text-decoration: underline; }
  .recent-empty {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    text-align: center;
    padding: var(--space-4) 0;
  }
  .recent-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .recent-item {
    display: grid;
    grid-template-columns: auto 1fr auto auto auto;
    gap: var(--space-2);
    align-items: center;
    font-size: var(--text-xs);
    padding: var(--space-2);
    background: var(--color-surface-1);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
  }
  .recent-id {
    font-family: var(--font-mono);
    color: var(--color-text);
    font-weight: 600;
  }
  .recent-version {
    font-family: var(--font-mono);
    color: var(--color-text-muted);
  }
  .recent-cost {
    font-family: var(--font-mono);
    color: var(--color-text);
  }
  .recent-view {
    font-size: var(--text-xs);
    color: var(--color-brand);
    text-decoration: none;
  }
  .recent-view:hover { text-decoration: underline; }
</style>
