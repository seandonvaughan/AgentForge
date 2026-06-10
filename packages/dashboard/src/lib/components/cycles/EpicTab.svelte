<script lang="ts">
  /**
   * EpicTab.svelte
   *
   * Wave-grouped decomposition view for epic/objective-mode cycles.
   *
   * Fetches the decomposition artifact via getDecomposition(cycleId), groups the
   * child items into topological waves via groupIntoWaves(), and renders each wave
   * as a labelled card grid.  Live execute-phase outcomes (status + actual cost)
   * are joined from the itemResults prop passed down by the detail page.
   *
   * Props:
   *   cycleId     — cycle ID used to fetch /api/v5/cycles/:id/decomposition
   *   itemResults — live results keyed by item ID: { status, costUsd? }
   *   class       — optional extra CSS class on the root element
   *
   * 404 / non-epic cycles: renders a "no decomposition" notice — no error thrown.
   * All EventSource / document.* access is guarded with the `browser` import.
   */

  import { browser } from '$app/environment';
  import { getDecomposition, type Decomposition, type DecompositionChild } from '$lib/api/epic.js';
  import { groupIntoWaves } from '$lib/util/epic-waves.js';

  // ── Public shape for itemResults entries ─────────────────────────────────────

  export interface ItemResult {
    status: string;
    costUsd?: number;
  }

  // ── Props ─────────────────────────────────────────────────────────────────────

  interface Props {
    cycleId: string;
    itemResults?: Record<string, ItemResult>;
    class?: string;
  }

  let { cycleId, itemResults = {}, class: className = '' }: Props = $props();

  // ── State ─────────────────────────────────────────────────────────────────────

  let loading = $state(true);
  let decomposition = $state<Decomposition | null>(null);
  let fetchError = $state<string | null>(null);

  // ── Fetch — re-runs whenever cycleId changes ──────────────────────────────────

  $effect(() => {
    const id = cycleId;
    loading = true;
    fetchError = null;
    decomposition = null;

    if (!browser) { loading = false; return; }

    getDecomposition(id)
      .then(d => { decomposition = d; })
      .catch(e => { fetchError = e instanceof Error ? e.message : String(e); })
      .finally(() => { loading = false; });
  });

  // ── Derived — topological wave groups ────────────────────────────────────────

  const waves = $derived.by<DecompositionChild[][]>(() => {
    if (decomposition === null) return [];
    return groupIntoWaves(decomposition.children);
  });

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function statusColor(status: string): string {
    if (status === 'completed') return 'var(--af-success)';
    if (status === 'failed' || status === 'killed' || status === 'crashed') return 'var(--af-danger)';
    if (status === 'in_progress') return 'var(--af-purple)';
    return 'var(--af-dim, #555)';
  }

  function fmtUsd(v: number): string {
    if (v === 0) return '$0.00';
    if (v < 0.001) return `$${v.toFixed(5)}`;
    if (v < 0.01) return `$${v.toFixed(4)}`;
    return `$${v.toFixed(3)}`;
  }

  const MAX_FILES_VISIBLE = 5;
</script>

<div class={['epic-tab', className].filter(Boolean).join(' ')}>

  {#if loading}
    <!-- Skeleton loading state -->
    <div class="epic-loading">
      <div class="skel skel-title"></div>
      <div class="skel skel-meta"></div>
      <div class="skel skel-card"></div>
      <div class="skel skel-card short"></div>
    </div>

  {:else if fetchError !== null}
    <div class="epic-notice muted">Could not load decomposition: {fetchError}</div>

  {:else if decomposition === null}
    <div class="epic-notice muted">No decomposition found for this cycle.</div>

  {:else if waves.length === 0}
    <div class="epic-notice muted">Decomposition is empty — no child items.</div>

  {:else}
    <!-- Header: objective + budget summary -->
    <div class="epic-header">
      <div class="epic-objective">{decomposition.objective}</div>
      <div class="epic-summary af2-mono muted">
        {decomposition.children.length} item{decomposition.children.length === 1 ? '' : 's'}
        &middot; {waves.length} wave{waves.length === 1 ? '' : 's'}
        &middot; budget {fmtUsd(decomposition.budgetUsd)}
      </div>
    </div>

    <!-- Wave groups -->
    <div class="waves">
      {#each waves as wave, waveIdx (waveIdx)}
        <div class="wave-group">
          <div class="wave-label">
            <span class="wave-badge af2-mono">Wave {waveIdx}</span>
            <span class="wave-count muted af2-mono">{wave.length} item{wave.length === 1 ? '' : 's'}</span>
          </div>

          <div class="wave-cards">
            {#each wave as child (child.id)}
              {@const result = itemResults[child.id]}
              {@const liveStatus = result?.status ?? 'pending'}
              {@const liveCost = result?.costUsd}
              <div
                class="child-card"
                style="border-left-color:{statusColor(liveStatus)}"
              >
                <!-- Card header: short id + live status -->
                <div class="child-head">
                  <span class="child-id af2-mono muted">#{child.id.slice(0, 12)}</span>
                  <span
                    class="child-status af2-mono"
                    style="color:{statusColor(liveStatus)}"
                  >{liveStatus.replace('_', ' ')}</span>
                </div>

                <!-- Title -->
                <div class="child-title">{child.title}</div>

                <!-- Cost row: actual (live) vs estimate -->
                <div class="child-costs af2-mono">
                  {#if liveCost != null}
                    <span class="cost-actual" style="color:var(--af-text, #e0e0e0)">{fmtUsd(liveCost)}</span>
                    <span class="muted">actual</span>
                  {/if}
                  {#if child.estimatedCostUsd > 0}
                    <span class="cost-est muted">{fmtUsd(child.estimatedCostUsd)} est.</span>
                  {/if}
                </div>

                <!-- Declared files (capped at MAX_FILES_VISIBLE) -->
                {#if child.files.length > 0}
                  <div class="child-files">
                    {#each child.files.slice(0, MAX_FILES_VISIBLE) as f (f)}
                      <span class="file-chip af2-mono">{f}</span>
                    {/each}
                    {#if child.files.length > MAX_FILES_VISIBLE}
                      <span class="file-chip-more muted">+{child.files.length - MAX_FILES_VISIBLE} more</span>
                    {/if}
                  </div>
                {/if}

                <!-- Predecessor hint (shown only when present) -->
                {#if child.predecessors.length > 0}
                  <div class="child-preds af2-mono muted">
                    after {child.predecessors.join(', ')}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  {/if}

</div>

<style>
  .epic-tab {
    font-size: 13px;
  }

  /* ── Skeleton ──────────────────────────────────────────────────────────────── */

  .epic-loading {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .skel {
    background: var(--af-border, #333);
    border-radius: 4px;
    animation: pulse 1.4s ease-in-out infinite;
  }
  .skel-title  { height: 18px; width: 260px; }
  .skel-meta   { height: 12px; width: 180px; }
  .skel-card   { height: 80px; }
  .skel-card.short { height: 60px; width: 65%; }
  @keyframes pulse {
    0%, 100% { opacity: 0.4; }
    50%       { opacity: 0.8; }
  }

  /* ── Notice (empty / error) ────────────────────────────────────────────────── */

  .epic-notice {
    padding: 8px 0;
    font-size: 12px;
  }
  .muted { color: var(--af-text-muted, #888); }

  /* ── Header ────────────────────────────────────────────────────────────────── */

  .epic-header {
    margin-bottom: 16px;
  }
  .epic-objective {
    font-size: 14px;
    font-weight: 600;
    color: var(--af-text, #e0e0e0);
    margin-bottom: 4px;
    line-height: 1.4;
  }
  .epic-summary {
    font-size: 11px;
  }

  /* ── Waves ─────────────────────────────────────────────────────────────────── */

  .waves {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .wave-group {}

  .wave-label {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .wave-badge {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    padding: 2px 8px;
    border-radius: 3px;
    background: var(--af-surface2, #1e1e1e);
    border: 1px solid var(--af-border, #2a2a2a);
    color: var(--af-text-muted, #888);
  }
  .wave-count {
    font-size: 11px;
  }

  /* ── Child card grid ───────────────────────────────────────────────────────── */

  .wave-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 10px;
  }

  .child-card {
    background: var(--af-surface, #141414);
    border: 1px solid var(--af-border, #2a2a2a);
    border-left-width: 3px;
    border-radius: 6px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    transition: border-color 200ms ease;
  }

  /* ── Child card internals ──────────────────────────────────────────────────── */

  .child-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }
  .child-id {
    font-size: 10px;
    white-space: nowrap;
  }
  .child-status {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .child-title {
    font-size: 12px;
    font-weight: 500;
    color: var(--af-text, #e0e0e0);
    line-height: 1.4;
  }

  .child-costs {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    flex-wrap: wrap;
  }
  .cost-actual {
    font-weight: 600;
  }
  .cost-est {}

  /* ── File chips ────────────────────────────────────────────────────────────── */

  .child-files {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    margin-top: 2px;
  }
  .file-chip {
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--af-surface2, #1e1e1e);
    border: 1px solid var(--af-border, #2a2a2a);
    color: var(--af-text-muted, #888);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 200px;
  }
  .file-chip-more {
    font-size: 9px;
    padding: 1px 5px;
  }

  /* ── Predecessor hint ──────────────────────────────────────────────────────── */

  .child-preds {
    font-size: 10px;
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ── Mono helper ────────────────────────────────────────────────────────────── */

  .af2-mono {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1;
  }

  /* ── Responsive: stack at narrow viewport ─────────────────────────────────── */

  @media (max-width: 480px) {
    .wave-cards {
      grid-template-columns: 1fr;
    }
  }
</style>
