<script lang="ts">
  import { onMount } from 'svelte';
  import { Btn, Card, Badge } from '$lib/components/v2';
  import CodexReadinessPanel from '$lib/components/CodexReadinessPanel.svelte';

  type CapabilityTier = 'opus' | 'sonnet' | 'haiku';
  type TeamAction = 'preview' | 'forge' | 'rebuild';

  interface TeamStatus {
    teamName: string | null;
    forgedAt: string | null;
    agentCount: number;
    modelCounts: Record<CapabilityTier, number>;
    hasTeamYaml: boolean;
    modifiedAt: string | null;
  }

  const PROFILE_META: Record<CapabilityTier, { label: string; model: string; tone: 'purple' | 'info' | 'muted' }> = {
    opus: { label: 'xhigh', model: 'gpt-5.5', tone: 'purple' },
    sonnet: { label: 'high', model: 'gpt-5.3-codex', tone: 'info' },
    haiku: { label: 'medium', model: 'gpt-5.4-mini', tone: 'muted' },
  };

  let status: TeamStatus | null = $state(null);
  let domains = $state('');
  let verbose = $state(false);
  let autoApply = $state(false);
  let loading = $state(true);
  let running: TeamAction | null = $state(null);
  let loadError: string | null = $state(null);
  let actionError: string | null = $state(null);
  let actionOk: string | null = $state(null);

  const statusLabel = $derived.by(() => status?.hasTeamYaml ? 'Forged' : 'No manifest');
  const statusVariant = $derived.by<'success' | 'warning'>(() => status?.hasTeamYaml ? 'success' : 'warning');

  function fmtDate(iso: string | null | undefined): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  async function loadStatus(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      const res = await fetch('/api/v5/team/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data: TeamStatus };
      status = json.data;
    } catch (e) {
      loadError = e instanceof Error ? e.message : 'Failed to load team status';
    } finally {
      loading = false;
    }
  }

  async function runTeamAction(action: TeamAction): Promise<void> {
    running = action;
    actionError = null;
    actionOk = null;
    const endpoint = action === 'rebuild' ? '/api/v5/team/rebuild' : '/api/v5/team/forge';
    const payload = action === 'rebuild'
      ? { autoApply }
      : { dryRun: action === 'preview', verbose, domains: domains.trim() || undefined };

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => ({}))) as { data?: { exitCode?: number; status?: TeamStatus }; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (json.data?.status) status = json.data.status;
      actionOk = action === 'preview'
        ? 'Preview completed.'
        : action === 'forge'
          ? 'Team forged.'
          : 'Team rebuild completed.';
    } catch (e) {
      actionError = e instanceof Error ? e.message : 'Team action failed';
    } finally {
      running = null;
    }
  }

  onMount(() => { void loadStatus(); });
</script>

<svelte:head><title>Team Forge — AgentForge</title></svelte:head>

{#if loading}
  <Card>
    <div class="skeleton-stack">
      {#each [1, 2, 3] as _}
        <div class="skeleton"></div>
      {/each}
    </div>
  </Card>
{:else if loadError}
  <Card>
    <p class="err-text">{loadError}</p>
    <Btn onClick={() => loadStatus()}>Retry</Btn>
  </Card>
{:else}
  <div class="forge-grid">
    <Card noPad>
      <div class="card-hdr">
        <div>
          <p class="section-title">AGENTFORGE TEAM</p>
          <h2>{status?.teamName ?? 'AgentForge Codex team'}</h2>
        </div>
        <Badge variant={statusVariant}>{statusLabel}</Badge>
      </div>

      <div class="stat-row">
        <div>
          <span class="stat-label">Agents</span>
          <strong>{status?.agentCount ?? 0}</strong>
        </div>
        <div>
          <span class="stat-label">Forged</span>
          <strong>{fmtDate(status?.forgedAt)}</strong>
        </div>
        <div>
          <span class="stat-label">Manifest</span>
          <strong>{fmtDate(status?.modifiedAt)}</strong>
        </div>
      </div>

      <div class="profile-list">
        {#each ['opus', 'sonnet', 'haiku'] as tier}
          {@const meta = PROFILE_META[tier as CapabilityTier]}
          <div class="profile-row">
            <Badge variant={meta.tone}>{meta.label}</Badge>
            <span class="profile-model">{meta.model}</span>
            <span class="profile-count">{status?.modelCounts[tier as CapabilityTier] ?? 0}</span>
          </div>
        {/each}
      </div>
    </Card>

    <Card>
      <p class="section-title">FORGE CONTROLS</p>
      <div class="field-grid">
        <div class="field">
          <label for="domains" class="field-label">Domains</label>
          <input id="domains" class="field-input" bind:value={domains} placeholder="runtime,frontend,quality" />
        </div>

        <div class="toggle-row">
          <div>
            <p class="field-label">Verbose preview</p>
            <p class="field-hint">Include scan detail in preview and forge runs.</p>
          </div>
          <button type="button" class="toggle-btn" class:on={verbose}
            onclick={() => { verbose = !verbose; }}
            aria-label="Verbose preview"
            role="switch" aria-checked={verbose}>
            <span class="toggle-thumb"></span>
          </button>
        </div>

        <div class="toggle-row">
          <div>
            <p class="field-label">Auto-apply rebuild</p>
            <p class="field-hint">Apply rebuild diffs without a separate review step.</p>
          </div>
          <button type="button" class="toggle-btn" class:on={autoApply}
            onclick={() => { autoApply = !autoApply; }}
            aria-label="Auto-apply rebuild"
            role="switch" aria-checked={autoApply}>
            <span class="toggle-thumb"></span>
          </button>
        </div>
      </div>

      <div class="action-row">
        <Btn type="button" onClick={() => runTeamAction('preview')} disabled={running !== null}>
          {running === 'preview' ? 'Previewing...' : 'Preview'}
        </Btn>
        <Btn type="button" variant="purple" onClick={() => runTeamAction('forge')} disabled={running !== null}>
          {running === 'forge' ? 'Forging...' : 'Forge Team'}
        </Btn>
        <Btn type="button" onClick={() => runTeamAction('rebuild')} disabled={running !== null}>
          {running === 'rebuild' ? 'Rebuilding...' : 'Rebuild'}
        </Btn>
      </div>

      {#if actionOk}<p class="save-ok">{actionOk}</p>{/if}
      {#if actionError}<p class="err-text">{actionError}</p>{/if}
    </Card>

    <CodexReadinessPanel compact title="CODEX READINESS" />
  </div>
{/if}

<style>
  .forge-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(320px, 420px);
    gap: 14px;
    align-items: start;
  }
  .card-hdr {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 16px;
    border-bottom: 1px solid var(--af-border);
  }
  h2 {
    margin: 4px 0 0;
    font-size: 18px;
    color: var(--af-text);
  }
  .section-title {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.1em;
    color: var(--af-dim);
    text-transform: uppercase;
    margin: 0 0 12px;
  }
  .stat-row {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1px;
    background: var(--af-border);
  }
  .stat-row > div {
    background: var(--af-surface);
    padding: 14px 16px;
  }
  .stat-label {
    display: block;
    font-size: 10px;
    color: var(--af-dim);
    text-transform: uppercase;
    margin-bottom: 4px;
  }
  .stat-row strong {
    font-size: 14px;
    color: var(--af-text);
  }
  .profile-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px;
  }
  .profile-row {
    display: grid;
    grid-template-columns: 82px 1fr 44px;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    background: var(--af-surface2);
  }
  .profile-model,
  .profile-count {
    font-family: var(--af-font-mono, monospace);
    font-size: 12px;
    color: var(--af-muted);
  }
  .profile-count {
    text-align: right;
    color: var(--af-text);
  }
  .field-grid { display: flex; flex-direction: column; gap: 14px; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field-label { font-size: 12px; font-weight: 600; color: var(--af-muted); margin: 0; }
  .field-hint { font-size: 11px; color: var(--af-dim); margin: 0; }
  .field-input {
    width: 100%;
    padding: 6px 10px;
    background: var(--af-surface2);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    color: var(--af-text);
    font-size: 12px;
    outline: none;
    box-sizing: border-box;
  }
  .field-input:focus { border-color: var(--af-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--af-accent) 15%, transparent); }
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
  .action-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px solid var(--af-border);
  }
  .save-ok,
  .err-text {
    font-size: 12px;
    margin: 12px 0 0;
  }
  .save-ok { color: var(--af-success); }
  .err-text { color: var(--af-danger); }
  .skeleton-stack { display: flex; flex-direction: column; gap: 10px; }
  .skeleton {
    height: 44px;
    background: linear-gradient(90deg, var(--af-surface2) 25%, var(--af-border2) 50%, var(--af-surface2) 75%);
    background-size: 200% 100%;
    border-radius: 6px;
    animation: shimmer 1.4s infinite;
  }
  @keyframes shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
  @media (max-width: 900px) {
    .forge-grid { grid-template-columns: 1fr; }
    .stat-row { grid-template-columns: 1fr; }
  }
</style>
