<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';

  interface AgentDetail {
    id: string;
    name: string;
    model: 'opus' | 'sonnet' | 'haiku';
    role?: string;
    systemPrompt?: string;
    skills?: string[];
    stats?: {
      totalSessions: number;
      successRate: number;
      avgCostUsd: number;
    };
    recentSessions?: Array<{
      id: string;
      startedAt: string;
      status: string;
      costUsd?: number;
      durationMs?: number;
    }>;
  }

  let agent: AgentDetail | null = null;
  let loading = true;
  let error: string | null = null;

  let agentId = $derived(page.params.id);

  async function load() {
    loading = true;
    error = null;
    try {
      const res = await fetch(`/api/v5/agents/${agentId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      agent = json.data ?? json;
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function formatDuration(ms?: number): string {
    if (!ms) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function formatDate(iso?: string): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleString();
  }

  function promptPreview(prompt?: string): string {
    if (!prompt) return 'No system prompt defined.';
    return prompt.length > 400 ? prompt.slice(0, 400) + '…' : prompt;
  }
</script>

<svelte:head><title>{agent?.name ?? agentId} — AgentForge</title></svelte:head>

<div class="page-header">
  <div style="display:flex; align-items:center; gap: var(--space-4);">
    <button class="btn btn-ghost btn-sm" on:click={() => goto('/agents')}>← Back</button>
    {#if agent}
      <div>
        <h1 class="page-title">{agent.name ?? agent.id}</h1>
        <p class="page-subtitle">{agent.role ?? 'Agent'}</p>
      </div>
    {:else}
      <h1 class="page-title">{agentId}</h1>
    {/if}
  </div>
  {#if agent}
    <span class="badge {agent.model}">{agent.model}</span>
  {/if}
</div>

{#if loading}
  <div>
    <div class="skeleton" style="height: 80px; width: 100%; margin-bottom: var(--space-4);"></div>
    <div class="skeleton" style="height: 160px; width: 100%; margin-bottom: var(--space-4);"></div>
    <div class="skeleton" style="height: 200px; width: 100%;"></div>
  </div>
{:else if error}
  <div class="empty-state">
    Failed to load agent.
    <button class="btn btn-ghost btn-sm" style="margin-top: var(--space-3)" on:click={load}>Retry</button>
  </div>
{:else if agent}
  <!-- Stats Row -->
  <div class="stat-grid" style="margin-bottom: var(--space-6);">
    <div class="stat-card">
      <div class="stat-value">{agent.stats?.totalSessions ?? 0}</div>
      <div class="stat-label">Total Sessions</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">{agent.stats?.successRate != null ? Math.round(agent.stats.successRate * 100) : '—'}%</div>
      <div class="stat-label">Success Rate</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${(agent.stats?.avgCostUsd ?? 0).toFixed(4)}</div>
      <div class="stat-label">Avg Cost / Session</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">{agent.skills?.length ?? 0}</div>
      <div class="stat-label">Skills</div>
    </div>
  </div>

  <!-- System Prompt -->
  <div class="card" style="margin-bottom: var(--space-6);">
    <div class="card-header">
      <span class="card-title">System Prompt</span>
    </div>
    <pre class="prompt-preview">{promptPreview(agent.systemPrompt)}</pre>
  </div>

  <!-- Skills -->
  {#if agent.skills && agent.skills.length > 0}
    <div class="card" style="margin-bottom: var(--space-6);">
      <div class="card-header">
        <span class="card-title">Skills</span>
      </div>
      <div class="skill-tags">
        {#each agent.skills as skill}
          <span class="badge muted">{skill}</span>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Recent Sessions -->
  <div class="card" style="padding: 0; overflow: hidden;">
    <div class="card-header" style="padding: var(--space-4) var(--space-5);">
      <span class="card-title">Recent Sessions</span>
    </div>
    {#if !agent.recentSessions || agent.recentSessions.length === 0}
      <div class="empty-state">No sessions yet.</div>
    {:else}
      <table class="data-table">
        <thead>
          <tr>
            <th>Session ID</th>
            <th>Started</th>
            <th>Duration</th>
            <th>Status</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {#each agent.recentSessions as s (s.id)}
            <tr>
              <td style="font-family: var(--font-mono); font-size: var(--text-xs);">{s.id}</td>
              <td style="color: var(--color-text-muted);">{formatDate(s.startedAt)}</td>
              <td style="font-family: var(--font-mono);">{formatDuration(s.durationMs)}</td>
              <td>
                {#if s.status === 'completed'}
                  <span class="badge success">completed</span>
                {:else if s.status === 'failed'}
                  <span class="badge danger">failed</span>
                {:else if s.status === 'running'}
                  <span class="badge" style="color:var(--color-info); border-color:rgba(74,158,255,0.3); background:rgba(74,158,255,0.08);">running</span>
                {:else}
                  <span class="badge muted">{s.status ?? '—'}</span>
                {/if}
              </td>
              <td style="font-family: var(--font-mono);">${(s.costUsd ?? 0).toFixed(4)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
{/if}

<style>
  .prompt-preview {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
    line-height: 1.6;
  }
  .skill-tags { display: flex; flex-wrap: wrap; gap: var(--space-2); }
</style>
