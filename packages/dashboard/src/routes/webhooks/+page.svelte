<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import type { PageData } from './$types';
  import { Card, Badge, Btn, KpiTile, PulseDot } from '$lib/components/v2';

  let { data }: { data: PageData } = $props();

  type DeliveryStatus = 'success' | 'failure';

  interface Webhook {
    id: string;
    name: string;
    url: string;
    secret: string | null;
    events: string[];
    enabled: boolean;
    lastDeliveryAt: string | null;
    lastDeliveryStatus: DeliveryStatus | null;
    createdAt: string;
  }

  interface WebhooksResponse {
    data: Webhook[];
    meta: { total: number; timestamp: string };
  }

  let webhooks: Webhook[] = $state((data.data ?? []) as Webhook[]);
  let loading = $state(webhooks.length === 0);
  let error: string | null = $state(null);

  let showCreate = $state(false);
  let formName = $state('');
  let formUrl = $state('');
  let formSecret = $state('');
  let formEvents = $state<string[]>([]);
  let formEnabled = $state(true);
  let formError: string | null = $state(null);
  let saving = $state(false);
  let copied: string | null = $state(null);
  let testingId: string | null = $state(null);
  let testResult: { id: string; ok: boolean; status: number } | null = $state(null);
  let deletingId: string | null = $state(null);

  const EVENT_OPTIONS = [
    'cycle.completed', 'cycle.failed', 'cycle.started',
    'approval.requested', 'approval.approved', 'approval.denied',
    'agent.started', 'agent.failed', 'health.degraded',
  ];

  let interval: ReturnType<typeof setInterval> | null = null;

  async function fetchWebhooks() {
    if (browser && document.visibilityState === 'hidden') return;
    try {
      const res = await fetch('/api/v5/webhooks');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as WebhooksResponse;
      webhooks = body.data as Webhook[];
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load webhooks';
    } finally {
      loading = false;
    }
  }

  async function testWebhook(id: string) {
    testingId = id;
    testResult = null;
    try {
      const res = await fetch(`/api/v5/webhooks/${id}/test`, { method: 'POST' });
      const body = await res.json() as { data?: { deliveryStatus: string; httpStatus: number } };
      const d = body.data;
      testResult = { id, ok: d?.deliveryStatus === 'success', status: d?.httpStatus ?? res.status };
      await fetchWebhooks();
    } catch {
      testResult = { id, ok: false, status: 0 };
    } finally {
      testingId = null;
    }
  }

  async function toggleEnabled(w: Webhook) {
    try {
      await fetch(`/api/v5/webhooks/${w.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !w.enabled }),
      });
      await fetchWebhooks();
    } catch { /* silent */ }
  }

  async function deleteWebhook(id: string) {
    deletingId = id;
    try {
      await fetch(`/api/v5/webhooks/${id}`, { method: 'DELETE' });
      await fetchWebhooks();
    } catch { /* silent */ } finally {
      deletingId = null;
    }
  }

  function generateSecret(): string {
    const arr = new Uint8Array(20);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      copied = url;
      setTimeout(() => { copied = null; }, 2000);
    } catch { /* ignore */ }
  }

  async function createWebhook() {
    formError = null;
    if (!formName.trim()) { formError = 'Name is required'; return; }
    if (!formUrl.trim()) { formError = 'URL is required'; return; }
    try { new URL(formUrl.trim()); } catch { formError = 'URL must be valid'; return; }
    saving = true;
    try {
      const res = await fetch('/api/v5/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName.trim(), url: formUrl.trim(),
          secret: formSecret.trim() || null, events: formEvents, enabled: formEnabled,
        }),
      });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        formError = body.error ?? 'Failed to create webhook';
        return;
      }
      formName = ''; formUrl = ''; formSecret = ''; formEvents = []; formEnabled = true;
      showCreate = false;
      await fetchWebhooks();
    } catch (e) {
      formError = e instanceof Error ? e.message : 'Failed to create webhook';
    } finally {
      saving = false;
    }
  }

  function toggleEvent(evt: string) {
    formEvents = formEvents.includes(evt)
      ? formEvents.filter(e => e !== evt)
      : [...formEvents, evt];
  }

  function fmtRel(iso: string | null): string {
    if (!iso) return '—';
    try {
      const diff = Date.now() - new Date(iso).getTime();
      const s = Math.floor(diff / 1000);
      if (s < 60) return `${s}s ago`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      return new Date(iso).toLocaleDateString();
    } catch { return iso; }
  }

  function truncUrl(url: string, n = 50): string {
    return url.length > n ? url.slice(0, n) + '…' : url;
  }

  const healthyCount = $derived(webhooks.filter(w => w.enabled && w.lastDeliveryStatus !== 'failure').length);
  const failingCount = $derived(webhooks.filter(w => w.lastDeliveryStatus === 'failure').length);

  onMount(() => {
    if (webhooks.length === 0) fetchWebhooks();
    interval = setInterval(fetchWebhooks, 30_000);
    if (browser) document.addEventListener('visibilitychange', fetchWebhooks);
  });

  onDestroy(() => {
    if (interval) clearInterval(interval);
    if (browser) document.removeEventListener('visibilitychange', fetchWebhooks);
  });
</script>

<div class="page">
  <div class="page-header">
    <div>
      <div class="crumbs">Workspace / Webhooks</div>
      <h1 class="page-title">Webhooks &amp; integrations</h1>
      <p class="page-sub">Outbound deliveries to Slack, Linear, Datadog, and custom endpoints</p>
    </div>
    <div class="header-actions">
      <Btn variant="primary" size="sm" onclick={() => { showCreate = !showCreate; formError = null; }}>
        {showCreate ? '✕ Cancel' : '+ New webhook'}
      </Btn>
    </div>
  </div>

  <div class="kpi-row">
    <KpiTile label="Total" value={webhooks.length} color="var(--af-text)" />
    <KpiTile label="Healthy" value={healthyCount} color="var(--af-success)" />
    <KpiTile label="Failing" value={failingCount} color={failingCount > 0 ? 'var(--af-danger)' : 'var(--af-dim)'} />
  </div>

  {#if showCreate}
    <Card>
      <div class="section-title" style="margin-bottom:14px">NEW WEBHOOK</div>
      <div class="create-grid">
        <div class="form-field">
          <label class="form-label" for="wh-name">Name</label>
          <input id="wh-name" class="form-input" type="text" placeholder="Slack alerts" bind:value={formName} />
        </div>
        <div class="form-field" style="grid-column:span 2">
          <label class="form-label" for="wh-url">URL</label>
          <input id="wh-url" class="form-input font-mono" type="url" placeholder="https://hooks.slack.com/…" bind:value={formUrl} />
        </div>
        <div class="form-field" style="grid-column:span 2">
          <label class="form-label" for="wh-secret">
            Secret
            <button class="gen-btn" onclick={() => { formSecret = generateSecret(); }}>Generate</button>
          </label>
          <input id="wh-secret" class="form-input font-mono" type="text" placeholder="optional signing secret" bind:value={formSecret} />
        </div>
        <div class="form-field" style="grid-column:span 3">
          <label class="form-label">Events</label>
          <div class="events-grid">
            {#each EVENT_OPTIONS as evt}
              <button class="evt-chip" class:evt-selected={formEvents.includes(evt)} onclick={() => toggleEvent(evt)}>
                <span class="font-mono">{evt}</span>
              </button>
            {/each}
          </div>
        </div>
        <div class="form-field form-row" style="grid-column:span 3">
          <label class="form-label" for="wh-enabled">Enabled</label>
          <input id="wh-enabled" type="checkbox" bind:checked={formEnabled} />
        </div>
      </div>
      {#if formError}
        <div class="form-error">{formError}</div>
      {/if}
      <div style="margin-top:14px;display:flex;gap:8px">
        <Btn variant="primary" size="md" onclick={createWebhook} disabled={saving}>{saving ? 'Creating…' : 'Create webhook'}</Btn>
        <Btn size="md" variant="ghost" onclick={() => { showCreate = false; formError = null; }}>Cancel</Btn>
      </div>
    </Card>
  {/if}

  {#if testResult}
    <div class="toast" class:toast-ok={testResult.ok} class:toast-fail={!testResult.ok}>
      {testResult.ok ? '✓ Test delivery succeeded' : '✗ Test delivery failed'}
      {#if testResult.status}— HTTP {testResult.status}{/if}
      <button class="toast-close" onclick={() => { testResult = null; }}>✕</button>
    </div>
  {/if}

  {#if loading}
    <Card>
      <div class="state-center">
        <div class="spinner"></div>
        <span style="font-size:12px;color:var(--af-dim);margin-top:8px">Loading webhooks…</span>
      </div>
    </Card>
  {:else if error}
    <Card>
      <div class="state-center">
        <span style="font-size:22px;color:var(--af-danger)">⚠</span>
        <span style="font-size:12px;color:var(--af-danger);margin-top:6px">{error}</span>
      </div>
    </Card>
  {:else if webhooks.length === 0}
    <Card>
      <div class="state-center">
        <span style="font-size:28px;color:var(--af-faint)">🔗</span>
        <div style="font-size:13px;color:var(--af-text);font-weight:600;margin-top:8px">No webhooks configured.</div>
        <div style="font-size:11px;color:var(--af-dim);margin-top:4px">Click "+ New webhook" to add your first integration.</div>
      </div>
    </Card>
  {:else}
    <div class="webhook-list">
      {#each webhooks as w (w.id)}
        <Card hover style="padding:14px 16px;">
          <div class="webhook-row">
            <div class="dot-col">
              {#if w.enabled && w.lastDeliveryStatus !== 'failure'}
                <PulseDot color="var(--af-success)" size={8} ring={false} />
              {:else if w.lastDeliveryStatus === 'failure'}
                <span class="dot-fail"></span>
              {:else}
                <span class="dot-off"></span>
              {/if}
            </div>
            <div class="webhook-info">
              <div class="webhook-name">{w.name}</div>
              <div class="url-row">
                <span class="webhook-url font-mono">{truncUrl(w.url)}</span>
                <button class="copy-btn font-mono" onclick={() => copyUrl(w.url)}>
                  {copied === w.url ? '✓ copied' : 'copy'}
                </button>
              </div>
              <div class="events-row">
                {#if w.events.length === 0}
                  <span style="font-size:10px;color:var(--af-faint)">no events</span>
                {:else}
                  {#each w.events as evt}
                    <Badge variant="muted" style="font-family:var(--af-font-mono);font-size:9px">{evt}</Badge>
                  {/each}
                {/if}
              </div>
            </div>
            <div class="webhook-actions">
              <div class="status-col">
                <Badge variant={w.lastDeliveryStatus === 'success' ? 'success' : w.lastDeliveryStatus === 'failure' ? 'danger' : 'muted'}>
                  {w.lastDeliveryStatus ?? 'never'}
                </Badge>
                <div class="font-mono" style="font-size:10px;color:var(--af-dim);margin-top:4px">
                  last {fmtRel(w.lastDeliveryAt)}
                </div>
              </div>
              <Btn size="sm" onclick={() => testWebhook(w.id)} disabled={testingId === w.id}>
                {testingId === w.id ? '…' : 'Test'}
              </Btn>
              <button class="toggle-btn" class:toggle-on={w.enabled} onclick={() => toggleEnabled(w)} title={w.enabled ? 'Disable' : 'Enable'}>
                <span class="toggle-track"><span class="toggle-thumb" class:thumb-on={w.enabled}></span></span>
              </button>
              <Btn size="sm" variant="danger" onclick={() => deleteWebhook(w.id)} disabled={deletingId === w.id}>
                {deletingId === w.id ? '…' : 'Delete'}
              </Btn>
            </div>
          </div>
        </Card>
      {/each}
    </div>
  {/if}
</div>

<style>
  .page { display: flex; flex-direction: column; gap: 12px; padding: 20px 24px; max-width: 1200px; }

  .page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 2px; }
  .crumbs { font-size: 10px; color: var(--af-faint); letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 4px; }
  .page-title { margin: 0; font-size: 20px; font-weight: 700; color: var(--af-text); }
  .page-sub { margin: 4px 0 0; font-size: 12px; color: var(--af-dim); }
  .header-actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; padding-top: 4px; }

  .kpi-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }

  .section-title { font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--af-dim); }

  .create-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; align-items: start; }
  .form-field { display: flex; flex-direction: column; gap: 5px; }
  .form-row { flex-direction: row; align-items: center; gap: 10px; }
  .form-label { font-size: 10px; color: var(--af-dim); letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .gen-btn {
    font-size: 10px; color: var(--af-purple);
    background: color-mix(in srgb, var(--af-purple) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--af-purple) 25%, transparent);
    border-radius: 3px; padding: 1px 6px; cursor: pointer; font-weight: 500;
    font-family: inherit; text-transform: none; letter-spacing: 0;
  }
  .form-input {
    height: 32px; background: var(--af-surface); border: 1px solid var(--af-border2);
    border-radius: 5px; padding: 0 10px; font-size: 12px; color: var(--af-text); outline: none; font-family: inherit;
  }
  .form-input:focus { border-color: var(--af-border3); box-shadow: 0 0 0 2px color-mix(in srgb, var(--af-purple) 20%, transparent); }

  .events-grid { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
  .evt-chip {
    padding: 3px 10px; border-radius: 4px; font-size: 10px; cursor: pointer;
    background: var(--af-surface2); border: 1px solid var(--af-border2); color: var(--af-dim);
    font-family: inherit; transition: all 120ms ease;
  }
  .evt-selected {
    background: color-mix(in srgb, var(--af-purple) 15%, transparent);
    border-color: color-mix(in srgb, var(--af-purple) 40%, transparent); color: var(--af-purple);
  }
  .form-error {
    font-size: 11px; color: var(--af-danger); padding: 6px 10px; margin-top: 8px;
    background: color-mix(in srgb, var(--af-danger) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--af-danger) 25%, transparent); border-radius: 5px;
  }

  .toast { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 6px; font-size: 12px; font-weight: 500; }
  .toast-ok { background: color-mix(in srgb, var(--af-success) 12%, transparent); border: 1px solid color-mix(in srgb, var(--af-success) 30%, transparent); color: var(--af-success); }
  .toast-fail { background: color-mix(in srgb, var(--af-danger) 12%, transparent); border: 1px solid color-mix(in srgb, var(--af-danger) 30%, transparent); color: var(--af-danger); }
  .toast-close { margin-left: auto; background: none; border: none; color: inherit; cursor: pointer; font-size: 12px; opacity: 0.7; }

  .webhook-list { display: flex; flex-direction: column; gap: 8px; }
  .webhook-row { display: grid; grid-template-columns: auto 1fr auto; gap: 14px; align-items: center; }
  .dot-col { display: flex; align-items: center; justify-content: center; width: 16px; }
  .dot-fail { width: 8px; height: 8px; border-radius: 50%; background: var(--af-danger); box-shadow: 0 0 5px var(--af-danger); display: block; }
  .dot-off { width: 8px; height: 8px; border-radius: 50%; background: var(--af-faint); display: block; }
  .webhook-info { min-width: 0; }
  .webhook-name { font-size: 13px; font-weight: 600; color: var(--af-text); margin-bottom: 3px; }
  .url-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .webhook-url { font-size: 11px; color: var(--af-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .copy-btn { font-size: 10px; color: var(--af-dim); background: none; border: 1px solid var(--af-border2); border-radius: 3px; padding: 1px 6px; cursor: pointer; flex-shrink: 0; font-family: var(--af-font-mono); transition: color 150ms ease; }
  .copy-btn:hover { color: var(--af-muted); border-color: var(--af-border3); }
  .events-row { display: flex; flex-wrap: wrap; gap: 4px; }
  .webhook-actions { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
  .status-col { text-align: right; }

  .toggle-btn { background: none; border: none; cursor: pointer; padding: 0; display: flex; align-items: center; }
  .toggle-track { display: block; width: 32px; height: 18px; border-radius: 999px; background: var(--af-border3); border: 1px solid var(--af-border2); position: relative; transition: background 200ms ease; }
  .toggle-on .toggle-track { background: var(--af-success); border-color: var(--af-success); }
  .toggle-thumb { display: block; position: absolute; width: 12px; height: 12px; border-radius: 50%; background: var(--af-dim); top: 2px; left: 2px; transition: left 200ms ease, background 200ms ease; }
  .thumb-on { left: 16px; background: #fff; }

  .state-center { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 20px; text-align: center; }
  .spinner { width: 24px; height: 24px; border: 2px solid var(--af-border2); border-top-color: var(--af-purple); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .font-mono { font-family: var(--af-font-mono); font-feature-settings: 'tnum' 1; }

  @media (max-width: 800px) {
    .kpi-row { grid-template-columns: repeat(3, 1fr); }
    .create-grid { grid-template-columns: 1fr; }
    .webhook-row { grid-template-columns: auto 1fr; }
    .webhook-actions { grid-column: span 2; flex-wrap: wrap; }
  }
</style>
