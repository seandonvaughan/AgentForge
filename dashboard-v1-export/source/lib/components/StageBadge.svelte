<script lang="ts">
  interface Props {
    stage: string | null | undefined;
  }
  let { stage }: Props = $props();

  const TERMINAL = new Set(['completed', 'failed', 'killed']);

  function variant(s: string | null | undefined): 'success' | 'danger' | 'warning' | 'info' | 'muted' {
    if (!s) return 'muted';
    const v = s.toLowerCase();
    if (v === 'completed') return 'success';
    if (v === 'failed') return 'danger';
    if (v === 'killed') return 'warning';
    if (TERMINAL.has(v)) return 'muted';
    return 'info';
  }

  let kind = $derived(variant(stage));
  let label = $derived(stage ?? 'unknown');
  let isRunning = $derived(stage != null && !TERMINAL.has(stage.toLowerCase()));
</script>

<span class="stage-badge {kind}" class:running={isRunning} title={label}>
  {#if isRunning}
    <span class="dot"></span>
  {/if}
  {label}
</span>

<style>
  .stage-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: 2px var(--space-2);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    border: 1px solid currentColor;
    font-family: var(--font-mono);
    line-height: 1.4;
  }
  .stage-badge.success { color: var(--color-success); border-color: rgba(76,175,130,0.4); background: rgba(76,175,130,0.08); }
  .stage-badge.danger  { color: var(--color-danger);  border-color: rgba(224,90,90,0.4);  background: rgba(224,90,90,0.08); }
  .stage-badge.warning { color: var(--color-warning); border-color: rgba(245,166,35,0.4); background: rgba(245,166,35,0.08); }
  .stage-badge.info    { color: var(--color-info);    border-color: rgba(74,158,255,0.4); background: rgba(74,158,255,0.08); }
  .stage-badge.muted   { color: var(--color-text-muted); border-color: var(--color-border); }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: var(--radius-full);
    background: currentColor;
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
</style>
