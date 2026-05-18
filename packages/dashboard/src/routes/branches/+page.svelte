<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { withWorkspace } from '$lib/stores/workspace';
  import { relativeTime } from '$lib/util/relative-time';
  import { Card, Badge, Btn, KpiTile, PulseDot } from '$lib/components/v2';

  type BranchStatus = 'active' | 'merged' | 'stale' | 'open-pr';

  interface AutonomousBranch {
    name:          string;
    // Sprint version stripped from the branch name (e.g. branch
    // "autonomous/v18.1.0" → cycle "v18.1.0"). The server route returns this
    // as `cycle`; older code mistyped it as `cycleId` and tried to use it as
    // a UUID, producing broken /cycles/<sprint-version> links.
    cycle:         string;
    lastCommitSha: string;
    lastCommitAt:  string;
    aheadOfMain:   number;
    behindMain:    number;
    ageMs:         number;
    status:        BranchStatus;
    prNumber:      number | null;
    prUrl:         string | null;
  }

  const STALE_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;
  const POLL_MS = 30_000;

  // ── state ───────────────────────────────────────────────────────────────
  let branches     = $state<AutonomousBranch[]>([]);
  let loading      = $state(true);
  let error        = $state<string | null>(null);

  let statusFilter = $state<BranchStatus | 'all'>('all');
  let searchQ      = $state('');
  let selected     = $state<Set<string>>(new Set());
  let selectAll    = $state(false);

  // delete state
  let deletingBranch   = $state<string | null>(null);
  let deletingBulk     = $state(false);
  let confirmDelete    = $state<string | null>(null);  // branch name pending confirm
  let confirmBulk      = $state(false);
  let forceDelete      = $state(false);
  let deleteError      = $state<string | null>(null);

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  // ── computed ─────────────────────────────────────────────────────────────
  let counts = $derived({
    all:      branches.length,
    active:   branches.filter(b => b.status === 'active').length,
    merged:   branches.filter(b => b.status === 'merged').length,
    stale:    branches.filter(b => b.status === 'stale').length,
    'open-pr': branches.filter(b => b.status === 'open-pr').length,
  });

  let filtered = $derived.by(() => {
    const q = searchQ.trim().toLowerCase();
    return branches.filter(b => {
      if (statusFilter !== 'all' && b.status !== statusFilter) return false;
      if (q && !b.name.toLowerCase().includes(q) && !b.cycle.toLowerCase().includes(q)) return false;
      return true;
    });
  });

  let staleList = $derived(branches.filter(b => b.status === 'stale'));

  // ── data ─────────────────────────────────────────────────────────────────
  async function fetchBranches(silent = false) {
    if (document.visibilityState === 'hidden') return;
    if (!silent) loading = true;
    error = null;
    try {
      const res = await fetch(withWorkspace('/api/v5/autonomous-branches'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data?: AutonomousBranch[] };
      branches = json.data ?? [];
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  async function doDelete(branchName: string, force: boolean) {
    const url = `/api/v5/autonomous-branches/${branchName}${force ? '?force=true' : ''}`;
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    branches = branches.filter(b => b.name !== branchName);
    selected = new Set([...selected].filter(n => n !== branchName));
  }

  async function handleDelete(branchName: string) {
    confirmDelete = null;
    deletingBranch = branchName;
    deleteError = null;
    try {
      await doDelete(branchName, forceDelete);
    } catch (e) {
      deleteError = String(e);
    } finally {
      deletingBranch = null;
      forceDelete = false;
    }
  }

  async function handleBulkDelete() {
    confirmBulk = false;
    deletingBulk = true;
    deleteError = null;
    const targets = staleList.map(b => b.name);
    const errors: string[] = [];
    for (const name of targets) {
      try {
        await doDelete(name, true);
      } catch (e) {
        errors.push(`${name}: ${String(e)}`);
      }
    }
    if (errors.length) deleteError = `${errors.length} deletion(s) failed:\n${errors.join('\n')}`;
    deletingBulk = false;
    if (statusFilter === 'stale' && staleList.length === 0) statusFilter = 'all';
  }

  function toggleSelect(name: string) {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name); else next.add(name);
    selected = next;
  }

  function toggleSelectAll() {
    if (selected.size === filtered.length) {
      selected = new Set();
    } else {
      selected = new Set(filtered.map(b => b.name));
    }
  }

  // ── formatters ────────────────────────────────────────────────────────────
  function fmtAge(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh ? `${d}d ${rh}h` : `${d}d`;
  }

  function ageRatio(ms: number): number {
    return Math.min(1, ms / STALE_THRESHOLD_MS);
  }

  function shaShort(sha: string): string {
    return sha?.slice(0, 7) ?? '—';
  }

  function statusVariant(s: BranchStatus): 'success' | 'warning' | 'purple' | 'info' | 'muted' {
    if (s === 'merged')   return 'success';
    if (s === 'stale')    return 'warning';
    if (s === 'active')   return 'purple';
    if (s === 'open-pr')  return 'info';
    return 'muted';
  }

  function cancelConfirm(e: MouseEvent) {
    if (!(e.target as HTMLElement).closest('.confirm-zone')) confirmDelete = null;
  }

  onMount(() => {
    fetchBranches();
    pollTimer = setInterval(() => fetchBranches(true), POLL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') fetchBranches(true);
    });
  });

  onDestroy(() => { if (pollTimer) clearInterval(pollTimer); });
</script>

<svelte:head><title>Branches — AgentForge</title></svelte:head>
<svelte:window onclick={cancelConfirm} />

<!-- ── Page header ─────────────────────────────────────────────────────── -->
<div class="ph">
  <div>
    <h1 class="ph-title">Autonomous Branches</h1>
    <p class="ph-sub">
      Git hygiene for <code class="code-inline">autonomous/*</code> cycles ·
      branches without an open PR become <span class="warn">stale</span> after 3 days
    </p>
  </div>
  <div class="ph-actions">
    {#if staleList.length > 0 && !confirmBulk}
      <Btn variant="danger" size="sm" onClick={() => (confirmBulk = true)} disabled={deletingBulk || loading}>
        Sweep stale ({staleList.length})
      </Btn>
    {/if}
    {#if confirmBulk}
      <span class="confirm-label">Delete {staleList.length} stale branch{staleList.length === 1 ? '' : 'es'}?</span>
      <Btn variant="danger" size="sm" onClick={handleBulkDelete} disabled={deletingBulk}>
        {deletingBulk ? 'Deleting…' : 'Yes, delete all'}
      </Btn>
      <Btn variant="ghost" size="sm" onClick={() => (confirmBulk = false)}>Cancel</Btn>
    {/if}
    <Btn variant="ghost" size="sm" onClick={() => fetchBranches()} disabled={loading}>
      {loading ? 'Refreshing…' : 'Refresh'}
    </Btn>
  </div>
</div>

<!-- ── KPI strip ───────────────────────────────────────────────────────── -->
<div class="kpi-strip">
  <KpiTile label="Total"   value={counts.all}        color="var(--af-text)" />
  <KpiTile label="Active"  value={counts.active}     color="var(--af-purple)"  live={counts.active > 0} />
  <KpiTile label="Open PR" value={counts['open-pr']} color="var(--af-sonnet)" />
  <KpiTile label="Merged"  value={counts.merged}     color="var(--af-success)" />
  <KpiTile label="Stale"   value={counts.stale}      color="var(--af-warning)" />
</div>

<!-- ── Filters + search ────────────────────────────────────────────────── -->
<div class="filter-row">
  {#each [
    { id: 'all',      label: 'All',       count: counts.all,             color: 'var(--af-muted)'   },
    { id: 'active',   label: 'Active',    count: counts.active,          color: 'var(--af-purple)'  },
    { id: 'open-pr',  label: 'Open PR',   count: counts['open-pr'],      color: 'var(--af-sonnet)'  },
    { id: 'merged',   label: 'Merged',    count: counts.merged,          color: 'var(--af-success)' },
    { id: 'stale',    label: 'Stale',     count: counts.stale,           color: 'var(--af-warning)' },
  ] as f}
    <button
      class="chip"
      class:chip-active={statusFilter === f.id}
      onclick={() => (statusFilter = f.id as BranchStatus | 'all')}
    >
      <span class="chip-count font-mono" style="color:{f.color}">{f.count}</span>
      {f.label}
    </button>
  {/each}
  <span class="flex-1"></span>
  <div class="search-box">
    <span class="search-icon">⌕</span>
    <input
      class="search-input"
      type="search"
      bind:value={searchQ}
      placeholder="Search branch or cycle…"
      spellcheck="false"
      autocomplete="off"
    />
    {#if searchQ}
      <button class="search-clear" onclick={() => (searchQ = '')} aria-label="Clear">✕</button>
    {/if}
  </div>
</div>

<!-- ── Error banner ────────────────────────────────────────────────────── -->
{#if deleteError}
  <div class="err-banner">
    <span style="white-space:pre-wrap">{deleteError}</span>
    <button class="err-close" onclick={() => (deleteError = null)}>✕</button>
  </div>
{/if}

{#if error}
  <div class="err-banner">
    {error}
    <button class="err-close" onclick={() => fetchBranches()}>Retry</button>
  </div>
{/if}

<!-- ── Loading skeleton ────────────────────────────────────────────────── -->
{#if loading && branches.length === 0}
  <Card noPad>
    {#each Array(4) as _}
      <div class="skel-row">
        <div class="skel" style="width:200px"></div>
        <div class="skel" style="width:80px"></div>
        <div class="skel" style="width:64px"></div>
        <div class="skel" style="width:90px;height:18px;border-radius:9px"></div>
      </div>
    {/each}
  </Card>

<!-- ── Empty states ────────────────────────────────────────────────────── -->
{:else if branches.length === 0 && !error}
  <div class="empty">
    <span class="empty-icon">⎇</span>
    <p>No <code class="code-inline">autonomous/*</code> branches found.</p>
    <p class="empty-hint">Start an autonomous cycle to create one.</p>
  </div>
{:else if filtered.length === 0}
  <div class="empty">
    <span class="empty-icon">⎇</span>
    <p>No branches match the current filter.</p>
    <Btn variant="ghost" size="sm" onClick={() => { statusFilter = 'all'; searchQ = ''; }}>Clear filters</Btn>
  </div>

<!-- ── Table ───────────────────────────────────────────────────────────── -->
{:else}
  <Card noPad>
    <table class="tbl">
      <thead>
        <tr>
          <th class="col-check">
            <input
              type="checkbox"
              class="cb"
              checked={selected.size > 0 && selected.size === filtered.length}
              indeterminate={selected.size > 0 && selected.size < filtered.length}
              onchange={toggleSelectAll}
              aria-label="Select all"
            />
          </th>
          <th>Branch</th>
          <th>Cycle</th>
          <th>SHA</th>
          <th>Ahead / Behind</th>
          <th>Age</th>
          <th>Status</th>
          <th>PR</th>
          <th class="col-actions">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each filtered as b (b.name)}
          {@const isDeleting = deletingBranch === b.name}
          {@const isSelected = selected.has(b.name)}
          <tr
            class:row-stale={b.status === 'stale'}
            class:row-merged={b.status === 'merged'}
            class:row-active={b.status === 'active'}
            class:row-deleting={isDeleting}
            class:row-selected={isSelected}
          >
            <td class="col-check">
              <input type="checkbox" class="cb" checked={isSelected} onchange={() => toggleSelect(b.name)} aria-label="Select {b.name}" />
            </td>

            <!-- Branch name -->
            <td>
              <div class="branch-cell">
                <span class="bar" style="background:{b.status === 'active' ? 'var(--af-purple)' : b.status === 'merged' ? 'var(--af-success)' : b.status === 'stale' ? 'var(--af-warning)' : 'var(--af-sonnet)'}"></span>
                <button
                  class="branch-name font-mono"
                  onclick={() => navigator.clipboard?.writeText(b.name).catch(() => {})}
                  title="Click to copy: {b.name}"
                >
                  {b.name}
                </button>
                {#if b.status === 'active'}
                  <PulseDot color="var(--af-purple)" size={5} />
                {/if}
              </div>
            </td>

            <!-- Cycle link -->
            <td>
              <a class="cycle-link font-mono" href="/sprints/{encodeURIComponent(b.cycle)}" title="View sprint {b.cycle}">
                {b.cycle}
              </a>
            </td>

            <!-- Last commit SHA -->
            <td>
              <span class="sha font-mono">{shaShort(b.lastCommitSha)}</span>
            </td>

            <!-- Ahead / Behind main -->
            <td>
              <span class="font-mono ahead-behind">
                <span class:pos={b.aheadOfMain > 0}>↑{b.aheadOfMain}</span>
                <span class="sep">/</span>
                <span class:neg={b.behindMain > 0}>↓{b.behindMain}</span>
              </span>
            </td>

            <!-- Age with staleness bar -->
            <td class="age-cell">
              <span class="font-mono" class:age-warn={b.status === 'stale'}>{fmtAge(b.ageMs)}</span>
              <div class="age-track">
                <div
                  class="age-fill"
                  class:age-fill-warn={ageRatio(b.ageMs) >= 0.7}
                  class:age-fill-danger={ageRatio(b.ageMs) >= 1}
                  style="width:{ageRatio(b.ageMs) * 100}%"
                ></div>
              </div>
            </td>

            <!-- Status badge -->
            <td>
              <Badge variant={statusVariant(b.status)}>
                {b.status === 'open-pr' ? 'open pr' : b.status}
              </Badge>
            </td>

            <!-- PR link -->
            <td>
              {#if b.prUrl}
                <a class="pr-link" href={b.prUrl} target="_blank" rel="noopener noreferrer">
                  #{b.prNumber} ↗
                </a>
              {:else if b.prNumber != null}
                <span class="font-mono dim">#{b.prNumber}</span>
              {:else}
                <span class="dim">—</span>
              {/if}
            </td>

            <!-- Actions -->
            <td class="col-actions">
              <div class="action-group confirm-zone">
                {#if confirmDelete === b.name}
                  <label class="force-label">
                    <input type="checkbox" bind:checked={forceDelete} />
                    force
                  </label>
                  <Btn variant="danger" size="sm" onClick={() => handleDelete(b.name)} disabled={isDeleting}>
                    {isDeleting ? '…' : 'Confirm'}
                  </Btn>
                  <Btn variant="ghost" size="sm" onClick={() => (confirmDelete = null)}>No</Btn>
                {:else if b.status !== 'active'}
                  <Btn
                    variant="ghost"
                    size="sm"
                    onClick={() => { confirmDelete = b.name; forceDelete = b.status !== 'merged'; }}
                    disabled={isDeleting || deletingBulk}
                  >
                    {isDeleting ? '…' : 'Delete'}
                  </Btn>
                {/if}
                {#if b.prUrl}
                  <Btn variant="ghost" size="sm" href={b.prUrl}>↗ PR</Btn>
                {/if}
              </div>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>

    <div class="tbl-footer font-mono">
      {filtered.length} of {branches.length} branch{branches.length === 1 ? '' : 'es'}
      {#if statusFilter !== 'all'} · {statusFilter}{/if}
      {#if searchQ} · "{searchQ}"{/if}
      {#if selected.size > 0} · {selected.size} selected{/if}
    </div>
  </Card>
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

  .confirm-label {
    font-size: 12px;
    color: var(--af-warning);
    font-weight: 500;
    white-space: nowrap;
  }

  .code-inline {
    font-family: var(--af-font-mono);
    font-size: 10px;
    background: var(--af-surface2);
    padding: 1px 5px;
    border-radius: 3px;
    border: 1px solid var(--af-border2);
  }

  .warn { color: var(--af-warning); font-weight: 600; }

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
    margin-bottom: 12px;
    flex-wrap: wrap;
  }

  .flex-1 { flex: 1; }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
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

  .chip-count { font-size: 10px; font-weight: 700; }

  .search-box {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    transition: border-color 120ms;
    min-width: 240px;
  }

  .search-box:focus-within { border-color: var(--af-accent); }

  .search-icon { color: var(--af-faint); font-size: 14px; line-height: 1; user-select: none; }

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

  .search-clear {
    background: none;
    border: none;
    color: var(--af-faint);
    cursor: pointer;
    font-size: 10px;
    padding: 0 2px;
    transition: color 120ms;
  }

  .search-clear:hover { color: var(--af-text); }

  /* ── Error banner ────────────────────────────────────────────────────── */
  .err-banner {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    padding: 10px 14px;
    background: color-mix(in srgb, var(--af-danger) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--af-danger) 25%, transparent);
    border-radius: 6px;
    color: var(--af-danger);
    font-size: 12px;
    margin-bottom: 12px;
    white-space: pre-wrap;
  }

  .err-close {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    opacity: 0.6;
    flex-shrink: 0;
    font-size: 12px;
    padding: 0;
  }

  .err-close:hover { opacity: 1; }

  /* ── Skeleton ────────────────────────────────────────────────────────── */
  .skel-row {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 14px;
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
  .empty-hint { font-size: 10px; color: var(--af-faint); }

  /* ── Table ───────────────────────────────────────────────────────────── */
  .tbl {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  .tbl thead tr {
    border-bottom: 1px solid var(--af-border);
  }

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

  .tbl tbody tr { transition: background 100ms; }
  .tbl tbody tr:hover { background: color-mix(in srgb, var(--af-surface2) 60%, transparent); }

  .row-stale td:first-child ~ td:nth-child(2) { /* branch name col */ }
  .row-stale { border-left: 3px solid var(--af-warning); }
  .row-merged { border-left: 3px solid color-mix(in srgb, var(--af-success) 60%, transparent); }
  .row-active { border-left: 3px solid var(--af-purple); }
  .row-deleting { opacity: 0.35; pointer-events: none; }
  .row-selected { background: color-mix(in srgb, var(--af-accent) 6%, transparent); }

  .col-check { width: 36px; padding: 9px 8px 9px 14px; }
  .col-actions { width: 160px; }

  .cb { accent-color: var(--af-accent); cursor: pointer; }

  /* ── Branch cell ─────────────────────────────────────────────────────── */
  .branch-cell {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .bar {
    width: 3px;
    height: 16px;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .branch-name {
    background: none;
    border: none;
    padding: 0;
    cursor: copy;
    font-family: var(--af-font-mono);
    font-size: 11px;
    color: var(--af-text);
    white-space: nowrap;
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    display: block;
  }

  .branch-name:hover { color: var(--af-accent2); }

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
    transition: border-color 120ms, color 120ms;
  }

  .cycle-link:hover { border-color: var(--af-accent); }

  /* ── SHA ─────────────────────────────────────────────────────────────── */
  .sha { font-size: 11px; color: var(--af-dim); letter-spacing: 0.02em; }

  /* ── Ahead / behind ──────────────────────────────────────────────────── */
  .ahead-behind { font-size: 11px; }
  .ahead-behind .sep { color: var(--af-faint); margin: 0 3px; }
  .ahead-behind .pos { color: var(--af-success); }
  .ahead-behind .neg { color: var(--af-warning); }

  /* ── Age cell ────────────────────────────────────────────────────────── */
  .age-cell { min-width: 80px; }

  .age-warn { color: var(--af-warning); }

  .age-track {
    margin-top: 4px;
    height: 3px;
    background: var(--af-surface2);
    border-radius: 2px;
    overflow: hidden;
    width: 56px;
  }

  .age-fill {
    height: 100%;
    background: var(--af-accent);
    border-radius: 2px;
    transition: width 300ms;
  }

  .age-fill-warn   { background: var(--af-warning); }
  .age-fill-danger { background: var(--af-danger); }

  /* ── PR link ─────────────────────────────────────────────────────────── */
  .pr-link {
    font-size: 11px;
    color: var(--af-sonnet);
    text-decoration: none;
    font-weight: 500;
    white-space: nowrap;
  }

  .pr-link:hover { text-decoration: underline; }

  /* ── Action column ───────────────────────────────────────────────────── */
  .action-group {
    display: flex;
    align-items: center;
    gap: 6px;
    justify-content: flex-end;
  }

  .force-label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    color: var(--af-dim);
    cursor: pointer;
    white-space: nowrap;
  }

  /* ── Table footer ────────────────────────────────────────────────────── */
  .tbl-footer {
    padding: 8px 14px;
    border-top: 1px solid var(--af-border);
    font-size: 10px;
    color: var(--af-faint);
    text-align: right;
  }

  /* ── Utility ─────────────────────────────────────────────────────────── */
  .font-mono { font-family: var(--af-font-mono); }
  .dim       { color: var(--af-dim); font-size: 11px; }

  /* ── Responsive ──────────────────────────────────────────────────────── */
  @media (max-width: 800px) {
    .kpi-strip { grid-template-columns: repeat(3, 1fr); }
    .age-track { display: none; }
  }
</style>
