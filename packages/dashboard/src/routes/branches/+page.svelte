<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  type BranchStatus = 'open_pr' | 'merged' | 'active' | 'stale';

  interface PrInfo {
    number: number;
    title: string;
    state: string;
    url: string | null;
  }

  interface AutonomousBranch {
    name: string;
    cycle: string;
    /** ISO 8601 timestamp of the branch tip commit */
    createdAt: string;
    sha: string;
    age: string;
    ageMs: number;
    status: BranchStatus;
    pr: PrInfo | null;
  }

  /** Must match STALE_DAYS × 24h in src/server/routes/branches.ts (currently 30 days) */
  const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;
  const POLL_INTERVAL_S    = 30;

  let branches: AutonomousBranch[] = $state([]);
  let loading   = $state(true);
  let error: string | null = $state(null);

  let deletingBranch: string | null  = $state(null);
  /** Branch name awaiting inline second-click confirm */
  let confirmingDelete: string | null = $state(null);
  let deleteError: string | null      = $state(null);
  let bulkConfirm  = $state(false);   // two-step for bulk delete
  let bulkDeleting = $state(false);

  let activeFilter: BranchStatus | 'all' = $state('all');
  let searchQuery   = $state('');
  let pollTimer:    ReturnType<typeof setInterval> | null = null;
  let tickTimer:    ReturnType<typeof setInterval> | null = null;
  let nextRefreshIn = $state(POLL_INTERVAL_S);

  /** Copy text to clipboard; ignore silently if not available */
  function copyBranchName(name: string) {
    navigator.clipboard?.writeText(name).catch(() => {});
  }

  // ── Sort state ─────────────────────────────────────────────────────────────
  type SortKey = 'name' | 'age' | 'status';
  let sortKey: SortKey = $state('age');
  let sortAsc = $state(false); // newest-first default

  async function fetchBranches(silent = false) {
    if (!silent) loading = true;
    error = null;
    try {
      const res = await fetch('/api/v1/branches');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      branches = (json.data ?? []) as AutonomousBranch[];
      nextRefreshIn = POLL_INTERVAL_S;
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  async function deleteBranch(branch: AutonomousBranch) {
    confirmingDelete = null;
    deletingBranch   = branch.name;
    deleteError      = null;
    try {
      const res = await fetch(
        `/api/v1/branches/${encodeURIComponent(branch.name)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      branches = branches.filter((b) => b.name !== branch.name);
    } catch (e) {
      deleteError = String(e);
    } finally {
      deletingBranch = null;
    }
  }

  async function deleteAllStale() {
    bulkConfirm  = false;
    bulkDeleting = true;
    deleteError  = null;
    const staleBranches = branches.filter((b) => b.status === 'stale');
    const errors: string[] = [];
    for (const branch of staleBranches) {
      try {
        const res = await fetch(
          `/api/v1/branches/${encodeURIComponent(branch.name)}`,
          { method: 'DELETE' },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          errors.push(`${branch.name}: ${body.error ?? `HTTP ${res.status}`}`);
        } else {
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
    // If the stale filter is active and we just cleared all stale branches,
    // revert to "all" so the user doesn't land on an empty filtered view.
    if (activeFilter === 'stale' && branches.filter((b) => b.status === 'stale').length === 0) {
      activeFilter = 'all';
    }
  }

  function formatAge(ageMs: number): string {
    const totalSecs  = Math.floor(ageMs / 1000);
    if (totalSecs < 60) return `${totalSecs}s`;
    const totalMins  = Math.floor(totalSecs / 60);
    if (totalMins  < 60) return `${totalMins}m`;
    const totalHours = Math.floor(totalMins  / 60);
    if (totalHours < 24) {
      const remMins = totalMins % 60;
      return remMins > 0 ? `${totalHours}h ${remMins}m` : `${totalHours}h`;
    }
    const days     = Math.floor(totalHours / 24);
    const remHours = totalHours % 24;
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
  }

  function formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleString('en-US', {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: false,
      });
    } catch { return iso; }
  }

  /**
   * Returns a 0–1 fraction representing how far this branch is toward the
   * stale threshold.  Capped at 1 (already stale).
   */
  function ageRatio(ageMs: number): number {
    return Math.min(1, ageMs / STALE_THRESHOLD_MS);
  }

  const STATUS_COLOR: Record<BranchStatus, string> = {
    'open_pr': 'var(--color-info)',
    'merged':  'var(--color-success)',
    'active':  'var(--color-brand)',
    'stale':   'var(--color-warning)',
  };

  const STATUS_LABEL: Record<BranchStatus, string> = {
    'open_pr': 'Open PR',
    'merged':  'Merged',
    'active':  'Active',
    'stale':   'Stale',
  };

  onMount(() => {
    fetchBranches();
    pollTimer = setInterval(() => fetchBranches(true), POLL_INTERVAL_S * 1000);
    tickTimer = setInterval(() => {
      nextRefreshIn = Math.max(0, nextRefreshIn - 1);
    }, 1000);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    if (tickTimer)  clearInterval(tickTimer);
  });

  // ── Derived counts ─────────────────────────────────────────────────────────
  let openCount   = $derived(branches.filter((b) => b.status === 'open_pr').length);
  let activeCount = $derived(branches.filter((b) => b.status === 'active').length);
  let mergedCount = $derived(branches.filter((b) => b.status === 'merged').length);
  let staleCount  = $derived(branches.filter((b) => b.status === 'stale').length);

  // ── Filtered + sorted view ─────────────────────────────────────────────────
  let filteredBranches = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();

    const base = branches.filter((b) => {
      const matchStatus = activeFilter === 'all' || b.status === activeFilter;
      const matchSearch = !q || b.name.toLowerCase().includes(q) || b.cycle.toLowerCase().includes(q);
      return matchStatus && matchSearch;
    });

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

  function cancelConfirm(e: MouseEvent) {
    // Clicking anywhere outside the inline confirm dismisses it
    const target = e.target as HTMLElement;
    if (!target.closest('.confirm-group')) confirmingDelete = null;
  }
</script>

<svelte:head><title>Branches — AgentForge</title></svelte:head>
<svelte:window onclick={cancelConfirm} />
<div class="page-header">
  <div>
    <h1 class="page-title">⎇ Autonomous Branches</h1>
    <p class="page-subtitle">
      Git hygiene for <code>autonomous/*</code> cycles ·
      branches with no open PR become <strong>stale</strong> after 30 days
    </p>
  </div>
  <div class="header-actions">
    {#if staleCount > 0 && !bulkConfirm}
      <button
        class="btn btn-danger-ghost"
        onclick={() => (bulkConfirm = true)}
        disabled={bulkDeleting || loading}
        title="Delete all stale branches at once"
      >
        Delete All Stale ({staleCount})
      </button>
    {/if}
    {#if bulkConfirm}
      <span class="bulk-confirm-prompt">Delete {staleCount} stale branch{staleCount === 1 ? '' : 'es'}?</span>
      <button class="btn btn-danger-solid btn-sm" onclick={deleteAllStale} disabled={bulkDeleting}>
        {bulkDeleting ? 'Deleting…' : 'Yes, delete all'}
      </button>
      <button class="btn btn-ghost btn-sm" onclick={() => (bulkConfirm = false)}>Cancel</button>
    {/if}
    <button
      class="btn btn-ghost"
      onclick={() => fetchBranches()}
      disabled={loading}
      title="Refresh branch list"
    >
      {loading ? 'Refreshing…' : 'Refresh'}
    </button>
  </div>
</div>

<!-- Summary pills / filter tabs -->
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
    class:active={activeFilter === 'open_pr'}
    onclick={() => (activeFilter = 'open_pr')}
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

  <span class="refresh-countdown" title="Next auto-refresh">
    ↻ {nextRefreshIn}s
  </span>
</div>

<!-- Search bar — filters by branch name or cycle identifier -->
<div class="search-bar">
  <span class="search-icon" aria-hidden="true">⌕</span>
  <input
    class="search-input"
    type="search"
    bind:value={searchQuery}
    placeholder="Search branch or cycle…"
    aria-label="Search branches"
    spellcheck="false"
    autocomplete="off"
  />
  {#if searchQuery}
    <button class="search-clear" onclick={() => (searchQuery = '')} aria-label="Clear search">✕</button>
  {/if}
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
  <!-- Skeleton rows that match actual row heights -->
  <div class="card" style="padding:0;overflow:hidden;">
    {#each Array(4) as _}
      <div class="skeleton-row">
        <div class="skeleton" style="width:220px;height:14px;border-radius:3px;"></div>
        <div class="skeleton" style="width:90px;height:14px;border-radius:3px;"></div>
        <div class="skeleton" style="width:70px;height:14px;border-radius:3px;"></div>
        <div class="skeleton" style="width:100px;height:14px;border-radius:3px;"></div>
        <div class="skeleton" style="width:60px;height:18px;border-radius:9px;"></div>
      </div>
    {/each}
  </div>
{:else if branches.length === 0 && !error}
  <div class="empty-state">
    <span class="empty-icon">⎇</span>
    <p>No <code>autonomous/*</code> branches found.</p>
    <p class="empty-hint">Start an autonomous cycle to create one.</p>
  </div>
{:else if filteredBranches.length === 0 && (activeFilter !== 'all' || searchQuery)}
  <div class="empty-state">
    <span class="empty-icon">⎇</span>
    {#if searchQuery && activeFilter !== 'all'}
      <p>No <strong>{STATUS_LABEL[activeFilter as BranchStatus]}</strong> branches matching <code>{searchQuery}</code>.</p>
    {:else if searchQuery}
      <p>No branches matching <code>{searchQuery}</code>.</p>
    {:else}
      <p>No <strong>{STATUS_LABEL[activeFilter as BranchStatus]}</strong> branches.</p>
    {/if}
    <button
      class="btn btn-ghost btn-sm"
      onclick={() => { activeFilter = 'all'; searchQuery = ''; }}
      style="margin-top:var(--space-3);"
    >
      Clear filters
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
            <!-- Branch name with copy-on-click -->
            <td>
              <button
                class="branch-name-btn"
                onclick={() => copyBranchName(branch.name)}
                title="Click to copy: {branch.name}"
                aria-label="Copy branch name {branch.name}"
              >
                <span class="branch-name">{branch.name}</span>
                <span class="copy-hint" aria-hidden="true">⊕</span>
              </button>
            </td>

            <!-- Cycle shortlink — navigates to the cycle detail page -->
            <td>
              <a
                class="cycle-badge"
                href="/cycles/{encodeURIComponent(branch.cycle)}"
                title="View cycle {branch.cycle}"
              >
                {branch.cycle}
              </a>
            </td>

            <!-- Age + visual staleness bar -->
            <td class="age-cell">
              <span class="mono" class:age-stale={branch.status === 'stale'}>
                {formatAge(branch.ageMs)}
              </span>
              <div
                class="age-bar-track"
                title="{Math.round(ageRatio(branch.ageMs) * 100)}% toward stale threshold"
              >
                <div
                  class="age-bar-fill"
                  class:age-bar-warning={ageRatio(branch.ageMs) >= 0.7}
                  class:age-bar-danger={ageRatio(branch.ageMs) >= 1}
                  style="width:{ageRatio(branch.ageMs) * 100}%"
                ></div>
              </div>
            </td>

            <!-- Last commit timestamp -->
            <td>
              <span class="mono muted">{formatDate(branch.createdAt)}</span>
            </td>

            <!-- Status badge -->
            <td>
              <span
                class="status-badge"
                style="color:{STATUS_COLOR[branch.status]};border-color:{STATUS_COLOR[branch.status]}44;background:{STATUS_COLOR[branch.status]}18;"
              >
                {STATUS_LABEL[branch.status]}
              </span>
            </td>

            <!-- PR link -->
            <td>
              {#if branch.pr?.url}
                <a class="pr-link" href={branch.pr.url} target="_blank" rel="noopener">
                  #{branch.pr.number} ↗
                </a>
              {:else if branch.pr}
                <span class="mono muted">#{branch.pr.number}</span>
              {:else}
                <span class="muted">—</span>
              {/if}
            </td>

            <!-- Delete action — inline two-step confirm -->
            <td class="action-cell">
              {#if branch.status === 'stale' || branch.status === 'merged'}
                {#if confirmingDelete === branch.name}
                  <span class="confirm-group">
                    <span class="confirm-label">Sure?</span>
                    <button
                      class="btn-delete btn-delete-confirm"
                      onclick={() => deleteBranch(branch)}
                      disabled={deletingBranch !== null || bulkDeleting}
                    >Yes</button>
                    <button
                      class="btn-cancel-confirm"
                      onclick={() => (confirmingDelete = null)}
                    >No</button>
                  </span>
                {:else}
                  <button
                    class="btn-delete"
                    disabled={deletingBranch === branch.name || bulkDeleting}
                    onclick={() => (confirmingDelete = branch.name)}
                    title={branch.status === 'merged' ? 'Delete merged branch' : 'Delete stale branch'}
                  >
                    {deletingBranch === branch.name ? '…' : 'Delete'}
                  </button>
                {/if}
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>

    <div class="table-footer">
      Showing {filteredBranches.length} of {branches.length} branch{branches.length === 1 ? '' : 'es'}
      {#if activeFilter !== 'all'} · filtered by <strong>{STATUS_LABEL[activeFilter as BranchStatus]}</strong>{/if}
      {#if searchQuery} · search: <code class="footer-code">{searchQuery}</code>{/if}
    </div>
  </div>
{/if}

<style>
  /* ── Page header ─────────────────────────────────────────────────────────── */
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

  .page-subtitle strong {
    color: var(--color-warning);
    font-weight: 600;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
  }

  /* Bulk confirm prompt */
  .bulk-confirm-prompt {
    font-size: var(--text-sm);
    color: var(--color-warning);
    font-weight: 500;
    white-space: nowrap;
  }

  /* Danger ghost variant */
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
    font-family: inherit;
  }

  .btn-danger-ghost:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-danger) 16%, transparent);
    border-color: color-mix(in srgb, var(--color-danger) 50%, transparent);
  }

  .btn-danger-ghost:disabled { opacity: 0.4; cursor: not-allowed; }

  /* Solid danger variant — used for second-click confirmation */
  .btn-danger-solid {
    background: var(--color-danger);
    border: 1px solid var(--color-danger);
    color: #fff;
    font-family: inherit;
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: 600;
    cursor: pointer;
    transition: opacity var(--duration-fast);
  }

  .btn-danger-solid:hover:not(:disabled) { opacity: 0.88; }
  .btn-danger-solid:disabled { opacity: 0.4; cursor: not-allowed; }

  /* ── Summary bar ─────────────────────────────────────────────────────────── */
  .summary-bar {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
    flex-wrap: wrap;
  }

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

  .pill:hover { background: var(--color-surface-2); }

  .pill.active {
    background: var(--color-surface-2);
    box-shadow: 0 0 0 2px currentColor;
  }

  .pill.all            { color: var(--color-text-muted); }
  .pill.all.active     { color: var(--color-text); box-shadow: 0 0 0 2px var(--color-border-strong); }
  .pill.open-pr        { border-color: color-mix(in srgb, var(--color-info)    26%, transparent); }
  .pill.active-pill    { border-color: color-mix(in srgb, var(--color-brand)   26%, transparent); }
  .pill.merged         { border-color: color-mix(in srgb, var(--color-success) 26%, transparent); }
  .pill.stale          { border-color: color-mix(in srgb, var(--color-warning) 26%, transparent); }

  .pill-count {
    font-size: var(--text-md);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }

  .pill.open-pr   .pill-count { color: var(--color-info); }
  .pill.active-pill .pill-count { color: var(--color-brand); }
  .pill.merged    .pill-count { color: var(--color-success); }
  .pill.stale     .pill-count { color: var(--color-warning); }

  .pill-label {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
  }

  /* Live countdown to next auto-refresh */
  .refresh-countdown {
    margin-left: auto;
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    font-family: var(--font-mono);
    letter-spacing: 0.02em;
    user-select: none;
  }

  /* ── Sort buttons ────────────────────────────────────────────────────────── */
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

  /* ── Skeleton rows ───────────────────────────────────────────────────────── */
  .skeleton-row {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--color-border);
  }

  .skeleton-row:last-child { border-bottom: none; }

  /* ── Table overrides ─────────────────────────────────────────────────────── */
  .branches-table tbody tr { cursor: default; }
  .branches-table tbody tr:hover { cursor: default; }

  /* Left accent stripe via inset box-shadow (border-left ignored under border-collapse) */
  .stale-row > td:first-child {
    box-shadow: inset 3px 0 0 var(--color-warning);
  }

  .merged-row > td:first-child {
    box-shadow: inset 3px 0 0 color-mix(in srgb, var(--color-success) 60%, transparent);
  }

  /* Dim row while delete is in-flight */
  .deleting-row {
    opacity: 0.4;
    pointer-events: none;
    transition: opacity var(--duration-normal);
  }

  /* ── Branch name cell — acts as a copy button ────────────────────────────── */
  .branch-name-btn {
    background: none;
    border: none;
    padding: 0;
    cursor: copy;
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-family: inherit;
    max-width: 260px;
  }

  .branch-name {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-brand);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .copy-hint {
    font-size: 10px;
    color: var(--color-text-faint);
    opacity: 0;
    transition: opacity var(--duration-fast);
    flex-shrink: 0;
  }

  .branch-name-btn:hover .copy-hint { opacity: 1; }
  .branch-name-btn:hover .branch-name { color: var(--color-brand-hover); }

  /* ── Age cell ─────────────────────────────────────────────────────────────── */
  .age-cell {
    min-width: 90px;
  }

  /* Micro progress bar showing time-to-stale progress */
  .age-bar-track {
    margin-top: 4px;
    height: 3px;
    background: var(--color-surface-3);
    border-radius: 2px;
    overflow: hidden;
    width: 64px;
  }

  .age-bar-fill {
    height: 100%;
    background: var(--color-brand);
    border-radius: 2px;
    transition: width var(--duration-normal);
  }

  .age-bar-fill.age-bar-warning { background: var(--color-warning); }
  .age-bar-fill.age-bar-danger  { background: var(--color-danger); }

  /* ── Cell helpers ────────────────────────────────────────────────────────── */
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

  .mono  { font-family: var(--font-mono); font-size: var(--text-xs); }
  .muted { color: var(--color-text-muted); }

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
    min-width: 120px;
  }

  /* ── Delete button ───────────────────────────────────────────────────────── */
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
    font-family: inherit;
  }

  .btn-delete:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-danger) 20%, transparent);
    border-color: color-mix(in srgb, var(--color-danger) 55%, transparent);
  }

  .btn-delete:disabled { opacity: 0.4; cursor: not-allowed; }

  /* ── Inline confirm group (shown instead of native confirm()) ────────────── */
  .confirm-group {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    animation: fade-in var(--duration-fast) ease;
  }

  @keyframes fade-in {
    from { opacity: 0; transform: translateX(4px); }
    to   { opacity: 1; transform: translateX(0); }
  }

  .confirm-label {
    font-size: var(--text-xs);
    color: var(--color-warning);
    font-weight: 600;
    white-space: nowrap;
  }

  .btn-delete-confirm {
    /* inherits .btn-delete — already a filled danger look on second click */
    background: var(--color-danger);
    border-color: var(--color-danger);
    color: #fff;
  }

  .btn-delete-confirm:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-danger) 85%, #fff);
  }

  .btn-cancel-confirm {
    background: none;
    border: 1px solid var(--color-border);
    color: var(--color-text-muted);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-md);
    font-size: var(--text-xs);
    cursor: pointer;
    transition: background var(--duration-fast);
    font-family: inherit;
  }

  .btn-cancel-confirm:hover { background: var(--color-surface-2); }

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

  /* ── Search bar ─────────────────────────────────────────────────────────── */
  .search-bar {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
    padding: var(--space-2) var(--space-3);
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    transition: border-color var(--duration-fast);
  }

  .search-bar:focus-within {
    border-color: var(--color-brand);
  }

  .search-icon {
    color: var(--color-text-faint);
    font-size: var(--text-md);
    flex-shrink: 0;
    user-select: none;
    line-height: 1;
  }

  .search-input {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    font-size: var(--text-sm);
    font-family: var(--font-mono);
    color: var(--color-text);
    min-width: 0;
  }

  .search-input::placeholder {
    color: var(--color-text-faint);
    font-family: inherit;
  }

  /* Remove browser default search decoration */
  .search-input::-webkit-search-cancel-button { display: none; }

  .search-clear {
    background: none;
    border: none;
    padding: 0 var(--space-1);
    color: var(--color-text-faint);
    cursor: pointer;
    font-size: var(--text-xs);
    flex-shrink: 0;
    line-height: 1;
    transition: color var(--duration-fast);
  }

  .search-clear:hover { color: var(--color-text); }

  /* ── Table footer ────────────────────────────────────────────────────────── */
  .table-footer {
    padding: var(--space-2) var(--space-4);
    border-top: 1px solid var(--color-border);
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    text-align: right;
  }

  .footer-code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    background: var(--color-surface-2);
    padding: 1px 4px;
    border-radius: 3px;
    color: var(--color-text-muted);
  }

  /* ── Responsive ──────────────────────────────────────────────────────────── */
  @media (max-width: 700px) {
    .summary-bar      { gap: var(--space-2); }
    .refresh-countdown { display: none; }
    .age-bar-track    { display: none; }
    :global(.branches-table) { font-size: var(--text-xs); }
  }
</style>
