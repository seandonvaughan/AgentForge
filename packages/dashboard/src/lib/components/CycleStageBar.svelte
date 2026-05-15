<script lang="ts">
  // CycleStageBar — scaffold for Track F (compact pill row).
  // Track B will replace this with a fuller version; the `compact` prop must be preserved.
  interface Props {
    stage?: string | null;
    costUsd?: number | null;
    budgetUsd?: number | null;
    startedAt?: string | null;
    isTerminal?: boolean;
    compact?: boolean;
  }

  let { stage = null, costUsd = null, budgetUsd = null, startedAt = null, isTerminal = false, compact = false }: Props = $props();

  const ORDERED_STAGES = ['plan', 'stage', 'run', 'verify', 'commit', 'review'];
  const TERMINAL_STAGES = new Set(['completed', 'failed', 'killed']);

  type PillState = 'done' | 'active' | 'pending' | 'failed' | 'terminal-ok' | 'terminal-fail' | 'terminal-killed';

  function getPillState(pill: string, currentStage: string | null): PillState {
    if (!currentStage) return 'pending';
    const cur = currentStage.toLowerCase();

    // If cycle is terminal, color all pills based on outcome
    if (TERMINAL_STAGES.has(cur)) {
      const idx = ORDERED_STAGES.indexOf(pill);
      if (cur === 'completed') return idx >= 0 ? 'done' : 'pending';
      if (cur === 'failed') {
        // Mark pills before current as done, rest pending — but we don't know where it failed
        // so mark all as done for completed, all as failed-terminal for failed
        return 'failed';
      }
      if (cur === 'killed') return 'pending';
      return 'pending';
    }

    const curIdx = ORDERED_STAGES.indexOf(cur);
    const pillIdx = ORDERED_STAGES.indexOf(pill);
    if (curIdx === -1) return 'pending';
    if (pillIdx < curIdx) return 'done';
    if (pillIdx === curIdx) return 'active';
    return 'pending';
  }

  let pills = $derived(
    ORDERED_STAGES.map((s) => ({
      label: s.toUpperCase(),
      key: s,
      state: getPillState(s, stage),
    }))
  );

  let terminalState = $derived(
    stage ? (TERMINAL_STAGES.has(stage.toLowerCase()) ? stage.toLowerCase() : null) : null
  );

  function budgetPct(cost: number | null | undefined, budget: number | null | undefined): number {
    if (cost == null || budget == null || budget <= 0) return 0;
    return Math.min(100, (cost / budget) * 100);
  }
</script>

<div class="csb" class:compact>
  <div class="pill-row">
    {#each pills as p (p.key)}
      <span class="pill {p.state}" title={p.label}>{p.label}</span>
    {/each}
    {#if terminalState}
      <span class="pill terminal {terminalState}" title={terminalState.toUpperCase()}>
        {terminalState === 'completed' ? '✓' : terminalState === 'failed' ? '✗' : '✕'}
      </span>
    {/if}
  </div>

  {#if !compact && costUsd != null && budgetUsd != null}
    <div class="burn-bar">
      <div class="burn-fill" style="width:{budgetPct(costUsd, budgetUsd)}%"></div>
    </div>
    <div class="burn-label">${costUsd.toFixed(2)} / ${budgetUsd.toFixed(2)}</div>
  {/if}
</div>

<style>
  .csb {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .pill-row {
    display: flex;
    gap: 3px;
    flex-wrap: nowrap;
    align-items: center;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    font-weight: 700;
    font-family: var(--font-mono, monospace);
    letter-spacing: 0.04em;
    border-radius: 3px;
    padding: 1px 5px;
    border: 1px solid transparent;
    line-height: 1.4;
    white-space: nowrap;
    transition: background 0.15s, color 0.15s;
  }

  /* Non-compact uses slightly larger pills */
  .csb:not(.compact) .pill {
    font-size: 11px;
    padding: 2px 7px;
  }

  .pill.pending {
    color: var(--color-text-muted, #6b7280);
    border-color: var(--color-border, rgba(255,255,255,0.08));
    background: transparent;
  }

  .pill.active {
    color: var(--color-info, #4a9eff);
    border-color: rgba(74, 158, 255, 0.4);
    background: rgba(74, 158, 255, 0.12);
    animation: pill-pulse 1.4s ease-in-out infinite;
  }

  .pill.done {
    color: var(--color-success, #4caf82);
    border-color: rgba(76, 175, 130, 0.3);
    background: rgba(76, 175, 130, 0.1);
  }

  .pill.failed {
    color: var(--color-danger, #e05a5a);
    border-color: rgba(224, 90, 90, 0.3);
    background: rgba(224, 90, 90, 0.08);
  }

  .pill.terminal {
    font-size: 10px;
    padding: 1px 4px;
  }

  .csb:not(.compact) .pill.terminal {
    font-size: 12px;
    padding: 2px 6px;
  }

  .pill.terminal.completed {
    color: var(--color-success, #4caf82);
    border-color: rgba(76, 175, 130, 0.5);
    background: rgba(76, 175, 130, 0.15);
  }

  .pill.terminal.failed {
    color: var(--color-danger, #e05a5a);
    border-color: rgba(224, 90, 90, 0.5);
    background: rgba(224, 90, 90, 0.12);
  }

  .pill.terminal.killed {
    color: var(--color-warning, #f5a623);
    border-color: rgba(245, 166, 35, 0.4);
    background: rgba(245, 166, 35, 0.1);
  }

  /* Burn bar (non-compact only) */
  .burn-bar {
    height: 4px;
    background: var(--color-surface-2, rgba(255,255,255,0.06));
    border-radius: 999px;
    overflow: hidden;
  }

  .burn-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--color-success, #4caf82), var(--color-info, #4a9eff));
    transition: width 0.3s ease;
  }

  .burn-label {
    font-size: 9px;
    font-family: var(--font-mono, monospace);
    color: var(--color-text-muted, #6b7280);
  }

  @keyframes pill-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }
</style>
