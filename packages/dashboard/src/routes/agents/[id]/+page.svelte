<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';

  interface AgentDetail {
    agentId: string;
    id?: string; // legacy compat — server returns agentId, not id
    name: string;
    model: 'opus' | 'sonnet' | 'haiku';
    description?: string | null;
    role?: string | null;
    systemPrompt?: string | null;
    skills?: string[];
    version?: string | null;
    seniority?: string | null;
    layer?: string | null;
    reportsTo?: string | null;
    canDelegateTo?: string[];
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

  let agent = $state<AgentDetail | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

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

  function promptPreview(prompt?: string | null): string {
    if (!prompt) return 'No system prompt defined.';
    return prompt.length > 600 ? prompt.slice(0, 600) + '…' : prompt;
  }

  const MODEL_COLOR: Record<string, string> = {
    opus:   'var(--color-opus)',
    sonnet: 'var(--color-sonnet)',
    haiku:  'var(--color-haiku)',
  };

  const SENIORITY_ORDER = ['junior', 'mid', 'senior', 'lead', 'principal'];
</script>

<svelte:head><title>{agent?.name ?? agentId} — AgentForge</title></svelte:head>

<div class="page-header">
  <div style="display:flex; align-items:center; gap: var(--space-4);">
    <button class="btn btn-ghost btn-sm" onclick={() => goto('/agents')}>← Back</button>
    {#if agent}
      <div>
        <h1 class="page-title">{agent.name ?? agent.agentId ?? agentId}</h1>
        <p class="page-subtitle">{agent.role ?? agent.seniority ?? 'Agent'}</p>
      </div>
    {:else}
      <h1 class="page-title">{agentId}</h1>
    {/if}
  </div>
  {#if agent}
    <div style="display:flex; align-items:center; gap: var(--space-3);">
      {#if agent.version}
        <span class="badge muted">v{agent.version}</span>
      {/if}
      <span class="badge {agent.model}">{agent.model}</span>
    </div>
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
    <button class="btn btn-ghost btn-sm" style="margin-top: var(--space-3)" onclick={load}>Retry</button>
  </div>
{:else if agent}
  <!-- Metadata row -->
  <div class="meta-grid" style="margin-bottom: var(--space-6);">
    <!-- Description -->
    {#if agent.description}
      <div class="meta-card full-width">
        <div class="meta-label">Description</div>
        <p class="meta-desc">{agent.description}</p>
      </div>
    {/if}

    <!-- Agent ID -->
    <div class="meta-card">
      <div class="meta-label">Agent ID</div>
      <code class="meta-mono">{agent.agentId}</code>
    </div>

    <!-- Model -->
    <div class="meta-card">
      <div class="meta-label">Model Tier</div>
      <span class="model-badge" style="color: {MODEL_COLOR[agent.model] ?? 'inherit'}">
        {agent.model.charAt(0).toUpperCase() + agent.model.slice(1)}
      </span>
    </div>

    <!-- Seniority -->
    {#if agent.seniority}
      <div class="meta-card">
        <div class="meta-label">Seniority</div>
        <div class="seniority-track">
          {#each SENIORITY_ORDER as level}
            <div class="seniority-pip {agent.seniority === level ? 'active' : SENIORITY_ORDER.indexOf(level) < SENIORITY_ORDER.indexOf(agent.seniority) ? 'past' : ''}"></div>
          {/each}
          <span class="seniority-label">{agent.seniority}</span>
        </div>
      </div>
    {/if}

    <!-- Layer -->
    {#if agent.layer}
      <div class="meta-card">
        <div class="meta-label">Layer</div>
        <span class="meta-value">{agent.layer}</span>
      </div>
    {/if}
  </div>

  <!-- Collaboration -->
  {#if agent.reportsTo || (agent.canDelegateTo && agent.canDelegateTo.length > 0)}
    <div class="card" style="margin-bottom: var(--space-6);">
      <div class="card-header">
        <span class="card-title">Collaboration</span>
      </div>
      <div class="collab-grid">
        {#if agent.reportsTo}
          <div class="collab-section">
            <div class="collab-label">Reports To</div>
            <button
              class="agent-chip reports-to"
              onclick={() => goto(`/agents/${agent?.reportsTo}`)}
            >
              <span class="chip-arrow">↑</span>
              {agent.reportsTo}
            </button>
          </div>
        {/if}
        {#if agent.canDelegateTo && agent.canDelegateTo.length > 0}
          <div class="collab-section">
            <div class="collab-label">Can Delegate To</div>
            <div class="chip-row">
              {#each agent.canDelegateTo as delegate}
                <button
                  class="agent-chip delegate"
                  onclick={() => goto(`/agents/${delegate}`)}
                >
                  <span class="chip-arrow">↓</span>
                  {delegate}
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- System Prompt -->
  <div class="card" style="margin-bottom: var(--space-6);">
    <div class="card-header">
      <span class="card-title">System Prompt</span>
      {#if agent.systemPrompt}
        <span class="meta-label" style="margin:0;">{agent.systemPrompt.length} chars</span>
      {/if}
    </div>
    <pre class="prompt-preview">{promptPreview(agent.systemPrompt)}</pre>
  </div>

  <!-- Skills -->
  {#if agent.skills && agent.skills.length > 0}
    <div class="card" style="margin-bottom: var(--space-6);">
      <div class="card-header">
        <span class="card-title">Skills</span>
        <span class="badge muted">{agent.skills.length}</span>
      </div>
      <div class="skill-tags">
        {#each agent.skills as skill}
          <span class="skill-tag">{skill}</span>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Recent Sessions (only shown when data is available) -->
  {#if agent.recentSessions && agent.recentSessions.length > 0}
    <div class="card" style="padding: 0; overflow: hidden;">
      <div class="card-header" style="padding: var(--space-4) var(--space-5);">
        <span class="card-title">Recent Sessions</span>
      </div>
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
    </div>
  {/if}
{/if}

<style>
  /* ── Metadata grid ─────────────────────────────────────────────────── */
  .meta-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: var(--space-3);
  }

  .meta-card {
    background: var(--color-surface-1);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-3) var(--space-4);
  }

  .meta-card.full-width {
    grid-column: 1 / -1;
  }

  .meta-label {
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--color-text-faint);
    margin-bottom: var(--space-1);
  }

  .meta-desc {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    line-height: 1.6;
  }

  .meta-mono {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    display: block;
    margin-top: var(--space-1);
  }

  .meta-value {
    font-size: var(--text-sm);
    color: var(--color-text);
    display: block;
    margin-top: var(--space-1);
  }

  .model-badge {
    font-size: var(--text-sm);
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    display: block;
    margin-top: var(--space-1);
  }

  /* ── Seniority track ───────────────────────────────────────────────── */
  .seniority-track {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: var(--space-2);
  }

  .seniority-pip {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-surface-3);
    border: 1px solid var(--color-border);
    transition: background var(--duration-fast);
  }

  .seniority-pip.past {
    background: rgba(91,138,245,0.4);
    border-color: rgba(91,138,245,0.5);
  }

  .seniority-pip.active {
    background: var(--color-brand);
    border-color: var(--color-brand);
    box-shadow: 0 0 6px rgba(91,138,245,0.5);
  }

  .seniority-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    margin-left: var(--space-2);
    text-transform: capitalize;
  }

  /* ── Collaboration ─────────────────────────────────────────────────── */
  .collab-grid {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-5);
  }

  .collab-section {
    flex: 1;
    min-width: 160px;
  }

  .collab-label {
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--color-text-faint);
    margin-bottom: var(--space-2);
  }

  .chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .agent-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    cursor: pointer;
    border: 1px solid var(--color-border);
    background: var(--color-surface-2);
    color: var(--color-text-muted);
    transition: all var(--duration-fast);
    white-space: nowrap;
  }

  .agent-chip:hover {
    color: var(--color-text);
    border-color: var(--color-border-strong);
    background: var(--color-surface-3);
  }

  .agent-chip.reports-to { border-color: rgba(91,138,245,0.3); }
  .agent-chip.reports-to:hover { border-color: var(--color-brand); color: var(--color-brand); }
  .agent-chip.delegate { border-color: rgba(76,175,130,0.3); }
  .agent-chip.delegate:hover { border-color: var(--color-success); color: var(--color-success); }

  .chip-arrow {
    font-size: 10px;
    opacity: 0.6;
  }

  /* ── Prompt + Skills ───────────────────────────────────────────────── */
  .prompt-preview {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
    line-height: 1.7;
    max-height: 320px;
    overflow-y: auto;
  }

  .skill-tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .skill-tag {
    display: inline-block;
    padding: 2px var(--space-2);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    color: var(--color-text-muted);
  }
</style>
