<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { approvalsStore, type CycleApproval } from '$lib/stores/approvals.js';
  import { relativeTime } from '$lib/util/relative-time';
  import {
    Card, Badge, Btn, KpiTile, ModelChip, PulseDot,
  } from '$lib/components/v2';

  // ── API types ──────────────────────────────────────────────────────────
  type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'rolled_back';

  interface TestSummary {
    passed: number;
    failed: number;
    total:  number;
  }

  interface Approval {
    id:             string;
    proposalTitle:  string;
    executionId:    string;
    agentId:        string;
    submittedAt:    string;
    reviewedAt?:    string;
    reviewedBy?:    string;
    status:         ApprovalStatus;
    testSummary?:   TestSummary;
    diff?:          string;
    impactSummary?: string;
    notes?:         string;
    model?:         string;
  }

  type FilterId = 'pending' | 'approved' | 'rejected' | 'rolled_back' | 'all';

  // ── state ──────────────────────────────────────────────────────────────
  let items        = $state<Approval[]>([]);
  let loading      = $state(true);
  let error        = $state<string | null>(null);
  let filter       = $state<FilterId>('pending');

  let selected     = $state<Approval | null>(null);   // detail pane
  let actioning    = $state<Set<string>>(new Set());
  let actionErrors = $state<Record<string, string>>({});
  let reviewedBy   = $state('dashboard-user');
  let reviewNotes  = $state('');

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const POLL_MS = 5_000;

  // Cycle approval store (budget-gate)
  let cycleApprovals   = $derived($approvalsStore.pending);
  let cycleLoading     = $derived($approvalsStore.loading);
  let cycleError       = $derived($approvalsStore.error);

  // ── computed ───────────────────────────────────────────────────────────
  let counts = $derived({
    pending:     items.filter(i => i.status === 'pending').length,
    approved:    items.filter(i => i.status === 'approved').length,
    rejected:    items.filter(i => i.status === 'rejected').length,
    rolled_back: items.filter(i => i.status === 'rolled_back').length,
  });

  let displayed = $derived(
    filter === 'all' ? items : items.filter(i => i.status === filter)
  );

  // ── data ───────────────────────────────────────────────────────────────
  async function load(silent = false) {
    if (document.visibilityState === 'hidden') return;
    if (!silent) loading = true;
    error = null;
    try {
      const qs = filter !== 'all' ? `?status=${filter}` : '';
      const res = await fetch(`/api/v5/approvals${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data?: unknown[] };
      items = (json.data ?? []).map(normalise);
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  function normalise(raw: unknown): Approval {
    const r = raw as Record<string, unknown>;
    const status = (['pending','approved','rejected','rolled_back'].includes(String(r.status)))
      ? r.status as ApprovalStatus
      : 'pending';
    return {
      id:             String(r.id ?? ''),
      proposalTitle:  String(r.proposalTitle ?? r.action ?? r.description ?? 'Review required'),
      executionId:    String(r.executionId ?? r.agentId ?? r.agent_id ?? '—'),
      agentId:        String(r.agentId ?? r.agent_id ?? '—'),
      submittedAt:    String(r.submittedAt ?? r.requestedAt ?? new Date().toISOString()),
      status,
      ...(r.reviewedAt    !== undefined ? { reviewedAt:    String(r.reviewedAt) }    : {}),
      ...(r.reviewedBy    !== undefined ? { reviewedBy:    String(r.reviewedBy) }    : {}),
      ...(r.impactSummary !== undefined ? { impactSummary: String(r.impactSummary) } : {}),
      ...(r.notes         !== undefined ? { notes:         String(r.notes) }         : {}),
      ...(r.diff          !== undefined ? { diff:          String(r.diff) }          : {}),
      ...(r.model         !== undefined ? { model:         String(r.model) }         : {}),
      ...(r.testSummary   !== undefined ? { testSummary:   r.testSummary as TestSummary } : {}),
    };
  }

  async function patch(id: string, action: 'approve' | 'reject') {
    actioning = new Set([...actioning, id]);
    const prev = { ...actionErrors };
    delete prev[id];
    actionErrors = prev;
    try {
      const res = await fetch(`/api/v5/approvals/${id}/${action}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewedBy, notes: reviewNotes || undefined }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = action === 'approve' ? 'approved' : 'rejected';
      items = items.map(i => i.id === id ? { ...i, status: next as ApprovalStatus, reviewedBy } : i);
      if (selected?.id === id) selected = { ...selected, status: next as ApprovalStatus };
      reviewNotes = '';
    } catch (e) {
      actionErrors = { ...actionErrors, [id]: String(e) };
    } finally {
      actioning = new Set([...actioning].filter(x => x !== id));
    }
  }

  // ── diff rendering ─────────────────────────────────────────────────────
  function renderDiff(diff: string): { type: 'add' | 'remove' | 'hunk' | 'plain'; text: string }[] {
    return diff.split('\n').map(line => {
      if (line.startsWith('+') && !line.startsWith('+++')) return { type: 'add',    text: line };
      if (line.startsWith('-') && !line.startsWith('---')) return { type: 'remove', text: line };
      if (line.startsWith('@@'))                            return { type: 'hunk',   text: line };
      return { type: 'plain', text: line };
    });
  }

  // ── badge helpers ──────────────────────────────────────────────────────
  function statusVariant(s: ApprovalStatus): 'warning' | 'success' | 'danger' | 'muted' {
    if (s === 'pending')     return 'warning';
    if (s === 'approved')    return 'success';
    if (s === 'rejected')    return 'danger';
    if (s === 'rolled_back') return 'muted';
    return 'muted';
  }

  function testChipVariant(t: TestSummary): 'success' | 'danger' | 'muted' {
    if (t.failed > 0)   return 'danger';
    if (t.passed > 0)   return 'success';
    return 'muted';
  }

  function fmtCost(n: number): string { return `$${n.toFixed(2)}`; }

  onMount(() => {
    load();
    pollTimer = setInterval(() => load(true), POLL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') load(true);
    });
    approvalsStore.connectSSE?.();
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    approvalsStore.disconnectSSE?.();
  });
</script>

<svelte:head><title>Approvals — AgentForge</title></svelte:head>

<!-- ── Page header ─────────────────────────────────────────────────────── -->
<div class="ph">
  <div>
    <h1 class="ph-title">Approvals Queue</h1>
    <p class="ph-sub">
      <span class="font-mono">{counts.pending}</span> pending ·
      human-in-the-loop review for autonomous actions
    </p>
  </div>
  <div class="ph-actions">
    <PulseDot color="var(--af-success)" size={5} />
    <span class="auto-label">auto-refresh {POLL_MS / 1000}s</span>
    <Btn variant="ghost" size="sm" onClick={() => load()} disabled={loading}>
      {loading ? 'Loading…' : 'Refresh'}
    </Btn>
  </div>
</div>

<!-- ── KPI strip ───────────────────────────────────────────────────────── -->
<div class="kpi-strip">
  <KpiTile label="Pending"     value={counts.pending}     color="var(--af-warning)"  live={counts.pending > 0} />
  <KpiTile label="Approved"    value={counts.approved}    color="var(--af-success)" />
  <KpiTile label="Rejected"    value={counts.rejected}    color="var(--af-danger)" />
  <KpiTile label="Rolled back" value={counts.rolled_back} color="var(--af-muted)" />
</div>

<!-- ── Cycle budget-gate approvals ────────────────────────────────────── -->
{#if cycleApprovals.length > 0 || cycleLoading}
  <div class="section-block">
    <div class="section-row">
      <h2 class="section-title">Cycle Budget Gates</h2>
      <span class="dim">{cycleApprovals.length} pending{cycleLoading ? ' · refreshing…' : ''}</span>
    </div>
    {#if cycleError}
      <div class="err-banner">{cycleError}</div>
    {/if}
    {#each cycleApprovals as ca (ca.cycleId)}
      {@const totalItems = ca.withinBudgetItems.length + ca.overflowItems.length}
      {@const withinCost = ca.withinBudgetItems.reduce((s, i) => s + i.estimatedCostUsd, 0)}
      <Card style="border-left: 3px solid var(--af-warning); margin-bottom: 10px;">
        <div class="ca-header">
          <div class="ca-left">
            <div class="ca-id-row">
              <a class="cycle-link font-mono" href="/cycles/{ca.cycleId}">{ca.cycleId.slice(0, 8)}</a>
              {#if ca.sprintVersion}
                <span class="version-chip font-mono">v{ca.sprintVersion}</span>
              {/if}
              <span class="dim">{relativeTime(ca.requestedAt)}</span>
            </div>
            {#if ca.agentSummary}
              <p class="ca-summary">{ca.agentSummary}</p>
            {/if}
            <div class="ca-items">
              {#each [...ca.withinBudgetItems, ...ca.overflowItems].slice(0, 3) as item}
                <span class="ca-item"><span class="font-mono dim">#{item.rank}</span> {item.title}</span>
              {/each}
              {#if totalItems > 3}
                <span class="dim ca-more">+{totalItems - 3} more</span>
              {/if}
            </div>
          </div>
          <div class="ca-right">
            <div class="ca-cost font-mono">{fmtCost(withinCost)}<span class="ca-budget">/ {fmtCost(ca.budgetUsd)}</span></div>
            <div class="dim" style="font-size:11px">{ca.withinBudgetItems.length} within budget{ca.overflowItems.length > 0 ? ` · ${ca.overflowItems.length} overflow` : ''}</div>
            <Btn variant="purple" size="sm" onClick={() => approvalsStore.open(ca)}>
              Review {totalItems} items
            </Btn>
          </div>
        </div>
      </Card>
    {/each}
  </div>
{/if}

<!-- ── Filter chips ─────────────────────────────────────────────────────── -->
<div class="filter-row">
  {#each [
    { id: 'pending',     label: 'Pending',     count: counts.pending,     color: 'var(--af-warning)' },
    { id: 'approved',    label: 'Approved',    count: counts.approved,    color: 'var(--af-success)' },
    { id: 'rejected',    label: 'Rejected',    count: counts.rejected,    color: 'var(--af-danger)'  },
    { id: 'rolled_back', label: 'Rolled back', count: counts.rolled_back, color: 'var(--af-muted)'   },
    { id: 'all',         label: 'All',         count: items.length,       color: 'var(--af-dim)'     },
  ] as f}
    <button
      class="chip"
      class:chip-active={filter === f.id}
      onclick={() => { filter = f.id as FilterId; load(); }}
    >
      <span class="font-mono chip-count" style="color:{f.color}">{f.count}</span>
      {f.label}
    </button>
  {/each}
</div>

<!-- ── Error ───────────────────────────────────────────────────────────── -->
{#if error}
  <div class="err-banner">{error} <button class="err-close" onclick={() => load()}>Retry</button></div>
{/if}

<!-- ── Two-pane layout ─────────────────────────────────────────────────── -->
<div class="two-pane">
  <!-- Left: list -->
  <div class="pane-list">
    {#if loading && items.length === 0}
      {#each Array(3) as _}
        <div class="skel-card"></div>
      {/each}
    {:else if displayed.length === 0}
      <div class="empty">
        <span class="empty-icon">✓</span>
        <p>{filter === 'pending' ? 'No pending approvals — all clear.' : 'No items match this filter.'}</p>
        <p class="empty-hint">The autonomous team is operating within approved boundaries.</p>
      </div>
    {:else}
      {#each displayed as item (item.id)}
        <button
          class="list-row"
          class:list-row-selected={selected?.id === item.id}
          onclick={() => (selected = item)}
        >
          <div class="list-top">
            <Badge variant={statusVariant(item.status)}>{item.status}</Badge>
            <span class="list-title">{item.proposalTitle}</span>
          </div>
          <div class="list-meta">
            <span class="agent-chip font-mono">{item.agentId}</span>
            {#if item.model}
              <ModelChip model={item.model.includes('opus') ? 'opus' : item.model.includes('sonnet') ? 'sonnet' : 'haiku'} />
            {/if}
            <span class="dim">{relativeTime(item.submittedAt)}</span>
            {#if item.testSummary}
              <Badge variant={testChipVariant(item.testSummary)}>
                {item.testSummary.passed}/{item.testSummary.total} tests
              </Badge>
            {/if}
          </div>
        </button>
      {/each}
    {/if}
  </div>

  <!-- Right: detail -->
  <div class="pane-detail">
    {#if !selected}
      <div class="detail-empty">
        <span class="empty-icon">←</span>
        <p class="dim">Select an approval to view details</p>
      </div>
    {:else}
      <div class="detail-scroll">
        <!-- Header -->
        <div class="detail-header">
          <div class="detail-title-row">
            <Badge variant={statusVariant(selected.status)}>{selected.status}</Badge>
            <h2 class="detail-title">{selected.proposalTitle}</h2>
          </div>
          <div class="detail-meta">
            <span class="agent-chip font-mono">{selected.agentId}</span>
            {#if selected.model}
              <ModelChip model={selected.model.includes('opus') ? 'opus' : selected.model.includes('sonnet') ? 'sonnet' : 'haiku'} />
            {/if}
            <span class="dim">{relativeTime(selected.submittedAt)}</span>
          </div>
        </div>

        <!-- Test summary -->
        {#if selected.testSummary}
          <Card style="margin-bottom:10px">
            <p class="section-label">TEST SUMMARY</p>
            <div class="test-chips">
              <span class="test-chip pass font-mono">{selected.testSummary.passed} passed</span>
              {#if selected.testSummary.failed > 0}
                <span class="test-chip fail font-mono">{selected.testSummary.failed} failed</span>
              {/if}
              <span class="test-chip muted font-mono">{selected.testSummary.total} total</span>
            </div>
          </Card>
        {/if}

        <!-- Impact summary -->
        {#if selected.impactSummary}
          <Card style="margin-bottom:10px">
            <p class="section-label">IMPACT</p>
            <p class="detail-body">{selected.impactSummary}</p>
          </Card>
        {/if}

        <!-- Notes -->
        {#if selected.notes}
          <Card style="margin-bottom:10px">
            <p class="section-label">NOTES</p>
            <p class="detail-body">{selected.notes}</p>
          </Card>
        {/if}

        <!-- Diff -->
        {#if selected.diff}
          <Card noPad style="margin-bottom:10px; overflow:hidden;">
            <div class="diff-header">
              <span class="section-label">DIFF</span>
            </div>
            <pre class="diff-pre font-mono">{#each renderDiff(selected.diff) as line}<span class="diff-line diff-{line.type}">{line.text}
</span>{/each}</pre>
          </Card>
        {/if}

        <!-- Approve / Reject -->
        {#if selected.status === 'pending'}
          <Card style="margin-bottom:10px">
            <p class="section-label">DECISION</p>
            <div class="review-fields">
              <label class="field-label">
                Reviewed by
                <input class="review-input" bind:value={reviewedBy} placeholder="your name" />
              </label>
              <label class="field-label">
                Notes (optional)
                <textarea class="review-input review-textarea" bind:value={reviewNotes} placeholder="Leave a note…" rows="2"></textarea>
              </label>
            </div>
            {#if actionErrors[selected.id]}
              <div class="action-err">{actionErrors[selected.id]}</div>
            {/if}
            <div class="decision-btns">
              <Btn
                variant="danger"
                size="md"
                disabled={actioning.has(selected.id)}
                onClick={() => patch(selected!.id, 'reject')}
              >
                {actioning.has(selected.id) ? '…' : 'Reject'}
              </Btn>
              <Btn
                variant="purple"
                size="md"
                disabled={actioning.has(selected.id)}
                onClick={() => patch(selected!.id, 'approve')}
              >
                {actioning.has(selected.id) ? '…' : 'Approve'}
              </Btn>
            </div>
          </Card>
        {:else}
          <div class="reviewed-by">
            Reviewed by <span class="font-mono">{selected.reviewedBy ?? '—'}</span>
            {#if selected.reviewedAt}· {relativeTime(selected.reviewedAt)}{/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

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

  .auto-label { font-size: 11px; color: var(--af-dim); }

  /* ── KPI strip ───────────────────────────────────────────────────────── */
  .kpi-strip {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
    margin-bottom: 14px;
  }

  /* ── Cycle budget gates ──────────────────────────────────────────────── */
  .section-block { margin-bottom: 16px; }

  .section-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 10px;
  }

  .section-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--af-text);
    margin: 0;
  }

  .ca-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
  }

  .ca-left  { flex: 1; min-width: 0; }
  .ca-right { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex-shrink: 0; }

  .ca-id-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }

  .cycle-link {
    font-size: 13px;
    font-weight: 700;
    color: var(--af-accent2);
    text-decoration: none;
  }

  .cycle-link:hover { text-decoration: underline; }

  .version-chip {
    font-size: 10px;
    padding: 1px 7px;
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 9999px;
    color: var(--af-dim);
  }

  .ca-summary {
    font-size: 11px;
    color: var(--af-muted);
    margin: 0 0 8px;
    line-height: 1.5;
  }

  .ca-items {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    font-size: 11px;
    color: var(--af-dim);
  }

  .ca-item { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }
  .ca-more { font-style: italic; }

  .ca-cost {
    font-size: 18px;
    font-weight: 700;
    color: var(--af-success);
  }

  .ca-budget {
    font-size: 11px;
    color: var(--af-dim);
    margin-left: 4px;
    font-weight: 400;
  }

  /* ── Filter chips ────────────────────────────────────────────────────── */
  .filter-row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }

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

  /* ── Error banner ────────────────────────────────────────────────────── */
  .err-banner {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    background: color-mix(in srgb, var(--af-danger) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--af-danger) 25%, transparent);
    border-radius: 6px;
    color: var(--af-danger);
    font-size: 12px;
    margin-bottom: 12px;
  }

  .err-close {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    opacity: 0.6;
    font-size: 12px;
    padding: 0;
  }

  .err-close:hover { opacity: 1; }

  /* ── Skeleton ────────────────────────────────────────────────────────── */
  .skel-card {
    height: 80px;
    background: var(--af-surface);
    border: 1px solid var(--af-border);
    border-radius: 6px;
    margin-bottom: 8px;
    animation: shimmer 1.5s ease-in-out infinite;
  }

  @keyframes shimmer {
    0%, 100% { opacity: 0.4; }
    50%       { opacity: 0.7; }
  }

  /* ── Two-pane layout ─────────────────────────────────────────────────── */
  .two-pane {
    display: grid;
    grid-template-columns: 380px 1fr;
    gap: 14px;
    min-height: 500px;
  }

  /* ── List pane ───────────────────────────────────────────────────────── */
  .pane-list {
    overflow-y: auto;
    max-height: 75vh;
  }

  .list-row {
    display: block;
    width: 100%;
    text-align: left;
    background: var(--af-surface);
    border: 1px solid var(--af-border);
    border-radius: 6px;
    padding: 12px 14px;
    margin-bottom: 8px;
    cursor: pointer;
    transition: border-color 120ms, background 120ms;
    font-family: inherit;
  }

  .list-row:hover { border-color: var(--af-border3); background: var(--af-surface2); }

  .list-row-selected {
    border-color: var(--af-accent);
    background: color-mix(in srgb, var(--af-accent) 6%, transparent);
  }

  .list-top {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }

  .list-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--af-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .list-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  /* ── Detail pane ─────────────────────────────────────────────────────── */
  .pane-detail {
    background: var(--af-surface);
    border: 1px solid var(--af-border);
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .detail-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 12px;
    color: var(--af-dim);
    font-size: 12px;
  }

  .detail-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
  }

  .detail-header {
    margin-bottom: 12px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--af-border);
  }

  .detail-title-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin-bottom: 8px;
  }

  .detail-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--af-text);
    margin: 0;
    line-height: 1.4;
  }

  .detail-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  /* ── Agent chip ──────────────────────────────────────────────────────── */
  .agent-chip {
    font-size: 11px;
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    padding: 2px 7px;
    border-radius: 4px;
    color: var(--af-text);
  }

  /* ── Section labels ──────────────────────────────────────────────────── */
  .section-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--af-dim);
    margin: 0 0 8px;
  }

  /* ── Test chips ──────────────────────────────────────────────────────── */
  .test-chips {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .test-chip {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
  }

  .test-chip.pass  { color: var(--af-success); background: color-mix(in srgb, var(--af-success) 12%, transparent); }
  .test-chip.fail  { color: var(--af-danger);  background: color-mix(in srgb, var(--af-danger) 12%, transparent);  }
  .test-chip.muted { color: var(--af-dim);     background: var(--af-surface2); }

  /* ── Detail body text ────────────────────────────────────────────────── */
  .detail-body {
    font-size: 12px;
    color: var(--af-muted);
    line-height: 1.6;
    margin: 0;
  }

  /* ── Diff viewer ─────────────────────────────────────────────────────── */
  .diff-header {
    padding: 8px 14px;
    border-bottom: 1px solid var(--af-border);
  }

  .diff-pre {
    margin: 0;
    padding: 0;
    font-size: 11px;
    line-height: 1.7;
    overflow-x: auto;
    max-height: 360px;
    overflow-y: auto;
    background: var(--af-surface);
  }

  .diff-line {
    display: block;
    padding: 0 14px;
    white-space: pre;
  }

  .diff-add    { background: color-mix(in srgb, var(--af-success) 10%, transparent); color: var(--af-success); }
  .diff-remove { background: color-mix(in srgb, var(--af-danger)  10%, transparent); color: var(--af-danger); }
  .diff-hunk   { color: var(--af-accent2); background: color-mix(in srgb, var(--af-accent) 6%, transparent); }
  .diff-plain  { color: var(--af-muted); }

  /* ── Review fields ───────────────────────────────────────────────────── */
  .review-fields {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-bottom: 12px;
  }

  .field-label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
    color: var(--af-dim);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .review-input {
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 5px;
    padding: 6px 10px;
    font-size: 12px;
    font-family: inherit;
    color: var(--af-text);
    outline: none;
    transition: border-color 120ms;
  }

  .review-input:focus { border-color: var(--af-accent); }

  .review-textarea { resize: vertical; min-height: 52px; }

  /* ── Decision buttons ────────────────────────────────────────────────── */
  .decision-btns {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }

  .action-err {
    font-size: 11px;
    color: var(--af-danger);
    margin-bottom: 8px;
  }

  .reviewed-by {
    font-size: 11px;
    color: var(--af-dim);
    padding: 10px 0;
  }

  /* ── Empty states ────────────────────────────────────────────────────── */
  .empty {
    text-align: center;
    padding: 40px 20px;
    color: var(--af-dim);
    font-size: 12px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }

  .empty-icon { font-size: 28px; opacity: 0.2; }
  .empty-hint { font-size: 10px; color: var(--af-faint); }

  /* ── Utility ─────────────────────────────────────────────────────────── */
  .font-mono { font-family: var(--af-font-mono); }
  .dim       { color: var(--af-dim); font-size: 11px; }

  /* ── Responsive ──────────────────────────────────────────────────────── */
  @media (max-width: 900px) {
    .two-pane { grid-template-columns: 1fr; }
    .kpi-strip { grid-template-columns: repeat(2, 1fr); }
    .pane-detail { min-height: 400px; }
  }
</style>
