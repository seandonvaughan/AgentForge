<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { writable } from 'svelte/store';

  const SERVER_URL = '';

  type BranchStatus = 'active' | 'merged' | 'conflict';

  interface BranchRecord {
    id: string;
    name: string;
    ownerAgent: string;
    task: string;
    status: BranchStatus;
    createdAt: string;
    recentActivity?: string[];
  }

  interface BranchEvent {
    type: string;
    data?: {
      branchId?: string;
      status?: BranchStatus;
      message?: string;
    };
    message?: string;
    timestamp?: string;
  }

  // Mock data — backend stub until /api/v5/branches is implemented
  const MOCK_BRANCHES: BranchRecord[] = [
    {
      id: 'br-1',
      name: 'agent/coder/task-stream-endpoint',
      ownerAgent: 'coder',
      task: 'Implement SSE stream endpoint',
      status: 'merged',
      createdAt: new Date(Date.now() - 3600000 * 2).toISOString(),
      recentActivity: [
        'Branch created by coder agent',
        'Code review passed — CodeReviewer APPROVE',
        'Merged into main by MergeController',
      ],
    },
    {
      id: 'br-2',
      name: 'agent/coder/task-dashboard-live',
      ownerAgent: 'coder',
      task: 'Dashboard live feed page',
      status: 'active',
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      recentActivity: [
        'Branch created by coder agent',
        'Awaiting code review',
      ],
    },
    {
      id: 'br-3',
      name: 'agent/debugger/task-fix-sse-cors',
      ownerAgent: 'debugger',
      task: 'Fix SSE CORS headers',
      status: 'conflict',
      createdAt: new Date(Date.now() - 1800000).toISOString(),
      recentActivity: [
        'Branch created by debugger agent',
        'Conflict detected with agent/coder/task-stream-endpoint',
        'Escalated to ConflictResolver',
      ],
    },
    {
      id: 'br-4',
      name: 'agent/api-specialist/task-branches-route',
      ownerAgent: 'api-specialist',
      task: 'Add /api/v5/branches route',
      status: 'active',
      createdAt: new Date(Date.now() - 900000).toISOString(),
      recentActivity: [
        'Branch created by api-specialist agent',
        'Tests passing — queued for review',
      ],
    },
  ];

  const branches = writable<BranchRecord[]>([]);
  const loading = writable(true);
  const error = writable<string | null>(null);
  const expandedId = writable<string | null>(null);

  let eventSource: EventSource | null = null;

  async function fetchBranches() {
    loading.set(true);
    error.set(null);
    try {
      const res = await fetch(`${SERVER_URL}/api/v5/branches`);
      if (res.ok) {
        const body = await res.json();
        branches.set(body.data ?? []);
      } else {
        // Server stub not yet implemented — use mock data
        branches.set(MOCK_BRANCHES);
      }
    } catch {
      // Offline or stub not wired — show mock data
      branches.set(MOCK_BRANCHES);
    } finally {
      loading.set(false);
    }
  }

  function connectSSE() {
    const es = new EventSource(`${SERVER_URL}/api/v5/stream`);
    eventSource = es;

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as BranchEvent;
        if (event.type === 'branch_event') {
          const { branchId, status } = event.data ?? {};
          if (branchId && status) {
            branches.update((list) =>
              list.map((b) =>
                b.id === branchId
                  ? {
                      ...b,
                      status,
                      recentActivity: [
                        ...(b.recentActivity ?? []),
                        `[SSE] ${event.message ?? 'Status updated'} — ${new Date().toLocaleTimeString()}`,
                      ],
                    }
                  : b
              )
            );
          }
          // If we get a generic branch event, refresh the full list
          if (!branchId) {
            fetchBranches();
          }
        }
      } catch {
        // ignore
      }
    };

    es.onerror = () => {
      es.close();
      eventSource = null;
      // Retry after 5s
      setTimeout(connectSSE, 5000);
    };
  }

  function toggleExpand(id: string) {
    expandedId.update((cur) => (cur === id ? null : id));
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
    active:   'var(--color-info)',
    merged:   'var(--color-success)',
    conflict: 'var(--color-danger)',
  };

  onMount(async () => {
    await fetchBranches();
    connectSSE();
  });

  onDestroy(() => {
    if (eventSource) eventSource.close();
  });

  $: activeBranches  = $branches.filter((b) => b.status === 'active').length;
  $: mergedBranches  = $branches.filter((b) => b.status === 'merged').length;
  $: conflictBranches = $branches.filter((b) => b.status === 'conflict').length;
</script>

<svelte:head><title>Branches — AgentForge</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Branch State</h1>
    <p class="page-subtitle">Git branch inventory managed by the autonomous coding team</p>
  </div>
  <button class="btn-ghost" on:click={fetchBranches}>Refresh</button>
</div>

<!-- Summary pills -->
<div class="summary-bar">
  <div class="pill active">
    <span class="pill-count">{activeBranches}</span>
    <span class="pill-label">Active</span>
  </div>
  <div class="pill merged">
    <span class="pill-count">{mergedBranches}</span>
    <span class="pill-label">Merged</span>
  </div>
  <div class="pill conflict">
    <span class="pill-count">{conflictBranches}</span>
    <span class="pill-label">Conflict</span>
  </div>
</div>

{#if $loading}
  <div class="loading-state">Loading branches…</div>
{:else if $error}
  <div class="error-banner">{$error}</div>
{:else}
  <div class="branches-table">
    <div class="table-header">
      <span>Branch Name</span>
      <span>Owner Agent</span>
      <span>Task</span>
      <span>Status</span>
      <span>Created</span>
    </div>

    {#each $branches as branch (branch.id)}
      <div class="table-row-wrapper">
        <button
          class="table-row {branch.status}"
          on:click={() => toggleExpand(branch.id)}
          aria-expanded={$expandedId === branch.id}
        >
          <span class="branch-name">{branch.name}</span>
          <span class="agent-tag">{branch.ownerAgent}</span>
          <span class="task-text">{branch.task}</span>
          <span
            class="status-badge"
            style="color: {STATUS_COLOR[branch.status]}; border-color: {STATUS_COLOR[branch.status]}44; background: {STATUS_COLOR[branch.status]}18;"
          >
            {branch.status}
          </span>
          <span class="created-at">{formatDate(branch.createdAt)}</span>
        </button>

        {#if $expandedId === branch.id && branch.recentActivity && branch.recentActivity.length > 0}
          <div class="activity-panel">
            <p class="activity-heading">Recent Activity</p>
            <ul class="activity-list">
              {#each branch.recentActivity as activity}
                <li>{activity}</li>
              {/each}
            </ul>
          </div>
        {/if}
      </div>
    {/each}

    {#if $branches.length === 0}
      <div class="empty-row">No branches found.</div>
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

  .btn-ghost {
    background: transparent;
    border: 1px solid var(--color-border);
    color: var(--color-text-muted);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: border-color var(--duration-fast), color var(--duration-fast);
  }

  .btn-ghost:hover {
    border-color: var(--color-border-strong);
    color: var(--color-text);
  }

  .summary-bar {
    display: flex;
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

  .pill.active  { border-color: var(--color-info)44;    }
  .pill.merged  { border-color: var(--color-success)44; }
  .pill.conflict{ border-color: var(--color-danger)44;  }

  .pill-count {
    font-size: var(--text-lg);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .pill.active   .pill-count { color: var(--color-info);    }
  .pill.merged   .pill-count { color: var(--color-success);  }
  .pill.conflict .pill-count { color: var(--color-danger);   }

  .pill-label {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
  }

  .branches-table {
    background: var(--color-bg-card);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  .table-header {
    display: grid;
    grid-template-columns: 2fr 1fr 2fr 100px 140px;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    background: var(--color-surface-1);
    border-bottom: 1px solid var(--color-border);
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .table-row-wrapper {
    border-bottom: 1px solid var(--color-border);
  }

  .table-row-wrapper:last-child {
    border-bottom: none;
  }

  .table-row {
    display: grid;
    grid-template-columns: 2fr 1fr 2fr 100px 140px;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    width: 100%;
    background: transparent;
    border: none;
    text-align: left;
    cursor: pointer;
    transition: background var(--duration-fast);
    align-items: center;
  }

  .table-row:hover {
    background: var(--color-bg-card-hover);
  }

  .table-row.conflict {
    border-left: 3px solid var(--color-danger);
  }

  .branch-name {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-brand);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .agent-tag {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    background: var(--color-surface-2);
    border-radius: var(--radius-sm);
    padding: 1px var(--space-2);
    display: inline-block;
    width: fit-content;
  }

  .task-text {
    font-size: var(--text-sm);
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status-badge {
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 2px var(--space-2);
    border-radius: var(--radius-full);
    border: 1px solid transparent;
    width: fit-content;
  }

  .created-at {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    font-family: var(--font-mono);
    white-space: nowrap;
  }

  .activity-panel {
    padding: var(--space-3) var(--space-4) var(--space-3) calc(var(--space-4) + 3px);
    background: var(--color-bg-elevated);
    border-top: 1px solid var(--color-border);
  }

  .activity-heading {
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0 0 var(--space-2) 0;
  }

  .activity-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .activity-list li {
    font-size: var(--text-sm);
    color: var(--color-text);
    padding-left: var(--space-3);
    position: relative;
  }

  .activity-list li::before {
    content: '›';
    position: absolute;
    left: 0;
    color: var(--color-text-faint);
  }

  .empty-row {
    padding: var(--space-8);
    text-align: center;
    font-size: var(--text-sm);
    color: var(--color-text-faint);
  }

  .loading-state {
    padding: var(--space-8);
    text-align: center;
    font-size: var(--text-sm);
    color: var(--color-text-muted);
  }

  .error-banner {
    padding: var(--space-3) var(--space-4);
    background: var(--color-danger)22;
    border: 1px solid var(--color-danger)44;
    border-radius: var(--radius-md);
    color: var(--color-danger);
    font-size: var(--text-sm);
  }
</style>
