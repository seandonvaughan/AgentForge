<script lang="ts">
  import { onMount } from 'svelte';
  import { Card, Btn, Badge } from '$lib/components/v2';

  type ModelCap = 'opus' | 'sonnet' | 'haiku' | 'none';
  type EffortCap = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  // ── State ──────────────────────────────────────────────────────────────────
  let loading = $state(true);
  let saving = $state(false);
  let saveSuccess = $state(false);
  let loadError: string | null = $state(null);
  let saveError: string | null = $state(null);

  let modelCap: ModelCap = $state('sonnet');
  let effortCap = $state<EffortCap>('medium');
  let fallbackEnabled = $state(true);
  let autoApprove = $state(false);
  let autoApproveThreshold = $state(0.85);
  let maxParallelAgents = $state(5);
  let maxAutoRetries = $state(1);
  let requireApprovalAfter = $state(1);
  let reExecuteOnRetry = $state(true);

  let errors: Partial<Record<'autoApproveThreshold' | 'maxParallelAgents' | 'maxAutoRetries' | 'requireApprovalAfter', string>> = $state({});

  const effortXhighWarning = $derived(effortCap === 'xhigh' || effortCap === 'max');
  const effortMaxWarning = $derived(effortCap === 'max');

  // ── Load ───────────────────────────────────────────────────────────────────
  async function load() {
    loading = true;
    loadError = null;
    try {
      const [settingsRes, autoRes] = await Promise.all([
        fetch('/api/v5/settings'),
        fetch('/api/v5/settings/autonomous'),
      ]);
      if (!settingsRes.ok) throw new Error(`Settings: HTTP ${settingsRes.status}`);
      const settingsJson = (await settingsRes.json()) as { data: Record<string, unknown> };
      const ex = (settingsJson.data?.execution ?? {}) as Record<string, unknown>;
      modelCap = (String(ex.defaultModel ?? 'sonnet') as ModelCap) || 'sonnet';
      fallbackEnabled = ex.fallbackEnabled !== false;
      autoApprove = Boolean(ex.autoApprove ?? false);
      autoApproveThreshold = Number(ex.autoApprovalThreshold ?? 0.85);
      maxParallelAgents = Number(ex.maxConcurrentAgents ?? 5);

      if (autoRes.ok) {
        const autoJson = (await autoRes.json()) as { data: { retry: Record<string, unknown> } };
        const retry = autoJson.data?.retry ?? {};
        maxAutoRetries = Number(retry.maxAutoRetries ?? 1);
        requireApprovalAfter = Number(retry.requireApprovalAfter ?? 1);
        reExecuteOnRetry = retry.reExecuteOnRetry !== false;
      }
    } catch (e) {
      loadError = e instanceof Error ? e.message : 'Failed to load settings';
    } finally {
      loading = false;
    }
  }

  // ── Validate ───────────────────────────────────────────────────────────────
  function validate(): boolean {
    const next: typeof errors = {};
    if (autoApprove && (autoApproveThreshold < 0 || autoApproveThreshold > 1)) {
      next.autoApproveThreshold = 'Threshold must be between 0 and 1';
    }
    if (maxParallelAgents < 1) next.maxParallelAgents = 'Must be ≥ 1';
    if (maxAutoRetries < 0) next.maxAutoRetries = 'Must be ≥ 0';
    if (requireApprovalAfter < 0) next.requireApprovalAfter = 'Must be ≥ 0';
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
      const [settingsRes, autoRes] = await Promise.all([
        fetch('/api/v5/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            execution: {
              defaultModel: modelCap,
              fallbackEnabled,
              autoApprove,
              autoApprovalThreshold: autoApproveThreshold,
              maxConcurrentAgents: maxParallelAgents,
            },
          }),
        }),
        fetch('/api/v5/settings/autonomous', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            retry: {
              maxAutoRetries,
              requireApprovalAfter,
              reExecuteOnRetry,
            },
          }),
        }),
      ]);
      if (!settingsRes.ok) {
        const err = (await settingsRes.json()) as { error?: string };
        throw new Error(err.error ?? `Settings: HTTP ${settingsRes.status}`);
      }
      if (!autoRes.ok) {
        const err = (await autoRes.json()) as { error?: string };
        throw new Error(err.error ?? `Autonomous: HTTP ${autoRes.status}`);
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
    <Btn onClick={() => load()}>Retry</Btn>
  </Card>
{:else}
  <form onsubmit={(e) => { e.preventDefault(); void save(); }}>
    <Card style="max-width:640px">
      <p class="section-title">AUTONOMOUS LOOP</p>
      <div class="field-grid">

        <!-- Codex profile cap -->
        <div class="field">
          <label for="model-cap" class="field-label">Codex profile cap (default)</label>
          <select id="model-cap" class="field-input" bind:value={modelCap}>
            <option value="opus">xhigh profile — Most capable</option>
            <option value="sonnet">high profile — Balanced</option>
            <option value="haiku">medium profile — Fast &amp; efficient</option>
            <option value="none">None — No cap</option>
          </select>
          <p class="field-hint">Upper limit on Codex model profile for autonomous agents; individual tasks may still override.</p>
        </div>

        <!-- Effort cap -->
        <div class="field">
          <label for="effort-cap" class="field-label">Effort cap (default)</label>
          <select id="effort-cap" class="field-input" bind:value={effortCap}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="xhigh">xhigh — xhigh profile only</option>
            <option value="max">Max — xhigh profile only, extended</option>
          </select>
          {#if effortMaxWarning}
            <div class="warn-banner">
              <Badge variant="warning">Warning</Badge>
              <span>Max effort uses extended reasoning on the xhigh profile — costs will be significantly higher.</span>
            </div>
          {:else if effortXhighWarning}
            <div class="warn-banner">
              <Badge variant="warning">xhigh profile only</Badge>
              <span>xhigh effort requires the xhigh profile cap or higher.</span>
            </div>
          {/if}
        </div>

        <!-- Fallback toggle -->
        <div class="field">
          <div class="toggle-row">
            <div>
              <p class="field-label">Fallback enabled</p>
              <p class="field-hint">Fall back to a cheaper capability tier if the primary tier is unavailable.</p>
            </div>
            <button type="button" class="toggle-btn" class:on={fallbackEnabled}
              onclick={() => { fallbackEnabled = !fallbackEnabled; }}
              role="switch" aria-checked={fallbackEnabled}>
              <span class="toggle-thumb"></span>
            </button>
          </div>
        </div>

        <!-- Auto-approve -->
        <div class="field">
          <div class="toggle-row">
            <div>
              <p class="field-label">Auto-approve gate verdicts</p>
              <p class="field-hint">Automatically approve when confidence exceeds threshold.</p>
            </div>
            <button type="button" class="toggle-btn" class:on={autoApprove}
              onclick={() => { autoApprove = !autoApprove; }}
              role="switch" aria-checked={autoApprove}>
              <span class="toggle-thumb"></span>
            </button>
          </div>
          {#if autoApprove}
            <div class="indent-field">
              <label for="aa-threshold" class="field-label">Confidence threshold</label>
              <div class="input-prefix-wrap">
                <input id="aa-threshold" class="field-input font-mono"
                  class:input-err={errors.autoApproveThreshold}
                  type="number" min="0" max="1" step="0.01"
                  bind:value={autoApproveThreshold} />
                <span class="input-suffix">0 – 1</span>
              </div>
              {#if errors.autoApproveThreshold}
                <p class="field-err">{errors.autoApproveThreshold}</p>
              {/if}
            </div>
          {/if}
        </div>

        <!-- Max parallel agents -->
        <div class="field">
          <label for="max-parallel" class="field-label">Max parallel agents</label>
          <input id="max-parallel" class="field-input font-mono"
            class:input-err={errors.maxParallelAgents}
            type="number" min="1" max="50"
            bind:value={maxParallelAgents} />
          {#if errors.maxParallelAgents}
            <p class="field-err">{errors.maxParallelAgents}</p>
          {/if}
        </div>

      </div>
    </Card>

    <!-- Retry config card -->
    <Card style="max-width:640px;margin-top:12px">
      <p class="section-title">AUTONOMOUS RETRY</p>
      <div class="field-grid">

        <div class="field">
          <label for="max-retries" class="field-label">Max auto-retries</label>
          <input id="max-retries" class="field-input font-mono"
            class:input-err={errors.maxAutoRetries}
            type="number" min="0" max="20"
            bind:value={maxAutoRetries} />
          <p class="field-hint">When a gate rejects, retry automatically up to this many times before failing.</p>
          {#if errors.maxAutoRetries}<p class="field-err">{errors.maxAutoRetries}</p>{/if}
        </div>

        <div class="field">
          <label for="approval-after" class="field-label">Require approval after</label>
          <input id="approval-after" class="field-input font-mono"
            class:input-err={errors.requireApprovalAfter}
            type="number" min="0" max="20"
            bind:value={requireApprovalAfter} />
          <p class="field-hint">After this many auto-retries, pause and require human approval to continue.</p>
          {#if errors.requireApprovalAfter}<p class="field-err">{errors.requireApprovalAfter}</p>{/if}
        </div>

        <div class="field">
          <p class="field-label">Re-execute on retry</p>
          <div class="seg-toggle">
            <button type="button" class="seg-btn" class:active={reExecuteOnRetry}
              onclick={() => { reExecuteOnRetry = true; }}>
              Full re-execute
            </button>
            <button type="button" class="seg-btn" class:active={!reExecuteOnRetry}
              onclick={() => { reExecuteOnRetry = false; }}>
              Test + Review only
            </button>
          </div>
          <p class="field-hint">Whether to re-run the execute phase or only re-test and re-review.</p>
        </div>

      </div>

      <div class="save-bar">
        {#if saveError}<span class="save-err">{saveError}</span>{/if}
        {#if saveSuccess}<span class="save-ok">Saved.</span>{/if}
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
  .field-label { font-size: 12px; font-weight: 600; color: var(--af-muted); margin: 0; }
  .field-input {
    padding: 6px 10px;
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    color: var(--af-text);
    font-size: 12px;
    outline: none;
    transition: border-color 150ms ease;
    max-width: 240px;
  }
  .field-input:focus { border-color: var(--af-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--af-accent) 15%, transparent); }
  .field-input.input-err { border-color: var(--af-danger); }
  select.field-input { max-width: 100%; }
  .field-hint { font-size: 11px; color: var(--af-dim); margin: 0; }
  .field-err  { font-size: 11px; color: var(--af-danger); margin: 0; }
  .warn-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    background: color-mix(in srgb, var(--af-warning) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--af-warning) 20%, transparent);
    border-radius: 6px;
    font-size: 11px;
    color: var(--af-warning);
  }
  /* Toggle switch */
  .toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .toggle-btn {
    width: 40px;
    height: 22px;
    border-radius: 11px;
    border: 1px solid var(--af-border3);
    background: var(--af-surface2);
    cursor: pointer;
    position: relative;
    transition: background 200ms ease, border-color 200ms ease;
    flex-shrink: 0;
    padding: 0;
  }
  .toggle-btn.on { background: var(--af-accent); border-color: var(--af-accent); }
  .toggle-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    transition: transform 200ms ease;
  }
  .toggle-btn.on .toggle-thumb { transform: translateX(18px); }
  /* Indent field shown when autoApprove is on */
  .indent-field { margin-left: 0; padding: 10px 12px; background: var(--af-surface2); border-radius: 6px; display: flex; flex-direction: column; gap: 4px; }
  .input-prefix-wrap { position: relative; display: inline-flex; align-items: center; gap: 8px; }
  .input-suffix { font-size: 11px; color: var(--af-dim); }
  /* Segmented toggle */
  .seg-toggle { display: inline-flex; border: 1px solid var(--af-border2); border-radius: 6px; overflow: hidden; }
  .seg-btn {
    padding: 5px 14px;
    font-size: 12px;
    font-weight: 500;
    border: none;
    background: transparent;
    color: var(--af-muted);
    cursor: pointer;
    transition: all 150ms ease;
  }
  .seg-btn:first-child { border-right: 1px solid var(--af-border2); }
  .seg-btn.active { background: var(--af-accent); color: #fff; }
  .seg-btn:not(.active):hover { background: var(--af-surface2); color: var(--af-text); }
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
