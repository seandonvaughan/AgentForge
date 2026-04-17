<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import type { PageData } from './$types';
  import type { AgentListItem } from './+page.server';

  let { data }: { data: PageData } = $props();

  let search = $state('');
  let filterModel: '' | 'opus' | 'sonnet' | 'haiku' = $state('');
  let filterTeam = $state('');

  // refreshedAgents is null until the first API fetch completes.
  // null   → API has not responded yet (show SSR data)
  // []     → API returned empty (preserved as empty — real empty state)
  // [...]  → API returned agents (prefer over SSR data)
  let refreshedAgents = $state<AgentListItem[] | null>(null);
  let refreshing = $state(false);
  let refreshError = $state<string | null>(null);

  // Prefer API data when it is non-empty; otherwise use SSR data from
  // +page.server.ts. This avoids the silent-override bug where an empty API
  // response (e.g., backend unreachable → 502 caught, or wrong projectRoot →
  // 200 { data: [] }) clobbers valid SSR-loaded agents. The ?? operator is
  // insufficient because [] is not nullish — length-check is required.
  let liveAgents = $derived(
    refreshedAgents !== null && refreshedAgents.length > 0
      ? refreshedAgents
      : (data.agents ?? [])
  );

  // All distinct team values from loaded agents — used to build team filter chips.
  let allTeams = $derived(
    [...new Set(liveAgents.map(a => a.team).filter((t): t is string => t !== null))].sort()
  );

  // Auto-fetch on mount so the list is populated even when SSR is not running
  // (e.g. when the SvelteKit build is served as static files via Fastify).
  // This mirrors the pattern used by /org and /sessions.
  onMount(refresh);

  async function refresh() {
    refreshing = true;
    refreshError = null;
    try {
      const res = await fetch('/api/v5/agents');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data?: AgentListItem[] };
      refreshedAgents = json.data ?? [];
    } catch (e) {
      refreshError = e instanceof Error ? e.message : 'Refresh failed';
      // Leave refreshedAgents as null so SSR data stays visible
    } finally {
      refreshing = false;
    }
  }

  let filtered = $derived(liveAgents.filter(a => {
    const q = search.toLowerCase();
    const label = (a.name ?? a.agentId ?? '').toLowerCase();
    const desc = (a.description ?? '').toLowerCase();
    const teamStr = (a.team ?? '').toLowerCase();
    const nameMatch = !q || label.includes(q) || desc.includes(q) || teamStr.includes(q);
    const modelMatch = filterModel === '' || a.model === filterModel;
    const teamMatch = filterTeam === '' || (filterTeam === '__unassigned__' ? !a.team : a.team === filterTeam);
    return nameMatch && modelMatch && teamMatch;
  }));

  /** Group agents by team for the stats bar */
  let teamStats = $derived(
    allTeams.map(t => ({ team: t, count: liveAgents.filter(a => a.team === t).length }))
  );
  let noTeamCount = $derived(liveAgents.filter(a => !a.team).length);

  const EFFORT_ORDER = ['max', 'high', 'medium', 'low'];
  function effortRank(e: string | null): number {
    const idx = EFFORT_ORDER.indexOf(e ?? '');
    return idx === -1 ? 99 : idx;
  }

  function teamLabel(t: string): string {
    if (t === '__unassigned__') return 'unassigned';
    return t.replace(/_/g, ' ');
  }
</script>

<svelte:head><title>Agents — AgentForge</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Agents</h1>
    <p class="page-subtitle">{liveAgents.length} agent{liveAgents.length === 1 ? '' : 's'} registered</p>
  </div>
  <div style="display:flex; align-items:center; gap: var(--space-2);">
    {#if refreshError}
      <span style="font-size:var(--text-xs); color:var(--color-danger);">{refreshError}</span>
    {/if}
    <button class="btn btn-ghost btn-sm" onclick={refresh} disabled={refreshing}>
      {refreshing ? 'Refreshing…' : 'Refresh'}
    </button>
  </div>
</div>

<!-- Team composition summary bar -->
{#if allTeams.length > 0}
  <div class="team-summary-bar" style="margin-bottom: var(--space-5);">
    {#each teamStats as ts}
      <button
        class="team-stat-chip {filterTeam === ts.team ? 'active' : ''}"
        onclick={() => { filterTeam = filterTeam === ts.team ? '' : ts.team; }}
        title="Filter to {teamLabel(ts.team)} team"
      >
        <span class="team-count">{ts.count}</span>
        <span class="team-name">{teamLabel(ts.team)}</span>
      </button>
    {/each}
    {#if noTeamCount > 0}
      <button
        class="team-stat-chip unassigned {filterTeam === '__unassigned__' ? 'active' : ''}"
        onclick={() => { filterTeam = filterTeam === '__unassigned__' ? '' : '__unassigned__'; }}
        title="Agents with no team assigned"
      >
        <span class="team-count">{noTeamCount}</span>
        <span class="team-name">unassigned</span>
      </button>
    {/if}
  </div>
{/if}

<div class="filters">
  <input
    class="search-input"
    type="search"
    placeholder="Search agents…"
    bind:value={search}
    aria-label="Search agents"
  />
  <div class="filter-pills">
    {#each (['', 'opus', 'sonnet', 'haiku'] as const) as tier}
      <button
        class="pill {filterModel === tier ? 'active' : ''} {tier || 'all'}"
        onclick={() => (filterModel = tier)}
      >
        {tier || 'All'}
      </button>
    {/each}
  </div>
  {#if filterTeam}
    <button class="clear-filter" onclick={() => (filterTeam = '')}>
      ✕ {teamLabel(filterTeam)}
    </button>
  {/if}
</div>

{#if liveAgents.length === 0 && !refreshing}
  <div class="empty-state">
    No agents found in <code>.agentforge/agents/</code>.
  </div>
{:else if filtered.length === 0}
  <div class="empty-state">No agents match{search ? ` "${search}"` : ''}.</div>
{:else}
  <div class="card" style="padding:0; overflow:hidden;">
    <table class="data-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Agent ID</th>
          <th>Model</th>
          <th>Team</th>
          <th>Effort</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {#each filtered as agent (agent.agentId)}
          <tr
            role="button"
            tabindex="0"
            onclick={() => goto(`/agents/${agent.agentId}`)}
            onkeydown={e => e.key === 'Enter' && goto(`/agents/${agent.agentId}`)}
          >
            <td style="font-weight:600; white-space:nowrap;">{agent.name}</td>
            <td style="font-family:var(--font-mono); font-size:var(--text-xs); color:var(--color-text-muted); white-space:nowrap;">
              {agent.agentId}
            </td>
            <td>
              {#if agent.model}
                <span class="badge {agent.model}">{agent.model}</span>
              {:else}
                <span class="badge muted">—</span>
              {/if}
            </td>
            <td>
              {#if agent.team}
                <button
                  class="team-chip {filterTeam === agent.team ? 'active' : ''}"
                  onclick={(e) => { e.stopPropagation(); filterTeam = filterTeam === agent.team ? '' : (agent.team ?? ''); }}
                  title="Filter to {teamLabel(agent.team)} team"
                >
                  {teamLabel(agent.team)}
                </button>
              {:else}
                <span style="color:var(--color-text-faint);">—</span>
              {/if}
            </td>
            <td>
              {#if agent.effort}
                <span class="effort-badge rank-{effortRank(agent.effort)}">{agent.effort}</span>
              {:else}
                <span style="color:var(--color-text-faint);">—</span>
              {/if}
            </td>
            <td class="description-cell">{agent.description ?? '—'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  /* ── Team summary bar ──────────────────────────────────────────────────── */
  .team-summary-bar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .team-stat-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 5px var(--space-3);
    border-radius: var(--radius-full);
    border: 1px solid var(--color-border);
    background: var(--color-surface-1);
    cursor: pointer;
    transition: all var(--duration-fast);
    font-size: var(--text-xs);
  }

  .team-stat-chip:hover {
    background: var(--color-surface-2);
    border-color: var(--color-border-strong);
  }

  .team-stat-chip.active {
    background: rgba(91,138,245,0.1);
    border-color: rgba(91,138,245,0.4);
    color: var(--color-brand);
  }

  .team-stat-chip.unassigned { opacity: 0.5; }
  .team-stat-chip.unassigned:hover { opacity: 0.8; }

  .team-count {
    font-weight: 700;
    font-size: var(--text-sm);
    color: var(--color-text);
    min-width: 18px;
    text-align: right;
  }

  .team-stat-chip.active .team-count { color: var(--color-brand); }

  .team-name {
    color: var(--color-text-muted);
    text-transform: capitalize;
    white-space: nowrap;
  }

  .team-stat-chip.active .team-name { color: var(--color-brand); }

  /* ── Filters row ─────────────────────────────────────────────────────────── */
  .filters {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    margin-bottom: var(--space-5);
    flex-wrap: wrap;
  }
  .search-input {
    flex: 1;
    min-width: 200px;
    padding: var(--space-2) var(--space-3);
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    font-size: var(--text-sm);
    outline: none;
  }
  .search-input:focus { border-color: var(--color-brand); }
  .filter-pills { display: flex; gap: var(--space-2); }
  .pill {
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    font-weight: 600;
    cursor: pointer;
    border: 1px solid var(--color-border);
    background: transparent;
    color: var(--color-text-muted);
    transition: all var(--duration-fast);
  }
  .pill:hover { background: var(--color-surface-2); color: var(--color-text); }
  .pill.active.all    { background: rgba(91,138,245,0.12); color: var(--color-brand);  border-color: rgba(91,138,245,0.4); }
  .pill.active.opus   { background: rgba(245,200,66,0.12); color: var(--color-opus);   border-color: rgba(245,200,66,0.4); }
  .pill.active.sonnet { background: rgba(74,158,255,0.12); color: var(--color-sonnet); border-color: rgba(74,158,255,0.4); }
  .pill.active.haiku  { background: rgba(76,175,130,0.12); color: var(--color-haiku);  border-color: rgba(76,175,130,0.4); }

  .clear-filter {
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    cursor: pointer;
    border: 1px solid rgba(91,138,245,0.4);
    background: rgba(91,138,245,0.08);
    color: var(--color-brand);
    transition: all var(--duration-fast);
  }
  .clear-filter:hover { background: rgba(91,138,245,0.15); }

  /* ── Table cells ────────────────────────────────────────────────────────── */
  .description-cell {
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ── Team chip (in-table clickable tag) ─────────────────────────────────── */
  .team-chip {
    display: inline-block;
    padding: 2px var(--space-2);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    cursor: pointer;
    border: 1px solid var(--color-border);
    background: var(--color-surface-2);
    color: var(--color-text-muted);
    text-transform: capitalize;
    white-space: nowrap;
    transition: all var(--duration-fast);
  }
  .team-chip:hover {
    border-color: rgba(91,138,245,0.4);
    color: var(--color-brand);
    background: rgba(91,138,245,0.06);
  }
  .team-chip.active {
    border-color: rgba(91,138,245,0.5);
    color: var(--color-brand);
    background: rgba(91,138,245,0.1);
  }

  /* ── Effort badge ───────────────────────────────────────────────────────── */
  .effort-badge {
    display: inline-block;
    padding: 2px var(--space-2);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  /* rank-0 = max, rank-1 = high, rank-2 = medium, rank-3 = low */
  .rank-0 { background: rgba(245,200,66,0.12);  color: var(--color-opus);    border: 1px solid rgba(245,200,66,0.3); }
  .rank-1 { background: rgba(245,130,66,0.10);  color: #e8844a;              border: 1px solid rgba(245,130,66,0.3); }
  .rank-2 { background: rgba(74,158,255,0.10);  color: var(--color-sonnet);  border: 1px solid rgba(74,158,255,0.25); }
  .rank-3 { background: rgba(76,175,130,0.08);  color: var(--color-haiku);   border: 1px solid rgba(76,175,130,0.2); }
</style>
