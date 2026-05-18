<script lang="ts">
  import { onMount } from 'svelte';
  import { Card, Btn, Badge } from '$lib/components/v2';

  interface Webhook {
    id: string;
    name: string;
    url: string;
    events: string[];
    enabled: boolean;
    lastDeliveryAt: string | null;
    lastDeliveryStatus: 'success' | 'failure' | null;
    createdAt: string;
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let loading = $state(true);
  let savingSettings = $state(false);
  let loadError: string | null = $state(null);
  let saveSettingsError: string | null = $state(null);
  let saveSettingsOk = $state(false);

  // Notification channel toggles (backed by /api/v5/settings)
  let emailEnabled = $state(false);
  let slackEnabled = $state(false);

  // Slack webhook URL input
  let slackWebhookUrl = $state('');

  // Webhooks list (from /api/v5/webhooks)
  let webhooks: Webhook[] = $state([]);
  let webhooksLoading = $state(true);
  let webhooksError: string | null = $state(null);

  // New webhook form
  let showNewWebhook = $state(false);
  let newWebhookName = $state('');
  let newWebhookUrl = $state('');
  let newWebhookEvents = $state<string[]>([]);
  let newWebhookErrors: Partial<Record<'name' | 'url', string>> = $state({});
  let creatingWebhook = $state(false);
  let createWebhookError: string | null = $state(null);

  const EVENT_OPTIONS = [
    'cycle.started', 'cycle.completed', 'cycle.failed',
    'approval.needed', 'budget.threshold', 'agent.promoted',
  ];

  // ── Load settings ──────────────────────────────────────────────────────────
  async function loadSettings() {
    loading = true;
    loadError = null;
    try {
      const res = await fetch('/api/v5/settings');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data: Record<string, unknown> };
      const dash = (json.data?.dashboard ?? {}) as Record<string, unknown>;
      emailEnabled = Boolean(dash.emailNotifications ?? false);
      slackEnabled = Boolean(dash.slackNotifications ?? false);
      slackWebhookUrl = String(dash.slackWebhookUrl ?? '');
    } catch (e) {
      loadError = e instanceof Error ? e.message : 'Failed to load settings';
    } finally {
      loading = false;
    }
  }

  async function loadWebhooks() {
    webhooksLoading = true;
    webhooksError = null;
    try {
      const res = await fetch('/api/v5/webhooks');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data: Webhook[] };
      webhooks = json.data;
    } catch (e) {
      webhooksError = e instanceof Error ? e.message : 'Failed to load webhooks';
    } finally {
      webhooksLoading = false;
    }
  }

  // ── Save notification settings ─────────────────────────────────────────────
  async function saveSettings() {
    savingSettings = true;
    saveSettingsError = null;
    saveSettingsOk = false;
    try {
      const res = await fetch('/api/v5/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dashboard: {
            emailNotifications: emailEnabled,
            slackNotifications: slackEnabled,
            slackWebhookUrl: slackWebhookUrl.trim(),
          },
        }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      saveSettingsOk = true;
      setTimeout(() => { saveSettingsOk = false; }, 3000);
    } catch (e) {
      saveSettingsError = e instanceof Error ? e.message : 'Save failed';
    } finally {
      savingSettings = false;
    }
  }

  // ── Toggle webhook enabled ─────────────────────────────────────────────────
  async function toggleWebhook(hook: Webhook) {
    try {
      const res = await fetch(`/api/v5/webhooks/${hook.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !hook.enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadWebhooks();
    } catch (_) {
      // silently fail — UI stays where it was
    }
  }

  // ── Delete webhook ─────────────────────────────────────────────────────────
  async function deleteWebhook(id: string) {
    try {
      const res = await fetch(`/api/v5/webhooks/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      await loadWebhooks();
    } catch (_) { /* noop */ }
  }

  // ── Create webhook ─────────────────────────────────────────────────────────
  function validateNewWebhook(): boolean {
    const next: typeof newWebhookErrors = {};
    if (!newWebhookName.trim()) next.name = 'Name is required';
    if (!newWebhookUrl.trim()) {
      next.url = 'URL is required';
    } else {
      try { new URL(newWebhookUrl.trim()); } catch { next.url = 'Must be a valid URL'; }
    }
    newWebhookErrors = next;
    return Object.keys(next).length === 0;
  }

  async function createWebhook() {
    if (!validateNewWebhook()) return;
    creatingWebhook = true;
    createWebhookError = null;
    try {
      const res = await fetch('/api/v5/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newWebhookName.trim(),
          url: newWebhookUrl.trim(),
          events: newWebhookEvents,
          enabled: true,
        }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      // Reset form
      showNewWebhook = false;
      newWebhookName = '';
      newWebhookUrl = '';
      newWebhookEvents = [];
      await loadWebhooks();
    } catch (e) {
      createWebhookError = e instanceof Error ? e.message : 'Create failed';
    } finally {
      creatingWebhook = false;
    }
  }

  function toggleEvent(ev: string) {
    if (newWebhookEvents.includes(ev)) {
      newWebhookEvents = newWebhookEvents.filter(e => e !== ev);
    } else {
      newWebhookEvents = [...newWebhookEvents, ev];
    }
  }

  function fmtDate(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  onMount(() => {
    void Promise.all([loadSettings(), loadWebhooks()]);
  });
</script>

{#if loading}
  <Card>
    <div class="skeleton-stack">
      {#each [1,2,3] as _}<div class="skeleton"></div>{/each}
    </div>
  </Card>
{:else if loadError}
  <Card><p class="err-text">{loadError}</p><Btn onClick={() => loadSettings()}>Retry</Btn></Card>
{:else}
  <form onsubmit={(e) => { e.preventDefault(); void saveSettings(); }}>
    <Card style="max-width:640px">
      <p class="section-title">NOTIFICATION CHANNELS</p>
      <div class="channel-list">

        <!-- In-app (always on) -->
        <div class="channel-row">
          <div class="channel-info">
            <p class="channel-name">In-app notifications</p>
            <p class="channel-sub">Bell icon in topbar — always active</p>
          </div>
          <div class="toggle-btn on" aria-disabled="true">
            <span class="toggle-thumb"></span>
          </div>
        </div>

        <!-- Email -->
        <div class="channel-row">
          <div class="channel-info">
            <p class="channel-name">Email</p>
            <p class="channel-sub">Cycle complete, approval requested, cost threshold</p>
          </div>
          <button type="button" class="toggle-btn" class:on={emailEnabled}
            onclick={() => { emailEnabled = !emailEnabled; }}
            role="switch" aria-checked={emailEnabled}>
            <span class="toggle-thumb"></span>
          </button>
        </div>

        <!-- Slack -->
        <div class="channel-row channel-col">
          <div class="channel-top">
            <div class="channel-info">
              <p class="channel-name">Slack</p>
              <p class="channel-sub">Connect Slack to receive cycle events</p>
            </div>
            <button type="button" class="toggle-btn" class:on={slackEnabled}
              onclick={() => { slackEnabled = !slackEnabled; }}
              role="switch" aria-checked={slackEnabled}>
              <span class="toggle-thumb"></span>
            </button>
          </div>
          {#if slackEnabled}
            <div class="channel-config">
              <label for="slack-url" class="field-label">Slack incoming webhook URL</label>
              <input id="slack-url" class="field-input" type="url"
                bind:value={slackWebhookUrl} placeholder="https://hooks.slack.com/services/…" />
            </div>
          {/if}
        </div>

      </div>

      <div class="save-bar">
        {#if saveSettingsError}<span class="save-err">{saveSettingsError}</span>{/if}
        {#if saveSettingsOk}<span class="save-ok">Saved.</span>{/if}
        <Btn variant="purple" type="submit" disabled={savingSettings}>
          {savingSettings ? 'Saving…' : 'Save'}
        </Btn>
      </div>
    </Card>
  </form>

  <!-- Webhooks card -->
  <Card style="max-width:720px;margin-top:12px" noPad>
    <div class="card-hdr">
      <p class="section-title" style="margin:0">OUTBOUND WEBHOOKS</p>
      <Btn variant="purple" size="sm" onClick={() => { showNewWebhook = !showNewWebhook; }}>
        {showNewWebhook ? 'Cancel' : '+ New webhook'}
      </Btn>
    </div>

    {#if showNewWebhook}
      <form onsubmit={(e) => { e.preventDefault(); void createWebhook(); }} class="new-webhook-form">
        <div class="field">
          <label for="wh-name" class="field-label">Name</label>
          <input id="wh-name" class="field-input" class:input-err={newWebhookErrors.name}
            type="text" bind:value={newWebhookName} placeholder="My webhook" />
          {#if newWebhookErrors.name}<p class="field-err">{newWebhookErrors.name}</p>{/if}
        </div>
        <div class="field">
          <label for="wh-url" class="field-label">URL</label>
          <input id="wh-url" class="field-input" class:input-err={newWebhookErrors.url}
            type="url" bind:value={newWebhookUrl} placeholder="https://…" />
          {#if newWebhookErrors.url}<p class="field-err">{newWebhookErrors.url}</p>{/if}
        </div>
        <div class="field">
          <p class="field-label">Events (optional — empty = all)</p>
          <div class="event-chips">
            {#each EVENT_OPTIONS as ev}
              <button type="button" class="chip" class:active={newWebhookEvents.includes(ev)}
                onclick={() => toggleEvent(ev)}>{ev}</button>
            {/each}
          </div>
        </div>
        {#if createWebhookError}<p class="field-err">{createWebhookError}</p>{/if}
        <div class="form-actions">
          <Btn variant="purple" type="submit" size="sm" disabled={creatingWebhook}>
            {creatingWebhook ? 'Creating…' : 'Create webhook'}
          </Btn>
        </div>
      </form>
    {/if}

    {#if webhooksLoading}
      <div class="empty-row"><p class="dim-text">Loading…</p></div>
    {:else if webhooksError}
      <div class="empty-row"><p class="err-text">{webhooksError}</p></div>
    {:else if webhooks.length === 0}
      <div class="empty-row"><p class="dim-text">No webhooks configured.</p></div>
    {:else}
      <table class="wh-table">
        <thead>
          <tr>
            {#each ['Name', 'URL', 'Events', 'Last delivery', ''] as h}
              <th>{h}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each webhooks as hook}
            <tr>
              <td class="td-name">{hook.name}</td>
              <td class="td-url font-mono">{hook.url.replace(/https?:\/\//, '')}</td>
              <td>
                {#if hook.events.length === 0}
                  <Badge variant="muted">all</Badge>
                {:else}
                  {#each hook.events.slice(0, 2) as ev}
                    <Badge variant="muted">{ev}</Badge>
                  {/each}
                  {#if hook.events.length > 2}
                    <Badge variant="muted">+{hook.events.length - 2}</Badge>
                  {/if}
                {/if}
              </td>
              <td class="td-date">
                {fmtDate(hook.lastDeliveryAt)}
                {#if hook.lastDeliveryStatus}
                  <Badge variant={hook.lastDeliveryStatus === 'success' ? 'success' : 'danger'}>
                    {hook.lastDeliveryStatus}
                  </Badge>
                {/if}
              </td>
              <td class="td-actions">
                <button type="button" class="toggle-btn-sm" class:on={hook.enabled}
                  onclick={() => toggleWebhook(hook)}
                  role="switch" aria-checked={hook.enabled} aria-label="Toggle webhook">
                  <span class="toggle-thumb"></span>
                </button>
                <Btn variant="danger" size="sm" onClick={() => deleteWebhook(hook.id)}>Delete</Btn>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </Card>
{/if}

<style>
  .section-title {
    font-size: 10px; font-weight: 700; letter-spacing: 0.1em;
    color: var(--af-dim); text-transform: uppercase; margin: 0 0 14px;
  }
  .channel-list { display: flex; flex-direction: column; gap: 1px; }
  .channel-row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 12px 0;
    border-bottom: 1px solid var(--af-border);
  }
  .channel-row:last-child { border-bottom: none; }
  .channel-col { flex-direction: column; align-items: stretch; }
  .channel-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .channel-info { flex: 1; }
  .channel-name { font-size: 13px; font-weight: 600; color: var(--af-text); margin: 0 0 2px; }
  .channel-sub  { font-size: 11px; color: var(--af-dim); margin: 0; }
  .channel-config { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
  /* Toggle */
  .toggle-btn {
    width: 40px; height: 22px; border-radius: 11px;
    border: 1px solid var(--af-border3); background: var(--af-surface2);
    cursor: pointer; position: relative; flex-shrink: 0; padding: 0;
    transition: background 200ms ease, border-color 200ms ease;
  }
  .toggle-btn.on { background: var(--af-accent); border-color: var(--af-accent); }
  .toggle-btn[aria-disabled="true"] { cursor: default; opacity: 0.7; }
  .toggle-thumb {
    position: absolute; top: 2px; left: 2px;
    width: 16px; height: 16px; border-radius: 50%; background: #fff;
    transition: transform 200ms ease;
  }
  .toggle-btn.on .toggle-thumb { transform: translateX(18px); }
  .toggle-btn-sm {
    width: 32px; height: 18px; border-radius: 9px;
    border: 1px solid var(--af-border3); background: var(--af-surface2);
    cursor: pointer; position: relative; padding: 0;
    transition: background 200ms ease;
  }
  .toggle-btn-sm.on { background: var(--af-accent); border-color: var(--af-accent); }
  .toggle-btn-sm .toggle-thumb { width: 12px; height: 12px; top: 2px; left: 2px; }
  .toggle-btn-sm.on .toggle-thumb { transform: translateX(14px); }
  /* Fields */
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field-label { font-size: 12px; font-weight: 600; color: var(--af-muted); margin: 0; }
  .field-input {
    padding: 6px 10px; background: var(--af-surface2); border: 1px solid var(--af-border2);
    border-radius: 6px; color: var(--af-text); font-size: 12px; outline: none;
    transition: border-color 150ms ease;
  }
  .field-input:focus { border-color: var(--af-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--af-accent) 15%, transparent); }
  .field-input.input-err { border-color: var(--af-danger); }
  .field-err { font-size: 11px; color: var(--af-danger); margin: 0; }
  /* Save bar */
  .save-bar {
    display: flex; align-items: center; justify-content: flex-end; gap: 12px;
    margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--af-border);
  }
  .save-err { font-size: 12px; color: var(--af-danger); }
  .save-ok  { font-size: 12px; color: var(--af-success); }
  /* Webhook table card header */
  .card-hdr {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 16px; border-bottom: 1px solid var(--af-border);
  }
  /* New webhook form */
  .new-webhook-form {
    padding: 14px 16px; border-bottom: 1px solid var(--af-border);
    display: flex; flex-direction: column; gap: 10px;
    background: var(--af-surface2);
  }
  .event-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    padding: 3px 9px; border-radius: 4px; font-size: 11px; font-weight: 500;
    border: 1px solid var(--af-border2); background: transparent;
    color: var(--af-muted); cursor: pointer; transition: all 120ms ease;
  }
  .chip.active { background: var(--af-accent); border-color: var(--af-accent); color: #fff; }
  .form-actions { display: flex; justify-content: flex-end; }
  /* Webhook table */
  .wh-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .wh-table thead th {
    text-align: left; font-size: 10px; font-weight: 600; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--af-dim);
    padding: 8px 14px; border-bottom: 1px solid var(--af-border);
  }
  .wh-table tbody tr { border-bottom: 1px solid var(--af-border); }
  .wh-table tbody tr:last-child { border-bottom: none; }
  .wh-table td { padding: 10px 14px; color: var(--af-text); vertical-align: middle; }
  .td-name { font-weight: 600; }
  .td-url { color: var(--af-dim); font-size: 11px; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .td-date { color: var(--af-dim); font-size: 11px; }
  .td-actions { display: flex; align-items: center; gap: 8px; }
  .empty-row { padding: 24px 16px; text-align: center; }
  .dim-text { font-size: 12px; color: var(--af-dim); margin: 0; }
  .err-text { color: var(--af-danger); font-size: 12px; margin: 0; }
  .skeleton-stack { display: flex; flex-direction: column; gap: 10px; }
  .skeleton {
    height: 36px;
    background: linear-gradient(90deg, var(--af-surface2) 25%, var(--af-border2) 50%, var(--af-surface2) 75%);
    background-size: 200% 100%; border-radius: 6px; animation: shimmer 1.4s infinite;
  }
  @keyframes shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
</style>
