<script lang="ts">
  import { approvalsStore, type CycleApproval, type CycleApprovalItem } from '$lib/stores/approvals.js';

  // ── local selection state ────────────────────────────────────────────────
  // Resets each time a new approval is opened; default = all within-budget.

  let approval: CycleApproval | null = $state(null);
  let selected: Set<string> = $state(new Set());
  let submitting = $state(false);
  let submitError: string | null = $state(null);
  let submitSuccess = $state(false);

  // Subscribe to the global store's active approval.
  const unsub = approvalsStore.subscribe(s => {
    if (s.active?.cycleId !== approval?.cycleId) {
      // New approval opened — reset selection to within-budget defaults.
      approval = s.active;
      selected = new Set((s.active?.withinBudgetItems ?? []).map(i => i.itemId));
      submitting = false;
      submitError = null;
      submitSuccess = false;
    }
  });

  // Svelte action: show/close native <dialog>, wire Escape key.
  function dialogAction(node: HTMLDialogElement) {
    if (approval) node.showModal();

    function onKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKeydown);
    return {
      destroy() {
        document.removeEventListener('keydown', onKeydown);
        unsub();
      },
    };
  }

  // ── derived helpers ──────────────────────────────────────────────────────

  function allItems(): CycleApprovalItem[] {
    if (!approval) return [];
    return [...approval.withinBudgetItems, ...approval.overflowItems];
  }

  function selectedCost(): number {
    return allItems()
      .filter(i => selected.has(i.itemId))
      .reduce((sum, i) => sum + i.estimatedCostUsd, 0);
  }

  function isOverBudget(): boolean {
    return approval ? selectedCost() > approval.budgetUsd : false;
  }

  // ── selection helpers ────────────────────────────────────────────────────

  function toggleItem(itemId: string) {
    const next = new Set(selected);
    if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
    selected = next;
  }

  function selectWithinBudget() {
    selected = new Set((approval?.withinBudgetItems ?? []).map(i => i.itemId));
  }

  function selectAll() {
    selected = new Set(allItems().map(i => i.itemId));
  }

  function selectNone() {
    selected = new Set();
  }

  // ── submission ───────────────────────────────────────────────────────────

  async function submit(mode: 'selected' | 'approveAll' | 'reject') {
    if (!approval || submitting) return;
    submitting = true;
    submitError = null;
    try {
      let body: {
        approveAll?: boolean;
        approvedItemIds?: string[];
        rejectedItemIds?: string[];
        decidedBy: string;
      };

      if (mode === 'approveAll') {
        body = { approveAll: true, decidedBy: 'dashboard' };
      } else if (mode === 'reject') {
        body = {
          approvedItemIds: [],
          rejectedItemIds: allItems().map(i => i.itemId),
          decidedBy: 'dashboard',
        };
      } else {
        const ids = allItems().map(i => i.itemId);
        body = {
          approvedItemIds: ids.filter(id => selected.has(id)),
          rejectedItemIds: ids.filter(id => !selected.has(id)),
          decidedBy: 'dashboard',
        };
      }

      const res = await fetch(`/api/v5/cycles/${approval.cycleId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err?.error ?? `HTTP ${res.status}`);
      }

      submitSuccess = true;
      approvalsStore.dismiss(approval.cycleId);
      // Brief success flash then auto-close
      setTimeout(close, 900);
    } catch (e) {
      submitError = String(e);
      submitting = false;
    }
  }

  function close() {
    approvalsStore.close();
  }

  function onBackdropClick(e: MouseEvent) {
    if ((e.target as HTMLElement).tagName === 'DIALOG') close();
  }

  // ── formatting ───────────────────────────────────────────────────────────

  function fmtCost(n: number): string {
    return `$${n.toFixed(2)}`;
  }

  function fmtRelative(iso: string): string {
    try {
      const diff = Date.now() - new Date(iso).getTime();
      if (diff < 60_000) return 'just now';
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
      return new Date(iso).toLocaleString();
    } catch { return iso; }
  }
</script>

{#if approval}
  <!-- Native <dialog> handles focus trapping and backdrop -->
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
  <dialog
    class="approval-modal"
    use:dialogAction
    onclick={onBackdropClick}
    aria-label="Cycle budget approval review"
  >
    <div class="modal-inner">
      <!-- ── header ──────────────────────────────────────────────────── -->
      <div class="modal-header">
        <div class="modal-title-row">
          <span class="modal-badge">Budget Review</span>
          <h2 class="modal-title">Cycle Approval Request</h2>
        </div>
        <button class="btn-close" onclick={close} aria-label="Close modal">✕</button>
      </div>

      <!-- ── cycle meta ─────────────────────────────────────────────── -->
      <div class="modal-meta">
        <a class="cycle-id mono" href={`/cycles/${approval.cycleId}`} target="_self">
          {approval.cycleId.slice(0, 8)}
        </a>
        {#if approval.sprintVersion}
          <span class="version-badge mono">v{approval.sprintVersion}</span>
        {/if}
        <span class="meta-sep">·</span>
        <span class="muted">{fmtRelative(approval.requestedAt)}</span>

        <div class="budget-readout" class:over={isOverBudget()}>
          <span class="budget-selected">{fmtCost(selectedCost())}</span>
          <span class="budget-slash muted"> / </span>
          <span class="budget-total muted">{fmtCost(approval.budgetUsd)} budget</span>
          {#if isOverBudget()}
            <span class="budget-warn">⚠ over budget</span>
          {/if}
        </div>
      </div>

      <!-- ── agent summary ──────────────────────────────────────────── -->
      {#if approval.agentSummary}
        <div class="agent-summary">{approval.agentSummary}</div>
      {/if}

      <!-- ── quick selection actions ───────────────────────────────── -->
      <div class="quick-actions">
        <span class="quick-label muted">Quick select:</span>
        <button class="btn btn-ghost btn-sm" onclick={selectWithinBudget}>Within budget only</button>
        <button class="btn btn-ghost btn-sm" onclick={selectAll}>Select all</button>
        <button class="btn btn-ghost btn-sm" onclick={selectNone}>Clear</button>
        <span class="sel-count muted">{selected.size} of {allItems().length} selected</span>
      </div>

      <!-- ── item list ──────────────────────────────────────────────── -->
      <div class="item-list" role="list">
        {#if approval.withinBudgetItems.length > 0}
          <div class="list-group-label muted">Within budget</div>
        {/if}
        {#each approval.withinBudgetItems as item (item.itemId)}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <label
            class="item-row"
            class:item-checked={selected.has(item.itemId)}
            role="listitem"
          >
            <input
              type="checkbox"
              checked={selected.has(item.itemId)}
              onchange={() => toggleItem(item.itemId)}
            />
            <div class="item-body">
              <div class="item-title">
                <span class="item-rank mono">#{item.rank}</span>
                {item.title}
              </div>
              <div class="item-meta muted">
                <span>{item.suggestedAssignee}</span>
                <span>·</span>
                <span class="item-cost">{fmtCost(item.estimatedCostUsd)}</span>
                <span>·</span>
                <span>{item.estimatedDurationMinutes}m</span>
                {#if item.rationale}
                  <span>·</span>
                  <span class="item-rationale">{item.rationale}</span>
                {/if}
              </div>
            </div>
          </label>
        {/each}

        {#if approval.overflowItems.length > 0}
          <div class="overflow-divider muted">
            <span class="overflow-label">Overflow — over budget</span>
          </div>
          {#each approval.overflowItems as item (item.itemId)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <label
              class="item-row item-overflow"
              class:item-checked={selected.has(item.itemId)}
              role="listitem"
            >
              <input
                type="checkbox"
                checked={selected.has(item.itemId)}
                onchange={() => toggleItem(item.itemId)}
              />
              <div class="item-body">
                <div class="item-title">
                  <span class="item-rank mono overflow-rank">#{item.rank}</span>
                  {item.title}
                </div>
                <div class="item-meta muted">
                  <span>{item.suggestedAssignee}</span>
                  <span>·</span>
                  <span class="item-cost">{fmtCost(item.estimatedCostUsd)}</span>
                  <span>·</span>
                  <span>{item.estimatedDurationMinutes}m</span>
                </div>
              </div>
            </label>
          {/each}
        {/if}
      </div>

      <!-- ── error/success banners ──────────────────────────────────── -->
      {#if submitError}
        <div class="submit-error">{submitError}</div>
      {/if}
      {#if submitSuccess}
        <div class="submit-success">✓ Decision recorded — cycle unblocked.</div>
      {/if}

      <!-- ── action bar ─────────────────────────────────────────────── -->
      <div class="modal-footer">
        <button
          class="btn btn-primary"
          disabled={submitting || selected.size === 0}
          onclick={() => submit('selected')}
        >
          {submitting ? 'Submitting…' : `Approve ${selected.size} item${selected.size !== 1 ? 's' : ''} (${fmtCost(selectedCost())})`}
        </button>
        <button
          class="btn btn-ghost"
          disabled={submitting}
          onclick={() => submit('approveAll')}
        >
          Approve all
        </button>
        <button
          class="btn btn-ghost btn-danger"
          disabled={submitting}
          onclick={() => submit('reject')}
        >
          Reject all
        </button>
        <button class="btn btn-ghost modal-cancel" disabled={submitting} onclick={close}>
          Cancel
        </button>
      </div>
    </div>
  </dialog>
{/if}

<style>
  /* ── dialog backdrop + centering ────────────────────────────────────── */
  .approval-modal {
    border: none;
    border-radius: var(--radius-xl, 12px);
    background: var(--color-bg-elevated);
    color: var(--color-text);
    padding: 0;
    max-width: min(680px, 96vw);
    width: 100%;
    max-height: min(85vh, 900px);
    box-shadow: 0 24px 64px rgba(0,0,0,0.48), 0 0 0 1px var(--color-border);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .approval-modal::backdrop {
    background: rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(2px);
  }

  /* ── inner layout ───────────────────────────────────────────────────── */
  .modal-inner {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    max-height: min(85vh, 900px);
  }

  /* ── header ─────────────────────────────────────────────────────────── */
  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }

  .modal-title-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .modal-badge {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding: 2px 8px;
    border-radius: var(--radius-full);
    background: rgba(245,166,35,0.15);
    color: var(--color-warning);
    border: 1px solid rgba(245,166,35,0.35);
    white-space: nowrap;
  }

  .modal-title {
    font-size: var(--text-md);
    font-weight: 700;
    margin: 0;
    color: var(--color-text);
  }

  .btn-close {
    background: none;
    border: none;
    color: var(--color-text-muted);
    font-size: 14px;
    cursor: pointer;
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    line-height: 1;
    transition: color var(--duration-fast), background var(--duration-fast);
  }

  .btn-close:hover {
    color: var(--color-text);
    background: var(--color-surface-2);
  }

  /* ── cycle meta ─────────────────────────────────────────────────────── */
  .modal-meta {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-5);
    border-bottom: 1px solid var(--color-border);
    flex-wrap: wrap;
    flex-shrink: 0;
  }

  .cycle-id {
    color: var(--color-brand);
    font-weight: 700;
    text-decoration: none;
    font-size: var(--text-sm);
  }

  .cycle-id:hover { text-decoration: underline; }

  .version-badge {
    font-size: var(--text-xs);
    padding: 1px var(--space-2);
    background: var(--color-bg-card);
    border: 1px solid var(--color-border);
    border-radius: 9999px;
    color: var(--color-text-muted);
  }

  .meta-sep {
    color: var(--color-text-faint);
    font-size: var(--text-xs);
  }

  .budget-readout {
    margin-left: auto;
    display: flex;
    align-items: baseline;
    gap: 4px;
    font-family: var(--font-mono);
  }

  .budget-selected {
    font-size: var(--text-xl);
    font-weight: 700;
    color: var(--color-success);
    transition: color var(--duration-fast);
  }

  .budget-readout.over .budget-selected {
    color: var(--color-warning);
  }

  .budget-slash,
  .budget-total {
    font-size: var(--text-sm);
  }

  .budget-warn {
    font-size: var(--text-xs);
    color: var(--color-warning);
    margin-left: var(--space-2);
  }

  /* ── agent summary ──────────────────────────────────────────────────── */
  .agent-summary {
    padding: var(--space-2) var(--space-5);
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    line-height: 1.6;
    background: var(--color-bg-card);
    border-bottom: 1px solid var(--color-border);
    border-left: 3px solid var(--color-border-strong);
    flex-shrink: 0;
  }

  /* ── quick selection ────────────────────────────────────────────────── */
  .quick-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-5);
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg-card);
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .quick-label {
    font-size: var(--text-xs);
    margin-right: var(--space-1);
  }

  .sel-count {
    margin-left: auto;
    font-size: var(--text-xs);
    font-family: var(--font-mono);
  }

  /* ── item list ──────────────────────────────────────────────────────── */
  .item-list {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-2) var(--space-3);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .list-group-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: var(--space-2) var(--space-2);
  }

  .item-row {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background var(--duration-fast);
    border: 1px solid transparent;
  }

  .item-row:hover {
    background: var(--color-bg-elevated);
  }

  .item-row.item-checked {
    background: rgba(91,138,245,0.06);
    border-color: rgba(91,138,245,0.15);
  }

  .item-row input[type="checkbox"] {
    margin-top: 3px;
    flex-shrink: 0;
    cursor: pointer;
  }

  .item-body {
    flex: 1;
    min-width: 0;
  }

  .item-title {
    font-size: var(--text-sm);
    color: var(--color-text);
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item-rank {
    color: var(--color-text-muted);
    margin-right: var(--space-2);
    font-size: var(--text-xs);
  }

  .overflow-rank {
    color: var(--color-warning);
  }

  .item-meta {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-xs);
    margin-top: 2px;
    flex-wrap: wrap;
  }

  .item-cost {
    font-family: var(--font-mono);
  }

  .item-rationale {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 220px;
    opacity: 0.7;
  }

  .item-overflow .item-title {
    color: var(--color-text-muted);
  }

  .overflow-divider {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-2);
    margin-top: var(--space-2);
    font-size: 10px;
  }

  .overflow-label {
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-warning);
    opacity: 0.8;
  }

  /* ── status banners ─────────────────────────────────────────────────── */
  .submit-error {
    margin: 0 var(--space-5) var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: rgba(224,90,90,0.08);
    border: 1px solid rgba(224,90,90,0.3);
    border-radius: var(--radius-sm);
    color: var(--color-danger);
    font-size: var(--text-xs);
  }

  .submit-success {
    margin: 0 var(--space-5) var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: rgba(76,175,130,0.1);
    border: 1px solid rgba(76,175,130,0.3);
    border-radius: var(--radius-sm);
    color: var(--color-success);
    font-size: var(--text-sm);
    font-weight: 600;
    text-align: center;
  }

  /* ── footer action bar ──────────────────────────────────────────────── */
  .modal-footer {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-4) var(--space-5);
    border-top: 1px solid var(--color-border);
    background: var(--color-bg-card);
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .btn-danger {
    color: var(--color-danger);
  }

  .btn-danger:hover:not(:disabled) {
    background: rgba(224,90,90,0.08);
    color: var(--color-danger);
  }

  .modal-cancel {
    margin-left: auto;
    color: var(--color-text-muted);
  }
</style>
