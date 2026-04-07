<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import ProgressBar from '$lib/components/ProgressBar.svelte';

  interface SprintItem {
    id: string;
    title: string;
    priority: 'P0' | 'P1' | 'P2';
    status: 'completed' | 'in_progress' | 'pending';
  }

  interface Sprint {
    id: string;
    version: string;
    title?: string;
    status: 'completed' | 'in_progress' | 'pending';
    startDate?: string;
    endDate?: string;
    items: SprintItem[];
  }

  let sprints: Sprint[] = [];
  let loading = true;
  let error: string | null = null;

  async function load() {
    loading = true;
    error = null;
    try {
      const res = await fetch('/api/v5/sprints');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      sprints = json.data ?? json ?? [];
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  function completionPct(sprint: Sprint): number {
    if (!sprint.items?.length) return 0;
    const done = sprint.items.filter(i => i.status === 'completed').length;
    return Math.round((done / sprint.items.length) * 100);
  }

  function itemsByPriority(items: SprintItem[], p: string) {
    return items.filter(i => i.priority === p);
  }

  const STATUS_LABEL: Record<string, string> = {
    completed: 'Completed',
    in_progress: 'In Progress',
    pending: 'Pending',
  };

  const STATUS_BADGE: Record<string, string> = {
    completed: 'success',
    in_progress: 'sonnet',
    pending: 'muted',
  };

  const ITEM_STATUS_ICON: Record<string, string> = {
    completed: '✓',
    in_progress: '◐',
    pending: '○',
  };

  onMount(load);
</script>

<svelte:head><title>Sprints — AgentForge</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Sprints</h1>
    <p class="page-subtitle">{sprints.length} sprints tracked</p>
  </div>
</div>

{#if loading}
  <div style="display: flex; flex-direction: column; gap: var(--space-5);">
    {#each Array(3) as _}
      <div class="card">
        <div class="skeleton" style="height: 20px; width: 40%; margin-bottom: var(--space-3);"></div>
        <div class="skeleton" style="height: 12px; width: 100%; margin-bottom: var(--space-2);"></div>
        <div class="skeleton" style="height: 12px; width: 80%;"></div>
      </div>
    {/each}
  </div>
{:else if error}
  <div class="empty-state">
    Failed to load sprints.
    <button class="btn btn-ghost btn-sm" style="margin-top: var(--space-3)" onclick={load}>Retry</button>
  </div>
{:else if sprints.length === 0}
  <div class="empty-state">No sprint data available.</div>
{:else}
  <div class="sprint-grid">
    {#each sprints as sprint (sprint.id)}
      {@const pct = completionPct(sprint)}
      <button class="card sprint-card clickable" onclick={() => goto(`/sprints/${sprint.version}`)}>
        <div class="sprint-header">
          <div>
            <div class="sprint-version">{sprint.version}</div>
            {#if sprint.title}
              <div class="sprint-title">{sprint.title}</div>
            {/if}
          </div>
          <span class="badge {STATUS_BADGE[sprint.status] ?? 'muted'}">{STATUS_LABEL[sprint.status] ?? sprint.status}</span>
        </div>

        <div style="margin: var(--space-3) 0;">
          <ProgressBar
            value={pct}
            label="Progress"
            color={sprint.status === 'completed' ? 'var(--color-success)' : sprint.status === 'in_progress' ? 'var(--color-brand)' : 'var(--color-text-faint)'}
          />
        </div>

        {#each (['P0', 'P1', 'P2'] as const) as priority}
          {@const items = itemsByPriority(sprint.items ?? [], priority)}
          {#if items.length > 0}
            <div class="priority-group">
              <div class="priority-label priority-{priority.toLowerCase()}">{priority}</div>
              <ul class="item-list">
                {#each items as item (item.id)}
                  <li class="item {item.status}">
                    <span class="item-icon">{ITEM_STATUS_ICON[item.status] ?? '○'}</span>
                    <span class="item-title">{item.title}</span>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
        {/each}

        {#if sprint.startDate || sprint.endDate}
          <div class="sprint-dates">
            {#if sprint.startDate}<span>{new Date(sprint.startDate).toLocaleDateString()}</span>{/if}
            {#if sprint.startDate && sprint.endDate}<span> – </span>{/if}
            {#if sprint.endDate}<span>{new Date(sprint.endDate).toLocaleDateString()}</span>{/if}
          </div>
        {/if}
      </button>
    {/each}
  </div>
{/if}

<style>
  .sprint-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: var(--space-5);
  }
  .sprint-card { display: flex; flex-direction: column; gap: var(--space-2); text-align: left; }
  .sprint-card.clickable {
    cursor: pointer;
    transition: border-color var(--duration-fast), background var(--duration-fast);
  }
  .sprint-card.clickable:hover {
    border-color: var(--color-brand);
    background: rgba(91,138,245,0.04);
  }
  .sprint-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-1);
  }
  .sprint-version {
    font-size: var(--text-lg);
    font-weight: 700;
    font-family: var(--font-mono);
    color: var(--color-text);
  }
  .sprint-title {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    margin-top: var(--space-1);
  }
  .priority-group { margin-top: var(--space-3); }
  .priority-label {
    font-size: var(--text-xs);
    font-weight: 700;
    letter-spacing: 0.08em;
    margin-bottom: var(--space-1);
  }
  .priority-p0 { color: var(--color-danger); }
  .priority-p1 { color: var(--color-warning); }
  .priority-p2 { color: var(--color-text-muted); }
  .item-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .item {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--color-text);
  }
  .item.completed { color: var(--color-text-muted); text-decoration: line-through; }
  .item-icon {
    font-size: var(--text-xs);
    flex-shrink: 0;
    width: 12px;
    text-align: center;
  }
  .item.completed .item-icon { color: var(--color-success); }
  .item.in_progress .item-icon { color: var(--color-brand); }
  .item.pending .item-icon { color: var(--color-text-faint); }
  .sprint-dates {
    margin-top: var(--space-3);
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    border-top: 1px solid var(--color-border);
    padding-top: var(--space-2);
  }
</style>
