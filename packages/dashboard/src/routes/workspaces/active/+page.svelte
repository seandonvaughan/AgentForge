<script lang="ts">
  /**
   * Active Worktrees page — /workspaces/active (T4.7)
   *
   * Shows all currently-allocated WorktreeHandles from the WorktreePool
   * singleton.  Polls every 5 s while the tab is visible.
   *
   * Layout:
   *   1. Stats bar  — active count, total allocations, GC'd count
   *   2. Worktree table — agent, branch, age (mm:ss), current item, path
   *   3. Empty state when no worktrees are allocated
   */
  import { withWorkspace } from '$lib/stores/workspace';
  import { KpiTile, Card, Badge, PulseDot } from '$lib/components/v2';

  // ── Types ────────────────────────────────────────────────────────────────
  interface SprintItem {
    id: string;
    title?: string;
    status?: string;
    [key: string]: unknown;
  }

  interface ActiveEntry {
    id: string;
    agentId: string;
    branch: string;
    path: string;
    allocatedAt: string;
    ageSeconds: number;
    currentItem: SprintItem | null;
  }

  interface PoolStats {
    active: number;
    totalAllocations: number;
    totalReleases: number;
    totalGcd: number;
  }

  interface ActiveResponse {
    active: ActiveEntry[];
    stats: PoolStats;
  }

  // ── State ─────────────────────────────────────────────────────────────────
  const POLL_MS = 5000;

  let entries = $state<ActiveEntry[]>([]);
  let stats = $state<PoolStats>({ active: 0, totalAllocations: 0, totalReleases: 0, totalGcd: 0 });
  let loading = $state(true);
  let error = $state<string | null>(null);

  // ── Data fetching ─────────────────────────────────────────────────────────

  async function loadActive(): Promise<void> {
    try {
      const res = await fetch(withWorkspace('/api/v5/workspaces/active'));
      if (!res.ok) { error = `HTTP ${res.status}`; return; }
      const json = (await res.json()) as ActiveResponse;
      entries = json.active ?? [];
      stats = json.stats ?? { active: 0, totalAllocations: 0, totalReleases: 0, totalGcd: 0 };
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  // ── Polling (5s, visibility-gated) ───────────────────────────────────────

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function startPolling(): void {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'hidden') return;
      void loadActive();
    }, POLL_MS);
  }

  function stopPolling(): void {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function onVisibilityChange(): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      void loadActive();
      startPolling();
    } else {
      stopPolling();
    }
  }

  $effect(() => {
    void loadActive();
    startPolling();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    return () => {
      stopPolling();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

  function fmtAge(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function truncatePath(p: string): string {
    const MAX = 48;
    return p.length > MAX ? '…' + p.slice(-(MAX - 1)) : p;
  }

  function itemLabel(item: SprintItem | null): string {
    if (!item) return '—';
    return item.title ?? item.id;
  }
</script>

<svelte:head><title>Active Worktrees — AgentForge</title></svelte:head>

<!-- ── Page header ──────────────────────────────────────────────────────── -->
<div class="page-header">
  <div>
    <h1 class="page-title">Active Worktrees</h1>
    <p class="page-sub">
      Live isolated git worktrees — one per running agent. Polls every 5 s.
    </p>
  </div>
  <div class="page-actions">
    <button
      class="refresh-btn"
      onclick={() => { loading = true; void loadActive(); }}
      disabled={loading}
    >
      {loading ? 'Loading…' : 'Refresh'}
    </button>
  </div>
</div>

<!-- ── Error banner ──────────────────────────────────────────────────────── -->
{#if error}
  <div class="banner banner--danger" style="margin-bottom:12px">
    <span>Error: <code class="af2-mono">{error}</code></span>
    <button class="banner-dismiss" onclick={() => { error = null; }}>✕</button>
  </div>
{/if}

<!-- ── Stats bar ─────────────────────────────────────────────────────────── -->
<div class="stats-bar">
  <KpiTile
    label="Active"
    value={stats.active}
    color={stats.active > 0 ? 'var(--af-accent)' : 'var(--af-text)'}
    live={stats.active > 0}
  />
  <KpiTile
    label="Total Allocated"
    value={stats.totalAllocations}
  />
  <KpiTile
    label="Released"
    value={stats.totalReleases}
  />
  <KpiTile
    label="GC'd"
    value={stats.totalGcd}
  />
</div>

<!-- ── Worktree table ─────────────────────────────────────────────────────── -->
{#if loading && entries.length === 0}
  <Card>
    <div class="skeleton-row"></div>
    <div class="skeleton-row skeleton-row--short"></div>
  </Card>
{:else if entries.length === 0}
  <Card>
    <div class="empty-state">
      <span class="empty-icon">⬡</span>
      <p>No active worktrees — agents will appear here when a cycle is running.</p>
    </div>
  </Card>
{:else}
  <Card>
    <div class="section-title" style="margin-bottom:10px">
      WORKTREES
      <PulseDot color="green" />
    </div>
    <div class="table-wrap">
      <table class="wt-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Branch</th>
            <th>Age</th>
            <th>Current Item</th>
            <th>Path</th>
          </tr>
        </thead>
        <tbody>
          {#each entries as entry (entry.id)}
            <tr>
              <td>
                <div class="agent-cell">
                  <Badge variant="purple">{entry.agentId}</Badge>
                </div>
              </td>
              <td>
                <code class="af2-mono branch-name">{entry.branch}</code>
              </td>
              <td>
                <span class="age-chip">{fmtAge(entry.ageSeconds)}</span>
              </td>
              <td>
                {#if entry.currentItem}
                  <div class="item-cell">
                    <code class="af2-mono item-id">{entry.currentItem.id}</code>
                    {#if entry.currentItem.title}
                      <span class="item-title">{entry.currentItem.title}</span>
                    {/if}
                  </div>
                {:else}
                  <span class="dim-dash">—</span>
                {/if}
              </td>
              <td>
                <code class="af2-mono path-val" title={entry.path}>{truncatePath(entry.path)}</code>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Card>
{/if}

<style>
  /* ── Page header ──────────────────────────────────────────────────────── */
  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 16px;
    gap: 16px;
  }

  .page-title {
    font-size: 20px;
    font-weight: 600;
    color: var(--af-text);
    margin: 0 0 4px;
  }

  .page-sub { font-size: 12px; color: var(--af-dim); margin: 0; }

  .page-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .refresh-btn {
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    color: var(--af-text);
    font-size: 12px;
    padding: 5px 12px;
    cursor: pointer;
    transition: background 120ms;
  }

  .refresh-btn:hover:not(:disabled) { background: var(--af-surface3, var(--af-surface2)); }
  .refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ── Stats bar ────────────────────────────────────────────────────────── */
  .stats-bar {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    margin-bottom: 14px;
  }

  /* ── Section title ────────────────────────────────────────────────────── */
  .section-title {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--af-dim);
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* ── Banners ──────────────────────────────────────────────────────────── */
  .banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 14px;
    border-radius: 6px;
    font-size: 12px;
    border: 1px solid;
  }

  .banner--danger {
    color: var(--af-danger);
    background: color-mix(in srgb, var(--af-danger) 8%, transparent);
    border-color: color-mix(in srgb, var(--af-danger) 25%, transparent);
  }

  .banner-dismiss {
    background: none;
    border: none;
    cursor: pointer;
    color: inherit;
    opacity: 0.7;
    font-size: 14px;
  }

  /* ── Table ────────────────────────────────────────────────────────────── */
  .table-wrap {
    overflow-x: auto;
  }

  .wt-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  .wt-table th {
    text-align: left;
    padding: 6px 10px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--af-faint);
    border-bottom: 1px solid var(--af-border2);
  }

  .wt-table td {
    padding: 8px 10px;
    border-bottom: 1px solid color-mix(in srgb, var(--af-border2) 50%, transparent);
    vertical-align: middle;
  }

  .wt-table tbody tr:last-child td { border-bottom: none; }

  .wt-table tbody tr:hover td {
    background: color-mix(in srgb, var(--af-purple) 4%, transparent);
  }

  /* ── Cell contents ────────────────────────────────────────────────────── */
  .agent-cell { display: flex; align-items: center; }

  .branch-name {
    font-size: 11px;
    color: var(--af-accent, var(--af-purple));
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1;
  }

  .age-chip {
    display: inline-block;
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 11px;
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1;
    color: var(--af-muted);
    white-space: nowrap;
  }

  .item-cell {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .item-id {
    font-size: 10px;
    color: var(--af-muted);
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1;
  }

  .item-title {
    font-size: 11px;
    color: var(--af-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 220px;
  }

  .dim-dash { color: var(--af-faint); }

  .path-val {
    font-size: 10px;
    color: var(--af-faint);
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1;
  }

  /* ── Empty state ──────────────────────────────────────────────────────── */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 64px 24px;
    gap: 10px;
    text-align: center;
    color: var(--af-dim);
  }

  .empty-icon { font-size: 32px; opacity: 0.25; }
  .empty-state p { margin: 0; font-size: 12px; }

  /* ── Skeleton ─────────────────────────────────────────────────────────── */
  .skeleton-row {
    height: 14px;
    background: var(--af-surface2);
    border-radius: 4px;
    margin-bottom: 8px;
    animation: shimmer 1.5s infinite linear;
  }

  .skeleton-row--short { width: 60%; }

  @keyframes shimmer {
    0%   { opacity: 0.4; }
    50%  { opacity: 0.9; }
    100% { opacity: 0.4; }
  }

  /* ── Mono font helper ─────────────────────────────────────────────────── */
  .af2-mono {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1;
  }

  /* ── Responsive ───────────────────────────────────────────────────────── */
  @media (max-width: 900px) {
    .stats-bar { grid-template-columns: repeat(2, 1fr); }
  }

  @media (max-width: 600px) {
    .stats-bar { grid-template-columns: 1fr; }
    .page-header { flex-direction: column; }
  }
</style>
