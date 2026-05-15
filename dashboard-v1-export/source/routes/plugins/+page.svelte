<script lang="ts">
  import { onMount } from 'svelte';

  interface Plugin {
    id: string;
    name: string;
    version?: string;
    description?: string;
    status: 'running' | 'stopped' | 'error' | 'loading';
    permissions?: string[];
    author?: string;
  }

  let plugins: Plugin[] = [];
  let loading = true;
  let error: string | null = null;
  let actionPending: Set<string> = new Set();
  let actionError: string | null = null;

  async function load() {
    loading = true;
    error = null;
    try {
      const res = await fetch('/api/v5/plugins');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      plugins = json.data ?? json ?? [];
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  async function togglePlugin(plugin: Plugin) {
    const action = plugin.status === 'running' ? 'stop' : 'start';
    actionPending = new Set([...actionPending, plugin.id]);
    actionError = null;
    try {
      const res = await fetch(`/api/v5/plugins/${plugin.id}/${action}`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const updated = json.data ?? json;
      plugins = plugins.map(p => p.id === plugin.id ? { ...p, ...updated } : p);
    } catch (e) {
      actionError = `Failed to ${action} ${plugin.name}: ${e}`;
    } finally {
      actionPending = new Set([...actionPending].filter(x => x !== plugin.id));
    }
  }

  const STATUS_BADGE: Record<string, string> = {
    running: 'success',
    stopped: 'muted',
    error: 'danger',
    loading: 'sonnet',
  };

  onMount(load);
</script>

<svelte:head><title>Plugins — AgentForge</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Plugins</h1>
    <p class="page-subtitle">{plugins.length} plugins installed · {plugins.filter(p => p.status === 'running').length} running</p>
  </div>
  <button class="btn btn-ghost btn-sm" onclick={load} disabled={loading}>
    {loading ? 'Loading…' : 'Refresh'}
  </button>
</div>

{#if actionError}
  <div class="error-banner">{actionError}</div>
{/if}

{#if loading}
  <div class="plugin-grid">
    {#each Array(6) as _}
      <div class="card plugin-card-skeleton">
        <div class="skeleton" style="height: 18px; width: 60%; margin-bottom: var(--space-3);"></div>
        <div class="skeleton" style="height: 12px; width: 100%; margin-bottom: var(--space-2);"></div>
        <div class="skeleton" style="height: 12px; width: 70%; margin-bottom: var(--space-4);"></div>
        <div class="skeleton" style="height: 30px; width: 80px;"></div>
      </div>
    {/each}
  </div>
{:else if error}
  <div class="empty-state">
    Failed to load plugins.
    <button class="btn btn-ghost btn-sm" style="margin-top: var(--space-3)" onclick={load}>Retry</button>
  </div>
{:else if plugins.length === 0}
  <div class="empty-state">No plugins installed.</div>
{:else}
  <div class="plugin-grid">
    {#each plugins as plugin (plugin.id)}
      <div class="card plugin-card">
        <div class="plugin-header">
          <div class="plugin-name-row">
            <span class="plugin-name">{plugin.name}</span>
            {#if plugin.version}
              <span class="plugin-version">v{plugin.version}</span>
            {/if}
          </div>
          <span class="badge {STATUS_BADGE[plugin.status] ?? 'muted'}">{plugin.status}</span>
        </div>

        {#if plugin.description}
          <p class="plugin-desc">{plugin.description}</p>
        {/if}

        {#if plugin.permissions && plugin.permissions.length > 0}
          <div class="permissions">
            <div class="permissions-label">Permissions</div>
            <div class="permission-tags">
              {#each plugin.permissions as perm}
                <span class="badge muted perm-badge">{perm}</span>
              {/each}
            </div>
          </div>
        {/if}

        {#if plugin.author}
          <div class="plugin-author">by {plugin.author}</div>
        {/if}

        <div class="plugin-actions">
          <button
            class="btn {plugin.status === 'running' ? 'btn-ghost' : 'btn-primary'} btn-sm"
            onclick={() => togglePlugin(plugin)}
            disabled={actionPending.has(plugin.id) || plugin.status === 'error' || plugin.status === 'loading'}
          >
            {#if actionPending.has(plugin.id)}
              {plugin.status === 'running' ? 'Stopping…' : 'Starting…'}
            {:else if plugin.status === 'running'}
              Stop
            {:else if plugin.status === 'error'}
              Error
            {:else}
              Start
            {/if}
          </button>
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .error-banner {
    background: rgba(224,90,90,0.1);
    border: 1px solid rgba(224,90,90,0.3);
    color: var(--color-danger);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    margin-bottom: var(--space-4);
  }
  .plugin-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--space-4);
  }
  .plugin-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .plugin-card-skeleton { min-height: 160px; }
  .plugin-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .plugin-name-row {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }
  .plugin-name {
    font-weight: 600;
    font-size: var(--text-md);
    color: var(--color-text);
  }
  .plugin-version {
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    color: var(--color-text-faint);
  }
  .plugin-desc {
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    margin: 0;
    line-height: 1.5;
  }
  .permissions { display: flex; flex-direction: column; gap: var(--space-1); }
  .permissions-label {
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-faint);
  }
  .permission-tags { display: flex; flex-wrap: wrap; gap: var(--space-1); }
  .perm-badge { font-size: 10px; padding: 1px var(--space-2); }
  .plugin-author {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    font-style: italic;
  }
  .plugin-actions {
    margin-top: auto;
    padding-top: var(--space-2);
    border-top: 1px solid var(--color-border);
  }
</style>
