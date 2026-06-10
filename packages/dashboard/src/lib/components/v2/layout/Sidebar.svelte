<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import {
    LayoutDashboard,
    RotateCw,
    Plus,
    Users,
    Network,
    GitBranch,
    ListChecks,
    Clock,
    Radio,
    Play,
    List,
    DollarSign,
    Sparkles,
    TrendingUp,
    Brain,
    Activity,
    Calendar,
    Webhook,
    Bell,
    ScrollText,
    Settings,
    PanelLeft,
    ChevronRight,
    Shield,
    GitMerge,
    BookOpen,
    Star,
    ShieldCheck,
  } from 'lucide-svelte';

  // ── Nav structure ──────────────────────────────────────────────────────
  interface NavItem {
    label: string;
    href: string;
    icon: any; // Lucide icon component — cannot narrow further without a union
    badgeCount?: number;
  }

  interface NavGroup {
    section: string;
    items: NavItem[];
  }

  const NAV: NavGroup[] = [
    {
      section: 'Operations',
      items: [
        { label: 'Command Center', href: '/',           icon: LayoutDashboard },
        { label: 'Cycles',         href: '/cycles',     icon: RotateCw },
        { label: 'Launch',         href: '/cycles/new', icon: Plus },
        { label: 'Agents',         href: '/agents',     icon: Users },
        { label: 'Org Graph',      href: '/org',        icon: Network },
        { label: 'Branches',       href: '/branches',   icon: GitBranch },
        { label: 'Approvals',      href: '/approvals',  icon: ListChecks },
        { label: 'Live Feed',      href: '/live',       icon: Radio },
        { label: 'Runner',         href: '/runner',     icon: Play },
        { label: 'Jobs',           href: '/jobs',       icon: List },
      ],
    },
    {
      section: 'Insights',
      items: [
        { label: 'Cost',        href: '/cost',        icon: DollarSign },
        { label: 'Quality',     href: '/quality',     icon: Star },
        { label: 'Flywheel',    href: '/flywheel',    icon: Sparkles },
        { label: 'Insights',    href: '/insights',    icon: TrendingUp },
        { label: 'Memory',      href: '/memory',      icon: Brain },
        { label: 'Knowledge',   href: '/knowledge',   icon: BookOpen },
        { label: 'KBs',         href: '/knowledge/kbs', icon: BookOpen },
        { label: 'Health',      href: '/health',      icon: Activity },
        { label: 'Durability',  href: '/durability',  icon: ShieldCheck },
      ],
    },
    {
      section: 'System',
      items: [
        { label: 'Schedule',      href: '/schedule',      icon: Calendar },
        { label: 'Webhooks',      href: '/webhooks',      icon: Webhook },
        { label: 'Notifications', href: '/notifications', icon: Bell },
        { label: 'Audit log',     href: '/audit',         icon: ScrollText },
        { label: 'Workspaces',    href: '/workspaces',    icon: GitMerge },
      ],
    },
    {
      section: 'Settings',
      items: [
        { label: 'Settings', href: '/settings', icon: Settings },
        { label: 'Security',  href: '/settings/security', icon: Shield },
      ],
    },
  ];

  // ── Pinned state — persisted in localStorage ───────────────────────────
  function readPinned(): boolean {
    if (typeof localStorage === 'undefined') return true;
    const stored = localStorage.getItem('af2-sidebar-pinned');
    return stored === null ? true : stored === 'true';
  }

  let pinned = $state(readPinned());
  let hovered = $state(false);

  const expanded = $derived(pinned || hovered);

  function togglePin(): void {
    pinned = !pinned;
    try { localStorage.setItem('af2-sidebar-pinned', String(pinned)); } catch { /* ignore */ }
  }

  // ── Active route ───────────────────────────────────────────────────────
  function isActive(href: string): boolean {
    const p = $page.url.pathname;
    if (href === '/') return p === '/';
    return p === href || p.startsWith(href + '/');
  }

  // ── Reduced motion ─────────────────────────────────────────────────────
  const reducedMotion = $derived(
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );

  const transitionDuration = $derived(reducedMotion ? '0ms' : '200ms');

  // ── Width exposed as CSS custom prop for Layout ────────────────────────
  const sidebarWidth = $derived(expanded ? '220px' : '48px');
</script>

<aside
  class="sidebar"
  style="
    width:{sidebarWidth};
    transition: width {transitionDuration} cubic-bezier(.2,.7,.2,1),
                box-shadow {transitionDuration} ease;
    position:{pinned ? 'relative' : 'absolute'};
    {!pinned ? 'top:66px;left:0;bottom:0;height:calc(100vh - 66px);z-index:50;' : ''}
    box-shadow:{!pinned && hovered ? '4px 0 24px rgba(0,0,0,0.4)' : 'none'};
  "
  onmouseenter={() => { hovered = true; }}
  onmouseleave={() => { hovered = false; }}
  aria-label="Site navigation"
>
  <!-- Pin / collapse control -->
  <div class="sidebar-header" class:sidebar-header-expanded={expanded}>
    {#if expanded}
      <span class="sidebar-header-label">Navigation</span>
    {/if}
    <button
      class="pin-btn"
      class:pin-btn-active={pinned}
      onclick={togglePin}
      title={pinned ? 'Collapse sidebar' : 'Pin sidebar'}
      aria-label={pinned ? 'Collapse sidebar' : 'Pin sidebar'}
      aria-pressed={pinned}
    >
      <PanelLeft size={13} aria-hidden="true" />
    </button>
  </div>

  <!-- Nav items -->
  <nav class="sidebar-nav" class:sidebar-nav-expanded={expanded}>
    {#each NAV as group (group.section)}
      <div class="nav-group">
        {#if expanded}
          <div class="group-label">{group.section}</div>
        {/if}

        {#each group.items as item (item.href)}
          {@const active = isActive(item.href)}
          {@const Icon = item.icon}
          <button
            class="nav-item"
            class:nav-item-active={active}
            class:nav-item-expanded={expanded}
            onclick={() => void goto(item.href)}
            title={!expanded ? item.label : undefined}
            aria-current={active ? 'page' : undefined}
          >
            {#if active}
              <span class="active-bar" aria-hidden="true"></span>
            {/if}

            <span class="nav-icon" aria-hidden="true">
              <Icon size={16} />
            </span>

            {#if expanded}
              <span class="nav-label">{item.label}</span>
              {#if (item.badgeCount ?? 0) > 0}
                <span class="nav-badge">{item.badgeCount}</span>
              {/if}
            {/if}
          </button>
        {/each}
      </div>
    {/each}
  </nav>

  <!-- Footer -->
  <div class="sidebar-footer" class:sidebar-footer-expanded={expanded}>
    {#if expanded}
      <ChevronRight size={13} class="footer-chevron" aria-hidden="true" />
      <span class="footer-text font-mono">AgentForge</span>
    {:else}
      <Settings size={14} class="footer-icon" aria-hidden="true" />
    {/if}
  </div>
</aside>

<style>
  .sidebar {
    grid-row: 3 / 4;
    grid-column: 1 / 2;
    display: flex;
    flex-direction: column;
    background: var(--af-bg);
    border-right: 1px solid var(--af-border);
    overflow: hidden;
    padding: 8px 0;
  }

  /* Header / pin row */
  .sidebar-header {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 0 8px;
    border-bottom: 1px solid var(--af-border);
    margin-bottom: 6px;
    height: 32px;
    flex-shrink: 0;
  }

  .sidebar-header-expanded {
    justify-content: space-between;
    padding: 0 12px 8px;
  }

  .sidebar-header-label {
    font-size: 9px;
    color: var(--af-faint);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-weight: 600;
  }

  .pin-btn {
    width: 22px;
    height: 22px;
    border-radius: 4px;
    background: transparent;
    border: 1px solid var(--af-border2);
    color: var(--af-dim);
    font-size: 11px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: all 150ms ease;
  }

  .pin-btn:hover {
    color: var(--af-muted);
    border-color: var(--af-border3);
  }

  .pin-btn-active {
    border-color: color-mix(in srgb, var(--af-purple) 35%, transparent);
    color: var(--af-purple);
  }

  /* Nav */
  .sidebar-nav {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 0;
    scrollbar-width: thin;
    scrollbar-color: var(--af-border) transparent;
  }

  .sidebar-nav-expanded {
    padding: 0 8px;
  }

  .nav-group {
    margin-bottom: 6px;
  }

  .group-label {
    font-size: 9px;
    color: var(--af-faint);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-weight: 600;
    padding: 6px 8px 3px;
  }

  .nav-item {
    position: relative;
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0;
    justify-content: center;
    padding: 6px 0;
    border-radius: 6px;
    background: transparent;
    border: 1px solid transparent;
    color: var(--af-faint);
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    text-align: left;
    transition: all 150ms ease;
    margin-bottom: 1px;
    white-space: nowrap;
  }

  .nav-item-expanded {
    gap: 10px;
    justify-content: flex-start;
    padding: 6px 8px;
  }

  .nav-item:hover {
    color: var(--af-muted);
    background: var(--af-surface);
  }

  .nav-item-active {
    background: var(--af-surface2);
    border-color: var(--af-border3);
    color: var(--af-purple);
  }

  .nav-item-active:hover {
    background: var(--af-surface2);
    color: var(--af-purple);
  }

  /* Active left border accent */
  .active-bar {
    position: absolute;
    left: -8px;
    top: 6px;
    width: 2px;
    height: 18px;
    border-radius: 2px;
    background: var(--af-grad, linear-gradient(180deg, var(--af-accent), var(--af-purple)));
  }

  .nav-item-expanded .active-bar {
    left: -8px;
  }

  /* Collapsed: active bar sits on left edge */
  .nav-item:not(.nav-item-expanded) .active-bar {
    left: 0;
    border-radius: 0 2px 2px 0;
  }

  .nav-icon {
    width: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: inherit;
  }

  .nav-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .nav-badge {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--af-warning);
    color: #000;
    font-weight: 700;
    flex-shrink: 0;
  }

  /* Footer */
  .sidebar-footer {
    border-top: 1px solid var(--af-border);
    padding: 8px 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    flex-shrink: 0;
    min-height: 36px;
  }

  .sidebar-footer-expanded {
    padding: 8px 12px;
    justify-content: flex-start;
  }

  :global(.footer-chevron) {
    color: var(--af-faint);
    flex-shrink: 0;
  }

  :global(.footer-icon) {
    color: var(--af-faint);
  }

  .footer-text {
    font-size: 10px;
    color: var(--af-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .font-mono {
    font-family: 'JetBrains Mono', monospace;
    font-feature-settings: 'tnum' 1;
  }
</style>
