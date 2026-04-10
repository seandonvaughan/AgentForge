<script lang="ts">
  import { goto } from '$app/navigation';
  import type { PageData } from './$types';
  import type { AgentDetail } from './+page.server';

  let { data }: { data: PageData } = $props();

  // Agent data is pre-loaded server-side via +page.server.ts — always available.
  // Using $derived keeps it in sync when SvelteKit updates data on navigation.
  let agent = $derived(data.agent);
  let agentId = $derived(agent.agentId);

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

<svelte:head><title>{agent.name} — AgentForge</title></svelte:head>

<div class="page-header">
  <div style="display:flex; align-items:center; gap: var(--space-4);">
    <button class="btn btn-ghost btn-sm" onclick={() => goto('/agents')}>← Back</button>
    <div>
      <h1 class="page-title">{agent.name}</h1>
      <p class="page-subtitle">{agent.role ?? agent.seniority ?? 'Agent'}</p>
    </div>
  </div>
  <div style="display:flex; align-items:center; gap: var(--space-3);">
    {#if agent.version}
      <span class="badge muted">v{agent.version}</span>
    {/if}
    <span class="badge {agent.model}">{agent.model}</span>
  </div>
</div>

{#if agent}
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
