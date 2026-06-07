<script module lang="ts">
  export type EpicStatus = 'planned' | 'in_progress' | 'completed' | 'failed' | 'killed';

  export interface EpicChild {
    id: string;
    title: string;
    files?: string[];
    estimatedCostUsd?: number;
    wave?: number | null;
    predecessors?: string[];
  }

  export interface EpicPlan {
    epicId?: string;
    rationale?: string;
    children?: EpicChild[];
  }

  export type EpicDecomposition =
    | EpicPlan
    | EpicChild[]
    | { plan?: EpicPlan | null; data?: EpicPlan | null; decomposition?: EpicPlan | null }
    | null
    | undefined;

  export interface ExecuteResult {
    id?: string;
    itemId?: string;
    childId?: string;
    status?: string;
    costUsd?: number;
    totalCostUsd?: number;
    result?: {
      status?: string;
      costUsd?: number;
      totalCostUsd?: number;
    };
  }

  export type ExecuteResults = ExecuteResult[] | Record<string, ExecuteResult> | null | undefined;

  export interface EpicChildRow {
    child: EpicChild;
    status: EpicStatus;
    liveCostUsd: number | null;
  }

  export interface EpicWaveGroup {
    wave: number;
    children: EpicChildRow[];
  }

  export function getEpicChildren(decomposition: EpicDecomposition): EpicChild[] {
    if (!decomposition) return [];
    if (Array.isArray(decomposition)) return decomposition;
    if (Array.isArray(decomposition.children)) return decomposition.children;
    if ('plan' in decomposition && decomposition.plan?.children) return decomposition.plan.children;
    if ('data' in decomposition && decomposition.data?.children) return decomposition.data.children;
    if ('decomposition' in decomposition && decomposition.decomposition?.children) {
      return decomposition.decomposition.children;
    }
    return [];
  }

  export function groupEpicChildrenByWave<T extends { wave?: number | null }>(children: T[]): Array<{ wave: number; children: T[] }> {
    if (children.length === 0) return [];

    const anyWave = children.some((child) => typeof child.wave === 'number');
    if (!anyWave) return [{ wave: 0, children }];

    const byWave = new Map<number, T[]>();
    for (const child of children) {
      const wave = typeof child.wave === 'number' ? child.wave : 0;
      const group = byWave.get(wave);
      if (group) group.push(child);
      else byWave.set(wave, [child]);
    }

    return Array.from(byWave.keys())
      .sort((a, b) => a - b)
      .map((wave) => ({ wave, children: byWave.get(wave) ?? [] }));
  }

  function normalizeExecuteResults(results: ExecuteResults): ExecuteResult[] {
    if (!results) return [];
    if (Array.isArray(results)) return results;
    return Object.entries(results).map(([id, result]) => ({ id, ...result }));
  }

  function resultKey(result: ExecuteResult): string | null {
    return result.itemId ?? result.childId ?? result.id ?? null;
  }

  function latestExecuteResultByChild(results: ExecuteResults): Map<string, ExecuteResult> {
    const byChild = new Map<string, ExecuteResult>();
    for (const result of normalizeExecuteResults(results)) {
      const key = resultKey(result);
      if (key) byChild.set(key, result);
    }
    return byChild;
  }

  export function deriveLiveStatus(result: ExecuteResult | null | undefined): EpicStatus {
    const status = (result?.status ?? result?.result?.status ?? '').toLowerCase();
    if (['completed', 'complete', 'succeeded', 'success', 'passed', 'merged'].includes(status)) return 'completed';
    if (['failed', 'failure', 'error', 'errored', 'crashed'].includes(status)) return 'failed';
    if (['killed', 'cancelled', 'canceled', 'aborted'].includes(status)) return 'killed';
    if (['running', 'in_progress', 'active', 'started', 'queued'].includes(status)) return 'in_progress';
    return 'planned';
  }

  export function deriveLiveCost(result: ExecuteResult | null | undefined): number | null {
    const cost = result?.costUsd ?? result?.totalCostUsd ?? result?.result?.costUsd ?? result?.result?.totalCostUsd;
    return typeof cost === 'number' && Number.isFinite(cost) ? cost : null;
  }

  export function buildEpicWaveGroups(decomposition: EpicDecomposition, executeResults: ExecuteResults): EpicWaveGroup[] {
    const byChild = latestExecuteResultByChild(executeResults);
    return groupEpicChildrenByWave(getEpicChildren(decomposition)).map((group) => ({
      wave: group.wave,
      children: group.children.map((child) => {
        const result = byChild.get(child.id);
        return {
          child,
          status: deriveLiveStatus(result),
          liveCostUsd: deriveLiveCost(result),
        };
      }),
    }));
  }

  export function countFiles(child: EpicChild): number {
    return child.files?.filter((file) => file.trim().length > 0).length ?? 0;
  }

  export function fileList(child: EpicChild): string[] {
    return child.files?.filter((file) => file.trim().length > 0) ?? [];
  }

  export function statusLabel(status: EpicStatus): string {
    return status.replace('_', ' ');
  }
</script>

<script lang="ts">
  import { browser } from '$app/environment';

  interface Props {
    decomposition?: EpicDecomposition;
    executeResults?: ExecuteResults;
    title?: string;
  }

  let {
    decomposition = null,
    executeResults = null,
    title = 'Epic decomposition',
  }: Props = $props();

  const waveGroups = $derived.by<EpicWaveGroup[]>(() => buildEpicWaveGroups(decomposition, executeResults));
  const childCount = $derived<number>(waveGroups.reduce((sum, group) => sum + group.children.length, 0));
  const declaredCostUsd = $derived<number>(
    waveGroups.reduce(
      (sum, group) => sum + group.children.reduce((inner, row) => inner + (row.child.estimatedCostUsd ?? 0), 0),
      0,
    ),
  );
  const liveCostUsd = $derived<number>(
    waveGroups.reduce(
      (sum, group) => sum + group.children.reduce((inner, row) => inner + (row.liveCostUsd ?? 0), 0),
      0,
    ),
  );

  function formatCost(cost: number | null | undefined): string {
    if (typeof cost !== 'number' || !Number.isFinite(cost)) return '—';
    return `$${cost.toFixed(2)}`;
  }
</script>

<section class="epic-tab" aria-label={title}>
  <div class="epic-head">
    <div>
      <h2>{title}</h2>
      <p>{waveGroups.length} waves · {childCount} children</p>
    </div>
    <div class="cost-summary" aria-label="Epic cost summary" aria-live={browser ? 'polite' : 'off'}>
      <span>Declared {formatCost(declaredCostUsd)}</span>
      <span>Live {formatCost(liveCostUsd)}</span>
    </div>
  </div>

  {#if waveGroups.length === 0}
    <div class="empty">No epic decomposition is available yet.</div>
  {:else}
    <div class="wave-list">
      {#each waveGroups as group (group.wave)}
        <section class="wave-group" data-testid={`wave-${group.wave}`} aria-label={`Wave ${group.wave + 1}`}>
          <div class="wave-head">
            <span>Wave {group.wave + 1}</span>
            <span>{group.children.length} child{group.children.length === 1 ? '' : 'ren'}</span>
          </div>

          <div class="child-list">
            {#each group.children as row (row.child.id)}
              <article class="child-row" data-testid={`epic-child-${row.child.id}`}>
                <div class="child-main">
                  <div class="child-title-row">
                    <span class="child-id">{row.child.id}</span>
                    <h3>{row.child.title}</h3>
                    <span class={`status status-${row.status}`}>{statusLabel(row.status)}</span>
                  </div>

                  <div class="child-meta">
                    <span>Declared {formatCost(row.child.estimatedCostUsd)}</span>
                    <span>Live {formatCost(row.liveCostUsd)}</span>
                    <span>{countFiles(row.child)} files</span>
                  </div>

                  {#if fileList(row.child).length > 0}
                    <div class="file-list" aria-label={`Declared files for ${row.child.id}`}>
                      {#each fileList(row.child) as file (file)}
                        <code>{file}</code>
                      {/each}
                    </div>
                  {/if}
                </div>
              </article>
            {/each}
          </div>
        </section>
      {/each}
    </div>
  {/if}
</section>

<style>
  .epic-tab {
    display: grid;
    gap: 14px;
  }

  .epic-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }

  .epic-head h2 {
    margin: 0;
    color: var(--af-text);
    font-size: 16px;
    font-weight: 650;
  }

  .epic-head p {
    margin: 4px 0 0;
    color: var(--af-dim);
    font-size: 12px;
  }

  .cost-summary {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
    color: var(--af-dim);
    font-family: var(--af-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 12px;
  }

  .empty {
    border: 1px dashed var(--af-border);
    border-radius: 8px;
    color: var(--af-dim);
    padding: 18px;
    text-align: center;
  }

  .wave-list {
    display: grid;
    gap: 12px;
  }

  .wave-group {
    border: 1px solid var(--af-border);
    border-radius: 8px;
    overflow: hidden;
  }

  .wave-head {
    align-items: center;
    background: color-mix(in srgb, var(--af-surface) 76%, transparent);
    border-bottom: 1px solid var(--af-border);
    color: var(--af-text);
    display: flex;
    font-size: 12px;
    font-weight: 650;
    justify-content: space-between;
    padding: 9px 12px;
    text-transform: uppercase;
  }

  .child-list {
    display: grid;
  }

  .child-row + .child-row {
    border-top: 1px solid var(--af-border);
  }

  .child-row {
    background: color-mix(in srgb, var(--af-bg) 96%, var(--af-surface));
    padding: 12px;
  }

  .child-main {
    display: grid;
    gap: 8px;
  }

  .child-title-row {
    align-items: center;
    display: grid;
    gap: 8px;
    grid-template-columns: max-content minmax(0, 1fr) max-content;
  }

  .child-id {
    color: var(--af-accent2);
    font-family: var(--af-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 12px;
  }

  .child-title-row h3 {
    color: var(--af-text);
    font-size: 14px;
    font-weight: 600;
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .status {
    border: 1px solid currentColor;
    border-radius: 999px;
    font-size: 11px;
    line-height: 1;
    padding: 4px 7px;
    text-transform: uppercase;
  }

  .status-planned {
    color: var(--af-dim);
  }

  .status-in_progress {
    color: var(--af-purple);
  }

  .status-completed {
    color: var(--af-success);
  }

  .status-failed,
  .status-killed {
    color: var(--af-danger);
  }

  .child-meta {
    color: var(--af-dim);
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    font-family: var(--af-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 12px;
  }

  .file-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .file-list code {
    background: color-mix(in srgb, var(--af-surface) 84%, transparent);
    border: 1px solid var(--af-border);
    border-radius: 6px;
    color: var(--af-text);
    font-size: 11px;
    padding: 3px 6px;
  }

  @media (max-width: 640px) {
    .epic-head {
      display: grid;
    }

    .cost-summary {
      justify-content: flex-start;
    }

    .child-title-row {
      grid-template-columns: 1fr max-content;
    }

    .child-id {
      grid-column: 1 / -1;
    }
  }
</style>
