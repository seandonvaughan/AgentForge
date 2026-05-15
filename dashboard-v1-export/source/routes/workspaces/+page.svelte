<script lang="ts">
  import { onMount } from 'svelte';
  import {
    workspaces,
    defaultWorkspaceId,
    currentWorkspaceId,
    loadWorkspaces,
    selectWorkspace,
  } from '$lib/stores/workspace';

  let newName = $state('');
  let newPath = $state('');
  let busy = $state(false);
  let error: string | null = $state(null);

  onMount(() => {
    loadWorkspaces();
  });

  async function addOne() {
    if (!newName.trim() || !newPath.trim()) return;
    busy = true;
    error = null;
    try {
      const res = await fetch('/api/v5/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), path: newPath.trim() }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      newName = '';
      newPath = '';
      await loadWorkspaces();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  async function removeOne(id: string) {
    if (!confirm(`Remove workspace "${id}"?`)) return;
    busy = true;
    error = null;
    try {
      const res = await fetch(`/api/v5/workspaces/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      if ($currentWorkspaceId === id) selectWorkspace(null);
      await loadWorkspaces();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  async function setDefault(id: string) {
    busy = true;
    error = null;
    try {
      const res = await fetch('/api/v5/workspaces/default', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadWorkspaces();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Workspaces — AgentForge</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Workspaces</h1>
    <p class="page-subtitle">Manage the global ~/.agentforge/workspaces.json registry</p>
  </div>
</div>

{#if error}
  <div class="error-banner">Failed: <code>{error}</code></div>
{/if}

<div class="card" style="margin-bottom:16px;">
  <h3>Add workspace</h3>
  <form onsubmit={(e) => { e.preventDefault(); addOne(); }} class="ws-form">
    <label>
      Name
      <input type="text" bind:value={newName} placeholder="My App" disabled={busy} />
    </label>
    <label>
      Path
      <input type="text" bind:value={newPath} placeholder="/Users/me/Projects/my-app" disabled={busy} />
    </label>
    <button type="submit" class="btn btn-primary" disabled={busy || !newName.trim() || !newPath.trim()}>
      {busy ? 'Saving…' : 'Add'}
    </button>
  </form>
</div>

<div class="card" style="padding:0;overflow:hidden;">
  {#if $workspaces.length === 0}
    <div class="empty-state" style="padding:24px;">
      <p>No workspaces registered yet.</p>
      <p>Add one above, or from the CLI: <code>agentforge workspaces add "My App" /path/to/my-app</code></p>
    </div>
  {:else}
    <table class="data-table">
      <thead>
        <tr>
          <th>Default</th>
          <th>ID</th>
          <th>Name</th>
          <th>Path</th>
          <th>Added</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each $workspaces as w (w.id)}
          <tr class:current={$currentWorkspaceId === w.id}>
            <td>
              {#if $defaultWorkspaceId === w.id}
                <span title="Default">★</span>
              {:else}
                <button class="btn btn-ghost btn-sm" onclick={() => setDefault(w.id)} disabled={busy}>
                  set default
                </button>
              {/if}
            </td>
            <td><code>{w.id}</code></td>
            <td>{w.name}</td>
            <td><code>{w.path}</code></td>
            <td>{new Date(w.addedAt).toLocaleString()}</td>
            <td>
              <button class="btn btn-ghost btn-sm" onclick={() => selectWorkspace(w.id)} disabled={busy}>
                select
              </button>
              <button class="btn btn-ghost btn-sm" onclick={() => removeOne(w.id)} disabled={busy}>
                remove
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .ws-form {
    display: grid;
    grid-template-columns: 1fr 2fr auto;
    gap: 12px;
    align-items: end;
  }
  .ws-form label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--color-text-muted, #888);
  }
  .ws-form input {
    background: var(--color-surface-2, #222);
    border: 1px solid var(--color-surface-3, #333);
    border-radius: 4px;
    padding: 6px 8px;
    color: var(--color-text, #eee);
    font-family: var(--font-mono, monospace);
    font-size: 12px;
  }
  code {
    font-family: var(--font-mono, monospace);
    background: var(--color-surface-2, #222);
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 11px;
  }
  tr.current { background: rgba(80,140,255,0.08); }
  .error-banner {
    background: rgba(224,90,90,0.1);
    border: 1px solid rgba(224,90,90,0.3);
    border-radius: 6px;
    color: var(--color-danger, #e05a5a);
    padding: 8px 12px;
    margin-bottom: 12px;
    font-size: 12px;
  }
</style>
