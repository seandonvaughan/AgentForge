<script lang="ts">
  /**
   * EpicReviewCard.svelte
   *
   * Compact verdict card shown in the cycle detail header for epic/objective-mode
   * cycles. Fetches the post-execution gate verdict via getEpicReview.
   *
   * Renders nothing when the review is null (404 — non-epic cycle) or when a
   * fetch error occurs, so standard cycles are completely unaffected.
   *
   * Props:
   *   cycleId — cycle id to fetch the epic review for
   *   class   — optional extra CSS class on the root element
   */

  import { getEpicReview, type EpicReview } from '$lib/api/epic.js';

  interface Props {
    cycleId: string;
    class?: string;
  }

  let { cycleId, class: className = '' }: Props = $props();

  let review = $state<EpicReview | null>(null);

  $effect(() => {
    const id = cycleId;
    review = null;

    getEpicReview(id)
      .then(r => { review = r; })
      .catch(() => { /* non-404 error: stay invisible */ });
  });

  // ── Verdict colour ──────────────────────────────────────────────────────────

  const verdictColor = $derived.by<string>(() => {
    if (review === null) return '';
    if (review.verdict === 'pass') return 'var(--af-success)';
    if (review.verdict === 'fail') return 'var(--af-danger, #e05353)';
    return 'var(--af-warning)'; // 'warn'
  });

  const verdictPillStyle = $derived(
    verdictColor
      ? `color:${verdictColor};` +
        `background:color-mix(in srgb,${verdictColor} 10%,transparent);` +
        `border:1px solid color-mix(in srgb,${verdictColor} 25%,transparent)`
      : ''
  );

  // ── Rationale excerpt — String.slice only, no regex ─────────────────────────

  const rationaleExcerpt = $derived.by<string>(() => {
    if (review === null) return '';
    const r = review.rationale;
    return r.length <= 200 ? r : r.slice(0, 200) + '…';
  });
</script>

{#if review !== null}
  <div class={['epic-review-card', className].filter(Boolean).join(' ')}>
    <div class="card-header">
      <span class="card-label">EPIC REVIEW</span>
      <span class="verdict-pill af2-mono" style={verdictPillStyle}>
        {review.verdict.toUpperCase()}
      </span>
    </div>

    <p class="rationale">{rationaleExcerpt}</p>

    {#if review.faultedItems && review.faultedItems.length > 0}
      <div class="faulted-items">
        <span class="faulted-label muted">Faulted:</span>
        {#each review.faultedItems as itemId (itemId)}
          <span class="item-chip af2-mono">{itemId}</span>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .epic-review-card {
    font-size: 13px;
    padding: 10px 12px;
    background: var(--af-surface, #141414);
    border: 1px solid var(--af-border, #2a2a2a);
    border-radius: 8px;
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }

  .card-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: var(--af-text-muted, #888);
    text-transform: uppercase;
  }

  .verdict-pill {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.05em;
    padding: 2px 8px;
    border-radius: 4px;
    text-transform: uppercase;
    display: inline-flex;
    align-items: center;
  }

  .rationale {
    margin: 0;
    font-size: 12px;
    color: var(--af-text, #e0e0e0);
    line-height: 1.5;
  }

  .faulted-items {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1px solid var(--af-border, #2a2a2a);
  }

  .faulted-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    flex-shrink: 0;
  }

  .muted { color: var(--af-text-muted, #888); }

  .item-chip {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--af-surface2, #1e1e1e);
    border: 1px solid var(--af-border, #2a2a2a);
    color: var(--af-text, #e0e0e0);
    white-space: nowrap;
  }

  .af2-mono {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1;
  }
</style>
