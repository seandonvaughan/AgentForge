<script lang="ts">
  import { page } from '$app/state';

  const nav = [
    { section: 'Overview', items: [
      { href: '/', label: 'Command Center' },
      { href: '/sessions', label: 'Sessions' },
      { href: '/cost', label: 'Cost Analytics' },
    ]},
    { section: 'Operations', items: [
      { href: '/live', label: 'Live Feed' },
      { href: '/branches', label: 'Branches' },
      { href: '/runner', label: 'Agent Runner' },
      { href: '/approvals', label: 'Approvals' },
    ]},
    { section: 'Organization', items: [
      { href: '/agents', label: 'Agents' },
      { href: '/org', label: 'Org Graph' },
      { href: '/sprints', label: 'Sprints' },
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
  {#each nav as group}
    <div class="nav-section">
      <div class="nav-label">{group.section}</div>
      {#each group.items as item}
        <a href={item.href} class="nav-item" class:active={page.url.pathname === item.href}>
          {item.label}
        </a>
      {/each}
    </div>
  {/each}
</nav>
