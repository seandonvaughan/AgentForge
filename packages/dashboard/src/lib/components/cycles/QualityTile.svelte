<script lang="ts">
  /**
   * QualityTile.svelte
   *
   * Overview tile for a single cycle's quality data.
   * - Ring showing mean quality score for this cycle (0–100)
   * - Best / worst agent dispatch rows (with item link if available)
   * - LLM-graded sample rate
   *
   * Data source: GET /api/v5/quality/step-scores?cycle_id=<cycleId>
   * Degrades gracefully when the endpoint doesn't exist yet.
   *
   * Props:
   *   cycleId — string
   *   class   — optional extra CSS class
   */

  import Ring from '$lib/components/v2/Ring.svelte';

  interface StepScore {
    agentId: string;
    itemId?: string;
    qualityScore: number;
    llmGraded: boolean;
  }

  interface StepScoresResponse {
    cycleId: string;
    scores: StepScore[];
  }

  interface Props {
    cycleId: string;
    class?: string;
  }

  let { cycleId, class: className = '' }: Props = $props();

  let loading = $state(true);
  let fetchError = $state(false);
  let data = $state<StepScoresResponse | null>(null);

  $effect(() => {
    const id = cycleId;
    loading = true;
    fetchError = false;
    data = null;

    fetch(`/api/v5/quality/step-scores?cycle_id=${encodeURIComponent(id)}`)
      .then(async res => {
        if (!res.ok) {
          // 404 expected when T7 endpoints not merged yet
          fetchError = true;
          return;
        }
        data = (await res.json()) as StepScoresResponse;
      })
      .catch(() => { fetchError = true; })
      .finally(() => { loading = false; });
  });

  // ── Derived metrics ──────────────────────────────────────────────────────────

  const scores = $derived(data?.scores ?? []);

  const meanQuality = $derived.by<number>(() => {
    if (scores.length === 0) return 0;
    return scores.reduce((s, r) => s + r.qualityScore, 0) / scores.length;
  });

  const llmGradedCount = $derived(scores.filter(s => s.llmGraded).length);

  const sampleRate = $derived(
    scores.length > 0 ? (llmGradedCount / scores.length) * 100 : 0,
  );

  // Best: highest score agent
  const bestEntry = $derived.by<StepScore | null>(() => {
    if (scores.length === 0) return null;
    return scores.reduce((best, s) => s.qualityScore > best.qualityScore ? s : best, scores[0]);
  });

  // Worst: lowest score agent
  const worstEntry = $derived.by<StepScore | null>(() => {
    if (scores.length === 0) return null;
    return scores.reduce((worst, s) => s.qualityScore < worst.qualityScore ? s : worst, scores[0]);
  });

  function fmtScore(v: number): string {
    return v.toFixed(1);
  }

  const ringColor = $derived.by<string>(() => {
    if (meanQuality >= 80) return 'var(--af-success)';
    if (meanQuality >= 60) return 'var(--af-warning)';
    return 'var(--af-danger, #e05353)';
  });
</script>

<div class={['quality-tile', className].filter(Boolean).join(' ')}>
  <div class="tile-header">
    <span class="tile-title">QUALITY</span>
    <span class="tile-tag af2-mono">this cycle</span>
  </div>

  {#if loading}
    <div class="tile-loading">
      <div class="ph-ring"></div>
      <div class="ph-rows">
        <div class="ph-row"></div>
        <div class="ph-row short"></div>
      </div>
    </div>

  {:else if fetchError || scores.length === 0}
    <div class="tile-empty">
      {#if fetchError}
        <span class="muted">Quality data not available yet.</span>
      {:else}
        <span class="muted">No quality scores recorded for this cycle.</span>
      {/if}
    </div>

  {:else}
    <div class="tile-body">
      <!-- Ring + mean -->
      <div class="ring-col">
        <Ring
          value={meanQuality}
          max={100}
          size={72}
          stroke={5}
          color={ringColor}
          label={fmtScore(meanQuality)}
          sub="/ 100"
        />
        <span class="ring-caption muted">Mean quality</span>
      </div>

      <!-- Stats -->
      <div class="stats-col">
        {#if bestEntry !== null}
          <div class="stat-row">
            <span class="stat-label muted">Best</span>
            <span class="agent-chip pos">
              {bestEntry.agentId}
              {#if bestEntry.itemId}
                <a
                  href="/cycles/{cycleId}?item={encodeURIComponent(bestEntry.itemId)}"
                  class="item-link af2-mono"
                  aria-label="View item {bestEntry.itemId}"
                >↗</a>
              {/if}
            </span>
            <span class="score-val af2-mono pos">{fmtScore(bestEntry.qualityScore)}</span>
          </div>
        {/if}

        {#if worstEntry !== null && worstEntry !== bestEntry}
          <div class="stat-row">
            <span class="stat-label muted">Worst</span>
            <span class="agent-chip neg">
              {worstEntry.agentId}
              {#if worstEntry.itemId}
                <a
                  href="/cycles/{cycleId}?item={encodeURIComponent(worstEntry.itemId)}"
                  class="item-link af2-mono"
                  aria-label="View item {worstEntry.itemId}"
                >↗</a>
              {/if}
            </span>
            <span class="score-val af2-mono neg">{fmtScore(worstEntry.qualityScore)}</span>
          </div>
        {/if}

        <div class="stat-row stat-row-bottom">
          <span class="stat-label muted">LLM-graded</span>
          <span class="af2-mono" style="font-size:12px">{sampleRate.toFixed(0)}%</span>
          <span class="muted" style="font-size:10px">({llmGradedCount}/{scores.length})</span>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .quality-tile {
    font-size: 13px;
  }

  .tile-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  .tile-title {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: var(--af-text-muted, #888);
    text-transform: uppercase;
  }

  .tile-tag {
    font-size: 10px;
    color: var(--af-text-muted, #888);
  }

  /* Loading skeleton */
  .tile-loading {
    display: flex;
    gap: 16px;
    align-items: center;
  }

  .ph-ring {
    width: 72px;
    height: 72px;
    border-radius: 50%;
    background: var(--af-border, #333);
    flex-shrink: 0;
    animation: pulse 1.4s ease-in-out infinite;
  }

  .ph-rows {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .ph-row {
    height: 10px;
    border-radius: 4px;
    background: var(--af-border, #333);
    animation: pulse 1.4s ease-in-out infinite;
  }

  .ph-row.short {
    width: 60%;
  }

  @keyframes pulse {
    0%, 100% { opacity: 0.4; }
    50%       { opacity: 0.8; }
  }

  /* Empty */
  .tile-empty {
    padding: 6px 0;
    font-size: 12px;
  }

  .muted { color: var(--af-text-muted, #888); }

  /* Body */
  .tile-body {
    display: flex;
    gap: 16px;
    align-items: flex-start;
  }

  .ring-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .ring-caption {
    font-size: 10px;
    white-space: nowrap;
  }

  .stats-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  .stat-row {
    display: grid;
    grid-template-columns: 44px 1fr auto;
    align-items: center;
    gap: 6px;
    font-size: 11px;
  }

  .stat-row-bottom {
    margin-top: 4px;
    padding-top: 4px;
    border-top: 1px solid var(--af-border, #333);
  }

  .stat-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    flex-shrink: 0;
  }

  .agent-chip {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-size: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 3px;
  }

  .agent-chip.pos { color: var(--af-success); }
  .agent-chip.neg { color: var(--af-danger, #e05353); }

  .score-val {
    font-size: 12px;
    font-weight: 600;
    flex-shrink: 0;
  }

  .score-val.pos { color: var(--af-success); }
  .score-val.neg { color: var(--af-danger, #e05353); }

  .item-link {
    color: inherit;
    text-decoration: none;
    opacity: 0.7;
    transition: opacity 150ms ease;
  }

  .item-link:hover {
    opacity: 1;
  }

  .af2-mono {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1;
  }
</style>
