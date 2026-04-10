<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  type BranchStatus = 'open-pr' | 'merged' | 'active' | 'stale';

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
  let bulkDeleting = $state(false);
  let activeFilter: BranchStatus | 'all' = $state('all');
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  // ── Sort state ─────────────────────────────────────────────────────────────
  type SortKey = 'name' | 'age' | 'status';
  let sortKey: SortKey = $state('age');
  let sortAsc = $state(false); // newest first by default

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

  async function deleteAllStale() {
    const staleBranches = branches.filter((b) => b.status === 'stale');
    if (staleBranches.length === 0) return;
    if (!confirm(`Delete all ${staleBranches.length} stale branch${staleBranches.length === 1 ? '' : 'es'}? This cannot be undone.`)) return;
    bulkDeleting = true;
    deleteError = null;
    const errors: string[] = [];
    for (const branch of staleBranches) {
      try {
        const res = await fetch(`/api/v5/autonomous-branches/${encodeURIComponent(branch.name)}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          errors.push(`${branch.name}: ${body.error ?? `HTTP ${res.status}`}`);
        } else {
          // Optimistic removal after each success
          branches = branches.filter((b) => b.name !== branch.name);
        }
      } catch (e) {
        errors.push(`${branch.name}: ${String(e)}`);
      }
    }
    if (errors.length > 0) {
      deleteError = `${errors.length} deletion(s) failed:\n${errors.join('\n')}`;
    }
    bulkDeleting = false;
  }

  function formatAge(ageMs: number): string {
    const totalSecs = Math.floor(ageMs / 1000);
    if (totalSecs < 60) return `${totalSecs}s`;
    const totalMins = Math.floor(totalSecs / 60);
    if (totalMins < 60) return `${totalMins}m`;
    const totalHours = Math.floor(totalMins / 60);
    if (totalHours < 24) {
      const remMins = totalMins % 60;
      return remMins > 0 ? `${totalHours}h ${remMins}m` : `${totalHours}h`;
    }
    const days = Math.floor(totalHours / 24);
    const remHours = totalHours % 24;
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
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
    'active':  'var(--color-brand)',
    'stale':   'var(--color-warning)',
  };

  const STATUS_LABEL: Record<BranchStatus, string> = {
    'open-pr': 'Open PR',
    'merged':  'Merged',
    'active':  'Active',
    'stale':   'Stale',
  };

  onMount(() => {
    fetchBranches();
    pollTimer = setInterval(() => fetchBranches(true), 30000);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  // ── Derived counts ─────────────────────────────────────────────────────────
  let openCount   = $derived(branches.filter((b) => b.status === 'open-pr').length);
  let activeCount = $derived(branches.filter((b) => b.status === 'active').length);
  let mergedCount = $derived(branches.filter((b) => b.status === 'merged').length);
  let staleCount  = $derived(branches.filter((b) => b.status === 'stale').length);

  // ── Filtered + sorted view ─────────────────────────────────────────────────
  let filteredBranches = $derived.by(() => {
    const base = activeFilter === 'all'
      ? branches
      : branches.filter((b) => b.status === activeFilter);

    return [...base].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'age')    cmp = a.ageMs - b.ageMs;
      if (sortKey === 'name')   cmp = a.name.localeCompare(b.name);
      if (sortKey === 'status') cmp = a.status.localeCompare(b.status);
      return sortAsc ? cmp : -cmp;
    });
  });

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      sortAsc = !sortAsc;
    } else {
      sortKey = key;
      sortAsc = key === 'name'; // default asc for name, desc for age/status
    }
  }

  function sortIcon(key: SortKey): string {
    if (sortKey !== key) return '↕';
    return sortAsc ? '↑' : '↓';
  }
</script>

<svelte:head><title>Branches — AgentForge</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Autonomous Branches</h1>
    <p class="page-subtitle">Git branch hygiene for <code>autonomous/*</code> cycles</p>
  </div>
  <div class="header-actions">
    {#if staleCount > 0}
      <button
        class="btn btn-danger-ghost"
        onclick={deleteAllStale}
        disabled={bulkDeleting || loading}
        title="Delete all stale branches at once"
      >
        {bulkDeleting ? 'Deleting…' : `Delete All Stale (${staleCount})`}
      </button>
    {/if}
    <button class="btn btn-ghost" onclick={() => fetchBranches()} disabled={loading}>
      {loading ? 'Refreshing…' : 'Refresh'}
    </button>
  </div>
</div>

<!-- Summary pills + filter tabs -->
<div class="summary-bar">
  <button
    class="pill all"
    class:active={activeFilter === 'all'}
    onclick={() => (activeFilter = 'all')}
  >
    <span class="pill-count">{branches.length}</span>
    <span class="pill-label">All</span>
  </button>
  <button
    class="pill open-pr"
    class:active={activeFilter === 'open-pr'}
    onclick={() => (activeFilter = 'open-pr')}
  >
    <span class="pill-count">{openCount}</span>
    <span class="pill-label">Open PR</span>
  </button>
  <button
    class="pill active-pill"
    class:active={activeFilter === 'active'}
    onclick={() => (activeFilter = 'active')}
  >
    <span class="pill-count">{activeCount}</span>
    <span class="pill-label">Active</span>
  </button>
  <button
    class="pill merged"
    class:active={activeFilter === 'merged'}
    onclick={() => (activeFilter = 'merged')}
  >
    <span class="pill-count">{mergedCount}</span>
    <span class="pill-label">Merged</span>
  </button>
  <button
    class="pill stale"
    class:active={activeFilter === 'stale'}
    onclick={() => (activeFilter = 'stale')}
  >
    <span class="pill-count">{staleCount}</span>
    <span class="pill-label">Stale</span>
  </button>
  <span class="auto-refresh-note">Auto-refresh every 30s</span>
</div>

{#if deleteError}
  <div class="error-banner">
    <span style="white-space:pre-wrap;">Delete failed: {deleteError}</span>
    <button class="close-btn" onclick={() => (deleteError = null)} aria-label="Dismiss">✕</button>
  </div>
{/if}

{#if error}
  <div class="error-banner">
    <span>{error}</span>
    <button class="close-btn" onclick={() => fetchBranches()} aria-label="Retry">Retry</button>
  </div>
{/if}

{#if loading && branches.length === 0}
  <div class="card">
    {#each Array(3) as _}
      <div class="skeleton" style="height:52px;margin-bottom:var(--space-2);border-radius:var(--radius-md);"></div>
    {/each}
  </div>
{:else if branches.length === 0 && !error}
  <div class="empty-state">
    <span class="empty-icon">⎇</span>
    <p>No <code>autonomous/*</code> branches found.</p>
    <p class="empty-hint">Run an autonomous cycle to create one.</p>
  </div>
{:else if filteredBranches.length === 0 && activeFilter !== 'all'}
  <div class="empty-state">
    <span class="empty-icon">⎇</span>
    <p>No <strong>{STATUS_LABEL[activeFilter as BranchStatus]}</strong> branches.</p>
    <button class="btn btn-ghost btn-sm" onclick={() => (activeFilter = 'all')} style="margin-top:var(--space-3);">
      Show all branches
    </button>
  </div>
{:else if filteredBranches.length > 0}
  <div class="card" style="padding:0;overflow:hidden;">
    <table class="data-table branches-table">
      <thead>
        <tr>
          <th>
            <button class="sort-btn" onclick={() => toggleSort('name')}>
              Branch <span class="sort-icon">{sortIcon('name')}</span>
            </button>
          </th>
          <th>Cycle</th>
          <th>
            <button class="sort-btn" onclick={() => toggleSort('age')}>
              Age <span class="sort-icon">{sortIcon('age')}</span>
            </button>
          </th>
          <th>Last Commit</th>
          <th>
            <button class="sort-btn" onclick={() => toggleSort('status')}>
              Status <span class="sort-icon">{sortIcon('status')}</span>
            </button>
          </th>
          <th>PR</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each filteredBranches as branch (branch.name)}
          <tr
            class:stale-row={branch.status === 'stale'}
            class:merged-row={branch.status === 'merged'}
            class:deleting-row={deletingBranch === branch.name}
          >
            <td>
              <span class="branch-name" title={branch.name}>{branch.name}</span>
            </td>
            <td>
              <a class="cycle-badge" href="/cycles?q={encodeURIComponent(branch.cycle)}" title="Filter cycles by this branch">
                {branch.cycle}
              </a>
            </td>
            <td>
              <span class="mono" class:age-stale={branch.status === 'stale'}>{formatAge(branch.ageMs)}</span>
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
              {#if branch.status === 'stale' || branch.status === 'merged'}
                <button
                  class="btn-delete"
                  disabled={deletingBranch === branch.name || bulkDeleting}
                  onclick={() => deleteBranch(branch)}
                  title={branch.status === 'merged' ? 'Delete merged branch' : 'Delete stale branch'}
                >
                  {deletingBranch === branch.name ? '…' : 'Delete'}
                </button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if filteredBranches.length > 0}
      <div class="table-footer">
        Showing {filteredBranches.length} of {branches.length} branch{branches.length === 1 ? '' : 'es'}
        {#if activeFilter !== 'all'} · filtered by <strong>{STATUS_LABEL[activeFilter as BranchStatus]}</strong>{/if}
      </div>
    {/if}
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

  .header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
  }

  /* Danger ghost button variant — used for bulk delete */
  .btn-danger-ghost {
    background: color-mix(in srgb, var(--color-danger) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-danger) 30%, transparent);
    color: var(--color-danger);
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    transition: background var(--duration-fast), border-color var(--duration-fast);
    white-space: nowrap;
  }

  .btn-danger-ghost:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-danger) 16%, transparent);
    border-color: color-mix(in srgb, var(--color-danger) 50%, transparent);
  }

  .btn-danger-ghost:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* ── Summary bar / filter tabs ────────────────────────────────────────────── */
  .summary-bar {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
    flex-wrap: wrap;
  }

  /* Pill buttons — double as filter tabs */
  .pill {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-full);
    border: 1px solid var(--color-border);
    background: transparent;
    cursor: pointer;
    transition: background var(--duration-fast), border-color var(--duration-fast), box-shadow var(--duration-fast);
    font-family: inherit;
    font-size: inherit;
  }

  .pill:hover {
    background: var(--color-surface-2);
  }

  /* Active filter state — highlight with a subtle ring */
  .pill.active {
    background: var(--color-surface-2);
    box-shadow: 0 0 0 2px currentColor;
  }

  .pill.all            { color: var(--color-text-muted); }
  .pill.all.active     { color: var(--color-text); box-shadow: 0 0 0 2px var(--color-border-strong); }

  .pill.open-pr        { border-color: color-mix(in srgb, var(--color-info) 26%, transparent); }
  .pill.active-pill    { border-color: color-mix(in srgb, var(--color-brand) 26%, transparent); }
  .pill.merged         { border-color: color-mix(in srgb, var(--color-success) 26%, transparent); }
  .pill.stale          { border-color: color-mix(in srgb, var(--color-warning) 26%, transparent); }

  .pill-count {
    font-size: var(--text-md);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }

  .pill.open-pr  .pill-count { color: var(--color-info); }
  .pill.active-pill .pill-count { color: var(--color-brand); }
  .pill.merged   .pill-count { color: var(--color-success); }
  .pill.stale    .pill-count { color: var(--color-warning); }

  .pill-label {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
  }

  .auto-refresh-note {
    margin-left: auto;
    font-size: var(--text-xs);
    color: var(--color-text-faint);
  }

  /* ── Sort buttons in column headers ──────────────────────────────────────── */
  .sort-btn {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    font: inherit;
    color: inherit;
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .sort-btn:hover { color: var(--color-text); }

  .sort-icon {
    opacity: 0.5;
    font-size: 10px;
  }

  /* ── Table overrides ─────────────────────────────────────────────────────── */
  /* Branch rows are not clickable; override the global pointer cursor that
     data-table tbody tr:hover sets in app.css. */
  .branches-table tbody tr {
    cursor: default;
  }

  .branches-table tbody tr:hover {
    cursor: default;
  }

  /* Stale/merged accent stripe: use inset box-shadow on first cell because
     border-left on <tr> is ignored by browsers with border-collapse:collapse. */
  .stale-row > td:first-child {
    box-shadow: inset 3px 0 0 var(--color-warning);
  }

  .merged-row > td:first-child {
    box-shadow: inset 3px 0 0 color-mix(in srgb, var(--color-success) 60%, transparent);
  }

  /* Dim row while a delete is in flight */
  .deleting-row {
    opacity: 0.45;
    pointer-events: none;
    transition: opacity var(--duration-normal);
  }

  /* ── Cell contents ───────────────────────────────────────────────────────── */
  .branch-name {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-brand);
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: inline-block;
    vertical-align: middle;
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
    text-decoration: none;
    transition: border-color var(--duration-fast), color var(--duration-fast);
  }

  .cycle-badge:hover {
    border-color: var(--color-brand);
    color: var(--color-brand);
  }

  .mono { font-family: var(--font-mono); font-size: var(--text-xs); }
  .muted { color: var(--color-text-muted); }

  /* Age value shown in warning color when the branch is stale */
  .age-stale { color: var(--color-warning); }

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

  /* ── Error banner ────────────────────────────────────────────────────────── */
  .error-banner {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: color-mix(in srgb, var(--color-danger) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-danger) 25%, transparent);
    border-radius: var(--radius-md);
    color: var(--color-danger);
    font-size: var(--text-sm);
    margin-bottom: var(--space-3);
  }

  .close-btn {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: var(--text-sm);
    padding: 0;
    flex-shrink: 0;
    opacity: 0.7;
  }

  .close-btn:hover { opacity: 1; }

  /* ── Empty states ────────────────────────────────────────────────────────── */
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

  .empty-icon {
    font-size: 32px;
    opacity: 0.2;
  }

  .empty-hint {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
  }

  .empty-state code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    background: var(--color-surface-2);
    padding: 1px 4px;
    border-radius: 3px;
  }

  /* ── Table footer ────────────────────────────────────────────────────────── */
  .table-footer {
    padding: var(--space-2) var(--space-4);
    border-top: 1px solid var(--color-border);
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    text-align: right;
  }

  /* ── Responsive ──────────────────────────────────────────────────────────── */
  @media (max-width: 700px) {
    .summary-bar { gap: var(--space-2); }
    .auto-refresh-note { display: none; }
    :global(.branches-table) { font-size: var(--text-xs); }
  }
</style>
