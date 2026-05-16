<script lang="ts">
  import { onMount } from 'svelte';
  import { Card, Btn, Badge } from '$lib/components/v2';

  interface ApiKey {
    id: string;
    label: string;
    scopes: string[];
    createdAt: string;
    lastUsedAt: string | null;
    revoked: boolean;
    revokedAt: string | null;
  }

  interface ApiKeyCreated {
    key: ApiKey;
    rawKey: string;
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let keys: ApiKey[] = $state([]);
  let loading = $state(true);
  let loadError: string | null = $state(null);

  // New key form
  let showForm = $state(false);
  let newLabel = $state('');
  let newScopes = $state<string[]>([]);
  let formErrors: Partial<Record<'label', string>> = $state({});
  let creating = $state(false);
  let createError: string | null = $state(null);

  // Created key modal
  let createdKey: string | null = $state(null);
  let copied = $state(false);

  const SCOPE_OPTIONS = ['read', 'write', 'admin', 'agents:read', 'agents:write', 'cycles:read', 'cycles:write'];

  // ── Helpers ────────────────────────────────────────────────────────────────
  function fmtRel(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ── Load ───────────────────────────────────────────────────────────────────
  async function load() {
    loading = true;
    loadError = null;
    try {
      const res = await fetch('/api/v5/keys');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data: ApiKey[] };
      keys = json.data.filter(k => !k.revoked);
    } catch (e) {
      loadError = e instanceof Error ? e.message : 'Failed to load API keys';
    } finally {
      loading = false;
    }
  }

  // ── Validate ───────────────────────────────────────────────────────────────
  function validate(): boolean {
    const next: typeof formErrors = {};
    if (!newLabel.trim()) next.label = 'Label is required';
    formErrors = next;
    return Object.keys(next).length === 0;
  }

  // ── Create ─────────────────────────────────────────────────────────────────
  async function createKey() {
    if (!validate()) return;
    creating = true;
    createError = null;
    try {
      const res = await fetch('/api/v5/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: newLabel.trim(), scopes: newScopes }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as { data: ApiKeyCreated };
      createdKey = json.data.rawKey;
      // Reset form
      showForm = false;
      newLabel = '';
      newScopes = [];
      await load();
    } catch (e) {
      createError = e instanceof Error ? e.message : 'Create failed';
    } finally {
      creating = false;
    }
  }

  // ── Revoke ─────────────────────────────────────────────────────────────────
  async function revoke(id: string) {
    try {
      const res = await fetch(`/api/v5/keys/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (_) { /* noop */ }
  }

  // ── Copy raw key ───────────────────────────────────────────────────────────
  async function copyKey() {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey);
      copied = true;
      setTimeout(() => { copied = false; }, 2000);
    } catch (_) { /* noop */ }
  }

  function toggleScope(scope: string) {
    if (newScopes.includes(scope)) {
      newScopes = newScopes.filter(s => s !== scope);
    } else {
      newScopes = [...newScopes, scope];
    }
  }

  onMount(() => { void load(); });
</script>

<!-- Raw key modal — shown once on creation -->
{#if createdKey}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={() => { createdKey = null; }}>
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="modal" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="New API key">
      <div class="modal-hdr">
        <p class="modal-title">API key created</p>
        <Badge variant="warning">Copy now — shown only once</Badge>
      </div>
      <p class="modal-sub">This key will not be displayed again. Store it securely.</p>
      <div class="key-box">
        <code class="key-text font-mono">{createdKey}</code>
      </div>
      <div class="modal-actions">
        <Btn variant="purple" onclick={copyKey}>{copied ? 'Copied!' : 'Copy to clipboard'}</Btn>
        <Btn onclick={() => { createdKey = null; }}>Done</Btn>
      </div>
    </div>
  </div>
{/if}

<Card style="max-width:720px" noPad>
  <div class="card-hdr">
    <p class="section-title" style="margin:0">API KEYS</p>
    <Btn variant="purple" size="sm" onclick={() => { showForm = !showForm; }}>
      {showForm ? 'Cancel' : '+ New API key'}
    </Btn>
  </div>

  {#if showForm}
    <form onsubmit={(e) => { e.preventDefault(); void createKey(); }} class="new-key-form">
      <div class="field">
        <label for="key-label" class="field-label">Label</label>
        <input id="key-label" class="field-input" class:input-err={formErrors.label}
          type="text" bind:value={newLabel} placeholder="My API key" />
        {#if formErrors.label}<p class="field-err">{formErrors.label}</p>{/if}
      </div>
      <div class="field">
        <p class="field-label">Scopes</p>
        <div class="scope-chips">
          {#each SCOPE_OPTIONS as scope}
            <button type="button" class="chip" class:active={newScopes.includes(scope)}
              onclick={() => toggleScope(scope)}>{scope}</button>
          {/each}
        </div>
        <p class="field-hint">Leave empty for full access.</p>
      </div>
      {#if createError}<p class="field-err">{createError}</p>{/if}
      <div class="form-actions">
        <Btn variant="purple" type="submit" size="sm" disabled={creating}>
          {creating ? 'Creating…' : 'Create key'}
        </Btn>
      </div>
    </form>
  {/if}

  {#if loading}
    <div class="empty-row">
      <p class="dim-text">Loading…</p>
    </div>
  {:else if loadError}
    <div class="empty-row">
      <p class="err-text">{loadError}</p>
      <Btn size="sm" onclick={() => load()}>Retry</Btn>
    </div>
  {:else if keys.length === 0}
    <div class="empty-row">
      <p class="dim-text">No active API keys. Create one above.</p>
    </div>
  {:else}
    <table class="keys-table">
      <thead>
        <tr>
          {#each ['Label', 'Created', 'Last used', 'Scopes', ''] as h}
            <th>{h}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each keys as key}
          <tr>
            <td class="td-label">{key.label}</td>
            <td class="td-date font-mono">{fmtRel(key.createdAt)}</td>
            <td class="td-date font-mono">{fmtRel(key.lastUsedAt)}</td>
            <td>
              <div class="scopes">
                {#if key.scopes.length === 0}
                  <Badge variant="purple">full access</Badge>
                {:else}
                  {#each key.scopes as s}
                    <Badge variant="muted">{s}</Badge>
                  {/each}
                {/if}
              </div>
            </td>
            <td>
              <Btn variant="danger" size="sm" onclick={() => revoke(key.id)}>Revoke</Btn>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</Card>

<style>
  .section-title {
    font-size: 10px; font-weight: 700; letter-spacing: 0.1em;
    color: var(--af-dim); text-transform: uppercase; margin: 0 0 14px;
  }
  .card-hdr {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 16px; border-bottom: 1px solid var(--af-border);
  }
  .new-key-form {
    padding: 14px 16px; border-bottom: 1px solid var(--af-border);
    display: flex; flex-direction: column; gap: 10px;
    background: var(--af-surface2);
  }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field-label { font-size: 12px; font-weight: 600; color: var(--af-muted); margin: 0; }
  .field-input {
    padding: 6px 10px; background: var(--af-surface2); border: 1px solid var(--af-border2);
    border-radius: 6px; color: var(--af-text); font-size: 12px; outline: none;
    max-width: 320px; transition: border-color 150ms ease;
  }
  .field-input:focus { border-color: var(--af-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--af-accent) 15%, transparent); }
  .field-input.input-err { border-color: var(--af-danger); }
  .field-hint { font-size: 11px; color: var(--af-dim); margin: 0; }
  .field-err  { font-size: 11px; color: var(--af-danger); margin: 0; }
  .scope-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    padding: 3px 9px; border-radius: 4px; font-size: 11px; font-weight: 500;
    border: 1px solid var(--af-border2); background: transparent;
    color: var(--af-muted); cursor: pointer; transition: all 120ms ease;
  }
  .chip.active { background: var(--af-accent); border-color: var(--af-accent); color: #fff; }
  .form-actions { display: flex; justify-content: flex-end; }
  /* Keys table */
  .keys-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .keys-table thead th {
    text-align: left; font-size: 10px; font-weight: 600; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--af-dim);
    padding: 8px 14px; border-bottom: 1px solid var(--af-border);
  }
  .keys-table tbody tr { border-bottom: 1px solid var(--af-border); }
  .keys-table tbody tr:last-child { border-bottom: none; }
  .keys-table td { padding: 10px 14px; vertical-align: middle; }
  .td-label { font-weight: 600; color: var(--af-text); }
  .td-date  { color: var(--af-dim); font-size: 11px; }
  .scopes { display: flex; gap: 4px; flex-wrap: wrap; }
  .empty-row { padding: 24px 16px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 8px; }
  .dim-text { font-size: 12px; color: var(--af-dim); margin: 0; }
  .err-text { color: var(--af-danger); font-size: 12px; margin: 0; }
  /* Raw key modal */
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.7);
    display: flex; align-items: center; justify-content: center; z-index: 9999;
  }
  .modal {
    background: var(--af-surface); border: 1px solid var(--af-border3);
    border-radius: 12px; padding: 24px; width: 560px; max-width: 90vw;
    display: flex; flex-direction: column; gap: 14px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.6);
  }
  .modal-hdr { display: flex; align-items: center; gap: 12px; }
  .modal-title { font-size: 16px; font-weight: 700; color: var(--af-text); margin: 0; }
  .modal-sub  { font-size: 12px; color: var(--af-dim); margin: 0; }
  .key-box {
    background: var(--af-surface2); border: 1px solid var(--af-border2);
    border-radius: 8px; padding: 12px 14px; overflow-x: auto;
  }
  .key-text { font-size: 12px; color: var(--af-success); word-break: break-all; }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
</style>
