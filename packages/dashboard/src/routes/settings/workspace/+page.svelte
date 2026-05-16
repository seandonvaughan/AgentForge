<script lang="ts">
  import { onMount } from 'svelte';
  import { Card, Btn } from '$lib/components/v2';

  // ── State ──────────────────────────────────────────────────────────────────
  let loading = $state(true);
  let saving = $state(false);
  let saveSuccess = $state(false);
  let loadError: string | null = $state(null);
  let saveError: string | null = $state(null);

  // Form fields
  let name = $state('');
  let dataDir = $state('');
  let defaultBudget = $state(0);
  let defaultMaxItems = $state(0);
  let gitRemote = $state('');

  // Validation errors
  let errors: Partial<Record<'name' | 'defaultBudget' | 'defaultMaxItems', string>> = $state({});

  // ── Load ───────────────────────────────────────────────────────────────────
  async function load() {
    loading = true;
    loadError = null;
    try {
      const res = await fetch('/api/v5/settings');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data: Record<string, unknown> };
      const d = json.data ?? {};
      const ws = (d.workspace ?? {}) as Record<string, unknown>;
      const ex = (d.execution ?? {}) as Record<string, unknown>;
      name = String(ws.name ?? 'AgentForge');
      dataDir = String(ws.dataDir ?? '.agentforge');
      defaultBudget = Number(ex.budgetLimitPerSprint ?? 200);
      defaultMaxItems = Number(ex.maxConcurrentAgents ?? 5);
      gitRemote = String(ws.gitRemote ?? '');
    } catch (e) {
      loadError = e instanceof Error ? e.message : 'Failed to load settings';
    } finally {
      loading = false;
    }
  }

  // ── Validate ───────────────────────────────────────────────────────────────
  function validate(): boolean {
    const next: typeof errors = {};
    if (!name.trim()) next.name = 'Name is required';
    if (defaultBudget < 0) next.defaultBudget = 'Must be ≥ 0';
    if (defaultMaxItems < 1) next.defaultMaxItems = 'Must be ≥ 1';
    errors = next;
    return Object.keys(next).length === 0;
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  async function save() {
    if (!validate()) return;
    saving = true;
    saveError = null;
    saveSuccess = false;
    try {
      const body = {
        workspace: { name: name.trim(), dataDir: dataDir.trim(), gitRemote: gitRemote.trim() },
        execution: { budgetLimitPerSprint: defaultBudget, maxConcurrentAgents: defaultMaxItems },
      };
      const res = await fetch('/api/v5/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      saveSuccess = true;
      setTimeout(() => { saveSuccess = false; }, 3000);
    } catch (e) {
      saveError = e instanceof Error ? e.message : 'Save failed';
    } finally {
      saving = false;
    }
  }

  onMount(() => { void load(); });
</script>

{#if loading}
  <Card>
    <div class="skeleton-stack">
      {#each [1,2,3,4,5] as _}
        <div class="skeleton"></div>
      {/each}
    </div>
  </Card>
{:else if loadError}
  <Card>
    <p class="err-text">{loadError}</p>
    <Btn onclick={() => load()}>Retry</Btn>
  </Card>
{:else}
  <form onsubmit={(e) => { e.preventDefault(); void save(); }}>
    <Card style="max-width:640px">
      <p class="section-title">WORKSPACE</p>
      <div class="field-grid">

        <div class="field">
          <label for="ws-name" class="field-label">Workspace name</label>
          <input id="ws-name" class="field-input" class:input-err={errors.name} type="text"
            bind:value={name} placeholder="AgentForge" />
          {#if errors.name}<p class="field-err">{errors.name}</p>{/if}
        </div>

        <div class="field">
          <label for="ws-data-dir" class="field-label">Data directory</label>
          <input id="ws-data-dir" class="field-input" type="text"
            bind:value={dataDir} placeholder=".agentforge" />
          <p class="field-hint">Directory where AgentForge stores state files.</p>
        </div>

        <div class="field">
          <label for="ws-budget" class="field-label">Default budget (USD / sprint)</label>
          <div class="input-prefix-wrap">
            <span class="input-prefix">$</span>
            <input id="ws-budget" class="field-input prefix-pad font-mono"
              class:input-err={errors.defaultBudget}
              type="number" min="0" step="1"
              bind:value={defaultBudget} />
          </div>
          {#if errors.defaultBudget}<p class="field-err">{errors.defaultBudget}</p>{/if}
        </div>

        <div class="field">
          <label for="ws-max-items" class="field-label">Default max concurrent agents</label>
          <input id="ws-max-items" class="field-input font-mono"
            class:input-err={errors.defaultMaxItems}
            type="number" min="1" max="200"
            bind:value={defaultMaxItems} />
          {#if errors.defaultMaxItems}<p class="field-err">{errors.defaultMaxItems}</p>{/if}
        </div>

        <div class="field">
          <label for="ws-git" class="field-label">Git remote</label>
          <input id="ws-git" class="field-input font-mono" type="text"
            bind:value={gitRemote} placeholder="https://github.com/org/repo" />
          <p class="field-hint">Optional — used for automated branch and PR operations.</p>
        </div>

      </div>

      <div class="save-bar">
        {#if saveError}
          <span class="save-err">{saveError}</span>
        {/if}
        {#if saveSuccess}
          <span class="save-ok">Saved.</span>
        {/if}
        <Btn variant="purple" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Btn>
      </div>
    </Card>
  </form>
{/if}

<style>
  .section-title {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.1em;
    color: var(--af-dim);
    text-transform: uppercase;
    margin: 0 0 14px;
  }
  .field-grid { display: flex; flex-direction: column; gap: 14px; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--af-muted);
  }
  .field-input {
    padding: 6px 10px;
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    color: var(--af-text);
    font-size: 12px;
    outline: none;
    transition: border-color 150ms ease;
  }
  .field-input:focus { border-color: var(--af-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--af-accent) 15%, transparent); }
  .field-input.input-err { border-color: var(--af-danger); }
  .field-hint { font-size: 11px; color: var(--af-dim); margin: 0; }
  .field-err { font-size: 11px; color: var(--af-danger); margin: 0; }
  .input-prefix-wrap { position: relative; display: inline-block; }
  .input-prefix {
    position: absolute;
    left: 10px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 12px;
    color: var(--af-dim);
    pointer-events: none;
  }
  .prefix-pad { padding-left: 20px; }
  .save-bar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 12px;
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px solid var(--af-border);
  }
  .save-err { font-size: 12px; color: var(--af-danger); }
  .save-ok  { font-size: 12px; color: var(--af-success); }
  .skeleton-stack { display: flex; flex-direction: column; gap: 10px; }
  .skeleton {
    height: 36px;
    background: linear-gradient(90deg, var(--af-surface2) 25%, var(--af-border2) 50%, var(--af-surface2) 75%);
    background-size: 200% 100%;
    border-radius: 6px;
    animation: shimmer 1.4s infinite;
  }
  .err-text { color: var(--af-danger); font-size: 12px; margin: 0 0 12px; }
  @keyframes shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
</style>
