<script lang="ts">
  import { costs, costsLoading, costsError, totalUsd, loadCosts } from '$lib/stores/costs.js';
  import { derived } from 'svelte/store';
  import { onMount } from 'svelte';

  let summary: { totalCostUsd: number; totalSessions: number; byModel: Array<{ model: string; costUsd: number; sessions: number }> } | null = null;

  async function loadSummary() {
    try {
      const res = await fetch('/api/v5/costs/summary');
      if (res.ok) {
        const json = await res.json();
        summary = json.data;
      }
    } catch { /* ignore */ }
  }

  onMount(() => { loadCosts(); loadSummary(); });

  // Per-model-tier breakdown
  const modelTotals = derived(costs, $costs => {
    const tiers: Record<string, { costUsd: number; sessions: number }> = {};
    for (const r of $costs) {
      const key = r.model || 'unknown';
      if (!tiers[key]) tiers[key] = { costUsd: 0, sessions: 0 };
      tiers[key].costUsd += r.totalCostUsd ?? r.cost_usd ?? 0;
      tiers[key].sessions += r.sessionCount ?? r.session_count ?? 0;
    }
    return Object.entries(tiers).sort((a, b) => b[1].costUsd - a[1].costUsd);
  });

  function agentId(r: (typeof $costs)[0]): string {
    return r.agentId || r.agent_id || '—';
  }

  function costUsd(r: (typeof $costs)[0]): number {
    return r.totalCostUsd ?? r.cost_usd ?? 0;
  }

  function sessionCount(r: (typeof $costs)[0]): number {
    return r.sessionCount ?? r.session_count ?? 0;
  }

  function modelClass(model: string): string {
    if (model.includes('opus')) return 'opus';
    if (model.includes('sonnet')) return 'sonnet';
    if (model.includes('haiku')) return 'haiku';
    return 'muted';
  }
</script>

<svelte:head><title>Cost Analytics — AgentForge</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Cost Analytics</h1>
    <p class="page-subtitle">Token usage and spend by agent and model</p>
  </div>
  <button class="btn btn-ghost btn-sm" on:click={loadCosts} disabled={$costsLoading}>
    {$costsLoading ? 'Loading…' : 'Refresh'}
  </button>
</div>

{#if summary}
  <div class="summary-banner">
    <div class="stat-card">
      <div class="stat-label">Total Spend</div>
      <div class="stat-value">${summary.totalCostUsd.toFixed(4)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total Sessions</div>
      <div class="stat-value">{summary.totalSessions}</div>
    </div>
    {#if summary.byModel.length > 0}
      <div class="stat-card">
        <div class="stat-label">Top Model</div>
        <div class="stat-value">{summary.byModel.slice().sort((a, b) => b.costUsd - a.costUsd)[0]?.model.split('-')[1] ?? summary.byModel[0]?.model ?? '—'}</div>
      </div>
    {/if}
  </div>
{/if}

{#if $costsError}
  <div class="empty-state" style="color:var(--color-danger);">
    {$costsError}
    <button class="btn btn-ghost btn-sm" style="margin-top:var(--space-3)" on:click={loadCosts}>Retry</button>
  </div>
{:else if $costsLoading}
  <div class="skeleton" style="height:120px;"></div>
{:else}
  <!-- Summary stat cards -->
  <div class="stat-grid" style="margin-bottom:var(--space-6);">
    <div class="stat-card">
      <div class="stat-value">${$totalUsd.toFixed(4)}</div>
      <div class="stat-label">Total Spend</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">{$costs.length}</div>
      <div class="stat-label">Agents with Spend</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">
        {$costs.reduce((n, r) => n + sessionCount(r), 0)}
      </div>
      <div class="stat-label">Total Sessions</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">
        {$costs.length > 0
          ? `$${($totalUsd / $costs.reduce((n, r) => n + Math.max(sessionCount(r), 1), 0)).toFixed(4)}`
          : '$0.0000'}
      </div>
      <div class="stat-label">Avg Cost / Session</div>
    </div>
  </div>

  <!-- Model tier breakdown -->
  {#if $modelTotals.length > 0}
    <div class="card" style="margin-bottom:var(--space-6);">
      <div class="card-header">
        <span class="card-title">By Model Tier</span>
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Sessions</th>
            <th>Spend</th>
            <th>% of Total</th>
          </tr>
        </thead>
        <tbody>
          {#each $modelTotals as [model, stats]}
            <tr>
              <td><span class="badge {modelClass(model)}">{model}</span></td>
              <td style="font-family:var(--font-mono);">{stats.sessions}</td>
              <td style="font-family:var(--font-mono);">${stats.costUsd.toFixed(4)}</td>
              <td style="font-family:var(--font-mono);">
                {$totalUsd > 0 ? Math.round(stats.costUsd / $totalUsd * 100) : 0}%
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <!-- Per-agent breakdown -->
  {#if $costs.length === 0}
    <div class="empty-state">No cost records yet — run some agents to see spend breakdown.</div>
  {:else}
    <div class="card" style="padding:0; overflow:hidden;">
      <div class="card-header" style="padding:var(--space-4) var(--space-5);">
        <span class="card-title">Per-Agent Breakdown</span>
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th>Agent ID</th>
            <th>Model</th>
            <th>Sessions</th>
            <th>Total Spend</th>
            <th>Avg / Session</th>
          </tr>
        </thead>
        <tbody>
          {#each $costs as record}
            <tr>
              <td style="font-family:var(--font-mono); font-size:var(--text-xs);">{agentId(record)}</td>
              <td>
                {#if record.model}
                  <span class="badge {modelClass(record.model)}">{record.model}</span>
                {:else}
                  <span class="badge muted">—</span>
                {/if}
              </td>
              <td style="font-family:var(--font-mono);">{sessionCount(record)}</td>
              <td style="font-family:var(--font-mono);">${costUsd(record).toFixed(4)}</td>
              <td style="font-family:var(--font-mono);">
                {sessionCount(record) > 0
                  ? `$${(costUsd(record) / sessionCount(record)).toFixed(4)}`
                  : '—'}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/if}

<style>
.summary-banner {
  display: flex;
  gap: var(--space-4);
  margin-bottom: var(--space-6);
  flex-wrap: wrap;
}
.stat-card {
  background: var(--color-surface-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-4) var(--space-6);
  min-width: 140px;
}
.stat-label {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: var(--space-1);
}
.stat-value {
  font-size: var(--text-xl);
  font-weight: 700;
  color: var(--color-text);
}
</style>
