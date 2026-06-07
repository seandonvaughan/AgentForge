<script lang="ts" module>
  // Public verdict union. Mirrors EpicReviewVerdict in
  // @agentforge/core's epic-review phase handler. Kept local so this
  // presentational component carries ZERO workspace dependencies.
  export type EpicVerdict = 'APPROVE' | 'REQUEST_CHANGES' | 'TRIAGE';

  /** A single faulted child item the reviewer wants fixed before approval. */
  export interface EpicVerdictFaultedItem {
    itemId: string;
    reason: string;
    files?: string[];
  }
</script>

<script lang="ts">
  /**
   * EpicVerdictCard.svelte
   *
   * Renders an epic-review verdict as a compact card:
   *   - verdict pill (APPROVE / REQUEST_CHANGES / TRIAGE)
   *   - rationale excerpt (truncated; full text on hover via title)
   *   - faulted-items list, only when one or more are present
   *
   * Pure presentational: no data fetching, no workspace imports.
   * SSR/browser-safe — every DOM/clipboard access is guarded behind
   * `typeof` checks so the card renders identically on the server.
   *
   * CONSUMER: the cycle-detail header (child-20) mounts this card.
   */

  interface Props {
    verdict: EpicVerdict;
    rationale?: string;
    faultedItems?: EpicVerdictFaultedItem[];
    /** Max characters of rationale shown before truncation. */
    excerptLength?: number;
    class?: string;
  }

  let {
    verdict,
    rationale = '',
    faultedItems = [],
    excerptLength = 220,
    class: className = '',
  }: Props = $props();

  // ── Verdict presentation ────────────────────────────────────────────────────
  type Tone = 'success' | 'danger' | 'warning';

  const TONE: Record<EpicVerdict, Tone> = {
    APPROVE: 'success',
    REQUEST_CHANGES: 'danger',
    TRIAGE: 'warning',
  };

  const LABEL: Record<EpicVerdict, string> = {
    APPROVE: 'APPROVE',
    REQUEST_CHANGES: 'REQUEST CHANGES',
    TRIAGE: 'TRIAGE',
  };

  // Unknown verdicts degrade to the safe TRIAGE styling rather than crashing.
  const tone = $derived<Tone>(TONE[verdict] ?? 'warning');
  const label = $derived(LABEL[verdict] ?? String(verdict));
  const toneVar = $derived(`var(--af-${tone})`);

  // ── Rationale excerpt ───────────────────────────────────────────────────────
  const trimmed = $derived(rationale.trim());
  const truncated = $derived(trimmed.length > excerptLength);
  const excerpt = $derived(
    truncated ? `${trimmed.slice(0, excerptLength).trimEnd()}…` : trimmed,
  );

  // ── Faulted items ───────────────────────────────────────────────────────────
  const faults = $derived(faultedItems ?? []);
  const hasFaults = $derived(faults.length > 0);

  // Browser-guarded clipboard affordance: copying an itemId is a no-op during
  // SSR (no `navigator`), so the handler short-circuits server-side.
  function copyItemId(itemId: string): void {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    void navigator.clipboard.writeText(itemId);
  }
</script>

<div
  class={['epic-verdict-card', `tone-${tone}`, className].filter(Boolean).join(' ')}
  style={`--verdict-tone:${toneVar};`}
  data-verdict={verdict}
>
  <div class="evc-head">
    <span class="evc-pill" data-testid="verdict-pill">{label}</span>
    <span class="evc-title">Epic review</span>
    {#if hasFaults}
      <span class="evc-fault-count af2-mono" data-testid="fault-count">
        {faults.length} faulted
      </span>
    {/if}
  </div>

  {#if excerpt}
    <p class="evc-rationale" title={truncated ? trimmed : undefined} data-testid="rationale">
      {excerpt}
    </p>
  {:else}
    <p class="evc-rationale muted" data-testid="rationale">No rationale provided.</p>
  {/if}

  {#if hasFaults}
    <ul class="evc-faults" data-testid="faulted-items">
      {#each faults as item (item.itemId)}
        <li class="evc-fault">
          <button
            type="button"
            class="evc-fault-id af2-mono"
            title="Copy item id"
            onclick={() => copyItemId(item.itemId)}
          >{item.itemId}</button>
          <span class="evc-fault-reason">{item.reason}</span>
          {#if item.files && item.files.length > 0}
            <span class="evc-fault-files af2-mono">{item.files.join(', ')}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .epic-verdict-card {
    background: var(--af-surface);
    border: 1px solid color-mix(in srgb, var(--verdict-tone) 25%, var(--af-border));
    border-radius: 10px;
    padding: 14px 16px;
    font-size: 13px;
    color: var(--af-text);
  }

  .evc-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
  }

  .evc-pill {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    padding: 3px 9px;
    border-radius: 5px;
    text-transform: uppercase;
    color: var(--verdict-tone);
    background: color-mix(in srgb, var(--verdict-tone) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--verdict-tone) 28%, transparent);
  }

  .evc-title {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--af-text-muted, var(--af-dim));
  }

  .evc-fault-count {
    margin-left: auto;
    font-size: 10px;
    color: var(--af-danger);
  }

  .evc-rationale {
    margin: 0;
    line-height: 1.5;
    color: var(--af-text);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .evc-rationale.muted {
    color: var(--af-text-muted, var(--af-dim));
    font-style: italic;
  }

  .evc-faults {
    list-style: none;
    margin: 12px 0 0;
    padding: 10px 0 0;
    border-top: 1px solid var(--af-border);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .evc-fault {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px;
    font-size: 12px;
  }

  .evc-fault-id {
    font-size: 11px;
    font-weight: 600;
    color: var(--af-danger);
    background: color-mix(in srgb, var(--af-danger) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--af-danger) 20%, transparent);
    border-radius: 4px;
    padding: 1px 6px;
    cursor: pointer;
  }

  .evc-fault-reason {
    flex: 1 1 60%;
    min-width: 0;
    color: var(--af-text);
  }

  .evc-fault-files {
    font-size: 10px;
    color: var(--af-text-muted, var(--af-dim));
  }

  .af2-mono {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1;
  }
</style>
