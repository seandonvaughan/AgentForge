<script lang="ts">
  import { onMount } from 'svelte';
  import { Badge, Btn, Card, PulseDot } from '$lib/components/v2';
  import { withWorkspace } from '$lib/stores/workspace';

  interface ReadinessData {
    ready: boolean;
    status: 'ready' | 'degraded';
    summary: {
      agentCount: number;
      warningCount: number;
      codexCliAvailable: boolean;
      mcpServerAvailable: boolean;
      codexLoginChecked: boolean;
      codexLoginOk: boolean | null;
    };
    checks: Record<string, { ok: boolean | null; label: string; detail?: string }>;
    warnings: string[];
  }

  let { title = 'CODEX READINESS', compact = false }: { title?: string; compact?: boolean } = $props();

  let readiness: ReadinessData | null = $state(null);
  let loading = $state(true);
  let error: string | null = $state(null);

  async function loadReadiness(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await fetch(withWorkspace('/api/v5/codex/readiness?skipLogin=true'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data?: ReadinessData };
      readiness = json.data ?? null;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load Codex readiness';
    } finally {
      loading = false;
    }
  }

  function checkVariant(ok: boolean | null): 'success' | 'warning' | 'danger' | 'muted' {
    if (ok === true) return 'success';
    if (ok === false) return 'danger';
    return 'muted';
  }

  function readinessColor(value: ReadinessData): string {
    return value.ready ? 'var(--af-success)' : 'var(--af-warning)';
  }

  onMount(() => { void loadReadiness(); });
</script>

<Card>
  <div class="readiness-head">
    <div>
      <p class="section-title">{title}</p>
      {#if readiness}
        <div class="status-row">
          <PulseDot color={readinessColor(readiness)} size={7} ring={readiness.ready} />
          <span class="status-text" style="color:{readinessColor(readiness)}">
            {readiness.ready ? 'Ready' : 'Needs attention'}
          </span>
          <Badge variant={readiness.ready ? 'success' : 'warning'}>
            {readiness.summary.agentCount} agents
          </Badge>
        </div>
      {:else}
        <div class="muted">{loading ? 'Checking Codex runtime...' : 'Codex readiness unavailable'}</div>
      {/if}
    </div>
    <Btn size="sm" onClick={() => void loadReadiness()} disabled={loading}>
      {loading ? 'Checking...' : 'Refresh'}
    </Btn>
  </div>

  {#if error}
    <div class="readiness-error">{error}</div>
  {:else if readiness}
    <div class:compact-grid={compact} class="check-grid">
      {#each Object.entries(readiness.checks) as [key, check] (key)}
        <div class="check-row">
          <span class="check-label">{check.label}</span>
          <Badge variant={checkVariant(check.ok)}>
            {check.ok === null ? 'skipped' : check.ok ? 'ok' : 'fail'}
          </Badge>
        </div>
      {/each}
    </div>

    {#if readiness.warnings.length > 0 && !compact}
      <div class="warning-list">
        {#each readiness.warnings.slice(0, 3) as warning}
          <div class="warning-item">{warning}</div>
        {/each}
      </div>
    {/if}
  {/if}
</Card>

<style>
  .readiness-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }
  .section-title {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--af-dim);
    text-transform: uppercase;
    margin: 0 0 8px;
  }
  .status-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .status-text {
    font-size: 13px;
    font-weight: 700;
  }
  .muted {
    font-size: 12px;
    color: var(--af-muted);
  }
  .check-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  .check-grid.compact-grid {
    grid-template-columns: 1fr;
  }
  .check-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    background: var(--af-surface2);
  }
  .check-label {
    color: var(--af-muted);
    font-size: 12px;
  }
  .warning-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 10px;
  }
  .warning-item,
  .readiness-error {
    padding: 8px 10px;
    border-radius: 6px;
    font-size: 12px;
    line-height: 1.4;
  }
  .warning-item {
    color: var(--af-warning);
    background: color-mix(in srgb, var(--af-warning) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--af-warning) 25%, transparent);
  }
  .readiness-error {
    color: var(--af-danger);
    background: color-mix(in srgb, var(--af-danger) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--af-danger) 25%, transparent);
  }
  @media (max-width: 700px) {
    .check-grid { grid-template-columns: 1fr; }
  }
</style>
