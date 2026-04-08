<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  interface ApprovalItem {
    id: string;
    agentId: string;
    action: string;
    description: string;
    requestedAt: string;
    priority: 'critical' | 'high' | 'medium' | 'low';
    status: 'pending' | 'approved' | 'denied';
    // legacy fields from existing endpoint shape
    proposalId?: string;
    proposalTitle?: string;
    executionId?: string;
    impactSummary?: string;
    submittedAt?: string;
    reviewedAt?: string;
    reviewedBy?: string;
    diff?: string;
    testSummary?: { passed: number; failed: number; total: number };
  }

  interface ApprovalsStats {
    pending: number;
    approvedToday: number;
    deniedToday: number;
  }

  let items: ApprovalItem[] = [];
  let stats: ApprovalsStats = { pending: 0, approvedToday: 0, deniedToday: 0 };
  let loading = true;
  let error: string | null = null;
  let apiUnavailable = false;

  let statusFilter = 'pending';
  let actioning: Set<string> = new Set();
  let actionError: Record<string, string> = {};

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  // Normalize items from either endpoint shape
  function normalizeItem(raw: Record<string, unknown>): ApprovalItem {
    return {
      id: String(raw.id ?? ''),
      agentId: String(raw.agentId ?? raw.agent_id ?? raw.executionId ?? '—'),
      action: String(raw.action ?? raw.proposalTitle ?? 'Review required'),
      description: String(raw.description ?? raw.impactSummary ?? ''),
      requestedAt: String(raw.requestedAt ?? raw.submittedAt ?? new Date().toISOString()),
      priority: (['critical','high','medium','low'].includes(String(raw.priority)) ? raw.priority : 'medium') as ApprovalItem['priority'],
      status: (['pending','approved','denied','rejected'].includes(String(raw.status)) ? (raw.status === 'rejected' ? 'denied' : raw.status) : 'pending') as ApprovalItem['status'],
      ...(raw.proposalId !== undefined ? { proposalId: String(raw.proposalId) } : {}),
      ...(raw.proposalTitle !== undefined ? { proposalTitle: String(raw.proposalTitle) } : {}),
      ...(raw.executionId !== undefined ? { executionId: String(raw.executionId) } : {}),
      ...(raw.impactSummary !== undefined ? { impactSummary: String(raw.impactSummary) } : {}),
      ...(raw.submittedAt !== undefined ? { submittedAt: String(raw.submittedAt) } : {}),
      ...(raw.reviewedAt !== undefined ? { reviewedAt: String(raw.reviewedAt) } : {}),
      ...(raw.reviewedBy !== undefined ? { reviewedBy: String(raw.reviewedBy) } : {}),
      ...(raw.diff !== undefined ? { diff: String(raw.diff) } : {}),
      ...(raw.testSummary !== undefined ? { testSummary: raw.testSummary as { passed: number; failed: number; total: number } } : {}),
    };
  }

  async function load(silent = false) {
    if (!silent) loading = true;
    error = null;
    try {
      const res = await fetch(`/api/v5/approvals?status=${statusFilter}`);
      if (res.status === 404) {
        apiUnavailable = true;
        items = MOCK_ITEMS.filter((i) => statusFilter === '' || i.status === statusFilter);
        computeStats();
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const raw: unknown[] = json.data ?? json.pending ?? json ?? [];
      items = (Array.isArray(raw) ? raw : []).map((r) => normalizeItem(r as Record<string, unknown>));
      computeStats();
      apiUnavailable = false;
    } catch (e) {
      error = String(e);
      // Fall through to mock data on error
      items = MOCK_ITEMS.filter((i) => statusFilter === '' || i.status === statusFilter);
      computeStats();
    } finally {
      loading = false;
    }
  }

  function computeStats() {
    const today = new Date().toDateString();
    const pending = items.filter((i) => i.status === 'pending').length;
    const approvedToday = items.filter((i) => i.status === 'approved' && new Date(i.requestedAt).toDateString() === today).length;
    const deniedToday = items.filter((i) => i.status === 'denied' && new Date(i.requestedAt).toDateString() === today).length;
    stats = { pending, approvedToday, deniedToday };
  }

  async function handleApprove(item: ApprovalItem) {
    actioning = new Set([...actioning, item.id]);
    actionError = { ...actionError };
    delete actionError[item.id];
    try {
      const res = await fetch(`/api/v5/approvals/${item.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewedBy: 'dashboard-user' }),
      });
      if (!res.ok) {
        // Try PATCH (legacy)
        const res2 = await fetch(`/api/v5/approvals/${item.id}/approve`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reviewedBy: 'dashboard-user' }),
        });
        if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
      }
      // Optimistic update
      items = items.map((i) => i.id === item.id ? { ...i, status: 'approved' } : i);
      computeStats();
    } catch (e) {
      actionError = { ...actionError, [item.id]: String(e) };
    } finally {
      actioning = new Set([...actioning].filter((id) => id !== item.id));
    }
  }

  async function handleDeny(item: ApprovalItem) {
    actioning = new Set([...actioning, item.id]);
    actionError = { ...actionError };
    delete actionError[item.id];
    try {
      const res = await fetch(`/api/v5/approvals/${item.id}/deny`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewedBy: 'dashboard-user' }),
      });
      if (!res.ok) {
        // Try /reject (legacy)
        const res2 = await fetch(`/api/v5/approvals/${item.id}/reject`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reviewedBy: 'dashboard-user' }),
        });
        if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
      }
      items = items.map((i) => i.id === item.id ? { ...i, status: 'denied' } : i);
      computeStats();
    } catch (e) {
      actionError = { ...actionError, [item.id]: String(e) };
    } finally {
      actioning = new Set([...actioning].filter((id) => id !== item.id));
    }
  }

  function priorityColor(p: ApprovalItem['priority']): string {
    return { critical: 'var(--color-danger)', high: 'var(--color-warning)', medium: 'var(--color-info)', low: 'var(--color-text-muted)' }[p] ?? 'var(--color-text-muted)';
  }

  function fmtDate(iso: string) {
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  }

  function fmtRelative(iso: string): string {
    try {
      const diff = Date.now() - new Date(iso).getTime();
      if (diff < 60000) return 'just now';
      if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
      if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
      return fmtDate(iso);
    } catch { return iso; }
  }

  // Mock data for when API isn't available
  const MOCK_ITEMS: ApprovalItem[] = [
    {
      id: 'mock-1',
      agentId: 'coder',
      action: 'Refactor authentication module',
      description: 'Replace legacy JWT handling with new session-based auth. Affects 12 files.',
      requestedAt: new Date(Date.now() - 300000).toISOString(),
      priority: 'high',
      status: 'pending',
    },
    {
      id: 'mock-2',
      agentId: 'architect',
      action: 'Add database migration v47',
      description: 'Adds new columns to sessions table for cost tracking. Reversible migration.',
      requestedAt: new Date(Date.now() - 900000).toISOString(),
      priority: 'medium',
      status: 'pending',
    },
    {
      id: 'mock-3',
      agentId: 'cto',
      action: 'Update deployment config',
      description: 'Increase worker count from 2 to 4 for improved throughput.',
      requestedAt: new Date(Date.now() - 7200000).toISOString(),
      priority: 'low',
      status: 'approved',
    },
  ];

  // ────────────────────────────────────────────────────────────────────────
  // Cycle Approvals — v6.7.4
  //
  // The autonomous loop's BudgetApproval gate blocks a cycle in the planning
  // phase when the scoring estimate exceeds the per-cycle budget. The dashboard
  // surfaces these as a separate section above the legacy /api/v5/approvals
  // queue. Each pending cycle approval displays its scored items, lets the
  // operator select which to approve, and posts to the new
  // POST /api/v5/cycles/:id/approve endpoint.
  // ────────────────────────────────────────────────────────────────────────

  interface CycleApprovalItem {
    itemId: string;
    title: string;
    rank: number;
    score: number;
    estimatedCostUsd: number;
    estimatedDurationMinutes: number;
    rationale: string;
    suggestedAssignee: string;
    suggestedTags: string[];
    withinBudget: boolean;
  }

  interface CycleApproval {
    cycleId: string;
    sprintVersion?: string | null;
    requestedAt: string;
    budgetUsd: number;
    newTotalUsd: number;
    withinBudgetItems: CycleApprovalItem[];
    overflowItems: CycleApprovalItem[];
    agentSummary?: string;
  }

  let cycleApprovals: CycleApproval[] = $state([]);
  let cycleApprovalsLoading = $state(false);
  let cycleApprovalsError: string | null = $state(null);
  let approvingCycle: Set<string> = $state(new Set());
  // Per-cycle item-level approval selection. Default: all within-budget items selected.
  let cycleSelections: Record<string, Set<string>> = $state({});

  async function loadCycleApprovals(silent = false) {
    if (!silent) cycleApprovalsLoading = true;
    cycleApprovalsError = null;
    try {
      // Discover candidate cycles via the cycles list (which exposes
      // hasApprovalPending). Then fetch each one's full approval payload.
      const res = await fetch('/api/v5/cycles?limit=20');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const list = (json?.cycles ?? []) as Array<{ cycleId: string; hasApprovalPending?: boolean; sprintVersion?: string | null }>;
      const pending = list.filter((c) => c.hasApprovalPending === true);

      const fetched: CycleApproval[] = [];
      for (const c of pending) {
        try {
          const r = await fetch(`/api/v5/cycles/${c.cycleId}/approval`);
          if (!r.ok) continue;
          const data = await r.json();
          fetched.push({
            cycleId: c.cycleId,
            sprintVersion: c.sprintVersion ?? null,
            requestedAt: data.requestedAt ?? new Date().toISOString(),
            budgetUsd: Number(data.budgetUsd ?? 200),
            newTotalUsd: Number(data.newTotalUsd ?? 0),
            withinBudgetItems: (data.withinBudget?.items ?? []) as CycleApprovalItem[],
            overflowItems: (data.overflow?.items ?? []) as CycleApprovalItem[],
            agentSummary: data.agentSummary,
          });
          // Initialize selection: every within-budget item checked, overflow unchecked
          if (!cycleSelections[c.cycleId]) {
            cycleSelections[c.cycleId] = new Set((data.withinBudget?.items ?? []).map((i: CycleApprovalItem) => i.itemId));
          }
        } catch { /* skip individual fetch errors */ }
      }
      cycleApprovals = fetched;
    } catch (e) {
      cycleApprovalsError = String(e);
    } finally {
      cycleApprovalsLoading = false;
    }
  }

  function toggleItem(cycleId: string, itemId: string) {
    const sel = cycleSelections[cycleId] ?? new Set();
    if (sel.has(itemId)) sel.delete(itemId); else sel.add(itemId);
    cycleSelections = { ...cycleSelections, [cycleId]: sel };
  }

  function selectAllItems(approval: CycleApproval) {
    cycleSelections = {
      ...cycleSelections,
      [approval.cycleId]: new Set([
        ...approval.withinBudgetItems.map((i) => i.itemId),
        ...approval.overflowItems.map((i) => i.itemId),
      ]),
    };
  }

  function selectWithinBudget(approval: CycleApproval) {
    cycleSelections = {
      ...cycleSelections,
      [approval.cycleId]: new Set(approval.withinBudgetItems.map((i) => i.itemId)),
    };
  }

  function selectNone(approval: CycleApproval) {
    cycleSelections = { ...cycleSelections, [approval.cycleId]: new Set() };
  }

  function selectedCost(approval: CycleApproval): number {
    const sel = cycleSelections[approval.cycleId] ?? new Set();
    const all = [...approval.withinBudgetItems, ...approval.overflowItems];
    return all.filter((i) => sel.has(i.itemId)).reduce((sum, i) => sum + i.estimatedCostUsd, 0);
  }

  async function approveCycle(approval: CycleApproval, mode: 'selected' | 'approveAll' | 'reject') {
    approvingCycle = new Set([...approvingCycle, approval.cycleId]);
    try {
      let body: { approveAll?: boolean; approvedItemIds?: string[]; rejectedItemIds?: string[]; decidedBy: string };
      if (mode === 'approveAll') {
        body = { approveAll: true, decidedBy: 'dashboard' };
      } else if (mode === 'reject') {
        const all = [...approval.withinBudgetItems, ...approval.overflowItems].map((i) => i.itemId);
        body = { approvedItemIds: [], rejectedItemIds: all, decidedBy: 'dashboard' };
      } else {
        const sel = cycleSelections[approval.cycleId] ?? new Set();
        const allIds = [...approval.withinBudgetItems, ...approval.overflowItems].map((i) => i.itemId);
        body = {
          approvedItemIds: allIds.filter((id) => sel.has(id)),
          rejectedItemIds: allIds.filter((id) => !sel.has(id)),
          decidedBy: 'dashboard',
        };
      }
      const res = await fetch(`/api/v5/cycles/${approval.cycleId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Optimistic: drop this approval from the list. Next poll will refresh.
      cycleApprovals = cycleApprovals.filter((c) => c.cycleId !== approval.cycleId);
    } catch (e) {
      cycleApprovalsError = `Failed to approve ${approval.cycleId.slice(0, 8)}: ${e}`;
    } finally {
      approvingCycle = new Set([...approvingCycle].filter((id) => id !== approval.cycleId));
    }
  }

  function fmtCost(n: number): string {
    return `$${n.toFixed(2)}`;
  }

  onMount(() => {
    load();
    loadCycleApprovals();
    pollTimer = setInterval(() => {
      load(true);
      loadCycleApprovals(true);
    }, 5000);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });
</script>

<svelte:head><title>Approvals — AgentForge</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Approvals Queue</h1>
    <p class="page-subtitle">Human-in-the-loop review for autonomous agent actions</p>
  </div>
  <div class="header-actions">
    <select class="filter-select" bind:value={statusFilter} onchange={() => load()}>
      <option value="">All</option>
      <option value="pending">Pending</option>
      <option value="approved">Approved</option>
      <option value="denied">Denied</option>
    </select>
    <button class="btn btn-ghost btn-sm" onclick={() => load()} disabled={loading}>
      {loading ? 'Loading…' : 'Refresh'}
    </button>
  </div>
</div>

<!-- ───────────────────────────────────────────────────────────────────────
     Cycle Approvals — autonomous loop budget gates that need a human decision
     ─────────────────────────────────────────────────────────────────────── -->
{#if cycleApprovals.length > 0 || cycleApprovalsLoading}
  <div class="cycle-approvals-section">
    <div class="section-header">
      <h2>Cycle Budget Approvals</h2>
      <span class="muted">{cycleApprovals.length} pending — auto-refreshes every 5s</span>
    </div>
    {#if cycleApprovalsError}
      <div class="error-banner">{cycleApprovalsError}</div>
    {/if}

    {#each cycleApprovals as approval (approval.cycleId)}
      {@const isApproving = approvingCycle.has(approval.cycleId)}
      {@const sel = cycleSelections[approval.cycleId] ?? new Set()}
      {@const selCost = selectedCost(approval)}
      {@const overBudget = selCost > approval.budgetUsd}

      <div class="cycle-approval-card">
        <div class="ca-header">
          <div>
            <a class="ca-cycleid mono" href={`/cycles/${approval.cycleId}`}>{approval.cycleId.slice(0, 8)}</a>
            {#if approval.sprintVersion}<span class="ca-version mono">v{approval.sprintVersion}</span>{/if}
            <span class="muted ca-relative">{fmtRelative(approval.requestedAt)}</span>
          </div>
          <div class="ca-totals">
            <div class="ca-cost {overBudget ? 'over' : 'ok'}">
              <span class="ca-cost-num">{fmtCost(selCost)}</span>
              <span class="ca-cost-budget">/ {fmtCost(approval.budgetUsd)}</span>
            </div>
            <div class="muted ca-cost-label">{sel.size} of {approval.withinBudgetItems.length + approval.overflowItems.length} items selected</div>
          </div>
        </div>

        {#if approval.agentSummary}
          <div class="ca-summary muted">{approval.agentSummary}</div>
        {/if}

        <div class="ca-quick-actions">
          <button class="btn btn-ghost btn-sm" onclick={() => selectWithinBudget(approval)}>Within budget only</button>
          <button class="btn btn-ghost btn-sm" onclick={() => selectAllItems(approval)}>Select all</button>
          <button class="btn btn-ghost btn-sm" onclick={() => selectNone(approval)}>Clear</button>
        </div>

        <div class="ca-items">
          {#each approval.withinBudgetItems as item (item.itemId)}
            <label class="ca-item" class:selected={sel.has(item.itemId)}>
              <input type="checkbox" checked={sel.has(item.itemId)} onchange={() => toggleItem(approval.cycleId, item.itemId)} />
              <div class="ca-item-body">
                <div class="ca-item-title">
                  <span class="ca-item-rank">#{item.rank}</span>
                  {item.title}
                </div>
                <div class="ca-item-meta muted">
                  <span>{item.suggestedAssignee}</span>
                  <span>·</span>
                  <span>{fmtCost(item.estimatedCostUsd)}</span>
                  <span>·</span>
                  <span>{item.estimatedDurationMinutes}m</span>
                </div>
              </div>
            </label>
          {/each}
          {#if approval.overflowItems.length > 0}
            <div class="ca-overflow-divider muted">Overflow — over budget</div>
            {#each approval.overflowItems as item (item.itemId)}
              <label class="ca-item overflow" class:selected={sel.has(item.itemId)}>
                <input type="checkbox" checked={sel.has(item.itemId)} onchange={() => toggleItem(approval.cycleId, item.itemId)} />
                <div class="ca-item-body">
                  <div class="ca-item-title">
                    <span class="ca-item-rank">#{item.rank}</span>
                    {item.title}
                  </div>
                  <div class="ca-item-meta muted">
                    <span>{item.suggestedAssignee}</span>
                    <span>·</span>
                    <span>{fmtCost(item.estimatedCostUsd)}</span>
                    <span>·</span>
                    <span>{item.estimatedDurationMinutes}m</span>
                  </div>
                </div>
              </label>
            {/each}
          {/if}
        </div>

        <div class="ca-footer">
          <button class="btn btn-primary" disabled={isApproving || sel.size === 0} onclick={() => approveCycle(approval, 'selected')}>
            {isApproving ? 'Approving…' : `Approve ${sel.size} items (${fmtCost(selCost)})`}
          </button>
          <button class="btn btn-ghost" disabled={isApproving} onclick={() => approveCycle(approval, 'approveAll')}>
            Approve all
          </button>
          <button class="btn btn-ghost danger" disabled={isApproving} onclick={() => approveCycle(approval, 'reject')}>
            Reject all
          </button>
        </div>
      </div>
    {/each}
  </div>
{/if}

<!-- Stats bar -->
<div class="stats-bar">
  <div class="stat-pill pending">
    <span class="stat-pill-value">{stats.pending}</span>
    <span class="stat-pill-label">Pending</span>
  </div>
  <div class="stat-divider"></div>
  <div class="stat-pill approved">
    <span class="stat-pill-value">{stats.approvedToday}</span>
    <span class="stat-pill-label">Approved today</span>
  </div>
  <div class="stat-divider"></div>
  <div class="stat-pill denied">
    <span class="stat-pill-value">{stats.deniedToday}</span>
    <span class="stat-pill-label">Denied today</span>
  </div>
  <div class="stat-refresh">
    <span class="auto-refresh-label">Auto-refresh every 5s</span>
    <span class="refresh-dot" class:active={!loading}></span>
  </div>
</div>

{#if apiUnavailable}
  <div class="api-banner">
    <strong>Preview mode</strong> — <code>/api/v5/approvals</code> not available. Showing mock data.
  </div>
{/if}

{#if error && !apiUnavailable}
  <div class="error-banner">{error}</div>
{/if}

{#if loading && items.length === 0}
  <div class="card">
    {#each Array(3) as _}
      <div class="skeleton" style="height:90px;margin-bottom:var(--space-3);border-radius:var(--radius-md);"></div>
    {/each}
  </div>
{:else if items.length === 0}
  <div class="empty-state">
    <span style="font-size:32px;opacity:0.2;">✓</span>
    <p>{statusFilter === 'pending' ? 'No pending approvals — all clear.' : 'No items match this filter.'}</p>
    <p style="font-size:var(--text-xs);color:var(--color-text-faint);">The autonomous team is operating within approved boundaries.</p>
  </div>
{:else}
  <div class="approval-list">
    {#each items as item (item.id)}
      <div class="approval-card card">
        <div class="approval-top">
          <div class="approval-left">
            <div class="approval-action-row">
              <span
                class="priority-badge"
                style="color: {priorityColor(item.priority)}; border-color: {priorityColor(item.priority)}44; background: {priorityColor(item.priority)}11;"
              >
                {item.priority}
              </span>
              <span class="approval-action">{item.action}</span>
            </div>
            <div class="approval-meta">
              <span class="agent-chip">{item.agentId}</span>
              <span class="meta-sep">·</span>
              <span class="meta-time" title={fmtDate(item.requestedAt)}>{fmtRelative(item.requestedAt)}</span>
              {#if item.testSummary}
                <span class="meta-sep">·</span>
                <span class="test-result">✓ {item.testSummary.passed}/{item.testSummary.total} tests</span>
              {/if}
            </div>
            {#if item.description}
              <p class="approval-desc">{item.description}</p>
            {/if}
            {#if item.diff}
              <details class="diff-details">
                <summary class="diff-summary">View diff</summary>
                <pre class="diff-viewer">{item.diff}</pre>
              </details>
            {/if}
            {#if actionError[item.id]}
              <div class="action-error">{actionError[item.id]}</div>
            {/if}
          </div>

          <div class="approval-right">
            {#if item.status === 'pending'}
              <div class="action-buttons">
                <button
                  class="btn btn-approve"
                  disabled={actioning.has(item.id)}
                  onclick={() => handleApprove(item)}
                >
                  {actioning.has(item.id) ? '…' : 'Approve'}
                </button>
                <button
                  class="btn btn-deny"
                  disabled={actioning.has(item.id)}
                  onclick={() => handleDeny(item)}
                >
                  {actioning.has(item.id) ? '…' : 'Deny'}
                </button>
              </div>
            {:else}
              <span class="status-badge status-{item.status}">{item.status}</span>
              {#if item.reviewedAt}
                <span class="reviewed-by">by {item.reviewedBy ?? 'dashboard-user'}</span>
              {/if}
            {/if}
          </div>
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .filter-select {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: var(--space-1) var(--space-2);
    font-size: var(--text-xs);
    color: var(--color-text);
    cursor: pointer;
  }

  /* Stats bar */
  .stats-bar {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    background: var(--color-bg-card);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-3) var(--space-5);
    margin-bottom: var(--space-4);
  }

  .stat-pill {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }

  .stat-pill-value {
    font-family: var(--font-mono);
    font-size: var(--text-xl);
    font-weight: 700;
    line-height: 1;
  }

  .stat-pill.pending .stat-pill-value { color: var(--color-warning); }
  .stat-pill.approved .stat-pill-value { color: var(--color-success); }
  .stat-pill.denied .stat-pill-value { color: var(--color-danger); }

  .stat-pill-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    white-space: nowrap;
  }

  .stat-divider {
    width: 1px;
    height: 28px;
    background: var(--color-border);
  }

  .stat-refresh {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .auto-refresh-label {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
  }

  .refresh-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-border);
    transition: background 0.3s;
  }

  .refresh-dot.active {
    background: var(--color-success);
  }

  /* Banners */
  .api-banner {
    background: rgba(245,166,35,0.08);
    border: 1px solid rgba(245,166,35,0.25);
    border-radius: var(--radius-md);
    color: var(--color-warning);
    font-size: var(--text-xs);
    padding: var(--space-2) var(--space-4);
    margin-bottom: var(--space-3);
  }

  .api-banner code {
    font-family: var(--font-mono);
    background: rgba(245,166,35,0.15);
    padding: 1px 4px;
    border-radius: 3px;
  }

  .error-banner {
    background: rgba(224,90,90,0.08);
    border: 1px solid rgba(224,90,90,0.25);
    border-radius: var(--radius-md);
    color: var(--color-danger);
    font-size: var(--text-xs);
    padding: var(--space-2) var(--space-4);
    margin-bottom: var(--space-3);
  }

  /* Approval list */
  .approval-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .approval-card {
    padding: var(--space-4) var(--space-5);
    transition: border-color var(--duration-fast);
  }

  .approval-card:hover {
    transform: none;
    box-shadow: none;
    border-color: var(--color-border-strong);
  }

  .approval-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-6);
  }

  .approval-left {
    flex: 1;
    min-width: 0;
  }

  .approval-action-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
  }

  .priority-badge {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 2px 7px;
    border-radius: var(--radius-full);
    border: 1px solid transparent;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .approval-action {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .approval-meta {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    margin-bottom: var(--space-2);
    flex-wrap: wrap;
  }

  .agent-chip {
    font-family: var(--font-mono);
    font-size: 11px;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: 1px 6px;
    color: var(--color-text);
  }

  .meta-sep { color: var(--color-text-faint); }
  .meta-time { color: var(--color-text-faint); }
  .test-result { color: var(--color-success); font-size: var(--text-xs); }

  .approval-desc {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    margin: 0 0 var(--space-2) 0;
    line-height: 1.5;
  }

  .diff-details {
    margin-top: var(--space-2);
  }

  .diff-summary {
    font-size: var(--text-xs);
    color: var(--color-brand);
    cursor: pointer;
    user-select: none;
    margin-bottom: var(--space-2);
  }

  .diff-viewer {
    background: var(--color-bg-elevated);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: var(--space-3);
    font-family: var(--font-mono);
    font-size: 11px;
    overflow-x: auto;
    white-space: pre;
    max-height: 280px;
    overflow-y: auto;
    margin: 0;
  }

  .action-error {
    font-size: var(--text-xs);
    color: var(--color-danger);
    margin-top: var(--space-1);
  }

  /* Action buttons */
  .approval-right {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--space-2);
    flex-shrink: 0;
  }

  .action-buttons {
    display: flex;
    gap: var(--space-2);
  }

  .btn-approve {
    background: rgba(76,175,130,0.15);
    border: 1px solid rgba(76,175,130,0.4);
    color: var(--color-success);
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: 600;
    cursor: pointer;
    transition: background var(--duration-fast), border-color var(--duration-fast);
    white-space: nowrap;
  }

  .btn-approve:hover:not(:disabled) {
    background: rgba(76,175,130,0.25);
    border-color: rgba(76,175,130,0.6);
  }

  .btn-approve:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .btn-deny {
    background: rgba(224,90,90,0.1);
    border: 1px solid rgba(224,90,90,0.35);
    color: var(--color-danger);
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: 600;
    cursor: pointer;
    transition: background var(--duration-fast), border-color var(--duration-fast);
    white-space: nowrap;
  }

  .btn-deny:hover:not(:disabled) {
    background: rgba(224,90,90,0.2);
    border-color: rgba(224,90,90,0.55);
  }

  .btn-deny:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .status-badge {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 3px 10px;
    border-radius: var(--radius-full);
  }

  .status-approved {
    background: rgba(76,175,130,0.15);
    color: var(--color-success);
  }

  .status-denied {
    background: rgba(224,90,90,0.12);
    color: var(--color-danger);
  }

  .reviewed-by {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    font-family: var(--font-mono);
  }
  /* ── Cycle approvals (v6.7.4) ─────────────────────────────────────── */
  .cycle-approvals-section {
    margin-bottom: var(--space-6);
  }
  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: var(--space-4);
  }
  .section-header h2 {
    font-size: var(--text-lg);
    margin: 0;
  }
  .cycle-approval-card {
    background: var(--color-bg-elevated);
    border: 1px solid var(--color-border);
    border-left: 3px solid var(--color-warning);
    border-radius: var(--radius-md);
    padding: var(--space-4);
    margin-bottom: var(--space-4);
  }
  .ca-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: var(--space-3);
  }
  .ca-cycleid {
    color: var(--color-brand);
    font-weight: 700;
    text-decoration: none;
    font-size: var(--text-md);
  }
  .ca-cycleid:hover { text-decoration: underline; }
  .ca-version {
    margin-left: var(--space-2);
    padding: 2px var(--space-2);
    background: var(--color-bg-card);
    border: 1px solid var(--color-border);
    border-radius: 9999px;
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }
  .ca-relative {
    margin-left: var(--space-2);
    font-size: var(--text-xs);
  }
  .ca-totals { text-align: right; }
  .ca-cost {
    font-size: var(--text-xl);
    font-weight: 700;
    font-family: var(--font-mono);
  }
  .ca-cost.ok { color: var(--color-success); }
  .ca-cost.over { color: var(--color-warning); }
  .ca-cost-budget {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    margin-left: var(--space-1);
  }
  .ca-cost-label {
    font-size: var(--text-xs);
    margin-top: var(--space-1);
  }
  .ca-summary {
    background: var(--color-bg-card);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
    margin-bottom: var(--space-3);
    font-size: var(--text-xs);
    line-height: 1.5;
    border-left: 2px solid var(--color-border);
  }
  .ca-quick-actions {
    display: flex;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }
  .ca-items {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    max-height: 400px;
    overflow-y: auto;
    margin-bottom: var(--space-3);
    padding: var(--space-2);
    background: var(--color-bg-card);
    border-radius: var(--radius-sm);
  }
  .ca-item {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background var(--duration-fast);
  }
  .ca-item:hover { background: var(--color-bg-elevated); }
  .ca-item.selected { background: rgba(91,138,245,0.06); }
  .ca-item input[type="checkbox"] {
    margin-top: 4px;
    flex-shrink: 0;
  }
  .ca-item-body { flex: 1; min-width: 0; }
  .ca-item-title {
    font-size: var(--text-sm);
    color: var(--color-text);
    line-height: 1.4;
  }
  .ca-item-rank {
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    margin-right: var(--space-2);
  }
  .ca-item-meta {
    font-size: var(--text-xs);
    margin-top: var(--space-1);
    display: flex;
    gap: var(--space-2);
  }
  .ca-item.overflow .ca-item-rank { color: var(--color-warning); }
  .ca-overflow-divider {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: var(--space-2) var(--space-3);
    border-top: 1px solid var(--color-border);
    margin-top: var(--space-2);
  }
  .ca-footer {
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }
  .btn.danger { color: var(--color-danger); }
  .btn.danger:hover { background: rgba(224,90,90,0.08); }
</style>
