<script lang="ts">
  /**
   * /durability — Wave 5 T4
   *
   * Lists in-flight + recently-completed cycle checkpoints with:
   *   - cycleId, phase, completedItemIds count, lastUpdatedAt (relative)
   *   - Resume button  → POST /api/v5/cycles/:id/resume
   *   - Force-clear button (>30 min idle) → confirms, then DELETE checkpoint
   *
   * Data: GET /api/v5/durability/checkpoints
   */
  import { browser } from '$app/environment';
  import { onMount, onDestroy } from 'svelte';
  import { withWorkspace } from '$lib/stores/workspace';

  // ── Types ────────────────────────────────────────────────────────────────────

  interface CheckpointRecord {
    cycleId: string;
    phase: string;
    completedItemIds: string[];
    lastUpdatedAt: string;
    idleSeconds: number;
  }

  interface CheckpointsResponse {
    data: CheckpointRecord[];
    meta: { total: number; timestamp: string };
  }

  // ── State ────────────────────────────────────────────────────────────────────

  let checkpoints = $state<CheckpointRecord[]>([]);
  let loading = $state(true);
  let error: string | null = $state(null);
  let lastRefreshedAt: Date | null = $state(null);

  /** cycleId being actioned — disables buttons for that row */
  let actioningId: string | null = $state(null);
  let actionError: string | null = $state(null);

  /** Confirmation modal state */
  let confirmClearId: string | null = $state(null);

  let pollHandle: ReturnType<typeof setInterval> | null = null;

  // ── Data fetching ─────────────────────────────────────────────────────────────

  async function fetchCheckpoints(silent = false): Promise<void> {
    if (!silent) loading = true;
    error = null;
    try {
      const res = await fetch(withWorkspace('/api/v5/durability/checkpoints'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as CheckpointsResponse;
      checkpoints = body.data ?? [];
      lastRefreshedAt = new Date();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load checkpoints';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void fetchCheckpoints();
    pollHandle = setInterval(() => {
      if (browser && document.visibilityState !== 'visible') return;
      void fetchCheckpoints(true);
    }, 15_000);
  });

  onDestroy(() => { if (pollHandle) clearInterval(pollHandle); });

  // ── Actions ──────────────────────────────────────────────────────────────────

  async function resumeCycle(cycleId: string): Promise<void> {
    actioningId = cycleId;
    actionError = null;
    try {
      const res = await fetch(
        withWorkspace(`/api/v5/cycles/${encodeURIComponent(cycleId)}/resume`),
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      // Refresh after successful resume
      await fetchCheckpoints(true);
    } catch (e) {
      actionError = e instanceof Error ? e.message : 'Resume failed';
    } finally {
      actioningId = null;
    }
  }

  function confirmForceClear(cycleId: string): void {
    confirmClearId = cycleId;
  }

  function cancelForceClear(): void {
    confirmClearId = null;
  }

  async function doForceClear(cycleId: string): Promise<void> {
    confirmClearId = null;
    actioningId = cycleId;
    actionError = null;
    try {
      // Force-clear: POST cancel then refresh (checkpoint cleanup is server-side)
      const res = await fetch(
        withWorkspace(`/api/v5/cycles/${encodeURIComponent(cycleId)}/cancel`),
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await fetchCheckpoints(true);
    } catch (e) {
      actionError = e instanceof Error ? e.message : 'Force-clear failed';
    } finally {
      actioningId = null;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function fmtRel(isoStr: string): string {
    const secs = Math.max(0, Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000));
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86400)}d ago`;
  }

  function isStale(record: CheckpointRecord): boolean {
    return record.idleSeconds > 30 * 60; // > 30 minutes
  }

  function phaseColor(phase: string): string {
    if (phase.includes('audit')) return 'var(--af-info)';
    if (phase.includes('plan')) return 'var(--af-accent)';
    if (phase.includes('execute')) return 'var(--af-success)';
    if (phase.includes('test')) return 'var(--af-warning)';
    if (phase.includes('gate') || phase.includes('review')) return 'var(--af-purple)';
    if (phase.includes('release') || phase.includes('learn')) return 'var(--af-success)';
    return 'var(--af-dim)';
  }
</script>

<svelte:head>
  <title>Durability — AgentForge</title>
</svelte:head>

<div class="page">

  <!-- Header -->
  <div class="page-header">
    <div class="page-title-row">
      <h1 class="page-title">Durability</h1>
      <div class="header-meta">
        {#if lastRefreshedAt}
          <span class="refresh-label">Updated {fmtRel(lastRefreshedAt.toISOString())}</span>
        {/if}
        <button class="btn-icon" onclick={() => void fetchCheckpoints()} title="Refresh">
          ↻
        </button>
      </div>
    </div>
    <p class="page-subtitle">
      In-flight and recently completed cycle checkpoints. Resume interrupted cycles or
      clear stale checkpoints (&gt;30 min idle).
    </p>
  </div>

  <!-- Error banner -->
  {#if error}
    <div class="error-banner" role="alert">
      {error}
      <button class="btn-link" onclick={() => { error = null; }}>✕</button>
    </div>
  {/if}

  {#if actionError}
    <div class="error-banner" role="alert">
      {actionError}
      <button class="btn-link" onclick={() => { actionError = null; }}>✕</button>
    </div>
  {/if}

  <!-- Loading skeleton -->
  {#if loading}
    <div class="skeleton-list" aria-label="Loading checkpoints">
      {#each [0, 1, 2] as _i (_i)}
        <div class="skeleton-row"></div>
      {/each}
    </div>

  <!-- Empty state -->
  {:else if checkpoints.length === 0}
    <div class="empty-state">
      <div class="empty-icon">✓</div>
      <p class="empty-title">No active checkpoints</p>
      <p class="empty-body">All cycles completed cleanly — no interrupted runs to resume.</p>
    </div>

  <!-- Checkpoint table -->
  {:else}
    <div class="table-wrap">
      <table class="checkpoint-table" aria-label="Cycle checkpoints">
        <thead>
          <tr>
            <th>Cycle ID</th>
            <th>Phase</th>
            <th>Progress</th>
            <th>Last updated</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each checkpoints as cp (cp.cycleId)}
            {@const stale = isStale(cp)}
            {@const busy = actioningId === cp.cycleId}
            <tr class:stale-row={stale}>
              <td class="cell-id">
                <span class="cycle-id">{cp.cycleId}</span>
                {#if stale}
                  <span class="stale-badge">STALE</span>
                {/if}
              </td>
              <td>
                <span class="phase-pill" style="color:{phaseColor(cp.phase)}">
                  {cp.phase}
                </span>
              </td>
              <td class="cell-progress">
                <span class="progress-count">{cp.completedItemIds.length}</span>
                <span class="progress-label"> items</span>
              </td>
              <td class="cell-time">{fmtRel(cp.lastUpdatedAt)}</td>
              <td class="cell-actions">
                <button
                  class="btn-resume"
                  disabled={busy}
                  onclick={() => void resumeCycle(cp.cycleId)}
                  aria-label="Resume cycle {cp.cycleId}"
                >
                  {busy ? '…' : '▶ Resume'}
                </button>
                {#if stale}
                  <button
                    class="btn-clear"
                    disabled={busy}
                    onclick={() => confirmForceClear(cp.cycleId)}
                    aria-label="Force-clear stale cycle {cp.cycleId}"
                  >
                    ✕ Force-clear
                  </button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <p class="table-footer">
      {checkpoints.length} checkpoint{checkpoints.length === 1 ? '' : 's'} found
    </p>
  {/if}

</div>

<!-- Confirmation modal -->
{#if confirmClearId !== null}
  {@const id = confirmClearId}
  <div class="modal-overlay" role="dialog" aria-modal="true" aria-label="Confirm force-clear">
    <div class="modal">
      <h2 class="modal-title">Force-clear stale cycle?</h2>
      <p class="modal-body">
        This will cancel cycle <code>{id}</code> and clear its checkpoint.
        Any in-progress work will be discarded. This cannot be undone.
      </p>
      <div class="modal-actions">
        <button class="btn-danger" onclick={() => void doForceClear(id)}>
          Yes, force-clear
        </button>
        <button class="btn-secondary" onclick={cancelForceClear}>
          Cancel
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .page {
    padding: 24px 28px;
    max-width: 1100px;
    margin: 0 auto;
  }

  /* Header */
  .page-header {
    margin-bottom: 24px;
  }

  .page-title-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 6px;
  }

  .page-title {
    font-size: 20px;
    font-weight: 700;
    color: var(--af-text);
    margin: 0;
  }

  .header-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
  }

  .refresh-label {
    font-size: 11px;
    color: var(--af-faint);
    font-family: 'JetBrains Mono', monospace;
  }

  .btn-icon {
    width: 26px;
    height: 26px;
    border-radius: 5px;
    border: 1px solid var(--af-border2);
    background: transparent;
    color: var(--af-dim);
    cursor: pointer;
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 150ms ease;
  }

  .btn-icon:hover {
    color: var(--af-text);
    border-color: var(--af-border3);
  }

  .page-subtitle {
    font-size: 13px;
    color: var(--af-dim);
    margin: 0;
  }

  /* Error banner */
  .error-banner {
    background: color-mix(in srgb, var(--af-danger) 12%, var(--af-surface));
    border: 1px solid color-mix(in srgb, var(--af-danger) 30%, transparent);
    border-radius: 7px;
    padding: 10px 14px;
    font-size: 12px;
    color: var(--af-danger);
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .btn-link {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 0;
    margin-left: auto;
    font-size: 14px;
    opacity: 0.7;
  }

  .btn-link:hover { opacity: 1; }

  /* Skeleton */
  .skeleton-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .skeleton-row {
    height: 52px;
    border-radius: 8px;
    background: var(--af-surface);
    animation: pulse 1.4s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.45; }
  }

  /* Empty state */
  .empty-state {
    text-align: center;
    padding: 60px 24px;
  }

  .empty-icon {
    font-size: 36px;
    color: var(--af-success);
    margin-bottom: 12px;
  }

  .empty-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--af-muted);
    margin: 0 0 6px;
  }

  .empty-body {
    font-size: 12px;
    color: var(--af-faint);
    margin: 0;
  }

  /* Table */
  .table-wrap {
    border: 1px solid var(--af-border);
    border-radius: 9px;
    overflow: hidden;
  }

  .checkpoint-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  .checkpoint-table th {
    padding: 10px 14px;
    text-align: left;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--af-faint);
    background: var(--af-surface);
    border-bottom: 1px solid var(--af-border);
  }

  .checkpoint-table td {
    padding: 11px 14px;
    color: var(--af-muted);
    border-bottom: 1px solid var(--af-border);
    vertical-align: middle;
  }

  .checkpoint-table tr:last-child td {
    border-bottom: none;
  }

  .checkpoint-table tr:hover td {
    background: var(--af-surface);
  }

  .stale-row td {
    background: color-mix(in srgb, var(--af-warning) 4%, transparent);
  }

  .stale-row:hover td {
    background: color-mix(in srgb, var(--af-warning) 8%, var(--af-surface));
  }

  .cell-id {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .cycle-id {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--af-text);
    font-weight: 500;
  }

  .stale-badge {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.06em;
    padding: 1px 6px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--af-warning) 18%, transparent);
    color: var(--af-warning);
    border: 1px solid color-mix(in srgb, var(--af-warning) 30%, transparent);
  }

  .phase-pill {
    font-size: 11px;
    font-weight: 600;
    font-family: 'JetBrains Mono', monospace;
  }

  .cell-progress {
    white-space: nowrap;
  }

  .progress-count {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    font-weight: 700;
    color: var(--af-text);
  }

  .progress-label {
    font-size: 11px;
    color: var(--af-dim);
  }

  .cell-time {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--af-dim);
  }

  .cell-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .btn-resume,
  .btn-clear {
    padding: 4px 10px;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: all 140ms ease;
    white-space: nowrap;
  }

  .btn-resume {
    background: color-mix(in srgb, var(--af-accent) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--af-accent) 30%, transparent);
    color: var(--af-accent);
  }

  .btn-resume:hover:not(:disabled) {
    background: color-mix(in srgb, var(--af-accent) 22%, transparent);
  }

  .btn-resume:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .btn-clear {
    background: color-mix(in srgb, var(--af-danger) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--af-danger) 25%, transparent);
    color: var(--af-danger);
  }

  .btn-clear:hover:not(:disabled) {
    background: color-mix(in srgb, var(--af-danger) 20%, transparent);
  }

  .btn-clear:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .table-footer {
    margin-top: 10px;
    font-size: 11px;
    color: var(--af-faint);
    font-family: 'JetBrains Mono', monospace;
  }

  /* Modal */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .modal {
    background: var(--af-bg);
    border: 1px solid var(--af-border2);
    border-radius: 12px;
    padding: 24px 28px;
    max-width: 420px;
    width: calc(100vw - 40px);
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
  }

  .modal-title {
    font-size: 15px;
    font-weight: 700;
    color: var(--af-text);
    margin: 0 0 10px;
  }

  .modal-body {
    font-size: 13px;
    color: var(--af-dim);
    margin: 0 0 20px;
    line-height: 1.5;
  }

  .modal-body code {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--af-accent);
    background: var(--af-surface);
    padding: 1px 4px;
    border-radius: 3px;
  }

  .modal-actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
  }

  .btn-danger {
    padding: 7px 16px;
    border-radius: 6px;
    background: var(--af-danger);
    border: 1px solid var(--af-danger);
    color: #fff;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 150ms ease;
  }

  .btn-danger:hover { opacity: 0.88; }

  .btn-secondary {
    padding: 7px 16px;
    border-radius: 6px;
    background: var(--af-surface);
    border: 1px solid var(--af-border2);
    color: var(--af-muted);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 150ms ease;
  }

  .btn-secondary:hover {
    border-color: var(--af-border3);
    color: var(--af-text);
  }
</style>
