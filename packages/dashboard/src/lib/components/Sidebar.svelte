<script lang="ts">
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import {
    workspaces,
    currentWorkspaceId,
    loadWorkspaces,
    selectWorkspace,
  } from '$lib/stores/workspace';
  import { approvalsStore } from '$lib/stores/approvals.js';

  let open = $state(false);

  onMount(() => {
    loadWorkspaces();
  });

  function currentName(list: { id: string; name: string }[], id: string | null): string {
    if (!id) return '(default)';
    const w = list.find((w) => w.id === id);
    return w ? w.name : id;
  }

  function pick(id: string | null) {
    selectWorkspace(id);
    open = false;
    // Reload so cycles fetches re-issue with the new workspaceId
    if (typeof window !== 'undefined') window.location.reload();
  }

  // Pending approval count — drives the badge on the Approvals nav item.
  // Use $derived (rune mode) since the Sidebar already uses $state.
  const pendingApprovalCount = $derived($approvalsStore.pending.length);

  const nav = [
    { section: 'Overview', items: [
      { href: '/', label: 'Command Center' },
      { href: '/jobs', label: 'Runtime Jobs' },
      { href: '/sessions', label: 'Sessions' },
      { href: '/cost', label: 'Cost Analytics' },
    ]},
    { section: 'Autonomous', items: [
      { href: '/cycles', label: 'Cycles' },
      { href: '/cycles/new', label: 'Launch' },
      { href: '/sprints', label: 'Sprints' },
      { href: '/runner', label: 'Agent Runner' },
      { href: '/live', label: 'Activity Feed' },
    ]},
    { section: 'Operations', items: [
      { href: '/branches', label: 'Branches' },
      { href: '/approvals', label: 'Approvals' },
      { href: '/workspaces', label: 'Workspaces' },
    ]},
    { section: 'Organization', items: [
      { href: '/agents', label: 'Agents' },
      { href: '/org', label: 'Org Graph' },
    ]},
    { section: 'Intelligence', items: [
      { href: '/flywheel', label: 'Flywheel' },
      { href: '/search', label: 'Search' },
      { href: '/memory', label: 'Memory' },
      { href: '/knowledge', label: 'Knowledge' },
    ]},
    { section: 'Platform', items: [
      { href: '/plugins', label: 'Plugins' },
      { href: '/health', label: 'Health' },
      { href: '/settings', label: 'Settings' },
    ]},
  ];
</script>

<nav class="sidebar">
  <div class="ws-switcher">
    <button class="ws-current" onclick={() => (open = !open)} aria-haspopup="listbox" aria-expanded={open}>
      <span class="ws-label">Workspace</span>
      <span class="ws-name">{currentName($workspaces, $currentWorkspaceId)}</span>
      <span class="ws-chevron">{open ? '▴' : '▾'}</span>
    </button>
    {#if open}
      <ul class="ws-list" role="listbox">
        <li>
          <button class="ws-item" onclick={() => pick(null)}>
            <em>(server default)</em>
          </button>
        </li>
        {#each $workspaces as w (w.id)}
          <li>
            <button
              class="ws-item"
              class:active={$currentWorkspaceId === w.id}
              onclick={() => pick(w.id)}
            >
              <strong>{w.name}</strong>
              <span class="ws-path">{w.path}</span>
            </button>
          </li>
        {/each}
        <li>
          <a class="ws-item ws-manage" href="/workspaces" onclick={() => (open = false)}>
            Manage workspaces…
          </a>
        </li>
      </ul>
    {/if}
  </div>

  {#each nav as group}
    <div class="nav-section">
      <div class="nav-label">{group.section}</div>
      {#each group.items as item}
        <a href={item.href} class="nav-item" class:active={page.url.pathname === item.href}>
          {item.label}
          {#if item.href === '/approvals' && pendingApprovalCount > 0}
            <span class="nav-badge">{pendingApprovalCount}</span>
          {/if}
        </a>
      {/each}
    </div>
  {/each}
</nav>

<style>
  .sidebar {
    overflow-y: auto;
    max-height: 100vh;
  }
  .ws-switcher {
    position: relative;
    padding: var(--space-3, 12px);
    border-bottom: 1px solid var(--color-surface-2, rgba(255,255,255,0.06));
    margin-bottom: var(--space-2, 8px);
  }
  .ws-current {
    width: 100%;
    background: var(--color-surface-2, rgba(255,255,255,0.04));
    border: 1px solid var(--color-surface-3, rgba(255,255,255,0.08));
    border-radius: var(--radius-md, 6px);
    padding: 8px 10px;
    text-align: left;
    color: var(--color-text, #e6e6e6);
    cursor: pointer;
    display: grid;
    grid-template-columns: 1fr auto;
    grid-template-rows: auto auto;
    gap: 2px 8px;
  }
  .ws-current:hover { background: var(--color-surface-3, rgba(255,255,255,0.07)); }
  .ws-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--color-text-muted, #888);
    grid-column: 1;
    grid-row: 1;
  }
  .ws-name {
    font-weight: 600;
    grid-column: 1;
    grid-row: 2;
  }
  .ws-chevron {
    grid-column: 2;
    grid-row: 1 / span 2;
    align-self: center;
    color: var(--color-text-muted, #888);
  }
  .ws-list {
    list-style: none;
    margin: 6px 0 0 0;
    padding: 4px;
    background: var(--color-surface-1, #1a1a1a);
    border: 1px solid var(--color-surface-3, rgba(255,255,255,0.08));
    border-radius: var(--radius-md, 6px);
    max-height: 280px;
    overflow-y: auto;
  }
  .ws-item {
    width: 100%;
    background: transparent;
    border: 0;
    padding: 6px 8px;
    text-align: left;
    color: var(--color-text, #e6e6e6);
    cursor: pointer;
    border-radius: 4px;
    font-size: 12px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-decoration: none;
  }
  .ws-item:hover { background: var(--color-surface-3, rgba(255,255,255,0.07)); }
  .ws-item.active { background: var(--color-brand-faded, rgba(80,140,255,0.15)); }
  .ws-path {
    font-size: 10px;
    color: var(--color-text-muted, #888);
    font-family: var(--font-mono, monospace);
    word-break: break-all;
  }
  .ws-manage { font-style: italic; color: var(--color-info, #5ab3ff); }

  /* ── approvals pending badge ─────────────────────────────────────────────── */
  .nav-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .nav-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 8px;
    background: var(--color-warning, #f5a623);
    color: #000;
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
    font-family: var(--font-mono, monospace);
    flex-shrink: 0;
  }
</style>
