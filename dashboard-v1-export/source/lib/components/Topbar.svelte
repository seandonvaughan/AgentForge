<script lang="ts">
  import { wsStore } from '$lib/stores/ws.js';
  import { versionFull } from '$lib/stores/version.js';
  import { approvalsStore } from '$lib/stores/approvals.js';

  let theme = 'dark';
  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  }
</script>

<header class="topbar">
  <div style="display:flex;align-items:center;gap:8px;flex:1">
    <span style="font-weight:700;font-size:14px;color:var(--color-text)">AgentForge</span>
    <span class="badge muted" style="font-size:10px">v{$versionFull}</span>
  </div>
  <div style="display:flex;align-items:center;gap:12px">
    <!-- WebSocket status -->
    <span style="font-size:11px;color:var(--color-text-muted)" title="WebSocket bus status">
      <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:{$wsStore.status === 'connected' ? 'var(--color-success)' : 'var(--color-danger)'};margin-right:4px"></span>
      {$wsStore.status}
    </span>
    <!-- SSE (approval notifications) status -->
    <span
      class="sse-indicator"
      title="Approval SSE stream — {$approvalsStore.sseConnected ? 'receiving live approval notifications' : 'offline; polling every 10 s as fallback'}"
    >
      <span
        class="conn-dot"
        style="background:{$approvalsStore.sseConnected ? 'var(--color-success)' : 'var(--color-text-faint)'}"
      ></span>
      SSE {$approvalsStore.sseConnected ? 'live' : 'offline'}
      {#if $approvalsStore.pending.length > 0}
        <a
          href="/approvals"
          class="pending-chip"
          title="{$approvalsStore.pending.length} cycle approval{$approvalsStore.pending.length !== 1 ? 's' : ''} awaiting review"
        >
          {$approvalsStore.pending.length} pending
        </a>
      {/if}
    </span>
    <button class="btn btn-ghost btn-sm" onclick={toggleTheme}>
      {theme === 'dark' ? '☀' : '🌙'}
    </button>
  </div>
</header>

<style>
  .sse-indicator {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--color-text-muted);
    white-space: nowrap;
  }

  .conn-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .pending-chip {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    border-radius: 9999px;
    background: rgba(245, 166, 35, 0.18);
    border: 1px solid rgba(245, 166, 35, 0.4);
    color: var(--color-warning);
    font-size: 10px;
    font-weight: 700;
    font-family: var(--font-mono);
    text-decoration: none;
    line-height: 1.4;
    transition: background var(--duration-fast);
  }

  .pending-chip:hover {
    background: rgba(245, 166, 35, 0.28);
  }

  @media (prefers-reduced-motion: reduce) {
    .conn-dot,
    .pending-chip { transition: none; }
  }
</style>
