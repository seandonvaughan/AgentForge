<script lang="ts">
  /**
   * /cost — v2 design rebuild.
   *
   * Sections:
   *   1. Page header with range selector
   *   2. Hero KPI tiles: last 24h / week / month / YTD spend
   *   3. Spend sparkline over 30 days
   *   4. By-model DistBar + breakdown
   *   5. Per-agent table
   *   6. Budget ring + forecast section
   *   7. Top expensive cycles list
   *
   * Data:
   *   GET /api/v5/costs         — per-agent records
   *   GET /api/v5/costs/summary — summary with byModel + dailyRollups
   *   GET /api/v5/cycles?limit=20 — for top-cycles section
   */
  import { onMount, onDestroy } from 'svelte';
  import {
    Btn, Badge, Card, DistBar, KpiTile, ModelChip, Sparkline, Ring,
  } from '$lib/components/v2';
  import { withWorkspace } from '$lib/stores/workspace';

  // ── Types ────────────────────────────────────────────────────────────────────

  interface CostRecord {
    agentId?: string;
    agent_id?: string;
    model?: string;
    totalCostUsd?: number;
    cost_usd?: number;
    sessionCount?: number;
    session_count?: number;
  }

  interface DailyRollup {
    date: string;
    costUsd: number;
  }

  interface ModelSummary {
    model: string;
    costUsd: number;
    sessions?: number;
  }

  interface CostSummary {
    totalCostUsd?: number;
    byModel?: ModelSummary[];
    dailyRollups?: DailyRollup[];
    /** window-specific buckets the server may return */
    last24hUsd?: number;
    last7dUsd?: number;
    last30dUsd?: number;
    ytdUsd?: number;
  }

  interface CycleRow {
    cycleId?: string;
    cycle_id?: string;
    sprintVersion?: string;
    sprint_version?: string;
    costUsd?: number;
    cost_usd?: number;
    stage?: string;
    startedAt?: string;
    started_at?: string;
  }

  // ── State ────────────────────────────────────────────────────────────────────

  let records: CostRecord[] = $state([]);
  let summary: CostSummary | null = $state(null);
  let cycles: CycleRow[] = $state([]);
  let loading = $state(true);
  let error: string | null = $state(null);
  let range: '24h' | '7d' | '30d' | '90d' = $state('7d');

  // Monthly budget target — hardcoded until a /settings endpoint exists
  const MONTHLY_BUDGET = 100;

  let pollHandle: ReturnType<typeof setInterval> | null = null;

  // ── Data fetching ─────────────────────────────────────────────────────────────

  async function fetchAll(): Promise<void> {
    error = null;
    try {
      const [costRes, sumRes, cycRes] = await Promise.all([
        fetch(withWorkspace('/api/v5/costs')),
        fetch(withWorkspace('/api/v5/costs/summary')),
        fetch(withWorkspace('/api/v5/cycles?limit=20')),
      ]);
      if (costRes.ok) {
        const j = await costRes.json() as { data?: CostRecord[] };
        records = j.data ?? [];
      }
      if (sumRes.ok) {
        const j = await sumRes.json() as { data?: CostSummary };
        summary = j.data ?? null;
      }
      if (cycRes.ok) {
        const j = await cycRes.json() as { cycles?: CycleRow[] };
        cycles = j.cycles ?? [];
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load cost data';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void fetchAll();
    pollHandle = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void fetchAll();
    }, 30_000);
  });
  onDestroy(() => { if (pollHandle) clearInterval(pollHandle); });

  // ── Derived ──────────────────────────────────────────────────────────────────

  function costOf(r: CostRecord): number {
    return r.totalCostUsd ?? r.cost_usd ?? 0;
  }
  function sessionsOf(r: CostRecord): number {
    return r.sessionCount ?? r.session_count ?? 0;
  }
  function agentIdOf(r: CostRecord): string {
    return r.agentId ?? r.agent_id ?? '—';
  }
  function cycleCost(c: CycleRow): number {
    return c.costUsd ?? c.cost_usd ?? 0;
  }
  function cycleId(c: CycleRow): string {
    return c.cycleId ?? c.cycle_id ?? '—';
  }

  const totalUsd = $derived(records.reduce((s, r) => s + costOf(r), 0));

  // Compute window spends from dailyRollups when the server doesn't provide buckets
  const last24hUsd = $derived(summary?.last24hUsd ?? (() => {
    const rollups = summary?.dailyRollups ?? [];
    const today = rollups[rollups.length - 1]?.costUsd ?? 0;
    return today;
  })());

  const last7dUsd = $derived(summary?.last7dUsd ?? (() => {
    const rollups = summary?.dailyRollups ?? [];
    return rollups.slice(-7).reduce((s, d) => s + d.costUsd, 0);
  })());

  const last30dUsd = $derived(summary?.last30dUsd ?? (() => {
    const rollups = summary?.dailyRollups ?? [];
    return rollups.slice(-30).reduce((s, d) => s + d.costUsd, 0);
  })());

  const ytdUsd = $derived(summary?.ytdUsd ?? (() => {
    const rollups = summary?.dailyRollups ?? [];
    const jan1 = new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
    return rollups.filter(d => d.date >= jan1).reduce((s, d) => s + d.costUsd, 0);
  })());

  // 30-day sparkline data
  const sparkData = $derived(() => {
    const rollups = summary?.dailyRollups ?? [];
    return rollups.slice(-30).map(d => d.costUsd);
  });

  // Per-model breakdown
  const byModel = $derived(() => {
    const models = summary?.byModel ?? [];
    const total = models.reduce((s, m) => s + m.costUsd, 0);
    return models
      .map(m => ({ ...m, pct: total > 0 ? (m.costUsd / total) * 100 : 0 }))
      .sort((a, b) => b.costUsd - a.costUsd);
  });

  // Per-agent records sorted by spend desc
  const sortedRecords = $derived([...records].sort((a, b) => costOf(b) - costOf(a)));

  // Top expensive cycles
  const topCycles = $derived(
    [...cycles].sort((a, b) => cycleCost(b) - cycleCost(a)).slice(0, 8)
  );

  // Forecast: last-7d daily average × remaining days in month
  const forecast = $derived(() => {
    const today = new Date();
    const daysLeft = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate() - today.getDate();
    const dailyAvg = last7dUsd / 7;
    const projected = last30dUsd + dailyAvg * daysLeft;
    return { daysLeft, dailyAvg, projected };
  });

  // Budget consumption ring (this month)
  const budgetPct = $derived(Math.min(100, Math.round((last30dUsd / MONTHLY_BUDGET) * 100)));

  function modelColor(model: string): string {
    const m = model.toLowerCase();
    if (m.includes('opus')) return 'var(--af-opus)';
    if (m.includes('sonnet')) return 'var(--af-sonnet)';
    if (m.includes('haiku')) return 'var(--af-haiku)';
    return 'var(--af-dim)';
  }

  function modelTier(model: string): 'opus' | 'sonnet' | 'haiku' {
    const m = model.toLowerCase();
    if (m.includes('opus')) return 'opus';
    if (m.includes('haiku')) return 'haiku';
    return 'sonnet';
  }
</script>

<svelte:head><title>Cost Analytics — AgentForge</title></svelte:head>

<!-- ── Page header ────────────────────────────────────────────────────────────── -->
<header class="cost-header">
  <div class="cost-crumbs font-mono">Workspace · Cost</div>
  <div class="cost-headline-row">
    <div>
      <h1 class="cost-title">Cost analytics</h1>
      <p class="cost-subtitle">Token spend by agent, model, and cycle</p>
    </div>
    <div class="cost-actions">
      <!-- Range selector -->
      <div class="range-strip">
        {#each (['24h', '7d', '30d', '90d'] as const) as r}
          <button
            class="range-btn font-mono"
            class:range-btn-active={range === r}
            onclick={() => { range = r; }}
          >{r}</button>
        {/each}
      </div>
      <Btn size="sm" onclick={fetchAll}>Refresh</Btn>
    </div>
  </div>
</header>

{#if loading}
  <!-- Skeleton -->
  <div class="kpi-grid">
    {#each Array(4) as _}
      <div class="skeleton" style="height:90px;border-radius:8px;"></div>
    {/each}
  </div>
  <div class="skeleton" style="height:200px;border-radius:8px;margin-bottom:14px;"></div>

{:else if error}
  <div class="error-banner">
    {error}
    <Btn size="sm" onclick={fetchAll} style="margin-left:12px">Retry</Btn>
  </div>

{:else}
  <!-- ── KPI tiles ────────────────────────────────────────────────────────────── -->
  <div class="kpi-grid">
    <KpiTile
      label="Last 24h"
      value="${last24hUsd.toFixed(4)}"
      color="var(--af-purple)"
      sparkline={sparkData().slice(-2)}
    />
    <KpiTile
      label="Last 7 days"
      value="${last7dUsd.toFixed(4)}"
      color="var(--af-accent2)"
    />
    <KpiTile
      label="Last 30 days"
      value="${last30dUsd.toFixed(4)}"
      color="var(--af-sonnet)"
    />
    <KpiTile
      label="YTD"
      value="${ytdUsd.toFixed(4)}"
      sub="{records.length} agents with spend"
      color="var(--af-text)"
    />
  </div>

  <!-- ── Spend sparkline + model breakdown ─────────────────────────────────────── -->
  <div class="two-col" style="margin-bottom:14px;">
    <Card>
      <div class="card-section-title">
        SPEND OVER TIME
        <span class="font-mono card-section-meta">{sparkData().length} days</span>
      </div>
      {#if sparkData().length > 1}
        <div class="sparkline-wrap">
          <Sparkline data={sparkData()} color="var(--af-purple)" w={480} h={160} gradient strokeWidth={2} />
          <div class="sparkline-labels font-mono">
            <span>30 days ago</span>
            <span>now</span>
          </div>
        </div>
      {:else}
        <div class="empty-state">No daily rollup data available.</div>
      {/if}
    </Card>

    <Card>
      <div class="card-section-title">BY MODEL TIER</div>
      {#if byModel().length === 0}
        <div class="empty-state">No model data yet.</div>
      {:else}
        <div class="model-list">
          {#each byModel() as m}
            <div class="model-row">
              <div class="model-row-head">
                <div class="model-row-name">
                  <span class="model-swatch" style="background:{modelColor(m.model)}"></span>
                  <span class="font-mono model-label">{m.model}</span>
                </div>
                <div class="model-row-nums">
                  <span class="font-mono">${m.costUsd.toFixed(2)}</span>
                  <span class="font-mono model-pct">{m.pct.toFixed(0)}%</span>
                </div>
              </div>
              <DistBar segments={[
                { value: m.pct, color: modelColor(m.model) },
                { value: 100 - m.pct, color: 'var(--af-border)' },
              ]} h={5} />
              {#if m.sessions}
                <div class="font-mono model-sessions">{m.sessions} sessions</div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </Card>
  </div>

  <!-- ── Per-agent table ────────────────────────────────────────────────────────── -->
  <Card noPad style="margin-bottom:14px;">
    <div class="card-header">
      <span class="card-section-title" style="margin:0">PER-AGENT SPEND</span>
      <span class="font-mono card-section-meta">sorted by total</span>
    </div>
    {#if sortedRecords.length === 0}
      <div class="empty-state">No cost records yet — run some agents to see spend breakdown.</div>
    {:else}
      <table class="data-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Model</th>
            <th>Sessions</th>
            <th>Total spend</th>
            <th>Avg / session</th>
          </tr>
        </thead>
        <tbody>
          {#each sortedRecords as r}
            <tr>
              <td class="font-mono td-sm">{agentIdOf(r)}</td>
              <td>
                {#if r.model}
                  <ModelChip model={modelTier(r.model)} />
                {:else}
                  <span class="font-mono dim">—</span>
                {/if}
              </td>
              <td class="font-mono">{sessionsOf(r)}</td>
              <td class="font-mono">${costOf(r).toFixed(4)}</td>
              <td class="font-mono dim">
                {sessionsOf(r) > 0 ? `$${(costOf(r) / sessionsOf(r)).toFixed(4)}` : '—'}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </Card>

  <!-- ── Budget ring + forecast ─────────────────────────────────────────────────── -->
  <div class="two-col" style="margin-bottom:14px;">
    <Card>
      <div class="card-section-title">MONTHLY BUDGET</div>
      <div class="budget-row">
        <Ring
          value={budgetPct}
          max={100}
          size={96}
          stroke={7}
          color={budgetPct >= 90 ? 'var(--af-danger)' : budgetPct >= 70 ? 'var(--af-warning)' : 'var(--af-success)'}
          label="{budgetPct}%"
          sub="used"
        />
        <div class="budget-meta">
          <div class="budget-stat">
            <div class="budget-stat-label">Spent this month</div>
            <div class="budget-stat-val font-mono">${last30dUsd.toFixed(2)}</div>
          </div>
          <div class="budget-stat">
            <div class="budget-stat-label">Monthly budget</div>
            <div class="budget-stat-val font-mono">${MONTHLY_BUDGET.toFixed(2)}</div>
          </div>
          <div class="budget-stat">
            <div class="budget-stat-label">Remaining</div>
            <div class="budget-stat-val font-mono" class:danger={last30dUsd > MONTHLY_BUDGET}>
              ${Math.max(0, MONTHLY_BUDGET - last30dUsd).toFixed(2)}
            </div>
          </div>
        </div>
      </div>
    </Card>

    <Card>
      <div class="card-section-title">FORECAST</div>
      <div class="forecast-body">
        <div class="forecast-line font-mono">
          At current burn rate of <strong>${forecast().dailyAvg.toFixed(2)}/day</strong>,
          you'll spend approximately
          <strong style="color:var(--af-warning)">${forecast().projected.toFixed(2)}</strong>
          by month end
          ({forecast().daysLeft} days remaining).
        </div>
        {#if forecast().projected > MONTHLY_BUDGET}
          <Badge variant="warning" style="margin-top:10px">Over budget</Badge>
        {:else}
          <Badge variant="success" style="margin-top:10px">Within budget</Badge>
        {/if}
      </div>
    </Card>
  </div>

  <!-- ── Top expensive cycles ──────────────────────────────────────────────────── -->
  <Card noPad>
    <div class="card-header">
      <span class="card-section-title" style="margin:0">TOP EXPENSIVE CYCLES</span>
      <span class="font-mono card-section-meta">by total cost</span>
    </div>
    {#if topCycles.length === 0}
      <div class="empty-state">No cycle data yet.</div>
    {:else}
      <table class="data-table">
        <thead>
          <tr>
            <th>Cycle ID</th>
            <th>Version</th>
            <th>Stage</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {#each topCycles as c}
            <tr>
              <td class="font-mono td-sm">{cycleId(c).slice(0, 12)}</td>
              <td class="font-mono">{c.sprintVersion ?? c.sprint_version ?? '—'}</td>
              <td>
                <Badge variant={
                  c.stage === 'completed' ? 'success' :
                  c.stage === 'failed' ? 'danger' :
                  'muted'
                }>{c.stage ?? '—'}</Badge>
              </td>
              <td class="font-mono">${cycleCost(c).toFixed(4)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </Card>
{/if}

<style>
  /* ── Page header ─────────────────────────────────────────────────────────────── */
  .cost-header {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 14px;
  }
  .cost-crumbs {
    font-size: 11px;
    color: var(--af-dim);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .cost-headline-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .cost-title {
    margin: 0;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--af-text);
  }
  .cost-subtitle {
    font-size: 12px;
    color: var(--af-muted);
    margin: 2px 0 0;
  }
  .cost-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* ── Range selector ──────────────────────────────────────────────────────────── */
  .range-strip {
    display: flex;
    background: var(--af-surface);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    padding: 2px;
    gap: 2px;
  }
  .range-btn {
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    background: transparent;
    border: none;
    color: var(--af-dim);
    transition: background 150ms, color 150ms;
  }
  .range-btn:hover { color: var(--af-text); }
  .range-btn-active {
    background: var(--af-surface2);
    color: var(--af-text);
  }

  /* ── KPI grid ────────────────────────────────────────────────────────────────── */
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    margin-bottom: 14px;
  }
  @media (max-width: 900px) { .kpi-grid { grid-template-columns: repeat(2, 1fr); } }

  /* ── Two-column layout ───────────────────────────────────────────────────────── */
  .two-col {
    display: grid;
    grid-template-columns: 1.4fr 1fr;
    gap: 14px;
  }
  @media (max-width: 900px) { .two-col { grid-template-columns: 1fr; } }

  /* ── Card sub-components ─────────────────────────────────────────────────────── */
  .card-header {
    padding: 12px 16px;
    border-bottom: 1px solid var(--af-border);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .card-section-title {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--af-dim);
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }
  .card-section-meta {
    font-size: 10px;
    color: var(--af-faint);
    font-weight: 400;
    letter-spacing: 0;
  }

  /* ── Sparkline ───────────────────────────────────────────────────────────────── */
  .sparkline-wrap {
    overflow: hidden;
  }
  .sparkline-labels {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: var(--af-faint);
    margin-top: 6px;
  }

  /* ── Model breakdown ─────────────────────────────────────────────────────────── */
  .model-list {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .model-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .model-row-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .model-row-name {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .model-swatch {
    width: 8px;
    height: 8px;
    border-radius: 2px;
    flex-shrink: 0;
  }
  .model-label {
    font-size: 12px;
    color: var(--af-text);
    text-transform: uppercase;
  }
  .model-row-nums {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 11px;
    color: var(--af-text);
  }
  .model-pct {
    font-size: 10px;
    color: var(--af-dim);
    min-width: 32px;
    text-align: right;
  }
  .model-sessions {
    font-size: 10px;
    color: var(--af-dim);
    margin-top: 2px;
  }

  /* ── Budget ──────────────────────────────────────────────────────────────────── */
  .budget-row {
    display: flex;
    align-items: center;
    gap: 20px;
    margin-top: 8px;
  }
  .budget-meta {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .budget-stat-label {
    font-size: 10px;
    color: var(--af-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .budget-stat-val {
    font-size: 18px;
    font-weight: 600;
    color: var(--af-text);
    margin-top: 2px;
  }
  .danger { color: var(--af-danger) !important; }

  /* ── Forecast ────────────────────────────────────────────────────────────────── */
  .forecast-body { margin-top: 8px; }
  .forecast-line {
    font-size: 13px;
    color: var(--af-muted);
    line-height: 1.6;
  }
  .forecast-line strong { color: var(--af-text); }

  /* ── Data table ──────────────────────────────────────────────────────────────── */
  .data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .data-table th {
    text-align: left;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--af-dim);
    padding: 8px 14px;
    border-bottom: 1px solid var(--af-border);
  }
  .data-table td {
    padding: 8px 14px;
    border-bottom: 1px solid var(--af-border);
    color: var(--af-text);
    vertical-align: middle;
  }
  .data-table tbody tr:last-child td { border-bottom: none; }
  .data-table tbody tr:hover { background: var(--af-surface2); }
  .td-sm { font-size: 11px; }
  .dim { color: var(--af-dim); }

  /* ── Empty + error ───────────────────────────────────────────────────────────── */
  .empty-state {
    padding: 24px 16px;
    text-align: center;
    font-size: 12px;
    color: var(--af-faint);
  }
  .error-banner {
    display: flex;
    align-items: center;
    padding: 14px 16px;
    background: color-mix(in srgb, var(--af-danger) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--af-danger) 30%, transparent);
    border-radius: 8px;
    color: var(--af-danger);
    font-size: 13px;
    margin-bottom: 14px;
  }

  /* ── Skeleton ────────────────────────────────────────────────────────────────── */
  .skeleton {
    background: linear-gradient(90deg, var(--af-surface) 0%, var(--af-surface2) 50%, var(--af-surface) 100%);
    background-size: 200% 100%;
    animation: skel 1.4s ease-in-out infinite;
    margin-bottom: 10px;
  }
  @keyframes skel {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
</style>
