<script lang="ts">
  import StatGrid from '$lib/components/StatGrid.svelte';
  import AgentTable from '$lib/components/AgentTable.svelte';
  import RecentSessions from '$lib/components/RecentSessions.svelte';
  import { agents, agentsLoading } from '$lib/stores/agents.js';
  import { sessions, sessionsLoading } from '$lib/stores/sessions.js';
  import { totalUsd, costsLoading } from '$lib/stores/costs.js';
  import { wsConnected } from '$lib/stores/ws.js';
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
</style>
