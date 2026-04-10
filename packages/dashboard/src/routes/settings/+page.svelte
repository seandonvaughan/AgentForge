<script lang="ts">
  import { onMount } from 'svelte';

  interface Settings {
    workspaceName?: string;
    defaultModel?: 'opus' | 'sonnet' | 'haiku';
    maxConcurrentAgents?: number;
    sessionTimeoutMinutes?: number;
    theme?: 'dark' | 'light';
    // Autonomous cycle retry settings
    maxAutoRetries?: number;
    requireApprovalAfter?: number;
    reExecuteOnRetry?: boolean;
  }

  let settings: Settings = {
    workspaceName: 'AgentForge',
    defaultModel: 'sonnet',
    maxConcurrentAgents: 10,
    sessionTimeoutMinutes: 60,
    theme: 'dark',
    maxAutoRetries: 1,
    requireApprovalAfter: 1,
    reExecuteOnRetry: true,
  };

  let loading = true;
  let saving = false;
  let saveSuccess = false;
  let error: string | null = null;
  let saveError: string | null = null;

  async function load() {
    loading = true;
    error = null;
    try {
      const [wsRes, autoRes] = await Promise.all([
        fetch('/api/v5/settings'),
        fetch('/api/v5/settings/autonomous'),
      ]);
      if (wsRes.ok) {
        const json = await wsRes.json();
        settings = { ...settings, ...(json.data ?? json) };
      }
      if (autoRes.ok) {
        const json = await autoRes.json();
        const retry = json.data?.retry ?? {};
        settings.maxAutoRetries = retry.maxAutoRetries ?? settings.maxAutoRetries;
        settings.requireApprovalAfter = retry.requireApprovalAfter ?? settings.requireApprovalAfter;
        settings.reExecuteOnRetry = retry.reExecuteOnRetry ?? settings.reExecuteOnRetry;
      }
    } catch (e) {
      error = null;
    } finally {
      loading = false;
    }
  }

  async function save() {
    saving = true;
    saveError = null;
    saveSuccess = false;
    try {
      const [wsRes, autoRes] = await Promise.all([
        fetch('/api/v5/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings),
        }),
        fetch('/api/v5/settings/autonomous', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            retry: {
              maxAutoRetries: settings.maxAutoRetries,
              requireApprovalAfter: settings.requireApprovalAfter,
              reExecuteOnRetry: settings.reExecuteOnRetry,
            },
          }),
        }),
      ]);
      if (!wsRes.ok) throw new Error(`Workspace settings: HTTP ${wsRes.status}`);
      if (!autoRes.ok) throw new Error(`Autonomous settings: HTTP ${autoRes.status}`);
      saveSuccess = true;
      setTimeout(() => { saveSuccess = false; }, 3000);
    } catch (e) {
      saveError = String(e);
    } finally {
      saving = false;
    }
  }

  function applyTheme(theme: 'dark' | 'light') {
    settings.theme = theme;
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : '');
    }
  }

  onMount(async () => {
    await load();
    // Apply theme from loaded settings
    if (settings.theme) applyTheme(settings.theme);
  });
</script>

<svelte:head><title>Settings — AgentForge</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Settings</h1>
    <p class="page-subtitle">Workspace configuration</p>
  </div>
</div>

{#if loading}
  <div class="card">
    {#each Array(5) as _}
      <div class="skeleton" style="height: 40px; width: 100%; margin-bottom: var(--space-4);"></div>
    {/each}
  </div>
{:else}
  <form onsubmit={(e) => { e.preventDefault(); save(); }}>
    <!-- Workspace -->
    <div class="card settings-section">
      <div class="card-header">
        <span class="card-title">Workspace</span>
      </div>

      <div class="field">
        <label class="field-label" for="workspace-name">Workspace Name</label>
        <input
          id="workspace-name"
          class="field-input"
          type="text"
          bind:value={settings.workspaceName}
          placeholder="AgentForge"
        />
      </div>

      <div class="field">
        <label class="field-label" for="default-model">Default Model</label>
        <select id="default-model" class="field-input" bind:value={settings.defaultModel}>
          <option value="opus">Opus — Most capable</option>
          <option value="sonnet">Sonnet — Balanced</option>
          <option value="haiku">Haiku — Fast &amp; efficient</option>
        </select>
      </div>

      <div class="field">
        <label class="field-label" for="max-agents">Max Concurrent Agents</label>
        <input
          id="max-agents"
          class="field-input"
          type="number"
          min="1"
          max="100"
          bind:value={settings.maxConcurrentAgents}
        />
        <p class="field-hint">Maximum number of agents that can run simultaneously.</p>
      </div>

      <div class="field">
        <label class="field-label" for="session-timeout">Session Timeout (minutes)</label>
        <input
          id="session-timeout"
          class="field-input"
          type="number"
          min="1"
          max="1440"
          bind:value={settings.sessionTimeoutMinutes}
        />
      </div>
    </div>

    <!-- Autonomous Retry -->
    <div class="card settings-section">
      <div class="card-header">
        <span class="card-title">Autonomous Retry</span>
      </div>

      <div class="field">
        <label class="field-label" for="max-retries">Max Auto-Retries</label>
        <input
          id="max-retries"
          class="field-input"
          type="number"
          min="0"
          max="10"
          bind:value={settings.maxAutoRetries}
        />
        <p class="field-hint">When the gate rejects, automatically retry up to this many times before failing.</p>
      </div>

      <div class="field">
        <label class="field-label" for="approval-after">Require Approval After</label>
        <input
          id="approval-after"
          class="field-input"
          type="number"
          min="0"
          max="10"
          bind:value={settings.requireApprovalAfter}
        />
        <p class="field-hint">After this many auto-retries, pause and require human approval to continue.</p>
      </div>

      <fieldset class="field" role="radiogroup">
        <legend class="field-label">Re-execute on Retry</legend>
        <div class="theme-toggle">
          <button
            type="button"
            class="theme-btn {settings.reExecuteOnRetry ? 'active' : ''}"
            onclick={() => settings.reExecuteOnRetry = true}
          >
            Full Re-execute
          </button>
          <button
            type="button"
            class="theme-btn {!settings.reExecuteOnRetry ? 'active' : ''}"
            onclick={() => settings.reExecuteOnRetry = false}
          >
            Test + Review Only
          </button>
        </div>
        <p class="field-hint">Whether to re-run the execute phase (agents fix findings) or only re-test and re-review.</p>
      </fieldset>
    </div>

    <!-- Appearance -->
    <div class="card settings-section">
      <div class="card-header">
        <span class="card-title">Appearance</span>
      </div>

      <fieldset class="field" role="radiogroup">
        <legend class="field-label">Theme</legend>
        <div class="theme-toggle">
          <button
            type="button"
            class="theme-btn {settings.theme === 'dark' ? 'active' : ''}"
            onclick={() => applyTheme('dark')}
          >
            Dark
          </button>
          <button
            type="button"
            class="theme-btn {settings.theme === 'light' ? 'active' : ''}"
            onclick={() => applyTheme('light')}
          >
            Light
          </button>
        </div>
        <p class="field-hint">Switch between dark and light mode.</p>
      </fieldset>
    </div>

    <!-- Save bar -->
    <div class="save-bar">
      {#if saveError}
        <span class="save-error">{saveError}</span>
      {/if}
      {#if saveSuccess}
        <span class="save-success">Settings saved.</span>
      {/if}
      <button type="submit" class="btn btn-primary" disabled={saving}>
        {saving ? 'Saving…' : 'Save Settings'}
      </button>
    </div>
  </form>
{/if}

<style>
  .settings-section {
    margin-bottom: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }
  .field { display: flex; flex-direction: column; gap: var(--space-1); }
  fieldset.field { border: none; padding: 0; margin: 0; }
  .field-label {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--color-text);
  }
  .field-input {
    padding: var(--space-2) var(--space-3);
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    font-size: var(--text-sm);
    outline: none;
    max-width: 400px;
  }
  .field-input:focus { border-color: var(--color-brand); box-shadow: 0 0 0 2px rgba(91,138,245,0.15); }
  .field-hint {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    margin: 0;
  }
  .theme-toggle {
    display: inline-flex;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .theme-btn {
    padding: var(--space-2) var(--space-5);
    border: none;
    background: transparent;
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    transition: all var(--duration-fast);
  }
  .theme-btn:first-child { border-right: 1px solid var(--color-border); }
  .theme-btn.active { background: var(--color-brand); color: white; }
  .theme-btn:not(.active):hover { background: var(--color-surface-2); color: var(--color-text); }
  .save-bar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-4);
    padding-top: var(--space-2);
  }
  .save-error { font-size: var(--text-sm); color: var(--color-danger); }
  .save-success { font-size: var(--text-sm); color: var(--color-success); }
</style>
