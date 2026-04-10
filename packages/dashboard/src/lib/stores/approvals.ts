// packages/dashboard/src/lib/stores/approvals.ts
//
// Global approval store for the autonomous cycle's budget-gate flow.
//
// Responsibility:
//   - Maintain the list of cycles currently awaiting a budget decision.
//   - Track which approval is open in the ApprovalModal.
//   - React to SSE `cycle_event` messages so the list updates in real-time
//     without a full page reload.
//   - Fall back to 10-second polling when SSE is unavailable.
//
// Usage:
//   import { approvalsStore } from '$lib/stores/approvals';
//   approvalsStore.connectSSE();   // call once in +layout.svelte onMount
//   approvalsStore.disconnectSSE(); // call in onDestroy
//   $approvalsStore.pending        // CycleApproval[]
//   $approvalsStore.active         // CycleApproval | null (open in modal)
//   approvalsStore.open(approval)  // show ApprovalModal
//   approvalsStore.close()         // hide ApprovalModal
//   approvalsStore.dismiss(cycleId)// remove after decision

import { writable } from 'svelte/store';

// ── types ──────────────────────────────────────────────────────────────────

export interface CycleApprovalItem {
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

export interface CycleApproval {
  cycleId: string;
  sprintVersion?: string | null;
  requestedAt: string;
  budgetUsd: number;
  newTotalUsd: number;
  withinBudgetItems: CycleApprovalItem[];
  overflowItems: CycleApprovalItem[];
  agentSummary?: string;
}

interface ApprovalsState {
  pending: CycleApproval[];
  active: CycleApproval | null;
  loading: boolean;
  error: string | null;
}

// ── store factory ──────────────────────────────────────────────────────────

function createApprovalsStore() {
  const { subscribe, update } = writable<ApprovalsState>({
    pending: [],
    active: null,
    loading: false,
    error: null,
  });

  let sseSource: EventSource | null = null;
  let sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let destroyed = false;

  // ── data fetching ────────────────────────────────────────────────────────

  async function refresh(autoOpen = false): Promise<void> {
    update(s => ({ ...s, loading: true, error: null }));
    try {
      // v6.7.4+: use cycle-sessions which now includes hasApprovalPending,
      // letting us skip the full cycles list scan.
      const res = await fetch('/api/v5/cycle-sessions');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as {
        sessions?: Array<{
          cycleId: string;
          hasApprovalPending?: boolean;
          workspaceRoot?: string;
          /** v6.6.0+: registered workspace ID — must be passed to approval endpoint
           *  so the server resolves the correct workspace root in multi-workspace setups. */
          workspaceId?: string;
          status?: string;
          sprintVersion?: string | null;
        }>;
      };
      const candidates = (json?.sessions ?? []).filter(c => c.hasApprovalPending === true);

      const fetched: CycleApproval[] = [];
      for (const c of candidates) {
        try {
          // Pass workspaceId so the server resolves the right workspace root.
          // Without this, multi-workspace deployments silently look in the
          // server's default workspace and never find the approval file.
          const qs = c.workspaceId ? `?workspaceId=${encodeURIComponent(c.workspaceId)}` : '';
          const r = await fetch(`/api/v5/cycles/${c.cycleId}/approval${qs}`);
          if (!r.ok) continue;
          const data = await r.json() as {
            requestedAt?: string;
            budgetUsd?: number;
            newTotalUsd?: number;
            withinBudget?: { items?: CycleApprovalItem[] };
            overflow?: { items?: CycleApprovalItem[] };
            agentSummary?: string;
            /** Injected by the server from sprint-link.json (v9.4+). */
            sprintVersion?: string | null;
          };
          fetched.push({
            cycleId: c.cycleId,
            // Prefer version from approval data (server reads sprint-link.json);
            // fall back to session field for forward compat.
            sprintVersion: data.sprintVersion ?? c.sprintVersion ?? null,
            requestedAt: data.requestedAt ?? new Date().toISOString(),
            budgetUsd: Number(data.budgetUsd ?? 200),
            newTotalUsd: Number(data.newTotalUsd ?? 0),
            withinBudgetItems: (data.withinBudget?.items ?? []),
            overflowItems: (data.overflow?.items ?? []),
            ...(data.agentSummary !== undefined ? { agentSummary: data.agentSummary } : {}),
          });
        } catch { /* skip individual fetch errors — cycle may have been decided */ }
      }

      update(s => {
        // Auto-open modal when a new approval arrives via SSE push and no
        // modal is currently open. "New" = cycleId wasn't in the previous list.
        let active = s.active;
        if (autoOpen && !active && fetched.length > 0) {
          const prevIds = new Set(s.pending.map(a => a.cycleId));
          const newest = fetched.find(a => !prevIds.has(a.cycleId));
          if (newest) active = newest;
        }
        return { ...s, pending: fetched, active, loading: false };
      });
    } catch (e) {
      update(s => ({ ...s, loading: false, error: String(e) }));
    }
  }

  // ── modal state ──────────────────────────────────────────────────────────

  function open(approval: CycleApproval): void {
    update(s => ({ ...s, active: approval }));
  }

  function close(): void {
    update(s => ({ ...s, active: null }));
  }

  /** Remove a cycle from the pending list and close the modal if it matches. */
  function dismiss(cycleId: string): void {
    update(s => ({
      ...s,
      pending: s.pending.filter(a => a.cycleId !== cycleId),
      active: s.active?.cycleId === cycleId ? null : s.active,
    }));
  }

  // ── SSE + polling ────────────────────────────────────────────────────────

  function connectSSE(): void {
    if (destroyed) destroyed = false;
    refresh();
    startSSE();
    // 10-second fallback poll — SSE covers the hot path, polling covers gaps.
    pollTimer = setInterval(refresh, 10_000);
  }

  function disconnectSSE(): void {
    destroyed = true;
    stopSSE();
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startSSE(): void {
    if (sseSource) return;
    sseSource = new EventSource('/api/v5/stream');

    sseSource.onmessage = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string) as {
          type?: string;
          category?: string;
        };
        // Refresh on any cycle event that might indicate a state change.
        // The cycle events watcher publishes `category` = the event type from
        // events.jsonl. We handle both underscore and dot variants of the
        // approval event name since different runtime versions may emit either.
        if (msg?.type === 'cycle_event') {
          const cat = msg.category ?? '';
          const isApprovalPush = cat === 'approval_pending' || cat === 'approval.pending';
          if (isApprovalPush) {
            // autoOpen=true: when a fresh approval arrives via SSE, open the
            // modal immediately so operators don't miss the gate.
            refresh(true);
          } else if (
            cat === 'budget_gate' ||
            cat === 'phase_change' ||
            cat === 'planning_complete'
          ) {
            refresh();
          }
        }
        // Top-level approval.pending event (some runtime versions emit this
        // directly rather than wrapping in cycle_event).
        if (msg?.type === 'approval.pending' || msg?.type === 'approval_pending') {
          refresh(true);
        }
        // Dashboard-wide refresh signals (emitted by the Playwright monitor etc.)
        if (msg?.type === 'refresh_signal') {
          refresh();
        }
      } catch { /* ignore malformed SSE messages */ }
    };

    sseSource.onerror = () => {
      sseSource?.close();
      sseSource = null;
      if (!destroyed) {
        sseReconnectTimer = setTimeout(startSSE, 5_000);
      }
    };
  }

  function stopSSE(): void {
    sseSource?.close();
    sseSource = null;
    if (sseReconnectTimer !== null) {
      clearTimeout(sseReconnectTimer);
      sseReconnectTimer = null;
    }
  }

  return { subscribe, refresh, open, close, dismiss, connectSSE, disconnectSSE };
}

export const approvalsStore = createApprovalsStore();
