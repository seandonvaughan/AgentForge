<script lang="ts">
  import { sessions, sessionsLoading } from '$lib/stores/sessions.js';
  import { goto } from '$app/navigation';
  import type { Session } from '$lib/stores/sessions.js';

  function agentLabel(s: Session): string {
    return s.agentId || s.agent_id || '—';
  }

  function costLabel(s: Session): string {
    const c = s.costUsd ?? s.cost_usd ?? 0;
    return `$${c.toFixed(4)}`;
  }

  function dateLabel(s: Session): string {
    const raw = s.startedAt || s.started_at;
    if (!raw) return '—';
    try { return new Date(raw).toLocaleString(); } catch { return raw; }
  }

  function statusClass(status: string): string {
    if (status === 'completed') return 'success';
    if (status === 'failed') return 'danger';
    return 'muted';
  }
</script>

<div class="card">
  <div class="card-header">
    <span class="card-title">Recent Sessions</span>
    <a href="/sessions" class="btn btn-ghost btn-sm">View all</a>
  </div>
  {#if $sessionsLoading}
    <div class="skeleton" style="height:120px"></div>
  {:else if $sessions.length === 0}
    <div class="empty-state">No sessions yet — invoke an agent to see history.</div>
  {:else}
    <table class="data-table">
      <thead>
        <tr>
          <th>Agent</th><th>Task</th><th>Model</th><th>Status</th><th>Cost</th><th>Started</th>
        </tr>
      </thead>
      <tbody>
        {#each $sessions.slice(0, 8) as s (s.id)}
          <tr on:click={() => goto(`/sessions/${s.id}`)}>
            <td><span class="badge muted">{agentLabel(s)}</span></td>
            <td style="max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px;">
              {s.task || '—'}
            </td>
            <td>
              {#if s.model}
                <span class="badge {s.model}">{s.model}</span>
              {:else}
                <span class="badge muted">—</span>
              {/if}
            </td>
            <td><span class="badge {statusClass(s.status)}">{s.status}</span></td>
            <td style="font-family:var(--font-mono); font-size:11px;">{costLabel(s)}</td>
            <td style="color:var(--color-text-muted); font-size:11px;">{dateLabel(s)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
