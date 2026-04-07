<script lang="ts">
  import { wsStore } from '$lib/stores/ws.js';
  import { versionFull } from '$lib/stores/version.js';

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
    <span style="font-size:11px;color:var(--color-text-muted)">
      <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:{$wsStore.status === 'connected' ? 'var(--color-success)' : 'var(--color-danger)'};margin-right:4px"></span>
      {$wsStore.status}
    </span>
    <button class="btn btn-ghost btn-sm" onclick={toggleTheme}>
      {theme === 'dark' ? '☀' : '🌙'}
    </button>
  </div>
</header>
