<script lang="ts">
  import { Badge, Card, DistBar, ModelChip, PulseDot } from '$lib/components/v2';

  type HeartbeatStaleness = 'healthy' | 'stale' | 'dead' | 'unknown';

  interface Props {
    providerUsage: Record<string, { items: number; costUsd: number }>;
    phaseErrorSummary: Record<string, { failed: number; retried: number }>;
    heartbeatStaleness: HeartbeatStaleness;
  }

  let {
    providerUsage = {},
    phaseErrorSummary = {},
    heartbeatStaleness = 'unknown',
  }: Props = $props();

  interface ProviderRow {
    providerId: string;
    items: number;
    costUsd: number;
  }

  const providerRows = $derived.by<ProviderRow[]>(() =>
    Object.entries(providerUsage)
      .map(([providerId, usage]) => ({
        providerId,
        items: Math.max(0, Number(usage?.items ?? 0)),
        costUsd: Math.max(0, Number(usage?.costUsd ?? 0)),
      }))
      .sort((a, b) => b.costUsd - a.costUsd),
  );

  const totalCostUsd = $derived(
    providerRows.reduce((sum, row) => sum + row.costUsd, 0),
  );

  const health = $derived.by<{
    label: string;
    badgeVariant: 'success' | 'warning' | 'danger' | 'muted';
    dotColor: string;
  }>(() => {
    if (heartbeatStaleness === 'healthy') {
      return { label: 'Healthy', badgeVariant: 'success', dotColor: 'var(--af-success)' };
    }
    if (heartbeatStaleness === 'stale') {
      return { label: 'Stale', badgeVariant: 'warning', dotColor: 'var(--af-warning)' };
    }
    if (heartbeatStaleness === 'dead') {
      return { label: 'Dead', badgeVariant: 'danger', dotColor: 'var(--af-danger)' };
    }
    return { label: 'Unknown', badgeVariant: 'muted', dotColor: 'var(--af-dim)' };
  });

  const distSegments = $derived.by<Array<{ value: number; color: string; label: string }>>(() => {
    const colors = [
      'var(--af-purple)',
      'var(--af-accent2)',
      'var(--af-success)',
      'var(--af-warning)',
      'var(--af-sonnet)',
      'var(--af-haiku)',
    ];
    return providerRows.map((row, i) => ({
      value: row.costUsd,
      color: colors[i % colors.length]!,
      label: `${row.providerId} ${fmtUsd(row.costUsd)}`,
    }));
  });

  const phaseErrorRows = $derived.by<Array<{ phase: string; failed: number; retried: number }>>(() =>
    Object.entries(phaseErrorSummary)
      .map(([phase, summary]) => ({
        phase,
        failed: Math.max(0, Number(summary?.failed ?? 0)),
        retried: Math.max(0, Number(summary?.retried ?? 0)),
      }))
      .filter((row) => row.failed > 0 || row.retried > 0)
      .sort((a, b) => a.phase.localeCompare(b.phase)),
  );

  function fmtUsd(v: number): string {
    return `$${v.toFixed(2)}`;
  }
</script>

<Card>
  <div class="provider-card-head">
    <div class="section-title">PROVIDER &amp; COST</div>
    <div class="provider-health">
      <PulseDot color={health.dotColor} size={7} />
      <Badge variant={health.badgeVariant}>{health.label}</Badge>
    </div>
  </div>

  {#if providerRows.length === 0}
    <div class="provider-empty muted">No provider usage has been recorded for this cycle yet.</div>
  {:else}
    <div class="provider-rows">
      {#each providerRows as row (row.providerId)}
        <div class="provider-row">
          <div class="provider-id-wrap">
            <ModelChip model={row.providerId} size="md" />
            <span class="af2-mono muted">{row.items} items</span>
          </div>
          <span class="af2-mono provider-cost">{fmtUsd(row.costUsd)}</span>
        </div>
      {/each}
    </div>

    <div class="provider-dist">
      <DistBar segments={distSegments} h={8} label="Cost share" />
    </div>

    <div class="provider-total-row">
      <span>Total spend</span>
      <span class="af2-mono provider-total-cost">{fmtUsd(totalCostUsd)}</span>
    </div>
  {/if}

  {#if phaseErrorRows.length > 0}
    <div class="phase-errors">
      <div class="phase-errors-title">Phase errors</div>
      {#each phaseErrorRows as row (row.phase)}
        <div class="phase-error-row">
          <span class="af2-mono phase-name">{row.phase}</span>
          <span class="af2-mono muted">{row.failed} failed · {row.retried} retried</span>
        </div>
      {/each}
    </div>
  {/if}
</Card>

<style>
  .provider-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .provider-health {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .provider-empty {
    margin-top: 10px;
    font-size: 12px;
  }

  .provider-rows {
    margin-top: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .provider-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .provider-id-wrap {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .provider-cost {
    font-weight: 600;
  }

  .provider-dist {
    margin-top: 10px;
  }

  .provider-total-row {
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid var(--af-border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 12px;
  }

  .provider-total-cost {
    color: var(--af-text);
    font-weight: 600;
  }

  .phase-errors {
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid var(--af-border);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .phase-errors-title {
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--af-dim);
  }

  .phase-error-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 12px;
  }

  .phase-name {
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .muted {
    color: var(--af-dim);
  }
</style>
