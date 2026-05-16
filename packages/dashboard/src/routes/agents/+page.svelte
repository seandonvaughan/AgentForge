<script lang="ts">
  /**
   * /agents — Agent Fleet page (v2 design).
   *
   * Rebuilt to match design/v2-handoff/prototype/page-agents.jsx AgentsPage.
   * Composition:
   *   1. Page header — crumbs, title, subtitle, actions.
   *   2. Stat strip — 5 KPI cards (total agents, teams, live now, total spend, top spender).
   *   3. Filter bar — search, model pills, team select.
   *   4. Agent table — name, ID, model chip, team badge, effort badge, description.
   *
   * Data: GET /api/v5/agents (SSR via +page.server.ts + client refresh every 15s).
   * Sparklines (24h invocations) require GET /api/v5/sessions?limit=100 — aggregated client-side.
   */
  import { goto } from '$app/navigation';
  import { onMount, onDestroy } from 'svelte';
  import {
    Badge, Btn, Card, DistBar, ModelChip, PulseDot, Sparkline,
  } from '$lib/components/v2';
  import type { PageData } from './$types';
  import type { AgentListItem } from './agents-utils';
  import { matchesAgentFilter } from './agents-utils';

  let { data }: { data: PageData } = $props();

  // ── State ───────────────────────────────────────────────────────────────────
  let search = $state('');
  let filterModel: '' | 'opus' | 'sonnet' | 'haiku' = $state('');
  let filterTeam = $state('');

  let liveAgents = $state<AgentListItem[]>(data.agents ?? []);
  let sessions = $state<SessionRow[]>([]);
  let loading = $state(false);
  let errorMsg = $state<string | null>(null);

  // ── Types ───────────────────────────────────────────────────────────────────
  interface SessionRow {
    agent_id?: string;
    agentId?: string;
    started_at?: string;
    startedAt?: string;
    cost_usd?: number;
    costUsd?: number;
  }

  // ── Polling ─────────────────────────────────────────────────────────────────
  let pollHandle: ReturnType<typeof setInterval> | null = null;

  async function refreshAgents(): Promise<void> {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    loading = true;
    errorMsg = null;
    try {
      const [agRes, sesRes] = await Promise.all([
        fetch('/api/v5/agents'),
        fetch('/api/v5/sessions?limit=100'),
      ]);
      if (agRes.ok) {
        const json = await agRes.json() as { data?: AgentListItem[] };
        if (json.data && json.data.length > 0) liveAgents = json.data;
      }
      if (sesRes.ok) {
        const json = await sesRes.json() as { data?: SessionRow[] };
        sessions = json.data ?? [];
      }
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : 'Refresh failed';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void refreshAgents();
    pollHandle = setInterval(refreshAgents, 15_000);
  });
  onDestroy(() => {
    if (pollHandle) clearInterval(pollHandle);
  });

  // ── Derived ─────────────────────────────────────────────────────────────────
  let filtered = $derived(
    liveAgents.filter(a => matchesAgentFilter(a, search, filterModel, filterTeam))
  );

  let allTeams = $derived(
    [...new Set(liveAgents.map(a => a.team).filter((t): t is string => !!t))].sort()
  );

  let modelCount = $derived({
    opus:   liveAgents.filter(a => a.model === 'opus').length,
    sonnet: liveAgents.filter(a => a.model === 'sonnet').length,
    haiku:  liveAgents.filter(a => a.model === 'haiku').length,
  });

  let totalSpend = $derived(
    sessions.reduce((s, r) => s + (r.cost_usd ?? r.costUsd ?? 0), 0)
  );

  interface AgentSpend { agentId: string; spend: number }
  let agentSpends = $derived<AgentSpend[]>(
    liveAgents.map(a => ({
      agentId: a.agentId,
      spend: sessions
        .filter(s => (s.agent_id ?? s.agentId) === a.agentId)
        .reduce((sum, s) => sum + (s.cost_usd ?? s.costUsd ?? 0), 0),
    }))
  );

  let topSpender = $derived(
    agentSpends.reduce<AgentSpend | null>(
      (top, cur) => (!top || cur.spend > top.spend) ? cur : top, null
    )
  );

  /** Sparkline of invocations per 2-hour bucket (last 24h) for an agent. */
  function sparklineFor(agentId: string): number[] {
    const buckets = new Array<number>(12).fill(0);
    const now = Date.now();
    const bucketMs = 2 * 60 * 60 * 1000;
    const horizon = now - 12 * bucketMs;
    for (const s of sessions) {
      if ((s.agent_id ?? s.agentId) !== agentId) continue;
      const t = s.started_at ?? s.startedAt;
      const ms = t ? new Date(t).getTime() : 0;
      if (!ms || ms < horizon) continue;
      const idx = Math.min(11, Math.floor((ms - horizon) / bucketMs));
      buckets[idx]! += 1;
    }
    return buckets;
  }

  function fmtRel(ts: string | undefined): string {
    if (!ts) return '—';
    const diff = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function lastActive(agentId: string): string {
    const times = sessions
      .filter(s => (s.agent_id ?? s.agentId) === agentId)
      .map(s => s.started_at ?? s.startedAt)
      .filter((t): t is string => !!t);
    if (!times.length) return '—';
    return fmtRel(times.reduce((a, b) => (new Date(a) > new Date(b) ? a : b)));
  }

  function agentSpend(agentId: string): number {
    return agentSpends.find(a => a.agentId === agentId)?.spend ?? 0;
  }

  const EFFORT_ORDER = ['max', 'high', 'medium', 'low'];
  function effortVariant(e: string | null): 'warning' | 'info' | 'muted' {
    if (!e) return 'muted';
    const rank = EFFORT_ORDER.indexOf(e.toLowerCase());
    if (rank <= 1) return 'warning';
    if (rank === 2) return 'info';
    return 'muted';
  }

  function teamLabel(t: string | null): string {
    if (!t) return 'unassigned';
    return t.replace(/_/g, ' ');
  }
</script>

<svelte:head><title>Agent Fleet — AgentForge</title></svelte:head>

<!-- ── Page header ──────────────────────────────────────────────────────────── -->
<header class="af-page-header">
  <div class="af-crumbs font-mono">Workspace · Agents</div>
  <div class="af-headline-row">
    <div>
      <h1 class="af-title">Agent fleet</h1>
      <p class="af-subtitle">
        <span class="font-mono">{liveAgents.length}</span> agents registered
        {#if loading}<span class="af-loading-dot"></span>{/if}
      </p>
    </div>
    <div class="af-actions">
      {#if errorMsg}
        <span class="af-err-inline">{errorMsg}</span>
      {/if}
      <Btn size="sm" onclick={refreshAgents} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</Btn>
    </div>
  </div>
</header>

<!-- ── Stat strip ────────────────────────────────────────────────────────────── -->
<div class="af-stat-strip">
  <!-- Total agents -->
  <Card style="padding:12px 14px;">
    <div class="af-stat-label">Total agents</div>
    <div class="af-stat-value font-mono">{liveAgents.length}</div>
    <DistBar segments={[
      { value: modelCount.opus,   color: 'var(--af-opus)'   },
      { value: modelCount.sonnet, color: 'var(--af-sonnet)' },
      { value: modelCount.haiku,  color: 'var(--af-haiku)'  },
    ]} h={4} />
    <div class="af-tier-row">
      <span><span style="color:var(--af-opus)">●</span> <span class="font-mono af-tier-cnt">{modelCount.opus}</span></span>
      <span><span style="color:var(--af-sonnet)">●</span> <span class="font-mono af-tier-cnt">{modelCount.sonnet}</span></span>
      <span><span style="color:var(--af-haiku)">●</span> <span class="font-mono af-tier-cnt">{modelCount.haiku}</span></span>
    </div>
  </Card>

  <!-- Teams -->
  <Card style="padding:12px 14px;">
    <div class="af-stat-label">Teams</div>
    <div class="af-stat-value font-mono">{allTeams.length}</div>
    <div class="af-stat-sub">+ <span class="font-mono">{liveAgents.filter(a => !a.team).length}</span> unassigned</div>
  </Card>

  <!-- Live now -->
  <Card style="padding:12px 14px;">
    <div class="af-stat-label">Sessions (24h)</div>
    <div style="display:flex; align-items:center; gap:6px;">
      <PulseDot color="var(--af-purple)" size={6} />
      <span class="af-stat-value font-mono">{sessions.length}</span>
    </div>
    <div class="af-stat-sub font-mono">{liveAgents.length} registered</div>
  </Card>

  <!-- Total spend -->
  <Card style="padding:12px 14px;">
    <div class="af-stat-label">Total spend</div>
    <div class="af-stat-value font-mono">${totalSpend.toFixed(2)}</div>
    <div class="af-stat-sub font-mono">
      avg ${liveAgents.length > 0 ? (totalSpend / liveAgents.length).toFixed(3) : '0.000'}/agent
    </div>
  </Card>

  <!-- Top spender -->
  <Card style="padding:12px 14px;">
    <div class="af-stat-label">Top spender</div>
    {#if topSpender}
      {@const ag = liveAgents.find(a => a.agentId === topSpender!.agentId)}
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
        {#if ag}<ModelChip model={ag.model} />{/if}
        <span class="af-stat-name">{topSpender.agentId}</span>
      </div>
      <div class="font-mono af-top-spend">${topSpender.spend.toFixed(3)}</div>
    {:else}
      <div class="af-stat-value font-mono">—</div>
    {/if}
  </Card>
</div>

<!-- ── Filter bar ────────────────────────────────────────────────────────────── -->
<div class="af-filters">
  <input
    class="af-search"
    type="search"
    placeholder="Search by name or id…"
    bind:value={search}
    aria-label="Search agents"
  />
  <span class="af-filter-label">MODEL</span>
  {#each (['', 'opus', 'sonnet', 'haiku'] as const) as tier}
    <button
      class="af-pill af-pill-{tier || 'all'} {filterModel === tier ? 'active' : ''}"
      onclick={() => (filterModel = tier)}
    >{tier || 'all'}</button>
  {/each}
  <span class="af-filter-sep"></span>
  <span class="af-filter-label">TEAM</span>
  <select
    class="af-select"
    bind:value={filterTeam}
    aria-label="Filter by team"
  >
    <option value="">All teams</option>
    {#each allTeams as t}
      <option value={t}>{teamLabel(t)}</option>
    {/each}
  </select>
  <span class="af-filter-count font-mono">{filtered.length} of {liveAgents.length}</span>
</div>

<!-- ── Agent table ───────────────────────────────────────────────────────────── -->
{#if liveAgents.length === 0 && !loading}
  <Card>
    <div class="af-empty">
      No agents found in <code class="af-code">.agentforge/agents/</code>.
    </div>
  </Card>
{:else if filtered.length === 0}
  <Card>
    <div class="af-empty">No agents match{search ? ` "${search}"` : ''}.</div>
  </Card>
{:else}
  <Card noPad>
    <table class="af-table">
      <thead>
        <tr>
          {#each ['Name', 'Agent ID', 'Model', 'Team', 'Effort', 'Cycle spend', 'Last active', 'Description'] as h}
            <th class="af-th">{h}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each filtered as agent (agent.agentId)}
          {@const spark = sparklineFor(agent.agentId)}
          {@const spend = agentSpend(agent.agentId)}
          {@const topSpend = topSpender?.spend ?? 0}
          <tr
            class="af-tr"
            role="button"
            tabindex="0"
            onclick={() => goto(`/agents/${agent.agentId}`)}
            onkeydown={e => e.key === 'Enter' && goto(`/agents/${agent.agentId}`)}
          >
            <!-- Name -->
            <td class="af-td af-td-name">
              <div style="display:flex; align-items:center; gap:8px;">
                {#if spark.some(v => v > 0)}
                  <PulseDot color="var(--af-purple)" size={5} />
                {/if}
                <span style="font-weight:500; color:var(--af-text);">{agent.name}</span>
              </div>
            </td>
            <!-- Agent ID -->
            <td class="af-td">
              <span class="font-mono af-agent-id">{agent.agentId}</span>
            </td>
            <!-- Model -->
            <td class="af-td">
              <ModelChip model={agent.model} />
            </td>
            <!-- Team -->
            <td class="af-td">
              {#if agent.team}
                <Badge variant="muted">{teamLabel(agent.team)}</Badge>
              {:else}
                <span class="af-dash">—</span>
              {/if}
            </td>
            <!-- Effort -->
            <td class="af-td">
              {#if agent.effort}
                <Badge variant={effortVariant(agent.effort)}>{agent.effort.toUpperCase()}</Badge>
              {:else}
                <span class="af-dash">—</span>
              {/if}
            </td>
            <!-- Cycle spend -->
            <td class="af-td">
              <div style="display:flex; align-items:center; gap:8px;">
                <span class="font-mono af-spend">${spend.toFixed(3)}</span>
                <div class="af-spend-bar">
                  <div
                    class="af-spend-fill"
                    style="width:{topSpend > 0 ? Math.min(100, (spend / topSpend) * 100) : 0}%"
                  ></div>
                </div>
              </div>
            </td>
            <!-- Last active -->
            <td class="af-td">
              <span class="font-mono af-last-active">{lastActive(agent.agentId)}</span>
              {#if spark.some(v => v > 0)}
                <div class="af-spark-wrap">
                  <Sparkline data={spark} color="var(--af-purple)" w={60} h={14} />
                </div>
              {/if}
            </td>
            <!-- Description -->
            <td class="af-td af-td-desc">{agent.description ?? '—'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </Card>
{/if}

<style>
  /* ── Page header ─────────────────────────────────────────────────────── */
  .af-page-header {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 14px;
  }
  .af-crumbs {
    font-size: 11px;
    color: var(--af-dim);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .af-headline-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .af-title {
    margin: 0 0 2px;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--af-text);
  }
  .af-subtitle {
    margin: 0;
    font-size: 12px;
    color: var(--af-muted);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .af-loading-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--af-purple);
    animation: af-pulse 1s ease-in-out infinite;
    flex-shrink: 0;
  }
  @keyframes af-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
  @media (prefers-reduced-motion: reduce) {
    .af-loading-dot { animation: none; }
  }
  .af-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
  .af-err-inline {
    font-size: 11px;
    color: var(--af-danger);
  }

  /* ── Stat strip ──────────────────────────────────────────────────────── */
  .af-stat-strip {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 8px;
    margin-bottom: 12px;
  }
  @media (max-width: 900px) {
    .af-stat-strip { grid-template-columns: repeat(3, 1fr); }
  }
  @media (max-width: 600px) {
    .af-stat-strip { grid-template-columns: repeat(2, 1fr); }
  }
  .af-stat-label {
    font-size: 10px;
    color: var(--af-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 6px;
  }
  .af-stat-value {
    font-size: 22px;
    font-weight: 600;
    color: var(--af-text);
    letter-spacing: -0.02em;
    margin-bottom: 4px;
  }
  .af-stat-sub {
    font-size: 10px;
    color: var(--af-dim);
    margin-top: 4px;
  }
  .af-tier-row {
    display: flex;
    justify-content: space-between;
    margin-top: 6px;
    font-size: 10px;
  }
  .af-tier-cnt { color: var(--af-muted); }
  .af-stat-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--af-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100px;
  }
  .af-top-spend {
    font-size: 14px;
    font-weight: 600;
    color: var(--af-purple);
  }

  /* ── Filters ─────────────────────────────────────────────────────────── */
  .af-filters {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }
  .af-search {
    flex: 1;
    min-width: 200px;
    padding: 5px 10px;
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    color: var(--af-text);
    font-size: 12px;
    outline: none;
  }
  .af-search:focus { border-color: var(--af-accent); }
  .af-filter-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: var(--af-dim);
  }
  .af-filter-sep {
    width: 1px;
    height: 18px;
    background: var(--af-border);
    margin: 0 2px;
    flex-shrink: 0;
  }
  .af-pill {
    padding: 4px 12px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid var(--af-border2);
    background: transparent;
    color: var(--af-dim);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    transition: border-color 150ms, color 150ms, background 150ms;
  }
  .af-pill:hover { background: var(--af-surface2); color: var(--af-text); }
  .af-pill.active.af-pill-all    { background: rgba(99,102,241,0.12); color: var(--af-accent); border-color: rgba(99,102,241,0.4); }
  .af-pill.active.af-pill-opus   { background: rgba(245,166,35,0.12);  color: var(--af-opus);   border-color: rgba(245,166,35,0.4); }
  .af-pill.active.af-pill-sonnet { background: rgba(122,160,247,0.12); color: var(--af-sonnet); border-color: rgba(122,160,247,0.4); }
  .af-pill.active.af-pill-haiku  { background: rgba(91,211,148,0.12);  color: var(--af-haiku);  border-color: rgba(91,211,148,0.4); }
  .af-select {
    padding: 4px 8px;
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    color: var(--af-muted);
    font-size: 11px;
    outline: none;
    cursor: pointer;
  }
  .af-filter-count {
    margin-left: auto;
    font-size: 11px;
    color: var(--af-dim);
  }

  /* ── Table ───────────────────────────────────────────────────────────── */
  .af-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .af-th {
    text-align: left;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--af-dim);
    padding: 10px 14px;
    border-bottom: 1px solid var(--af-border);
    white-space: nowrap;
  }
  .af-tr {
    border-bottom: 1px solid var(--af-border);
    cursor: pointer;
    transition: background 120ms;
  }
  .af-tr:hover { background: var(--af-surface2); }
  .af-tr:last-child { border-bottom: none; }
  .af-td {
    padding: 8px 14px;
    vertical-align: middle;
  }
  .af-td-name { white-space: nowrap; }
  .af-agent-id {
    font-size: 11px;
    color: var(--af-muted);
  }
  .af-dash { color: var(--af-faint); font-size: 11px; }
  .af-spend {
    font-size: 11px;
    color: var(--af-text);
    min-width: 52px;
  }
  .af-spend-bar {
    width: 44px;
    height: 3px;
    background: var(--af-border);
    border-radius: 2px;
    overflow: hidden;
    flex-shrink: 0;
  }
  .af-spend-fill {
    height: 100%;
    background: var(--af-grad-h);
    transition: width 400ms ease;
  }
  @media (prefers-reduced-motion: reduce) {
    .af-spend-fill { transition: none; }
  }
  .af-last-active {
    font-size: 11px;
    color: var(--af-dim);
    display: block;
  }
  .af-spark-wrap {
    margin-top: 2px;
    opacity: 0.8;
  }
  .af-td-desc {
    color: var(--af-dim);
    font-size: 11px;
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ── Empty ───────────────────────────────────────────────────────────── */
  .af-empty {
    padding: 40px 20px;
    text-align: center;
    font-size: 13px;
    color: var(--af-dim);
  }
  .af-code {
    font-family: var(--af-font-mono);
    font-size: 12px;
    background: var(--af-surface2);
    padding: 2px 6px;
    border-radius: 4px;
  }
</style>
