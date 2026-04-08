<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  type BranchStatus = 'open-pr' | 'merged' | 'stale';

  interface AutonomousBranch {
    name: string;
    cycle: string;
    lastCommitAt: string;
    ageMs: number;
    status: BranchStatus;
    prNumber: number | null;
    prUrl: string | null;
  }

  let branches: AutonomousBranch[] = $state([]);
  let loading = $state(true);
  let error: string | null = $state(null);
  let deletingBranch: string | null = $state(null);
  let deleteError: string | null = $state(null);
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function fetchBranches(silent = false) {
    if (!silent) loading = true;
    error = null;
    try {
      const res = await fetch('/api/v5/autonomous-branches');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      branches = (json.data ?? []) as AutonomousBranch[];
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  async function deleteBranch(branch: AutonomousBranch) {
    if (!confirm(`Delete branch "${branch.name}"? This cannot be undone.`)) return;
    deletingBranch = branch.name;
    deleteError = null;
    try {
      const res = await fetch(`/api/v5/autonomous-branches/${encodeURIComponent(branch.name)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      // Optimistic removal
      branches = branches.filter((b) => b.name !== branch.name);
    } catch (e) {
      deleteError = String(e);
    } finally {
      deletingBranch = null;
    }
  }

  function formatAge(ageMs: number): string {
    const s = Math.floor(ageMs / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  }

  function formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    } catch {
      return iso;
    }
  }

  const STATUS_COLOR: Record<BranchStatus, string> = {
    'open-pr': 'var(--color-info)',
    'merged':  'var(--color-success)',
    'stale':   'var(--color-warning)',
  };

  const STATUS_LABEL: Record<BranchStatus, string> = {
    'open-pr': 'Open PR',
    'merged':  'Merged',
    'stale':   'Stale',
  };

  onMount(() => {
    fetchBranches();
    pollTimer = setInterval(() => fetchBranches(true), 30000);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  let openCount = $derived(branches.filter((b) => b.status === 'open-pr').length);
  let mergedCount = $derived(branches.filter((b) => b.status === 'merged').length);
  let staleCount = $derived(branches.filter((b) => b.status === 'stale').length);
</script>

<svelte:head><title>Branches — AgentForge</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Autonomous Branches</h1>
    <p class="page-subtitle">Git branch hygiene for <code>autonomous/*</code> cycles</p>
  </div>
  <button class="btn btn-ghost" onclick={() => fetchBranches()} disabled={loading}>
    {loading ? 'Refreshing…' : 'Refresh'}
  </button>
</div>

<!-- Summary pills -->
<div class="summary-bar">
  <div class="pill open-pr">
    <span class="pill-count">{openCount}</span>
    <span class="pill-label">Open PR</span>
  </div>
  <div class="pill merged">
    <span class="pill-count">{mergedCount}</span>
    <span class="pill-label">Merged</span>
  </div>
  <div class="pill stale">
    <span class="pill-count">{staleCount}</span>
    <span class="pill-label">Stale</span>
  </div>
  <span class="auto-refresh-note">Auto-refresh every 30s</span>
</div>

{#if deleteError}
  <div class="error-banner">Delete failed: {deleteError}</div>
{/if}

{#if error}
  <div class="error-banner">{error}</div>
{/if}

{#if loading && branches.length === 0}
  <div class="card">
    {#each Array(3) as _}
      <div class="skeleton" style="height:52px;margin-bottom:var(--space-2);border-radius:var(--radius-md);"></div>
    {/each}
  </div>
{:else if branches.length === 0 && !error}
  <div class="empty-state">
    <span style="font-size:32px;opacity:0.2;">⎇</span>
    <p>No <code>autonomous/*</code> branches found.</p>
    <p style="font-size:var(--text-xs);color:var(--color-text-faint);">Run an autonomous cycle to create one.</p>
  </div>
{:else if branches.length > 0}
  <div class="card" style="padding:0;overflow:hidden;">
    <table class="data-table">
      <thead>
        <tr>
          <th>Branch</th>
          <th>Cycle</th>
          <th>Age</th>
          <th>Last Commit</th>
          <th>Status</th>
          <th>PR</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each branches as branch (branch.name)}
          <tr class:stale-row={branch.status === 'stale'}>
            <td>
              <span class="branch-name">{branch.name}</span>
            </td>
            <td>
              <span class="cycle-badge">{branch.cycle}</span>
            </td>
            <td>
              <span class="mono muted">{formatAge(branch.ageMs)}</span>
            </td>
            <td>
              <span class="mono muted">{formatDate(branch.lastCommitAt)}</span>
            </td>
            <td>
              <span
                class="status-badge"
                style="color:{STATUS_COLOR[branch.status]};border-color:{STATUS_COLOR[branch.status]}44;background:{STATUS_COLOR[branch.status]}18;"
              >
                {STATUS_LABEL[branch.status]}
              </span>
            </td>
            <td>
              {#if branch.prUrl}
                <a class="pr-link" href={branch.prUrl} target="_blank" rel="noopener">
                  #{branch.prNumber} ↗
                </a>
              {:else}
                <span class="muted">—</span>
              {/if}
            </td>
            <td class="action-cell">
              {#if branch.status === 'stale'}
                <button
                  class="btn-delete"
                  disabled={deletingBranch === branch.name}
                  onclick={() => deleteBranch(branch)}
                  title="Delete stale branch"
                >
                  {deletingBranch === branch.name ? '…' : 'Delete'}
                </button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: var(--space-4);
  }

  .page-title {
    font-size: var(--text-xl);
    font-weight: 600;
    color: var(--color-text);
    margin: 0 0 var(--space-1) 0;
  }

  .page-subtitle {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    margin: 0;
  }

  .page-subtitle code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    background: var(--color-surface-2);
    padding: 1px 4px;
    border-radius: 3px;
  }

  /* Summary bar */
  .summary-bar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
  }

  .pill {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-full);
    border: 1px solid var(--color-border);
    background: var(--color-bg-card);
  }

  .pill.open-pr  { border-color: color-mix(in srgb, var(--color-info) 26%, transparent);    }
  .pill.merged   { border-color: color-mix(in srgb, var(--color-success) 26%, transparent); }
  .pill.stale    { border-color: color-mix(in srgb, var(--color-warning) 26%, transparent); }

  .pill-count {
    font-size: var(--text-lg);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .pill.open-pr  .pill-count { color: var(--color-info);    }
  .pill.merged   .pill-count { color: var(--color-success);  }
  .pill.stale    .pill-count { color: var(--color-warning);  }

  .pill-label {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
  }

  .auto-refresh-note {
    margin-left: auto;
    font-size: var(--text-xs);
    color: var(--color-text-faint);
  }

  /* Table rows */
  /* Use box-shadow instead of border-left: with border-collapse:collapse,
     borders belong to cells, not rows — border-left on <tr> is ignored by
     most browsers. An inset box-shadow on the first cell gives the same
     visual result and works across all browsers. */
  .stale-row > td:first-child {
    box-shadow: inset 3px 0 0 var(--color-warning);
  }

  .branch-name {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-brand);
  }

  .cycle-badge {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    background: var(--color-surface-2);
    border-radius: var(--radius-sm);
    padding: 2px var(--space-2);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    white-space: nowrap;
  }

  .mono { font-family: var(--font-mono); font-size: var(--text-xs); }
  .muted { color: var(--color-text-muted); }

  .status-badge {
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 2px var(--space-2);
    border-radius: var(--radius-full);
    border: 1px solid transparent;
    white-space: nowrap;
  }

  .pr-link {
    font-size: var(--text-xs);
    color: var(--color-info);
    text-decoration: none;
    font-weight: 500;
    white-space: nowrap;
  }

  .pr-link:hover { text-decoration: underline; }

  .action-cell {
    text-align: right;
    min-width: 80px;
  }

  .btn-delete {
    background: color-mix(in srgb, var(--color-danger) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-danger) 35%, transparent);
    color: var(--color-danger);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-xs);
    font-weight: 600;
    cursor: pointer;
    transition: background var(--duration-fast), border-color var(--duration-fast);
    white-space: nowrap;
  }

  .btn-delete:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-danger) 20%, transparent);
    border-color: color-mix(in srgb, var(--color-danger) 55%, transparent);
  }

  .btn-delete:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Error / empty */
  .error-banner {
    padding: var(--space-3) var(--space-4);
    background: color-mix(in srgb, var(--color-danger) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-danger) 25%, transparent);
    border-radius: var(--radius-md);
    color: var(--color-danger);
    font-size: var(--text-sm);
    margin-bottom: var(--space-3);
  }

  .empty-state {
    text-align: center;
    padding: var(--space-12) var(--space-8);
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
  }

  .empty-state code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    background: var(--color-surface-2);
    padding: 1px 4px;
    border-radius: 3px;
  }
</style>
