<script lang="ts">
  import { onMount } from 'svelte';
  import {
    workspaces,
    defaultWorkspaceId,
    currentWorkspaceId,
    loadWorkspaces,
    selectWorkspace,
  } from '$lib/stores/workspace';
  import { Btn, Badge, Card } from '$lib/components/v2';

  let newName = $state('');
  let newPath = $state('');
  let newBusConfig = $state('');
  let showCreateForm = $state(false);
  let busy = $state(false);
  let error: string | null = $state(null);

  onMount(() => { loadWorkspaces(); });

  async function addOne() {
    if (!newName.trim() || !newPath.trim()) return;
    busy = true;
    error = null;
    try {
      const body: Record<string, string> = {
        name: newName.trim(),
        path: newPath.trim(),
      };
      if (newBusConfig.trim()) body.busConfig = newBusConfig.trim();
      const res = await fetch('/api/v5/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      newName = '';
      newPath = '';
      newBusConfig = '';
      showCreateForm = false;
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

  async function activateWorkspace(id: string) {
    busy = true;
    error = null;
    try {
      // PATCH /api/v5/workspaces/:id/activate for switching active workspace
      const res = await fetch(`/api/v5/workspaces/${encodeURIComponent(id)}/activate`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
      });
      if (res.ok) {
        selectWorkspace(id);
        await loadWorkspaces();
      } else {
        // Fallback: client-side selection only
        selectWorkspace(id);
      }
    } catch {
      // Fallback: client-side selection
      selectWorkspace(id);
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

  function formatAddedAt(ts: string): string {
    try { return new Date(ts).toLocaleString(); } catch { return ts; }
  }
</script>

<svelte:head><title>Workspaces — AgentForge</title></svelte:head>

<!-- ── Page header ──────────────────────────────────────────────────────── -->
<div class="page-header">
  <div>
    <h1 class="page-title">Workspaces</h1>
    <p class="page-sub">
      Manage the global <code class="af2-mono inline-code">~/.agentforge/workspaces.json</code> registry
    </p>
  </div>
  <div class="page-actions">
    <Btn size="sm" onclick={() => loadWorkspaces()}>Refresh</Btn>
    <Btn variant="purple" size="sm" onclick={() => { showCreateForm = !showCreateForm; }}>
      {showCreateForm ? '✕ Cancel' : '+ New Workspace'}
    </Btn>
  </div>
</div>

<!-- ── Error banner ──────────────────────────────────────────────────────── -->
{#if error}
  <div class="banner banner--danger" style="margin-bottom:12px">
    <span>Error: <code class="af2-mono">{error}</code></span>
    <button class="banner-dismiss" onclick={() => { error = null; }}>✕</button>
  </div>
{/if}

<!-- ── Create workspace form ─────────────────────────────────────────────── -->
{#if showCreateForm}
  <Card style="margin-bottom:14px">
    <div class="section-title" style="margin-bottom:12px">ADD WORKSPACE</div>
    <form onsubmit={(e) => { e.preventDefault(); addOne(); }} class="create-form">
      <div class="form-row">
        <div class="field">
          <label class="field-label" for="ws-name">Name</label>
          <input
            id="ws-name"
            type="text"
            class="field-input af2-mono"
            placeholder="My App"
            bind:value={newName}
            disabled={busy}
          />
        </div>
        <div class="field field--wide">
          <label class="field-label" for="ws-path">Data directory path</label>
          <input
            id="ws-path"
            type="text"
            class="field-input af2-mono"
            placeholder="/Users/me/Projects/my-app"
            bind:value={newPath}
            disabled={busy}
          />
        </div>
        <div class="field field--wide">
          <label class="field-label" for="ws-bus">Bus config (optional)</label>
          <input
            id="ws-bus"
            type="text"
            class="field-input af2-mono"
            placeholder="&#123;&quot;type&quot;:&quot;redis&quot;,&quot;url&quot;:&quot;redis://localhost:6379&quot;&#125;"
            bind:value={newBusConfig}
            disabled={busy}
          />
        </div>
        <div class="field field--submit">
          <Btn
            variant="purple"
            type="submit"
            disabled={busy || !newName.trim() || !newPath.trim()}
          >
            {busy ? 'Saving…' : 'Add'}
          </Btn>
        </div>
      </div>
    </form>
  </Card>
{/if}

<!-- ── Workspace cards ───────────────────────────────────────────────────── -->
{#if $workspaces.length === 0}
  <Card>
    <div class="empty-state">
      <span class="empty-icon">⬡</span>
      <p>No workspaces registered yet.</p>
      <p class="empty-sub">
        Click <strong>+ New Workspace</strong> above, or use the CLI:
        <code class="af2-mono inline-code">agentforge workspaces add "My App" /path/to/my-app</code>
      </p>
    </div>
  </Card>
{:else}
  <div class="workspace-grid">
    {#each $workspaces as ws (ws.id)}
      {@const isActive = $currentWorkspaceId === ws.id}
      {@const isDefault = $defaultWorkspaceId === ws.id}

      <Card accent={isActive} hover style={isActive ? 'border-color:color-mix(in srgb,var(--af-purple) 35%,transparent)' : ''}>
        <!-- Card header row -->
        <div class="ws-card-header">
          <div class="ws-title-row">
            {#if isActive}
              <span class="active-bar"></span>
            {/if}
            <span class="ws-name">{ws.name}</span>
            {#if isDefault}
              <Badge variant="purple">default</Badge>
            {/if}
            {#if isActive}
              <Badge variant="success">active</Badge>
            {/if}
          </div>
          <div class="ws-actions">
            {#if !isActive}
              <Btn size="sm" onclick={() => activateWorkspace(ws.id)} disabled={busy}>Switch</Btn>
            {/if}
            {#if !isDefault}
              <Btn size="sm" onclick={() => setDefault(ws.id)} disabled={busy}>Set default</Btn>
            {/if}
            <Btn variant="danger" size="sm" onclick={() => removeOne(ws.id)} disabled={busy}>Remove</Btn>
          </div>
        </div>

        <!-- Details grid -->
        <div class="ws-details-grid">
          <div class="ws-detail">
            <span class="ws-detail-label">ID</span>
            <code class="af2-mono ws-detail-value">{ws.id}</code>
          </div>
          <div class="ws-detail">
            <span class="ws-detail-label">Path</span>
            <code class="af2-mono ws-detail-value">{ws.path}</code>
          </div>
          <div class="ws-detail">
            <span class="ws-detail-label">Added</span>
            <span class="ws-detail-value">{formatAddedAt(ws.addedAt)}</span>
          </div>
        </div>
      </Card>
    {/each}
  </div>
{/if}

<style>
  /* ── Page header ──────────────────────────────────────────────────────── */
  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 16px;
    gap: 16px;
  }

  .page-title {
    font-size: 20px;
    font-weight: 600;
    color: var(--af-text);
    margin: 0 0 4px;
  }

  .page-sub { font-size: 12px; color: var(--af-dim); margin: 0; }

  .page-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  /* ── Section title ────────────────────────────────────────────────────── */
  .section-title {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--af-dim);
    text-transform: uppercase;
  }

  /* ── Inline code ──────────────────────────────────────────────────────── */
  .inline-code {
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 3px;
    padding: 1px 5px;
    font-size: 11px;
    color: var(--af-muted);
  }

  /* ── Banners ──────────────────────────────────────────────────────────── */
  .banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 14px;
    border-radius: 6px;
    font-size: 12px;
    border: 1px solid;
  }

  .banner--danger {
    color: var(--af-danger);
    background: color-mix(in srgb, var(--af-danger) 8%, transparent);
    border-color: color-mix(in srgb, var(--af-danger) 25%, transparent);
  }

  .banner-dismiss {
    background: none;
    border: none;
    cursor: pointer;
    color: inherit;
    opacity: 0.7;
    font-size: 14px;
  }

  /* ── Create form ──────────────────────────────────────────────────────── */
  .form-row {
    display: flex;
    gap: 12px;
    align-items: flex-end;
    flex-wrap: wrap;
  }

  .field { display: flex; flex-direction: column; gap: 5px; }
  .field--wide { flex: 1; min-width: 180px; }
  .field--submit { flex-shrink: 0; padding-bottom: 1px; }

  .field-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: var(--af-dim);
    text-transform: uppercase;
  }

  .field-input {
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    color: var(--af-text);
    padding: 6px 10px;
    font-size: 12px;
    outline: none;
    transition: border-color 150ms;
    box-sizing: border-box;
    width: 100%;
  }

  .field-input:focus { border-color: var(--af-purple); }
  .field-input:disabled { opacity: 0.5; cursor: not-allowed; }
  .field-input::placeholder { color: var(--af-faint); }

  /* ── Empty state ──────────────────────────────────────────────────────── */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 64px 24px;
    gap: 10px;
    text-align: center;
    color: var(--af-dim);
  }

  .empty-icon { font-size: 32px; opacity: 0.25; }

  .empty-state p { margin: 0; font-size: 12px; }

  .empty-sub { font-size: 11px; color: var(--af-faint); }

  /* ── Workspace card grid ──────────────────────────────────────────────── */
  .workspace-grid {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  /* ── Workspace card ───────────────────────────────────────────────────── */
  .ws-card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 12px;
  }

  .ws-title-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .active-bar {
    width: 3px;
    height: 18px;
    background: linear-gradient(180deg, var(--af-accent), var(--af-purple));
    border-radius: 2px;
    flex-shrink: 0;
  }

  .ws-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--af-text);
  }

  .ws-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  /* ── Workspace details grid ───────────────────────────────────────────── */
  .ws-details-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
  }

  .ws-detail {
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    padding: 8px 10px;
  }

  .ws-detail-label {
    display: block;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: var(--af-faint);
    text-transform: uppercase;
    margin-bottom: 3px;
  }

  .ws-detail-value {
    font-size: 11px;
    color: var(--af-muted);
    overflow-wrap: anywhere;
  }

  code.ws-detail-value {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1;
  }

  .af2-mono {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1;
  }

  @media (max-width: 900px) {
    .ws-details-grid { grid-template-columns: 1fr; }
    .form-row { flex-direction: column; }
  }

  @media (max-width: 600px) {
    .page-header { flex-direction: column; align-items: stretch; }
    .page-actions { justify-content: flex-start; }
    .ws-card-header { flex-direction: column; }
  }
</style>
