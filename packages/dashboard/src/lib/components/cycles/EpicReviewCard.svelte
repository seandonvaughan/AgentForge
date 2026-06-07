<script module lang="ts">
  export type EpicReviewVerdict = 'APPROVE' | 'REQUEST_CHANGES' | 'TRIAGE';

  export interface EpicReviewFaultedItem {
    itemId: string;
    reason: string;
    files: string[];
  }

  export interface EpicReviewArtifact {
    phase?: 'gate';
    mode?: 'epic-review';
    cycleId?: string;
    attempt?: number;
    verdict: EpicReviewVerdict;
    rationale: string;
    faultedItems: EpicReviewFaultedItem[];
    schemaValidationOk?: boolean;
    triageUsed?: boolean;
    costUsd?: number;
    durationMs?: number;
    completedAt?: string;
  }

  export type VerdictVariant = 'success' | 'warning' | 'danger' | 'muted';

  const VERDICT_LABELS: Record<EpicReviewVerdict, string> = {
    APPROVE: 'Approved',
    REQUEST_CHANGES: 'Changes requested',
    TRIAGE: 'Triage',
  };

  export function formatEpicReviewVerdict(value: string | null | undefined): string {
    if (value === 'APPROVE' || value === 'REQUEST_CHANGES' || value === 'TRIAGE') {
      return VERDICT_LABELS[value];
    }
    return 'Unknown';
  }

  export function epicReviewVerdictVariant(value: string | null | undefined): VerdictVariant {
    if (value === 'APPROVE') return 'success';
    if (value === 'REQUEST_CHANGES') return 'danger';
    if (value === 'TRIAGE') return 'warning';
    return 'muted';
  }

  export function formatRationaleExcerpt(value: string | null | undefined, max = 220): string {
    const text = (value ?? '').replace(/\s+/g, ' ').trim();
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
  }

  export function formatFaultedFiles(files: string[] | null | undefined): string {
    const clean = (files ?? []).map(f => f.trim()).filter(Boolean);
    if (clean.length === 0) return 'No files listed';
    if (clean.length <= 2) return clean.join(', ');
    return `${clean.slice(0, 2).join(', ')} +${clean.length - 2}`;
  }
</script>

<script lang="ts">
  import { browser } from '$app/environment';
  import Badge from '$lib/components/v2/Badge.svelte';
  import Card from '$lib/components/v2/Card.svelte';
  import PulseDot from '$lib/components/v2/PulseDot.svelte';

  interface Props {
    cycleId: string;
    class?: string;
  }

  type LoadState = 'idle' | 'loading' | 'ready' | 'absent' | 'error';

  let { cycleId, class: className = '' }: Props = $props();

  let loadState = $state<LoadState>('idle');
  let review = $state<EpicReviewArtifact | null>(null);

  const faultedItems = $derived(review?.faultedItems ?? []);
  const verdictVariant = $derived(epicReviewVerdictVariant(review?.verdict));
  const verdictColor = $derived.by<string>(() => {
    if (review?.verdict === 'APPROVE') return 'var(--af-success)';
    if (review?.verdict === 'REQUEST_CHANGES') return 'var(--af-danger)';
    if (review?.verdict === 'TRIAGE') return 'var(--af-warning)';
    return 'var(--af-dim)';
  });

  $effect(() => {
    if (!browser || cycleId.trim() === '') {
      loadState = 'absent';
      review = null;
      return;
    }

    const controller = new AbortController();
    const id = cycleId;
    loadState = 'loading';
    review = null;

    fetch(`/api/v5/cycles/${encodeURIComponent(id)}/epic-review`, {
      signal: controller.signal,
    })
      .then(async res => {
        if (res.status === 404 || res.status === 204) {
          loadState = 'absent';
          return;
        }
        if (!res.ok) {
          loadState = 'error';
          return;
        }
        const body = (await res.json()) as EpicReviewArtifact | { data?: EpicReviewArtifact | null };
        review = 'data' in body ? body.data ?? null : body;
        loadState = review === null ? 'absent' : 'ready';
      })
      .catch(err => {
        if ((err as Error).name !== 'AbortError') {
          loadState = 'error';
        }
      });

    return () => {
      controller.abort();
    };
  });
</script>

{#if loadState === 'loading'}
  <Card class={['epic-review-card', className].filter(Boolean).join(' ')}>
    <div class="epic-review-head">
      <span class="eyebrow">Epic review</span>
      <Badge>Loading</Badge>
    </div>
    <div class="skeleton rationale-skeleton"></div>
  </Card>
{:else if loadState === 'error'}
  <Card class={['epic-review-card', 'is-error', className].filter(Boolean).join(' ')}>
    <div class="epic-review-head">
      <span class="eyebrow">Epic review</span>
      <Badge variant="warning">Unavailable</Badge>
    </div>
    <p class="rationale">Could not load the epic review verdict.</p>
  </Card>
{:else if loadState === 'ready' && review !== null}
  <Card class={['epic-review-card', className].filter(Boolean).join(' ')} accent={review.verdict === 'REQUEST_CHANGES'}>
    <div class="epic-review-head">
      <div class="title-row">
        <PulseDot color={verdictColor} size={7} ring={review.verdict === 'REQUEST_CHANGES'} />
        <span class="eyebrow">Epic review</span>
      </div>
      <Badge variant={verdictVariant}>{formatEpicReviewVerdict(review.verdict)}</Badge>
    </div>

    {#if formatRationaleExcerpt(review.rationale)}
      <p class="rationale">{formatRationaleExcerpt(review.rationale)}</p>
    {:else}
      <p class="rationale muted">No rationale recorded.</p>
    {/if}

    {#if faultedItems.length > 0}
      <div class="faulted-wrap" aria-label="Faulted items">
        <div class="faulted-title">
          <span>Faulted items</span>
          <span class="faulted-count af2-mono">{faultedItems.length}</span>
        </div>
        <ul class="faulted-list">
          {#each faultedItems as item (item.itemId)}
            <li class="faulted-item">
              <div class="faulted-main">
                <span class="faulted-id af2-mono">{item.itemId}</span>
                <span class="faulted-reason">{item.reason}</span>
              </div>
              <span class="faulted-files af2-mono">{formatFaultedFiles(item.files)}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </Card>
{/if}

<style>
  .epic-review-card {
    min-width: 280px;
    font-size: 13px;
  }

  .epic-review-head,
  .title-row,
  .faulted-title,
  .faulted-item,
  .faulted-main {
    display: flex;
    align-items: center;
  }

  .epic-review-head {
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 10px;
  }

  .title-row {
    gap: 8px;
    min-width: 0;
  }

  .eyebrow {
    color: var(--af-text-muted, #888);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .rationale {
    margin: 0;
    color: var(--af-text, #ddd);
    line-height: 1.45;
  }

  .muted {
    color: var(--af-text-muted, #888);
  }

  .faulted-wrap {
    margin-top: 12px;
    border-top: 1px solid var(--af-border, #333);
    padding-top: 10px;
  }

  .faulted-title {
    justify-content: space-between;
    color: var(--af-text-muted, #888);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .faulted-count {
    color: var(--af-danger, #e05353);
  }

  .faulted-list {
    display: grid;
    gap: 8px;
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
  }

  .faulted-item {
    justify-content: space-between;
    gap: 12px;
    border: 1px solid color-mix(in srgb, var(--af-danger, #e05353) 18%, transparent);
    border-radius: 6px;
    padding: 8px;
    background: color-mix(in srgb, var(--af-danger, #e05353) 5%, transparent);
  }

  .faulted-main {
    flex: 1;
    gap: 8px;
    min-width: 0;
  }

  .faulted-id {
    flex-shrink: 0;
    color: var(--af-danger, #e05353);
    font-size: 11px;
  }

  .faulted-reason {
    min-width: 0;
    overflow: hidden;
    color: var(--af-text, #ddd);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .faulted-files {
    flex-shrink: 0;
    max-width: 42%;
    overflow: hidden;
    color: var(--af-text-muted, #888);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .skeleton {
    border-radius: 4px;
    background: var(--af-border, #333);
    animation: pulse 1.4s ease-in-out infinite;
  }

  .rationale-skeleton {
    height: 34px;
  }

  .is-error .rationale {
    color: var(--af-warning, #d7a336);
  }

  @media (max-width: 560px) {
    .faulted-item {
      align-items: flex-start;
      flex-direction: column;
    }

    .faulted-files {
      max-width: 100%;
    }
  }

  @keyframes pulse {
    0%, 100% { opacity: 0.45; }
    50% { opacity: 0.8; }
  }
</style>
