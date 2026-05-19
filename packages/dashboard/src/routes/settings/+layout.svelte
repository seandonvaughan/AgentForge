<script lang="ts">
  import { page } from '$app/stores';
  import type { Snippet } from 'svelte';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();

  const SECTIONS = [
    { id: 'workspace',     label: 'Workspace',      href: '/settings/workspace' },
    { id: 'autonomous',    label: 'Autonomous',      href: '/settings/autonomous' },
    { id: 'forge',         label: 'Forge',           href: '/settings/forge' },
    { id: 'notifications', label: 'Notifications',   href: '/settings/notifications' },
    { id: 'security',      label: 'Security',        href: '/settings/security' },
    { id: 'team',          label: 'Team',            href: '/settings/team' },
    { id: 'billing',       label: 'Billing',         href: '/settings/billing' },
  ] as const;

  // Derive active section from page path
  const activeSection = $derived(
    SECTIONS.find(s => $page.url.pathname.startsWith(s.href))?.id ?? 'workspace'
  );
</script>

<svelte:head><title>Settings — AgentForge</title></svelte:head>

<div class="settings-root">
  <!-- Page header -->
  <div class="page-hdr">
    <p class="crumbs">Workspace › Settings</p>
    <h1 class="page-title">Settings</h1>
  </div>

  <div class="settings-layout">
    <!-- Left vertical nav -->
    <nav class="settings-nav" aria-label="Settings sections">
      {#each SECTIONS as section}
        {@const isActive = activeSection === section.id}
        <a
          href={section.href}
          class="nav-item"
          class:active={isActive}
          aria-current={isActive ? 'page' : undefined}
        >
          {#if isActive}
            <span class="active-pip" aria-hidden="true"></span>
          {/if}
          {section.label}
        </a>
      {/each}
    </nav>

    <!-- Content panel -->
    <div class="settings-content">
      {@render children()}
    </div>
  </div>
</div>

<style>
  .settings-root {
    max-width: 1100px;
  }

  .page-hdr {
    margin-bottom: 20px;
  }

  .crumbs {
    font-size: 11px;
    color: var(--af-dim);
    margin: 0 0 4px;
    letter-spacing: 0.02em;
  }

  .page-title {
    font-size: 20px;
    font-weight: 700;
    color: var(--af-text);
    margin: 0;
    letter-spacing: -0.02em;
  }

  .settings-layout {
    display: grid;
    grid-template-columns: 180px 1fr;
    gap: 18px;
    align-items: start;
  }

  .settings-nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .nav-item {
    position: relative;
    display: block;
    padding: 7px 12px 7px 20px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    text-decoration: none;
    background: transparent;
    border: 1px solid transparent;
    color: var(--af-muted);
    transition: all 150ms ease;
  }

  .nav-item:hover:not(.active) {
    background: var(--af-surface2);
    color: var(--af-text);
  }

  .nav-item.active {
    background: var(--af-surface2);
    border-color: var(--af-border3);
    color: var(--af-purple);
  }

  .active-pip {
    position: absolute;
    left: 8px;
    top: 50%;
    transform: translateY(-50%);
    width: 2px;
    height: 16px;
    border-radius: 2px;
    background: linear-gradient(180deg, var(--af-accent), var(--af-purple));
  }

  .settings-content {
    min-width: 0;
  }
</style>
