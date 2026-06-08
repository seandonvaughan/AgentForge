<script lang="ts">
  import Badge from './Badge.svelte';

  export type EpicChildStatus =
    | 'pending'
    | 'queued'
    | 'running'
    | 'done'
    | 'failed'
    | 'blocked';

  interface Props {
    /** Stable child id (e.g. "child-15"). */
    id: string;
    /** Human-readable child title. */
    title: string;
    /** Files this child declares it will touch. */
    files?: string[];
    /** Forecast cost in USD for this child. */
    estimatedCostUsd?: number;
    /** Decomposition lifecycle status. */
    status?: EpicChildStatus;
    /** Extra inline CSS appended after the row styles (caller overrides). */
    style?: string;
    class?: string;
  }

  let {
    id,
    title,
    files = [],
    estimatedCostUsd = 0,
    status = 'pending',
    style = '',
    class: className = '',
  }: Props = $props();

  // status → Badge variant (presentational only)
  type BadgeVariant = 'success' | 'warning' | 'danger' | 'info' | 'purple' | 'muted';
  const statusVariant: Record<EpicChildStatus, BadgeVariant> = {
    pending: 'muted',
    queued: 'info',
    running: 'purple',
    done: 'success',
    failed: 'danger',
    blocked: 'warning',
  };
  const variant = $derived(statusVariant[status] ?? 'muted');

  const costLabel = $derived(`$${(estimatedCostUsd ?? 0).toFixed(2)}`);
  const fileCount = $derived(files?.length ?? 0);

  const rowStyle = $derived(
    `display:flex;align-items:center;gap:12px;` +
    `padding:10px 12px;` +
    `border:1px solid var(--af-border);border-radius:8px;` +
    `background:var(--af-surface);` +
    style
  );
</script>

<div
  class={['af2-epic-child-row', className].filter(Boolean).join(' ')}
  style={rowStyle}
  data-child-id={id}
>
  <div style="flex:1;min-width:0">
    <div
      style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--af-text)"
    >
      <span style="color:var(--af-dim);font-family:var(--af-mono,monospace);font-size:11px">{id}</span>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{title}</span>
    </div>
    <div style="margin-top:3px;font-size:11px;color:var(--af-muted)">
      {fileCount} {fileCount === 1 ? 'file' : 'files'}
      {#if fileCount > 0}
        · <span style="font-family:var(--af-mono,monospace)">{files.join(', ')}</span>
      {/if}
    </div>
  </div>

  <span
    style="font-size:12px;font-weight:600;color:var(--af-text);font-variant-numeric:tabular-nums;white-space:nowrap"
  >{costLabel}</span>

  <Badge {variant}>{status}</Badge>
</div>
