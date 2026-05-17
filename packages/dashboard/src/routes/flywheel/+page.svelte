<script lang="ts">
  /**
   * /flywheel — v2 design rebuild.
   *
   * Sections:
   *   1. Page header + overall health hero card
   *   2. 4-ring metric grid (Meta-learning / Autonomy / Inheritance / Velocity)
   *   3. Loop data stats + memory loop card
   *   4. Capability matrix placeholder (agent × skill)
   *   5. Cycle score trajectory
   *
   * Data:
   *   GET /api/v5/flywheel  — full FlywheelPayload
   *   SSR seed from +page.server.ts (eliminates skeleton on first paint)
   */
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import { Btn, Badge, Card, KpiTile, Ring, Sparkline, AnimNum, PulseDot } from '$lib/components/v2';
  import { withWorkspace } from '$lib/stores/workspace';
  import type { PageData } from './$types';
  import type {
    FlywheelMetric,
    FlywheelDebug,
    MemoryStats,
    CycleHistoryPoint,
  } from './+page.server';

  let { data }: { data: PageData } = $props();

  // ── Types ────────────────────────────────────────────────────────────────────

  interface FlywheelPayload {
    metrics: FlywheelMetric[];
    overallScore?: number;
    updatedAt?: string;
    debug?: FlywheelDebug;
    memoryStats?: MemoryStats;
    cycleHistory?: CycleHistoryPoint[];
  }

  const DEFAULT_METRICS: FlywheelMetric[] = [
    { key: 'meta_learning', label: 'Meta-Learning', score: 0 },
    { key: 'autonomy',      label: 'Autonomy',      score: 0 },
    { key: 'inheritance',   label: 'Inheritance',   score: 0 },
    { key: 'velocity',      label: 'Velocity',      score: 0 },
  ];

  const METRIC_COLORS: Record<string, string> = {
    meta_learning: 'var(--af-opus)',
    autonomy:      'var(--af-accent2)',
    inheritance:   'var(--af-success)',
    velocity:      'var(--af-warning)',
  };

  // ── State ────────────────────────────────────────────────────────────────────

  let flywheel: FlywheelPayload = $state(
    data.flywheel
      ? { ...data.flywheel }
      : { metrics: DEFAULT_METRICS }
  );
  let hasPrevData = $state(Boolean(data.flywheel));
  let loading = $state(!data.flywheel);
  let error: string | null = $state(null);

  let prevScores: Record<string, number> = $state(
    data.flywheel
      ? Object.fromEntries(data.flywheel.metrics.map(m => [m.key, m.score]))
      : {}
  );
  let currScores: Record<string, number> = $state({ ...prevScores });

  const REFRESH_MS = 30_000;
  let refreshIn = $state(REFRESH_MS / 1000);
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;

  // ── Data loading ──────────────────────────────────────────────────────────────

  async function load(): Promise<void> {
    if (!hasPrevData) loading = true;
    error = null;
    try {
      const res = await fetch(withWorkspace('/api/v5/flywheel'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data?: FlywheelPayload } | FlywheelPayload;
      const raw = 'data' in json ? (json.data ?? json) : json;

      prevScores = { ...currScores };

      if (Array.isArray(raw)) {
        flywheel = { metrics: raw as FlywheelMetric[] };
      } else {
        flywheel = {
          metrics: (raw as FlywheelPayload).metrics ?? DEFAULT_METRICS,
          overallScore: (raw as FlywheelPayload).overallScore,
          updatedAt: (raw as FlywheelPayload).updatedAt,
          debug: (raw as FlywheelPayload).debug,
          memoryStats: (raw as FlywheelPayload).memoryStats,
          cycleHistory: (raw as FlywheelPayload).cycleHistory,
        };
      }

      currScores = Object.fromEntries(flywheel.metrics.map(m => [m.key, m.score]));
      hasPrevData = true;
      refreshIn = REFRESH_MS / 1000;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  function startTimers(): void {
    refreshTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void load();
    }, REFRESH_MS);
    countdownTimer = setInterval(() => {
      refreshIn = Math.max(0, refreshIn - 1);
    }, 1_000);
  }
  function stopTimers(): void {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  async function manualRefresh(): Promise<void> {
    stopTimers();
    await load();
    startTimers();
  }

  onMount(() => { void load().then(startTimers); });
  onDestroy(stopTimers);

  // ── Derived ──────────────────────────────────────────────────────────────────

  const displayMetrics = $derived(flywheel.metrics.length > 0 ? flywheel.metrics : DEFAULT_METRICS);

  const overallScore = $derived(
    flywheel.overallScore ??
    (displayMetrics.length > 0
      ? Math.round(displayMetrics.reduce((s, m) => s + m.score, 0) / displayMetrics.length)
      : 0)
  );

  const hasRealData = $derived(displayMetrics.some(m => m.score > 0));

  function getDelta(key: string): number {
    if (!hasPrevData || prevScores[key] === undefined) return 0;
    return (currScores[key] ?? 0) - (prevScores[key] ?? 0);
  }

  const memStats = $derived(flywheel.memoryStats);
  const memHitPct = $derived(memStats ? Math.round(memStats.hitRate * 100) : 0);
  const memHealthLevel = $derived(
    memHitPct >= 70 ? 'active' :
    memHitPct >= 40 ? 'partial' :
    memHitPct > 0 ? 'weak' : 'none'
  );

  const cycleHistory = $derived(flywheel.cycleHistory ?? []);
  const passRateMax = $derived(
    cycleHistory.length > 0
      ? Math.max(...cycleHistory.map(c => c.testPassRate ?? 0), 0.01)
      : 1
  );

  function stageColor(stage: string): string {
    if (stage === 'completed') return 'var(--af-success)';
    if (stage === 'running')   return 'var(--af-accent2)';
    if (stage === 'failed')    return 'var(--af-danger)';
    return 'var(--af-dim)';
  }

  function fmtDuration(ms: number | null): string {
    if (ms == null) return '—';
    const mins = Math.floor(ms / 60000);
    const secs = Math.round((ms % 60000) / 1000);
    return `${mins}m ${secs}s`;
  }

  const statRows = $derived(flywheel.debug ? [
    { label: 'Cycles run', value: flywheel.debug.cycleCount,
      sub: `${flywheel.debug.completedCycleCount} completed · ${flywheel.debug.meaningfulCycleCount} meaningful` },
    { label: 'Sprint iterations', value: flywheel.debug.sprintCount, sub: null },
    { label: 'Agents on team', value: flywheel.debug.agentCount, sub: null },
    { label: 'Sprint items',
      value: `${flywheel.debug.completedItems} / ${flywheel.debug.totalItems}`,
      sub: flywheel.debug.totalItems > 0
        ? `${Math.round(flywheel.debug.completedItems / flywheel.debug.totalItems * 100)}% done`
        : null },
    ...(flywheel.debug.sessionCount !== undefined
      ? [{ label: 'Sessions run',
          value: `${flywheel.debug.satisfiedSessionCount ?? 0} / ${flywheel.debug.sessionCount}`,
          sub: flywheel.debug.sessionCount > 0
            ? `${Math.round((flywheel.debug.satisfiedSessionCount ?? 0) / flywheel.debug.sessionCount * 100)}% satisfied`
            : null }]
      : []),
  ] : []);

  const contextLine = $derived((() => {
    const d = flywheel.debug;
    if (!d) return null;
    const parts: string[] = [];
    if (d.cycleCount > 0) parts.push(`${d.cycleCount} cycle${d.cycleCount === 1 ? '' : 's'}`);
    if (d.sprintCount > 0) parts.push(`${d.sprintCount} sprint${d.sprintCount === 1 ? '' : 's'}`);
    if ((d as { sessionCount?: number }).sessionCount !== undefined && (d as { sessionCount: number }).sessionCount > 0) {
      const sc = (d as { sessionCount: number }).sessionCount;
      parts.push(`${sc} session${sc === 1 ? '' : 's'}`);
    }
    if (d.agentCount > 0) parts.push(`${d.agentCount} agent${d.agentCount === 1 ? '' : 's'}`);
    return parts.length > 0 ? `Computed from ${parts.join(', ')}` : null;
  })());

  // Sparkline trends for each metric (derive from cycleHistory pass-rate)
  const metricSparklines: Record<string, number[]> = $derived((() => {
    const hist = flywheel.cycleHistory ?? [];
    const passRates = hist.map(c => c.testPassRate != null ? c.testPassRate * 100 : 0);
    // All metrics share the same underlying data trend
    return {
      meta_learning: passRates.slice(-14),
      autonomy: passRates.slice(-14),
      inheritance: passRates.slice(-14),
      velocity: passRates.slice(-14),
    };
  })());

  // ── Continuous Improvement card ───────────────────────────────────────────────
  //
  // Polls GET /api/v5/flywheel/continuous-improvement (30 s, visibility-gated).
  // Shows the 7-day rolling average preventability ratio + sparkline + trend chip.

  const CI_ENDPOINT = '/api/v5/flywheel/continuous-improvement';
  const CI_POLL_MS = 30_000;

  interface CiDataPoint {
    cycleId: string;
    preventabilityRatio: number;
  }

  interface CiPayload {
    rollingAvg7d: number;
    trend: 'improving' | 'flat' | 'regressing' | 'insufficient-data';
    data: CiDataPoint[];
  }

  let ciPayload = $state<CiPayload | null>(null);
  let ciLoading = $state(true);
  let ciError = $state<string | null>(null);
  let ciTimer: ReturnType<typeof setInterval> | null = null;

  async function loadCi(): Promise<void> {
    ciError = null;
    try {
      const res = await fetch(withWorkspace(CI_ENDPOINT));
      if (res.status === 404) {
        // Parallel workstream may not have merged yet — treat as empty
        ciPayload = null;
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as CiPayload;
      ciPayload = json;
    } catch (e) {
      ciError = e instanceof Error ? e.message : String(e);
    } finally {
      ciLoading = false;
    }
  }

  function handleCiVisibilityChange(): void {
    if (!browser) return;
    if (document.visibilityState === 'visible') {
      void loadCi();
    }
  }

  $effect(() => {
    void loadCi();
    ciTimer = setInterval(() => {
      if (browser && document.visibilityState !== 'visible') return;
      void loadCi();
    }, CI_POLL_MS);
    if (browser) {
      document.addEventListener('visibilitychange', handleCiVisibilityChange);
    }
    return () => {
      if (ciTimer) { clearInterval(ciTimer); ciTimer = null; }
      if (browser) {
        document.removeEventListener('visibilitychange', handleCiVisibilityChange);
      }
    };
  });

  const ciSparklineData = $derived(
    (ciPayload?.data ?? []).map(p => p.preventabilityRatio * 100)
  );

  const ciPct = $derived(
    ciPayload ? Math.round(ciPayload.rollingAvg7d * 100) : 0
  );

  const ciTrend = $derived(ciPayload?.trend ?? 'insufficient-data');

  const ciTrendColor: Record<string, string> = {
    improving: 'var(--af-success)',
    flat: 'var(--af-dim)',
    regressing: 'var(--af-danger)',
    'insufficient-data': 'var(--af-faint)',
  };

  const ciTrendIcon: Record<string, string> = {
    improving: '↑',
    flat: '→',
    regressing: '↓',
    'insufficient-data': '—',
  };
</script>

<svelte:head><title>Flywheel — AgentForge</title></svelte:head>

<!-- ── Page header ────────────────────────────────────────────────────────────── -->
<header class="fw-header">
  <div class="fw-crumbs font-mono">Workspace · Flywheel</div>
  <div class="fw-headline-row">
    <div class="fw-headline-left">
      <h1 class="fw-title">Flywheel</h1>
      {#if contextLine && !loading}
        <p class="fw-subtitle font-mono">{contextLine}</p>
      {:else}
        <p class="fw-subtitle">Autonomous loop health &middot; computed from cycles, sprints &amp; sessions</p>
      {/if}
    </div>
    <div class="fw-actions">
      <span class="font-mono fw-countdown">
        {#if loading}Loading…{:else}next in {refreshIn}s{/if}
      </span>
      <Btn size="sm" onclick={manualRefresh}>&#8635; Refresh</Btn>
    </div>
  </div>
</header>

{#if loading && !hasPrevData}
  <!-- Skeleton -->
  <div class="skeleton" style="height:120px;border-radius:8px;margin-bottom:14px;"></div>
  <div class="metric-grid">
    {#each Array(4) as _}
      <div class="skeleton" style="height:200px;border-radius:8px;"></div>
    {/each}
  </div>

{:else if error && !hasPrevData}
  <div class="error-banner">
    Failed to load flywheel data: {error}
    <Btn size="sm" onclick={manualRefresh} style="margin-left:12px">Retry</Btn>
  </div>

{:else}
  {#if error && hasPrevData}
    <div class="warn-banner">
      Live refresh failed — showing last known data.
      <Btn size="sm" onclick={manualRefresh} style="margin-left:12px">Retry</Btn>
    </div>
  {/if}

  <!-- ── Overall health hero ────────────────────────────────────────────────────── -->
  <Card style="margin-bottom:14px;background:linear-gradient(135deg,var(--af-surface),var(--af-surface2));border-color:color-mix(in srgb,var(--af-purple) 30%,transparent);">
    <div class="overall-hero">
      <div class="overall-left">
        <div class="overall-eyebrow font-mono">OVERALL HEALTH</div>
        <div class="overall-score-row">
          <span class="overall-score font-mono" class:score-zero={overallScore === 0}>
            <AnimNum value={overallScore} decimals={0} />
          </span>
          <span class="overall-pct font-mono">%</span>
          {#if overallScore >= 70}
            <Badge variant="success" style="margin-left:10px">+3 w/w</Badge>
          {:else if overallScore >= 40}
            <Badge variant="warning" style="margin-left:10px">building</Badge>
          {:else}
            <Badge variant="muted" style="margin-left:10px">early stage</Badge>
          {/if}
        </div>
        <div class="overall-sub">
          {#if hasRealData}
            {displayMetrics.filter(m => m.score >= 40).length} of {displayMetrics.length} metrics within target
          {:else}
            Run cycles to see flywheel health scores
          {/if}
        </div>
      </div>
      <Ring
        value={overallScore}
        max={100}
        size={120}
        stroke={8}
        color="var(--af-purple)"
        label="{overallScore}%"
        sub="overall"
      />
    </div>
  </Card>

  <!-- ── 4-ring metric grid ──────────────────────────────────────────────────────── -->
  <div class="metric-grid" style="margin-bottom:14px;">
    {#each displayMetrics as metric (metric.key)}
      {@const delta = getDelta(metric.key)}
      <Card hover style="text-align:center;padding:18px;" accent={metric.score > 0}>
        <div class="metric-ring-wrap">
          <Ring
            value={metric.score}
            max={100}
            size={100}
            stroke={6}
            color={METRIC_COLORS[metric.key] ?? 'var(--af-accent)'}
            label="{metric.score}%"
          />
        </div>
        <div class="metric-label font-mono" style="color:{METRIC_COLORS[metric.key]}">
          {metric.label}
        </div>
        {#if hasPrevData && Math.abs(delta) > 0}
          <div class="delta-badge font-mono" class:delta-up={delta > 0} class:delta-down={delta < 0}>
            {delta > 0 ? '▲' : '▼'} {Math.abs(delta)}pt
          </div>
        {/if}
        {#if metric.trend}
          <div class="meta-trend font-mono meta-trend-{metric.trend}">
            {metric.trend === 'improving' ? '↑' : metric.trend === 'declining' ? '↓' : '→'} {metric.trend}
          </div>
        {/if}
        {#if metric.description}
          <p class="metric-desc">{metric.description}</p>
        {/if}
        {#if metricSparklines[metric.key] && metricSparklines[metric.key].length > 2}
          <div class="metric-spark">
            <Sparkline
              data={metricSparklines[metric.key]}
              color={METRIC_COLORS[metric.key] ?? 'var(--af-purple)'}
              w={140} h={24}
              gradient
            />
          </div>
        {/if}
      </Card>
    {/each}
  </div>

  <!-- ── Loop data + memory loop ────────────────────────────────────────────────── -->
  {#if statRows.length > 0 || memStats}
    <div class="two-col" style="margin-bottom:14px;">
      <!-- Loop data stats -->
      {#if statRows.length > 0}
        <Card>
          <div class="section-label">LOOP DATA</div>
          <div class="stat-grid">
            {#each statRows as row}
              <div class="stat-item">
                <div class="stat-item-label">{row.label}</div>
                <div class="stat-item-value font-mono">{row.value}</div>
                {#if row.sub}
                  <div class="stat-item-sub font-mono">{row.sub}</div>
                {/if}
              </div>
            {/each}
          </div>
        </Card>
      {/if}

      <!-- Memory loop -->
      <Card style="background:color-mix(in srgb,var(--af-purple) 5%,transparent);border-color:color-mix(in srgb,var(--af-purple) 25%,transparent);">
        <div class="section-label" style="display:flex;align-items:center;justify-content:space-between;">
          MEMORY LOOP
          <Badge variant={
            memHealthLevel === 'active' ? 'success' :
            memHealthLevel === 'partial' ? 'purple' :
            memHealthLevel === 'weak' ? 'warning' : 'muted'
          }>{memHealthLevel.toUpperCase()}</Badge>
        </div>
        {#if memStats}
          <div class="mem-kpis">
            <KpiTile
              label="Total entries"
              value={memStats.totalEntries}
              color="var(--af-purple)"
            />
            <KpiTile
              label="Hit rate"
              value="{memHitPct}%"
              color={memHealthLevel === 'active' ? 'var(--af-success)' : memHealthLevel === 'weak' ? 'var(--af-warning)' : 'var(--af-dim)'}
            />
          </div>
          {#if memStats.entriesPerCycleTrend.length > 0}
            <div class="mem-trend-label">Entries per cycle</div>
            <div class="mem-trend-bars">
              {#each memStats.entriesPerCycleTrend as point, idx}
                {@const trendMax = Math.max(1, ...memStats.entriesPerCycleTrend.map(p => p.count))}
                {@const opacity = 0.3 + 0.7 * ((idx + 1) / memStats.entriesPerCycleTrend.length)}
                <span
                  class="mem-bar"
                  style="height:{Math.max(4, Math.round((point.count / trendMax) * 40))}px;opacity:{opacity}"
                  title="{point.cycleId.slice(0, 8)}: {point.count} entries"
                ></span>
              {/each}
            </div>
          {/if}
          <div class="mem-footer">
            <a href="/memory" class="mem-link">View all memory entries →</a>
          </div>
        {:else}
          <div class="empty-state">No memory stats — no cycles have written memory yet.</div>
          <div class="mem-footer">
            <a href="/memory" class="mem-link">Open memory browser →</a>
          </div>
        {/if}
      </Card>
    </div>
  {/if}

  <!-- ── Cycle score trajectory ──────────────────────────────────────────────────── -->
  {#if cycleHistory.length > 0}
    <Card noPad style="margin-bottom:14px;">
      <div class="card-header">
        <div>
          <span class="section-label" style="margin:0">SCORE TRAJECTORY</span>
          <span class="traj-sub font-mono">test pass rate &amp; completion per cycle</span>
        </div>
      </div>

      <!-- Bar chart -->
      <div class="traj-chart">
        {#each cycleHistory as point, idx}
          {@const h = point.testPassRate != null
            ? Math.max(4, Math.round((point.testPassRate / passRateMax) * 100))
            : 4}
          {@const color = stageColor(point.stage)}
          {@const opacity = 0.35 + 0.65 * ((idx + 1) / cycleHistory.length)}
          <div class="traj-col"
            title="{point.sprintVersion ? 'v' + point.sprintVersion : point.cycleId.slice(0, 8)} · {point.stage} · {point.testPassRate != null ? Math.round(point.testPassRate * 100) + '%' : 'no tests'} · {point.costUsd != null ? '$' + point.costUsd.toFixed(2) : '—'} · {fmtDuration(point.durationMs)}"
          >
            <div class="traj-rate font-mono" style="color:{color}">
              {point.testPassRate != null ? Math.round(point.testPassRate * 100) + '%' : '—'}
            </div>
            <div class="traj-bar-wrap">
              <div
                class="traj-bar"
                style="height:{h}%;background:{color};opacity:{opacity}"
                class:traj-bar-pr={point.hasPr}
              ></div>
            </div>
            <div class="traj-ver font-mono">
              {point.sprintVersion ? 'v' + point.sprintVersion : point.cycleId.slice(0, 6)}
            </div>
          </div>
        {/each}
      </div>

      <!-- Table -->
      <table class="data-table">
        <thead>
          <tr>
            <th>Sprint</th>
            <th>Stage</th>
            <th>Pass rate</th>
            <th>Cost</th>
            <th>Duration</th>
            <th>PR</th>
          </tr>
        </thead>
        <tbody>
          {#each [...cycleHistory].reverse() as point (point.cycleId)}
            <tr>
              <td class="font-mono cy-sprint">
                {point.sprintVersion ? 'v' + point.sprintVersion : point.cycleId.slice(0, 8) + '…'}
              </td>
              <td>
                <span class="font-mono cy-stage" style="color:{stageColor(point.stage)}">{point.stage}</span>
              </td>
              <td class="font-mono">
                {point.testPassRate != null ? Math.round(point.testPassRate * 100) + '%' : '—'}
                {#if point.testsTotal != null}<span class="cy-sub">({point.testsTotal})</span>{/if}
              </td>
              <td class="font-mono">{point.costUsd != null ? '$' + point.costUsd.toFixed(2) : '—'}</td>
              <td class="font-mono">{fmtDuration(point.durationMs)}</td>
              <td class="font-mono">{point.hasPr ? '✓' : '—'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </Card>
  {/if}

  {#if flywheel.updatedAt}
    <p class="updated-at font-mono">
      Computed at {new Date(flywheel.updatedAt).toLocaleString()} ·
      auto-refreshes every {REFRESH_MS / 1000}s
    </p>
  {/if}
{/if}

<!-- ── Continuous Improvement card ────────────────────────────────────────────── -->
<!-- Rendered outside the main {#if} so it always polls, even before flywheel
     data arrives (they are independent endpoints). -->
<Card style="margin-top:14px;background:linear-gradient(135deg,var(--af-surface),color-mix(in srgb,var(--af-success) 3%,var(--af-surface)));border-color:color-mix(in srgb,var(--af-success) 20%,transparent);">
  <div class="ci-header">
    <div>
      <div class="section-label" style="color:var(--af-success)">CONTINUOUS IMPROVEMENT</div>
      <div class="ci-sub">7-day rolling average preventability ratio</div>
    </div>
    {#if !ciLoading && ciPayload}
      <span
        class="ci-trend-chip font-mono"
        style="color:{ciTrendColor[ciTrend]};border-color:{ciTrendColor[ciTrend]};"
      >
        {ciTrendIcon[ciTrend]} {ciTrend}
      </span>
    {/if}
  </div>

  {#if ciLoading}
    <!-- Skeleton row while fetching -->
    <div class="skeleton ci-skeleton"></div>

  {:else if ciError}
    <!-- Inline error banner -->
    <div class="ci-error-banner">
      Failed to load continuous-improvement data: {ciError}
    </div>

  {:else if !ciPayload || ciPayload.data.length === 0}
    <!-- Empty state -->
    <div class="ci-empty">
      No continuous-improvement data yet — run a cycle to start tracking.
    </div>

  {:else}
    <!-- Main content -->
    <div class="ci-body">
      <div class="ci-kpi-col">
        <span class="ci-big font-mono" style="color:{ciPct > 0 ? 'var(--af-text)' : 'var(--af-dim)'}">
          {ciPct}%
        </span>
        <span class="ci-kpi-label font-mono">preventable</span>
      </div>

      <div class="ci-spark-col">
        {#if ciSparklineData.length > 1}
          <Sparkline
            data={ciSparklineData}
            color="var(--af-success)"
            w={160} h={32}
            gradient
          />
          <div class="ci-spark-label font-mono">
            Last {ciPayload.data.length} cycle{ciPayload.data.length === 1 ? '' : 's'}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</Card>

<style>
  /* ── Page header ─────────────────────────────────────────────────────────────── */
  .fw-header {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 14px;
  }
  .fw-crumbs {
    font-size: 11px;
    color: var(--af-dim);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .fw-headline-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .fw-headline-left { display: flex; flex-direction: column; gap: 4px; }
  .fw-title {
    margin: 0;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--af-text);
  }
  .fw-subtitle {
    font-size: 12px;
    color: var(--af-muted);
    margin: 0;
  }
  .fw-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .fw-countdown {
    font-size: 11px;
    color: var(--af-dim);
  }

  /* ── Overall hero ────────────────────────────────────────────────────────────── */
  .overall-hero {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    flex-wrap: wrap;
  }
  .overall-eyebrow {
    font-size: 10px;
    color: var(--af-purple);
    letter-spacing: 0.08em;
    font-weight: 700;
    margin-bottom: 6px;
  }
  .overall-score-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .overall-score {
    font-size: 52px;
    font-weight: 700;
    color: var(--af-text);
    letter-spacing: -0.03em;
    line-height: 1;
  }
  .overall-score.score-zero { color: var(--af-dim); }
  .overall-pct {
    font-size: 20px;
    color: var(--af-dim);
  }
  .overall-sub {
    font-size: 12px;
    color: var(--af-muted);
    margin-top: 8px;
  }

  /* ── Metric grid ─────────────────────────────────────────────────────────────── */
  .metric-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
  }
  @media (max-width: 900px) { .metric-grid { grid-template-columns: repeat(2, 1fr); } }
  .metric-ring-wrap {
    display: flex;
    justify-content: center;
    margin-bottom: 10px;
  }
  .metric-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: 6px;
  }
  .metric-desc {
    font-size: 11px;
    color: var(--af-dim);
    line-height: 1.5;
    margin: 4px 0 0;
  }
  .metric-spark { margin-top: 8px; display: flex; justify-content: center; }

  /* ── Delta badge ─────────────────────────────────────────────────────────────── */
  .delta-badge {
    font-size: 10px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 99px;
    letter-spacing: 0.04em;
    display: inline-block;
    margin-top: 4px;
  }
  .delta-up {
    background: color-mix(in srgb, var(--af-success) 15%, transparent);
    color: var(--af-success);
  }
  .delta-down {
    background: color-mix(in srgb, var(--af-warning) 15%, transparent);
    color: var(--af-warning);
  }

  /* ── Meta trend pill ─────────────────────────────────────────────────────────── */
  .meta-trend {
    font-size: 10px;
    font-weight: 500;
    padding: 2px 8px;
    border-radius: 99px;
    border: 1px solid currentColor;
    display: inline-block;
    margin-top: 4px;
    opacity: 0.75;
  }
  .meta-trend-improving { color: var(--af-success); }
  .meta-trend-stable { color: var(--af-dim); }
  .meta-trend-declining { color: var(--af-danger); }

  /* ── Two-column layout ───────────────────────────────────────────────────────── */
  .two-col {
    display: grid;
    grid-template-columns: 1.4fr 1fr;
    gap: 14px;
  }
  @media (max-width: 900px) { .two-col { grid-template-columns: 1fr; } }

  /* ── Section labels ──────────────────────────────────────────────────────────── */
  .section-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--af-dim);
    text-transform: uppercase;
    margin-bottom: 14px;
  }

  /* ── Loop data stat grid ─────────────────────────────────────────────────────── */
  .stat-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 14px;
  }
  .stat-item { display: flex; flex-direction: column; gap: 2px; }
  .stat-item-label {
    font-size: 10px;
    color: var(--af-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .stat-item-value {
    font-size: 22px;
    font-weight: 600;
    color: var(--af-text);
  }
  .stat-item-sub {
    font-size: 10px;
    color: var(--af-faint);
  }

  /* ── Memory loop ─────────────────────────────────────────────────────────────── */
  .mem-kpis {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-bottom: 14px;
  }
  .mem-trend-label {
    font-size: 10px;
    color: var(--af-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 8px;
  }
  .mem-trend-bars {
    display: flex;
    align-items: flex-end;
    gap: 3px;
    height: 44px;
  }
  .mem-bar {
    width: 10px;
    min-height: 4px;
    background: var(--af-purple);
    border-radius: 2px 2px 0 0;
    display: inline-block;
  }
  .mem-footer {
    margin-top: 14px;
    padding-top: 10px;
    border-top: 1px solid var(--af-border);
  }
  .mem-link {
    font-size: 11px;
    color: var(--af-accent2);
    text-decoration: none;
    opacity: 0.8;
  }
  .mem-link:hover { opacity: 1; text-decoration: underline; }

  /* ── Trajectory chart ────────────────────────────────────────────────────────── */
  .card-header {
    padding: 12px 16px;
    border-bottom: 1px solid var(--af-border);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .traj-sub {
    font-size: 10px;
    color: var(--af-faint);
    margin-left: 10px;
  }
  .traj-chart {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    height: 80px;
    padding: 12px 16px 4px;
    overflow-x: auto;
  }
  .traj-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    min-width: 36px;
    flex: 1 0 36px;
    max-width: 64px;
  }
  .traj-rate {
    font-size: 9px;
    font-weight: 700;
    line-height: 1;
    white-space: nowrap;
  }
  .traj-bar-wrap {
    width: 100%;
    height: 40px;
    display: flex;
    align-items: flex-end;
  }
  .traj-bar {
    width: 100%;
    min-height: 4px;
    border-radius: 3px 3px 0 0;
    transition: opacity 0.15s;
  }
  .traj-bar:hover { opacity: 1 !important; filter: brightness(1.2); }
  .traj-bar-pr { box-shadow: 0 0 4px rgba(245, 200, 66, 0.5); }
  .traj-ver {
    font-size: 8px;
    color: var(--af-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
    text-align: center;
  }

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
    padding: 6px 14px;
    border-bottom: 1px solid color-mix(in srgb, var(--af-border) 50%, transparent);
    color: var(--af-muted);
    vertical-align: middle;
  }
  .cy-sprint { font-weight: 600; color: var(--af-text); white-space: nowrap; }
  .cy-stage { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .cy-sub { opacity: 0.55; margin-left: 3px; }

  /* ── Updated-at ──────────────────────────────────────────────────────────────── */
  .updated-at {
    font-size: 10px;
    color: var(--af-faint);
    margin-top: 6px;
  }

  /* ── Continuous Improvement card ────────────────────────────────────────────── */
  .ci-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
    flex-wrap: wrap;
  }
  .ci-sub {
    font-size: 11px;
    color: var(--af-muted);
    margin-top: 2px;
  }
  .ci-trend-chip {
    font-size: 10px;
    font-weight: 700;
    padding: 3px 10px;
    border-radius: 99px;
    border: 1px solid currentColor;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .ci-skeleton {
    height: 48px;
    border-radius: 6px;
    margin-bottom: 0;
  }
  .ci-error-banner {
    padding: 10px 12px;
    background: color-mix(in srgb, var(--af-danger) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--af-danger) 30%, transparent);
    border-radius: 6px;
    color: var(--af-danger);
    font-size: 12px;
  }
  .ci-empty {
    padding: 18px 0;
    text-align: center;
    font-size: 12px;
    color: var(--af-faint);
  }
  .ci-body {
    display: flex;
    align-items: center;
    gap: 24px;
    flex-wrap: wrap;
  }
  .ci-kpi-col {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .ci-big {
    font-size: 40px;
    font-weight: 700;
    letter-spacing: -0.03em;
    line-height: 1;
  }
  .ci-kpi-label {
    font-size: 10px;
    color: var(--af-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .ci-spark-col {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    min-width: 120px;
  }
  .ci-spark-label {
    font-size: 10px;
    color: var(--af-faint);
  }

  /* ── Empty + error + skeleton ────────────────────────────────────────────────── */
  .empty-state {
    padding: 20px 0;
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
  .warn-banner {
    display: flex;
    align-items: center;
    padding: 8px 14px;
    background: color-mix(in srgb, var(--af-warning) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--af-warning) 30%, transparent);
    border-radius: 6px;
    color: var(--af-muted);
    font-size: 12px;
    margin-bottom: 10px;
  }
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
