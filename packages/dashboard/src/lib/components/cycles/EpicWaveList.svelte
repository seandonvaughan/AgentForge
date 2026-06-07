<script lang="ts">
  import { formatUsd, groupChildrenByWave, type ObjectiveModeView } from '$lib/util/objective-mode';

  export interface EpicWaveChild {
    id: string;
    title?: string | null;
    declaredFiles?: readonly string[] | null;
    files?: readonly string[] | null;
    estimatedCostUsd?: number | null;
    costUsd?: number | null;
    actualCostUsd?: number | null;
    status?: string | null;
    wave?: number | null;
  }

  export type EpicDecompositionView = ObjectiveModeView<EpicWaveChild> | readonly EpicWaveChild[];

  interface Props {
    view?: EpicDecompositionView | null;
    class?: string;
  }

  let { view = null, class: className = '' }: Props = $props();

  const waves = $derived(groupChildrenByWave<EpicWaveChild>(view));

  function childTitle(child: EpicWaveChild): string {
    return child.title?.trim() || 'Untitled child';
  }

  function declaredFiles(child: EpicWaveChild): readonly string[] {
    return child.declaredFiles ?? child.files ?? [];
  }

  function statusLabel(status: string | null | undefined): string {
    return status?.trim() || 'unknown';
  }

  function actualCost(child: EpicWaveChild): number | null | undefined {
    return child.actualCostUsd ?? child.costUsd;
  }
</script>

<div class={['epic-wave-list', className].filter(Boolean).join(' ')} data-testid="epic-wave-list">
  {#if waves.length === 0}
    <div class="empty">No child epics declared.</div>
  {:else}
    {#each waves as wave (wave.wave)}
      <section class="wave" aria-labelledby={`epic-wave-${wave.wave}`}>
        <div class="wave-header">
          <h3 id={`epic-wave-${wave.wave}`}>{wave.label}</h3>
          <span class="wave-total">{formatUsd(wave.estimatedCostUsd)} estimated</span>
        </div>

        <div class="children">
          {#each wave.children as child (child.id)}
            {@const files = declaredFiles(child)}
            <article class="child-row" aria-label={child.id}>
              <div class="child-main">
                <div class="child-title">
                  <span class="child-id">{child.id}</span>
                  <span>{childTitle(child)}</span>
                </div>
                <div class="file-list" aria-label={`${child.id} declared files`}>
                  {#if files.length > 0}
                    {#each files as file (file)}
                      <span class="file-chip">{file}</span>
                    {/each}
                  {:else}
                    <span class="muted">No declared files</span>
                  {/if}
                </div>
              </div>

              <div class="child-meta">
                <span class="status">{statusLabel(child.status)}</span>
                <span class="cost"><span>Estimate</span>{formatUsd(child.estimatedCostUsd)}</span>
                <span class="cost"><span>Actual</span>{formatUsd(actualCost(child))}</span>
              </div>
            </article>
          {/each}
        </div>
      </section>
    {/each}
  {/if}
</div>

<style>
  .epic-wave-list {
    display: grid;
    gap: var(--space-4, 16px);
  }

  .empty {
    color: var(--color-muted, var(--af-muted));
    font-size: 13px;
    padding: var(--space-4, 16px);
    border: 1px solid var(--color-border, var(--af-border));
    border-radius: var(--radius-2, 8px);
    background: var(--color-surface, var(--af-surface));
  }

  .wave {
    display: grid;
    gap: var(--space-3, 12px);
  }

  .wave-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3, 12px);
  }

  .wave-header h3 {
    margin: 0;
    color: var(--color-text, var(--af-text));
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0;
  }

  .wave-total {
    color: var(--color-muted, var(--af-muted));
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .children {
    display: grid;
    gap: var(--space-2, 8px);
  }

  .child-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--space-4, 16px);
    align-items: center;
    min-width: 0;
    padding: var(--space-3, 12px);
    border: 1px solid var(--color-border, var(--af-border));
    border-radius: var(--radius-2, 8px);
    background: var(--color-surface, var(--af-surface));
  }

  .child-main {
    display: grid;
    gap: var(--space-2, 8px);
    min-width: 0;
  }

  .child-title {
    display: flex;
    gap: var(--space-2, 8px);
    min-width: 0;
    color: var(--color-text, var(--af-text));
    font-size: 13px;
    font-weight: 600;
  }

  .child-id {
    color: var(--color-muted, var(--af-muted));
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
  }

  .file-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
  }

  .file-chip {
    max-width: 100%;
    overflow-wrap: anywhere;
    padding: 2px 6px;
    border: 1px solid color-mix(in srgb, var(--color-accent, var(--af-accent)) 18%, transparent);
    border-radius: var(--radius-1, 4px);
    color: var(--color-muted, var(--af-muted));
    background: color-mix(in srgb, var(--color-accent, var(--af-accent)) 7%, transparent);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    font-size: 11px;
  }

  .muted {
    color: var(--color-muted, var(--af-muted));
    font-size: 12px;
  }

  .child-meta {
    display: flex;
    align-items: center;
    gap: var(--space-3, 12px);
    color: var(--color-muted, var(--af-muted));
    font-size: 12px;
    white-space: nowrap;
  }

  .status {
    padding: 2px 7px;
    border: 1px solid var(--color-border-strong, var(--af-border3));
    border-radius: var(--radius-1, 4px);
    color: var(--color-text, var(--af-text));
    background: var(--color-surface-2, var(--af-surface2));
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
  }

  .cost {
    display: grid;
    gap: 2px;
    justify-items: end;
    color: var(--color-text, var(--af-text));
    font-variant-numeric: tabular-nums;
  }

  .cost span {
    color: var(--color-muted, var(--af-muted));
    font-size: 10px;
    text-transform: uppercase;
  }

  @media (max-width: 640px) {
    .wave-header,
    .child-row,
    .child-title,
    .child-meta {
      align-items: stretch;
      display: grid;
    }

    .child-row {
      grid-template-columns: 1fr;
    }

    .child-meta {
      grid-template-columns: repeat(3, minmax(0, 1fr));
      white-space: normal;
    }

    .cost {
      justify-items: start;
    }
  }
</style>
