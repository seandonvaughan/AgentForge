<script lang="ts">
  import { sessions, sessionsLoading, sessionsError, loadSessions } from '$lib/stores/sessions.js';
  import { onMount } from 'svelte';

  onMount(() => loadSessions({ limit: 100 }));

  function refresh() {
    loadSessions({ limit: 100 });
  }

  function agentLabel(s: (typeof $sessions)[0]): string {
    return s.agentId || s.agent_id || '—';
  }

  function taskLabel(s: (typeof $sessions)[0]): string {
    return s.task || '—';
  }

  function costLabel(s: (typeof $sessions)[0]): string {
    const c = s.costUsd ?? s.cost_usd ?? 0;
    return `$${c.toFixed(4)}`;
  }

  function dateLabel(s: (typeof $sessions)[0]): string {
    const raw = s.startedAt || s.started_at;
    if (!raw) return '—';
    try { return new Date(raw).toLocaleString(); } catch { return raw; }
  }

  function duration(s: (typeof $sessions)[0]): string {
    const start = s.startedAt || s.started_at;
    const end = s.completedAt || s.completed_at;
    if (!start || !end) return '—';
    try {
      const ms = new Date(end).getTime() - new Date(start).getTime();
      if (ms < 0) return '—';
      if (ms < 1000) return `${ms}ms`;
      return `${(ms / 1000).toFixed(1)}s`;
    } catch { return '—'; }
  }

  function modelBadge(s: (typeof $sessions)[0]): string {
    return s.model || '—';
  }

  function statusClass(status: string): string {
    if (status === 'completed') return 'success';
    if (status === 'failed') return 'danger';
    if (status === 'running') return 'info';
    return 'muted';
  }
</script>

<svelte:head><title>Sessions — AgentForge v5</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Sessions</h1>
    <p class="page-subtitle">All agent execution history</p>
  </div>
  <button class="btn btn-ghost btn-sm" on:click={refresh} disabled={$sessionsLoading}>
    {$sessionsLoading ? 'Loading…' : 'Refresh'}
  </button>
</div>

{#if $sessionsError}
  <div class="empty-state" style="color:var(--color-danger);">
    {$sessionsError}
    <button class="btn btn-ghost btn-sm" style="margin-top:var(--space-3)" on:click={refresh}>Retry</button>
  </div>
{:else if $sessionsLoading}
  <div class="card">
    {#each Array(8) as _}
      <div class="skeleton" style="height:20px; width:100%; margin-bottom:10px;"></div>
    {/each}
  </div>
{:else if $sessions.length === 0}
  <div class="empty-state">No sessions yet — invoke an agent to see history here.</div>
{:else}
  <div class="card" style="padding:0; overflow:hidden;">
    <table class="data-table">
      <thead>
        <tr>
          <th>Agent</th>
          <th>Task</th>
          <th>Model</th>
          <th>Status</th>
          <th>Duration</th>
          <th>Cost</th>
          <th>Started</th>
        </tr>
      </thead>
      <tbody>
        {#each $sessions as session (session.id)}
          <tr>
            <td><span class="badge muted">{agentLabel(session)}</span></td>
            <td style="max-width:300px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:var(--text-sm);">
              {taskLabel(session)}
            </td>
            <td>
              {#if session.model}
                <span class="badge {session.model}">{modelBadge(session)}</span>
              {:else}
                <span class="badge muted">—</span>
              {/if}
            </td>
            <td>
              <span class="badge {statusClass(session.status)}">{session.status}</span>
            </td>
            <td style="font-family:var(--font-mono); font-size:var(--text-xs);">{duration(session)}</td>
            <td style="font-family:var(--font-mono); font-size:var(--text-xs);">{costLabel(session)}</td>
            <td style="color:var(--color-text-muted); font-size:var(--text-xs);">{dateLabel(session)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
