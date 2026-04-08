<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import StageBadge from '$lib/components/StageBadge.svelte';
  import { relativeTime, formatDuration } from '$lib/util/relative-time';
  import { withWorkspace } from '$lib/stores/workspace';

  interface CycleSummary {
    cycleId: string;
    sprintVersion?: string;
    stage: string;
    startedAt: string;
    completedAt?: string | null;
    durationMs?: number | null;
    costUsd?: number | null;
    budgetUsd?: number | null;
    testsPassed?: number | null;
    testsTotal?: number | null;
    prUrl?: string | null;
    hasApprovalPending?: boolean;
  }

  const TERMINAL = new Set(['completed', 'failed', 'killed']);

  let cycles: CycleSummary[] = $state([]);
  let loading = $state(true);
  let error: string | null = $state(null);
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function loadCycles() {
    try {
      const res = await fetch(withWorkspace('/api/v5/cycles?limit=50'));
      if (!res.ok) {
        error = `HTTP ${res.status}`;
        return;
      }
      const json = await res.json();
      const list = (json?.cycles ?? json?.data ?? json ?? []) as CycleSummary[];
      cycles = [...list].sort((a, b) => {
        const ta = new Date(a.startedAt ?? 0).getTime();
        const tb = new Date(b.startedAt ?? 0).getTime();
        return tb - ta;
      });
      error = null;
      managePolling();
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  function hasActive(): boolean {
    return cycles.some((c) => !TERMINAL.has((c.stage ?? '').toLowerCase()));
  }

  function managePolling() {
    if (hasActive()) {
      if (!pollTimer) {
        pollTimer = setInterval(loadCycles, 5000);
      }
    } else if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function shortId(id: string): string {
    return (id ?? '').slice(0, 8);
  }

  function formatCost(cost?: number | null, budget?: number | null): string {
    if (cost == null) return '—';
    const c = `$${cost.toFixed(2)}`;
    if (budget == null) return c;
    return `${c} / $${budget.toFixed(2)}`;
  }

  function costFraction(cost?: number | null, budget?: number | null): number {
    if (cost == null || budget == null || budget <= 0) return 0;
    return Math.min(1, cost / budget);
  }

  function formatTests(passed?: number | null, total?: number | null): string {
    if (total == null) return '—';
    return `${passed ?? 0}/${total}`;
  }

  onMount(() => {
    loadCycles();
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });
</script>

<svelte:head><title>Cycles — AgentForge</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Cycles</h1>
    <p class="page-subtitle">Autonomous sprint cycles — history and live status</p>
  </div>
  <div class="header-actions">
    <button class="btn btn-ghost" onclick={loadCycles} disabled={loading}>
      {loading ? 'Refreshing…' : 'Refresh'}
    </button>
    <a class="btn btn-primary" href="/cycles/new">+ New Cycle</a>
  </div>
</div>

{#if error}
  <div class="error-banner">
    Failed to load cycles: <code>{error}</code>
    <button class="btn btn-ghost btn-sm" onclick={loadCycles}>Retry</button>
  </div>
{/if}

{#if loading && cycles.length === 0}
  <div class="card">
    <div class="skeleton" style="height:24px;margin-bottom:12px;"></div>
    <div class="skeleton" style="height:24px;margin-bottom:12px;"></div>
    <div class="skeleton" style="height:24px;"></div>
  </div>
{:else if cycles.length === 0 && !error}
  <div class="card">
    <div class="empty-state">
      <p>No cycles yet.</p>
      <p>Run one with <code>npm run autonomous:cycle</code> or click the <strong>New Cycle</strong> button.</p>
      <a class="btn btn-primary" href="/cycles/new" style="margin-top:var(--space-4);">+ New Cycle</a>
    </div>
  </div>
{:else if cycles.length > 0}
  <div class="card" style="padding:0;overflow:hidden;">
    <table class="data-table">
      <thead>
        <tr>
          <th>Stage</th>
          <th>Cycle</th>
          <th>Sprint</th>
          <th>Started</th>
          <th>Duration</th>
          <th>Cost</th>
          <th>Tests</th>
          <th>PR</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each cycles as c (c.cycleId)}
          <tr onclick={() => (window.location.href = `/cycles/${c.cycleId}`)}>
            <td><StageBadge stage={c.stage} /></td>
            <td>
              <a class="cycle-id" href="/cycles/{c.cycleId}" onclick={(e) => e.stopPropagation()}>
                {shortId(c.cycleId)}
              </a>
            </td>
            <td><span class="mono">{c.sprintVersion ?? '—'}</span></td>
            <td><span class="muted">{relativeTime(c.startedAt)}</span></td>
            <td><span class="mono">{formatDuration(c.durationMs)}</span></td>
            <td>
              <div class="cost-cell">
                <span class="mono">{formatCost(c.costUsd, c.budgetUsd)}</span>
                {#if c.budgetUsd != null && c.costUsd != null}
                  <div class="cost-bar">
                    <div class="cost-bar-fill" style="width:{costFraction(c.costUsd, c.budgetUsd) * 100}%"></div>
                  </div>
                {/if}
              </div>
            </td>
            <td><span class="mono">{formatTests(c.testsPassed, c.testsTotal)}</span></td>
            <td>
              {#if c.prUrl}
                <a class="pr-link" href={c.prUrl} target="_blank" rel="noopener" onclick={(e) => e.stopPropagation()}>
                  PR ↗
                </a>
              {:else}
                <span class="muted">—</span>
              {/if}
            </td>
            <td>
              {#if c.hasApprovalPending}
                <span class="badge warning" title="Approval pending">⚑ approval</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .header-actions {
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }
  .error-banner {
    background: rgba(224,90,90,0.1);
    border: 1px solid rgba(224,90,90,0.3);
    border-radius: var(--radius-md);
    color: var(--color-danger);
    font-size: var(--text-sm);
    padding: var(--space-3);
    margin-bottom: var(--space-4);
    display: flex;
    align-items: center;
    gap: var(--space-3);
    justify-content: space-between;
  }
  .error-banner code {
    font-family: var(--font-mono);
    background: rgba(224,90,90,0.15);
    padding: 1px 4px;
    border-radius: 3px;
  }
  .cycle-id {
    font-family: var(--font-mono);
    color: var(--color-brand);
    text-decoration: none;
    font-weight: 600;
  }
  .cycle-id:hover { text-decoration: underline; }
  .mono { font-family: var(--font-mono); font-size: var(--text-xs); }
  .muted { color: var(--color-text-muted); font-size: var(--text-xs); }
  .cost-cell {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 110px;
  }
  .cost-bar {
    height: 4px;
    background: var(--color-surface-2);
    border-radius: var(--radius-full);
    overflow: hidden;
  }
  .cost-bar-fill {
    height: 100%;
    background: var(--color-brand);
    transition: width var(--duration-normal) var(--easing-default);
  }
  .pr-link {
    font-size: var(--text-xs);
    color: var(--color-info);
    text-decoration: none;
    font-weight: 500;
  }
  .pr-link:hover { text-decoration: underline; }
  code {
    font-family: var(--font-mono);
    background: var(--color-surface-2);
    padding: 1px 4px;
    border-radius: 3px;
    font-size: var(--text-xs);
  }
  @media (max-width: 700px) {
    :global(.data-table) { font-size: var(--text-xs); }
  }
</style>
