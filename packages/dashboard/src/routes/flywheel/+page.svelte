<script lang="ts">
  import { onMount } from 'svelte';
  import Gauge from '$lib/components/Gauge.svelte';

  interface FlywheelMetric {
    key: string;
    label: string;
    score: number; // 0-100
    description?: string;
  }

  interface FlywheelDebug {
    cycleCount: number;
    meaningfulCycleCount: number;
    completedCycleCount: number;
    sprintCount: number;
    agentCount: number;
    totalItems: number;
    completedItems: number;
  }

  interface CycleEntryPoint {
    cycleId: string;
    count: number;
    startedAt: string;
  }

  interface MemoryStats {
    totalEntries: number;
    entriesPerCycleTrend: CycleEntryPoint[];
    hitRate: number;
  }

  interface FlywheelData {
    metrics: FlywheelMetric[];
    updatedAt?: string;
    overallScore?: number;
    debug?: FlywheelDebug;
    memoryStats?: MemoryStats;
  }

  const DEFAULT_METRICS: FlywheelMetric[] = [
    { key: 'meta_learning', label: 'Meta-Learning', score: 0 },
    { key: 'autonomy', label: 'Autonomy', score: 0 },
    { key: 'inheritance', label: 'Inheritance', score: 0 },
    { key: 'velocity', label: 'Velocity', score: 0 },
  ];

  const METRIC_COLORS: Record<string, string> = {
    meta_learning: '#f5c842',
    autonomy: '#4a9eff',
    inheritance: '#4caf82',
    velocity: '#f5a623',
  };

  let flywheel: FlywheelData = { metrics: DEFAULT_METRICS };
  let loading = true;
  let error: string | null = null;

  async function load() {
    loading = true;
    error = null;
    try {
      const res = await fetch('/api/v5/flywheel');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const raw = json.data ?? json;
      // Normalize: might be array or object with metrics key
      if (Array.isArray(raw)) {
        flywheel = { metrics: raw };
      } else {
        flywheel = {
          metrics: raw.metrics ?? DEFAULT_METRICS,
          updatedAt: raw.updatedAt,
          overallScore: raw.overallScore,
          debug: raw.debug,
        };
      }
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  $: displayMetrics = flywheel.metrics.length > 0 ? flywheel.metrics : DEFAULT_METRICS;
  $: overallScore = flywheel.overallScore ??
    (displayMetrics.length > 0
      ? Math.round(displayMetrics.reduce((s, m) => s + m.score, 0) / displayMetrics.length)
      : 0);

  // Summary stat rows derived from debug payload
  $: statRows = flywheel.debug ? [
    { label: 'Cycles run', value: flywheel.debug.cycleCount },
    { label: 'Completed autonomously', value: flywheel.debug.completedCycleCount },
    { label: 'Sprint iterations', value: flywheel.debug.sprintCount },
    { label: 'Agents on team', value: flywheel.debug.agentCount },
    { label: 'Sprint items', value: `${flywheel.debug.completedItems} / ${flywheel.debug.totalItems}` },
  ] : [];

  // Memory stats card — visible when the server reports at least a memoryStats field
  $: memStats = flywheel.memoryStats;
  $: memHitPct = memStats ? Math.round(memStats.hitRate * 100) : 0;
  $: memTrendMax = memStats
    ? Math.max(1, ...memStats.entriesPerCycleTrend.map(p => p.count))
    : 1;

  onMount(load);
</script>

<svelte:head><title>Flywheel — AgentForge</title></svelte:head>

<div class="page-header">
  <div>
    <h1 class="page-title">Flywheel</h1>
    <p class="page-subtitle">Autonomous loop health — computed from cycles, sprints &amp; agents</p>
  </div>
  {#if !loading && !error}
    <div class="overall-score">
      <div class="overall-value">{overallScore}%</div>
      <div class="overall-label">Overall</div>
    </div>
  {/if}
</div>

{#if loading}
  <div class="gauges-grid">
    {#each Array(4) as _}
      <div class="card metric-card">
        <div class="skeleton" style="height: 110px; width: 100px; margin: 0 auto var(--space-3);"></div>
        <div class="skeleton" style="height: 14px; width: 60%; margin: 0 auto;"></div>
      </div>
    {/each}
  </div>
{:else if error}
  <div class="empty-state">
    Failed to load flywheel data.
    <button class="btn btn-ghost btn-sm" style="margin-top: var(--space-3)" onclick={load}>Retry</button>
  </div>
{:else}
  <div class="gauges-grid">
    {#each displayMetrics as metric (metric.key)}
      <div class="card metric-card">
        <Gauge
          value={Math.round(metric.score)}
          label={metric.label}
          color={METRIC_COLORS[metric.key] ?? 'var(--color-brand)'}
        />
        {#if metric.description}
          <p class="metric-desc">{metric.description}</p>
        {/if}
      </div>
    {/each}
  </div>

  {#if statRows.length > 0}
    <div class="card stats-card">
      <h2 class="stats-title">Loop Data</h2>
      <dl class="stats-grid">
        {#each statRows as row}
          <div class="stat-row">
            <dt class="stat-label">{row.label}</dt>
            <dd class="stat-value">{row.value}</dd>
          </div>
        {/each}
      </dl>
    </div>
  {/if}

  {#if memStats}
    <div class="card memory-card" data-testid="memory-stats-card">
      <h2 class="stats-title">Memory</h2>
      <dl class="stats-grid">
        <div class="stat-row">
          <dt class="stat-label">Total entries</dt>
          <dd class="stat-value">{memStats.totalEntries}</dd>
        </div>
        <div class="stat-row">
          <dt class="stat-label">Hit rate</dt>
          <dd class="stat-value hit-rate" class:hit-rate--active={memHitPct > 0}>
            {memHitPct}%
          </dd>
        </div>
        <div class="stat-row trend-row">
          <dt class="stat-label">Entries per cycle</dt>
          <dd class="trend-bars" aria-label="Entries per cycle trend">
            {#if memStats.entriesPerCycleTrend.length === 0}
              <span class="trend-empty">—</span>
            {:else}
              {#each memStats.entriesPerCycleTrend as point (point.cycleId)}
                <span
                  class="trend-bar"
                  style="height: {Math.round((point.count / memTrendMax) * 40) + 4}px"
                  title="{point.cycleId.slice(0, 8)}: {point.count} {point.count === 1 ? 'entry' : 'entries'}"
                ></span>
              {/each}
            {/if}
          </dd>
        </div>
      </dl>
    </div>
  {/if}

  {#if flywheel.updatedAt}
    <p class="updated-at">Last updated: {new Date(flywheel.updatedAt).toLocaleString()}</p>
  {/if}
{/if}

<style>
  .gauges-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: var(--space-5);
    margin-bottom: var(--space-6);
  }
  .metric-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-6) var(--space-5);
  }
  .metric-desc {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-align: center;
    margin: 0;
    line-height: 1.5;
  }
  .overall-score {
    text-align: center;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-3) var(--space-5);
  }
  .overall-value {
    font-family: var(--font-mono);
    font-size: var(--text-2xl);
    font-weight: 700;
    color: var(--color-brand);
  }
  .overall-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.07em;
  }
  .updated-at {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    margin-top: var(--space-2);
  }
  /* ── Loop Data stats panel ────────────────────────────────────────────── */
  .stats-card {
    margin-bottom: var(--space-4);
    padding: var(--space-5) var(--space-6);
  }
  .stats-title {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.07em;
    margin: 0 0 var(--space-4);
  }
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: var(--space-3) var(--space-5);
    margin: 0;
  }
  .stat-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .stat-label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }
  .stat-value {
    font-family: var(--font-mono);
    font-size: var(--text-lg);
    font-weight: 700;
    color: var(--color-text);
    margin: 0;
  }

  /* ── Memory stats card ────────────────────────────────────────────────── */
  .memory-card {
    margin-bottom: var(--space-4);
    padding: var(--space-5) var(--space-6);
  }
  .hit-rate--active {
    color: var(--color-success, #4caf82);
  }
  .trend-row {
    grid-column: 1 / -1;
  }
  .trend-bars {
    display: flex;
    align-items: flex-end;
    gap: 3px;
    height: 48px;
    margin: 0;
    padding-top: var(--space-1);
  }
  .trend-bar {
    width: 10px;
    min-height: 4px;
    background: var(--color-brand, #4a9eff);
    border-radius: 2px 2px 0 0;
    opacity: 0.75;
    transition: opacity 0.15s;
  }
  .trend-bar:hover {
    opacity: 1;
  }
  .trend-empty {
    font-size: var(--text-sm);
    color: var(--color-text-faint);
    line-height: 48px;
  }
</style>
