<script lang="ts">
  /**
   * /quality — Quality dashboard page.
   *
   * Sections:
   *  1. Cost-vs-Quality scatter (last 30 days, agent_id coloured, pure SVG)
   *  2. Skill ladder (mean quality delta per skill vs control)
   *  3. Rubric drift sparkline (mean quality per cycle, last 14 cycles)
   *
   * Data:
   *   GET /api/v5/quality/aggregates?window=30d → { by_agent, by_skill, by_model }
   *   GET /api/v5/quality/skill-effectiveness?skill_id=all → skill paired data
   *
   * All document.* / window.* gated with `if (browser)`.
   * Degrades to empty-state when T7 endpoints not merged yet.
   */
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { Card } from '$lib/components/v2';
  import CostQualityScatter from '$lib/components/quality/CostQualityScatter.svelte';
  import SkillLadder from '$lib/components/quality/SkillLadder.svelte';

  // ── Types ────────────────────────────────────────────────────────────────────

  interface AgentAggregate {
    agentId: string;
    meanQuality: number;
    totalCostUsd: number;
    sampleCount: number;
  }

  interface SkillAggregate {
    skillId: string;
    meanQuality: number;
    baselineMeanQuality: number;
    sampleCount: number;
  }

  interface AggregatesResponse {
    by_agent?: AgentAggregate[];
    by_skill?: SkillAggregate[];
    by_model?: Array<{ model: string; meanQuality: number }>;
    // cycle-level means for drift sparkline
    by_cycle?: Array<{ cycleId: string; meanQuality: number; startedAt?: string }>;
  }

  // ── State ────────────────────────────────────────────────────────────────────

  let aggregates = $state<AggregatesResponse | null>(null);
  let aggLoading = $state(true);
  let aggError = $state(false);

  // ── Data fetch ───────────────────────────────────────────────────────────────

  onMount(() => {
    if (!browser) return;
    fetchAggregates();
  });

  function fetchAggregates(): void {
    aggLoading = true;
    aggError = false;

    fetch('/api/v5/quality/aggregates?window=30d')
      .then(async res => {
        if (!res.ok) {
          aggError = true;
          return;
        }
        aggregates = (await res.json()) as AggregatesResponse;
      })
      .catch(() => { aggError = true; })
      .finally(() => { aggLoading = false; });
  }

  // ── Derived: scatter points ──────────────────────────────────────────────────

  const scatterPoints = $derived.by(() => {
    const byAgent = aggregates?.by_agent ?? [];
    return byAgent
      .filter(a => a.totalCostUsd > 0)
      .map(a => ({
        agentId: a.agentId,
        costUsd: a.totalCostUsd,
        qualityScore: a.meanQuality,
      }));
  });

  // ── Derived: skill ladder entries ─────────────────────────────────────────────

  const skillLadderEntries = $derived.by(() => {
    const bySkill = aggregates?.by_skill ?? [];
    return bySkill.map(s => ({
      skillId: s.skillId,
      delta: s.meanQuality - s.baselineMeanQuality,
      sampleSize: s.sampleCount,
    }));
  });

  // ── Derived: rubric drift sparkline (last 14 cycles) ────────────────────────

  const driftPoints = $derived.by<number[]>(() => {
    const byCycle = aggregates?.by_cycle ?? [];
    return byCycle.slice(-14).map(c => c.meanQuality);
  });

  const driftCycleIds = $derived.by<string[]>(() => {
    const byCycle = aggregates?.by_cycle ?? [];
    return byCycle.slice(-14).map(c => c.cycleId);
  });

  // Sparkline min/max labels
  const driftMin = $derived(driftPoints.length > 0 ? Math.min(...driftPoints) : 0);
  const driftMax = $derived(driftPoints.length > 0 ? Math.max(...driftPoints) : 0);
  const driftLast = $derived(driftPoints.length > 0 ? driftPoints[driftPoints.length - 1] : null);

  // Build a minimal inline SVG for drift (no component dep)
  const SPARK_W = 320;
  const SPARK_H = 60;

  const driftSvgPath = $derived.by<string>(() => {
    if (driftPoints.length < 2) return '';
    const mn = driftMin;
    const mx = driftMax;
    const range = mx - mn || 1;
    const pts = driftPoints.map((v, i) => {
      const x = (i / (driftPoints.length - 1)) * SPARK_W;
      const y = SPARK_H - ((v - mn) / range) * (SPARK_H - 8) - 4;
      return `${x},${y}`;
    });
    return pts.join(' ');
  });
</script>

<svelte:head>
  <title>Quality — AgentForge</title>
</svelte:head>

<div class="quality-page">
  <!-- Page header -->
  <div class="page-header">
    <div>
      <h1 class="page-title">Quality</h1>
      <p class="page-sub muted">Last 30 days · agent-level · skill effectiveness</p>
    </div>
    <button class="refresh-btn" onclick={fetchAggregates} aria-label="Refresh quality data">
      ↺ Refresh
    </button>
  </div>

  {#if aggLoading}
    <!-- Loading skeleton -->
    <div class="section-grid">
      <Card>
        <div class="ph-header"></div>
        <div class="ph-chart"></div>
      </Card>
      <Card>
        <div class="ph-header"></div>
        <div class="ph-rows"></div>
      </Card>
    </div>

  {:else if aggError && aggregates === null}
    <!-- Full error state (no data at all) -->
    <Card>
      <div class="error-state">
        <span class="error-icon" aria-hidden="true">⚠</span>
        <div>
          <div class="error-title">Quality endpoints not available</div>
          <div class="muted" style="font-size:12px;margin-top:4px">
            Waiting for /api/v5/quality endpoints (T7). Data will appear once merged.
          </div>
        </div>
        <button class="refresh-btn" onclick={fetchAggregates}>Retry</button>
      </div>
    </Card>

  {:else}
    <!-- Section 1: Cost-vs-Quality scatter -->
    <Card>
      <div class="section-header">
        <span class="section-title">COST VS QUALITY</span>
        <span class="section-tag muted af2-mono">last 30 days · by agent</span>
      </div>
      <CostQualityScatter points={scatterPoints} w={520} h={300} />
    </Card>

    <!-- Section 2: Skill ladder -->
    <Card>
      <div class="section-header">
        <span class="section-title">SKILL EFFECTIVENESS</span>
        <span class="section-tag muted af2-mono">quality delta vs baseline</span>
      </div>
      <SkillLadder entries={skillLadderEntries} />
    </Card>

    <!-- Section 3: Rubric drift sparkline -->
    <Card>
      <div class="section-header">
        <span class="section-title">RUBRIC DRIFT</span>
        <span class="section-tag muted af2-mono">mean quality · last {driftPoints.length} cycles</span>
      </div>

      {#if driftPoints.length < 2}
        <div class="muted" style="font-size:12px;padding:12px 0">
          Not enough cycles yet (need at least 2).
        </div>
      {:else}
        <div class="drift-wrap">
          <div class="drift-meta">
            <div class="drift-kpi">
              <span class="drift-kpi-val af2-mono">{driftLast !== null ? driftLast.toFixed(1) : '—'}</span>
              <span class="drift-kpi-label muted">Latest</span>
            </div>
            <div class="drift-kpi">
              <span class="drift-kpi-val af2-mono">{driftMax.toFixed(1)}</span>
              <span class="drift-kpi-label muted">Peak</span>
            </div>
            <div class="drift-kpi">
              <span class="drift-kpi-val af2-mono">{driftMin.toFixed(1)}</span>
              <span class="drift-kpi-label muted">Low</span>
            </div>
          </div>

          <svg
            width={SPARK_W}
            height={SPARK_H}
            viewBox="0 0 {SPARK_W} {SPARK_H}"
            style="display:block;width:100%;max-width:{SPARK_W}px;height:auto"
            aria-label="Rubric drift sparkline"
            role="img"
          >
            <!-- Zero / baseline grid -->
            {#each [25, 50, 75] as tick (tick)}
              {@const mn = driftMin}
              {@const mx = driftMax}
              {@const range = mx - mn || 1}
              {@const sy = SPARK_H - ((tick - mn) / range) * (SPARK_H - 8) - 4}
              {#if tick >= mn && tick <= mx}
                <line
                  x1="0"
                  y1={sy}
                  x2={SPARK_W}
                  y2={sy}
                  stroke="var(--af-border)"
                  stroke-width="0.5"
                  stroke-dasharray="3,3"
                />
              {/if}
            {/each}

            <!-- Area fill -->
            {#if driftSvgPath.length > 0}
              {@const firstX = 0}
              {@const lastX = SPARK_W}
              <path
                d="M{firstX},{SPARK_H} L{driftSvgPath} L{lastX},{SPARK_H} Z"
                fill="var(--af-accent)"
                fill-opacity="0.12"
              />
              <polyline
                points={driftSvgPath}
                fill="none"
                stroke="var(--af-accent)"
                stroke-width="1.6"
                stroke-linejoin="round"
                stroke-linecap="round"
              />
              <!-- Latest dot -->
              {#if driftPoints.length > 0}
                {@const mn = driftMin}
                {@const mx = driftMax}
                {@const range = mx - mn || 1}
                {@const lastY = SPARK_H - ((driftPoints[driftPoints.length - 1] - mn) / range) * (SPARK_H - 8) - 4}
                <circle cx={SPARK_W} cy={lastY} r="3" fill="var(--af-accent)" />
              {/if}
            {/if}
          </svg>

          <!-- Cycle IDs below as tick labels -->
          {#if driftCycleIds.length > 0}
            <div class="drift-labels">
              <span class="drift-label muted af2-mono">{driftCycleIds[0].slice(0, 8)}</span>
              <span class="drift-label muted af2-mono">{driftCycleIds[driftCycleIds.length - 1].slice(0, 8)}</span>
            </div>
          {/if}
        </div>
      {/if}
    </Card>
  {/if}
</div>

<style>
  .quality-page {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 20px 24px;
    max-width: 900px;
  }

  /* Page header */
  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 4px;
  }

  .page-title {
    font-size: 20px;
    font-weight: 700;
    color: var(--af-text);
    margin: 0 0 4px;
  }

  .page-sub {
    font-size: 12px;
  }

  .muted { color: var(--af-text-muted, #888); }

  /* Section header */
  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
  }

  .section-title {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: var(--af-text-muted, #888);
    text-transform: uppercase;
  }

  .section-tag {
    font-size: 10px;
  }

  /* Skeleton */
  .section-grid {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .ph-header {
    height: 12px;
    width: 180px;
    border-radius: 4px;
    background: var(--af-border, #333);
    margin-bottom: 16px;
    animation: pulse 1.4s ease-in-out infinite;
  }

  .ph-chart {
    height: 240px;
    border-radius: 6px;
    background: var(--af-border, #333);
    animation: pulse 1.4s ease-in-out infinite;
  }

  .ph-rows {
    height: 120px;
    border-radius: 6px;
    background: var(--af-border, #333);
    animation: pulse 1.4s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 0.4; }
    50%       { opacity: 0.8; }
  }

  /* Error state */
  .error-state {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 8px 0;
  }

  .error-icon {
    font-size: 20px;
    color: var(--af-warning);
    flex-shrink: 0;
  }

  .error-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--af-text);
  }

  /* Refresh button */
  .refresh-btn {
    padding: 5px 12px;
    font-size: 11px;
    border-radius: 5px;
    border: 1px solid var(--af-border2);
    background: transparent;
    color: var(--af-muted);
    cursor: pointer;
    font-family: inherit;
    transition: all 150ms ease;
    flex-shrink: 0;
  }

  .refresh-btn:hover {
    color: var(--af-text);
    border-color: var(--af-border3);
  }

  /* Drift sparkline */
  .drift-wrap {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .drift-meta {
    display: flex;
    gap: 24px;
  }

  .drift-kpi {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .drift-kpi-val {
    font-size: 18px;
    font-weight: 700;
    color: var(--af-text);
  }

  .drift-kpi-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .drift-labels {
    display: flex;
    justify-content: space-between;
  }

  .drift-label {
    font-size: 9px;
  }

  .af2-mono {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1;
  }
</style>
