<script lang="ts">
  import { onMount } from 'svelte';
  import { Card, Btn, Badge, KpiTile } from '$lib/components/v2';

  // ── State ──────────────────────────────────────────────────────────────────
  let loading = $state(true);
  let loadError: string | null = $state(null);

  // Budget data sourced from /api/v5/settings (the only live billing-adjacent endpoint)
  let budgetLimit = $state(0);
  let budgetUsed = $state(0);

  // ── Load ───────────────────────────────────────────────────────────────────
  async function load() {
    loading = true;
    loadError = null;
    try {
      const [settingsRes, costsRes] = await Promise.all([
        fetch('/api/v5/settings'),
        fetch('/api/v5/costs?window=30d').catch(() => null),
      ]);
      if (!settingsRes.ok) throw new Error(`HTTP ${settingsRes.status}`);
      const settingsJson = (await settingsRes.json()) as { data: Record<string, unknown> };
      const ex = (settingsJson.data?.execution ?? {}) as Record<string, unknown>;
      budgetLimit = Number(ex.budgetLimitPerSprint ?? 0);

      if (costsRes?.ok) {
        const costsJson = (await costsRes.json()) as { data: { totalCost?: number } };
        budgetUsed = Number(costsJson.data?.totalCost ?? 0);
      }
    } catch (e) {
      loadError = e instanceof Error ? e.message : 'Failed to load data';
    } finally {
      loading = false;
    }
  }

  const budgetPct = $derived(budgetLimit > 0 ? Math.min((budgetUsed / budgetLimit) * 100, 100) : 0);

  onMount(() => { void load(); });
</script>

{#if loading}
  <Card>
    <div class="skeleton-stack">
      {#each [1,2,3] as _}<div class="skeleton"></div>{/each}
    </div>
  </Card>
{:else if loadError}
  <Card>
    <p class="err-text">{loadError}</p>
    <Btn onClick={() => load()}>Retry</Btn>
  </Card>
{:else}
  <!-- Plan tier card -->
  <Card style="max-width:720px;margin-bottom:12px">
    <div class="plan-hdr">
      <p class="section-title">PLAN</p>
      <Badge variant="purple">Coming soon</Badge>
    </div>
    <p class="plan-note">
      Billing plan management and Stripe integration are not yet wired up.
      The fields below reflect live data from the settings API where available.
    </p>

    <div class="metrics-row">
      <KpiTile label="Plan" value="—" sub="Not configured" />
      <KpiTile label="Budget limit / sprint" value={`$${budgetLimit.toFixed(2)}`} color="var(--af-text)" />
      <KpiTile
        label="Spend (30 d)"
        value={`$${budgetUsed.toFixed(2)}`}
        color={budgetPct > 80 ? 'var(--af-danger)' : budgetPct > 60 ? 'var(--af-warning)' : 'var(--af-success)'}
      />
    </div>

    <!-- Budget bar -->
    {#if budgetLimit > 0}
      <div class="budget-bar-wrap">
        <div class="budget-bar-track">
          <div class="budget-bar-fill"
            style="width:{budgetPct}%; background:{budgetPct > 80 ? 'var(--af-danger)' : budgetPct > 60 ? 'var(--af-warning)' : 'var(--af-accent)'}">
          </div>
        </div>
        <p class="budget-label font-mono">
          ${budgetUsed.toFixed(2)} / ${budgetLimit.toFixed(2)} ({budgetPct.toFixed(0)}%)
        </p>
      </div>
    {/if}
  </Card>

  <!-- Payment method placeholder -->
  <Card style="max-width:720px;margin-bottom:12px">
    <div class="plan-hdr">
      <p class="section-title">PAYMENT METHOD</p>
      <Badge variant="warning">Coming soon</Badge>
    </div>
    <p class="plan-note">
      Stripe Elements integration is not yet implemented. Payment method management will appear here.
    </p>
    <div class="placeholder-stripe">
      <div class="stripe-mock-card">
        <span class="stripe-icon">💳</span>
        <span class="stripe-label">Card ending in ••••</span>
      </div>
      <Btn disabled>Manage payment method</Btn>
    </div>
  </Card>

  <!-- Invoice history -->
  <Card style="max-width:720px" noPad>
    <div class="card-hdr">
      <p class="section-title" style="margin:0">INVOICE HISTORY</p>
      <Badge variant="warning">Coming soon</Badge>
    </div>
    <div class="empty-row">
      <p class="dim-text">
        Invoice history is not yet available. A billing backend endpoint
        (<code class="font-mono">/api/v5/billing/invoices</code>) must be implemented to populate this table.
      </p>
    </div>
  </Card>
{/if}

<style>
  .section-title {
    font-size: 10px; font-weight: 700; letter-spacing: 0.1em;
    color: var(--af-dim); text-transform: uppercase; margin: 0 0 0;
  }
  .plan-hdr { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .plan-note { font-size: 12px; color: var(--af-dim); margin: 0 0 16px; line-height: 1.5; }
  .metrics-row {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 14px;
  }
  /* Budget bar */
  .budget-bar-wrap { margin-top: 4px; display: flex; flex-direction: column; gap: 6px; }
  .budget-bar-track {
    height: 6px; background: var(--af-border2); border-radius: 3px; overflow: hidden;
  }
  .budget-bar-fill { height: 100%; border-radius: 3px; transition: width 400ms ease; }
  .budget-label { font-size: 11px; color: var(--af-dim); margin: 0; }

  /* Payment placeholder */
  .placeholder-stripe {
    display: flex; align-items: center; gap: 12px;
    padding: 12px; background: var(--af-surface2); border-radius: 8px;
    border: 1px dashed var(--af-border3);
  }
  .stripe-mock-card { display: flex; align-items: center; gap: 8px; flex: 1; }
  .stripe-icon { font-size: 18px; }
  .stripe-label { font-size: 12px; color: var(--af-muted); }

  /* Misc */
  .card-hdr {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 16px; border-bottom: 1px solid var(--af-border);
  }
  .empty-row { padding: 24px 16px; text-align: center; }
  .dim-text { font-size: 12px; color: var(--af-dim); margin: 0; line-height: 1.6; }
  .err-text { color: var(--af-danger); font-size: 12px; margin: 0 0 12px; }
  .skeleton-stack { display: flex; flex-direction: column; gap: 10px; }
  .skeleton {
    height: 60px;
    background: linear-gradient(90deg, var(--af-surface2) 25%, var(--af-border2) 50%, var(--af-surface2) 75%);
    background-size: 200% 100%; border-radius: 6px; animation: shimmer 1.4s infinite;
  }
  @keyframes shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
</style>
