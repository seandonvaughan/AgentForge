<script lang="ts">
  import { onDestroy } from 'svelte';

  // Props
  let {
    stage = 'unknown',
    costUsd = null,
    budgetUsd = null,
    startedAt = null,
    isTerminal = false,
    compact = false,
    /** Internal phase name (audit/plan/assign/test/review/gate/release/learn) for sub-step indicator. */
    activePhase = null,
    /** Completed internal phases for showing checkmark progress under macro pills. */
    completedPhases = [],
  }: {
    stage: string;
    costUsd?: number | null;
    budgetUsd?: number | null;
    startedAt?: string | null;
    isTerminal?: boolean;
    compact?: boolean;
    activePhase?: string | null;
    completedPhases?: string[];
  } = $props();

  /** Map macro stage → internal sub-phases. PLAN contains audit+plan, STAGE=assign, RUN=execute, VERIFY=test, COMMIT=review+gate, REVIEW=release+learn. */
  const MACRO_SUBPHASES: Record<string, string[]> = {
    PLAN: ['audit', 'plan'],
    STAGE: ['assign'],
    RUN: ['execute'],
    VERIFY: ['test'],
    COMMIT: ['review', 'gate'],
    REVIEW: ['release', 'learn'],
  };

  // The 6 canonical workflow stages
  const STAGES = ['PLAN', 'STAGE', 'RUN', 'VERIFY', 'COMMIT', 'REVIEW'] as const;
  type Stage = (typeof STAGES)[number];
  type StageState = 'pending' | 'active' | 'complete' | 'failed';

  // Map cycle.stage (lowercase enum) to the STAGES array index
  const STAGE_MAP: Record<string, number> = {
    plan:      0,
    stage:     1,
    run:       2,
    verify:    3,
    commit:    4,
    review:    5,
    completed: 5,
    failed:    -1,
    killed:    -1,
    crashed:   -1,
    unknown:   -1,
  };

  /** Derive which macro pill a dead cycle stopped on, given the internal phase artifacts. */
  function failedAtIndex(activeIntPhase: string | null, doneIntPhases: string[]): number {
    const phaseToMacro: Record<string, number> = {
      audit: 0, plan: 0, stage: 1, assign: 1, run: 2, execute: 2,
      verify: 3, test: 3, commit: 4, review: 4, gate: 4,
      release: 5, learn: 5,
    };
    if (activeIntPhase && phaseToMacro[activeIntPhase.toLowerCase()] !== undefined) {
      return phaseToMacro[activeIntPhase.toLowerCase()]!;
    }
    for (let i = doneIntPhases.length - 1; i >= 0; i--) {
      const m = phaseToMacro[doneIntPhases[i]!.toLowerCase()];
      if (m !== undefined) return Math.min(STAGES.length - 1, m + 1);
    }
    return 0;
  }

  function computeStates(rawStage: string, terminal: boolean, activeIntPhase: string | null, doneIntPhases: string[]): Record<Stage, StageState> {
    const key = rawStage.toLowerCase();
    const states: Record<Stage, StageState> = {
      PLAN: 'pending', STAGE: 'pending', RUN: 'pending',
      VERIFY: 'pending', COMMIT: 'pending', REVIEW: 'pending',
    };

    if (terminal && (key === 'completed' || key === 'review')) {
      for (const s of STAGES) states[s] = 'complete';
      return states;
    }

    // Failed/killed/crashed: mark stages reached as complete, the one it died on as failed.
    if (key === 'failed' || key === 'killed' || key === 'crashed') {
      const idx = failedAtIndex(activeIntPhase, doneIntPhases);
      for (let i = 0; i < STAGES.length; i++) {
        if (i < idx) states[STAGES[i]] = 'complete';
        else if (i === idx) states[STAGES[i]] = 'failed';
        else states[STAGES[i]] = 'pending';
      }
      return states;
    }

    const idx = STAGE_MAP[key] ?? -1;
    if (idx < 0) return states;

    for (let i = 0; i < STAGES.length; i++) {
      if (i < idx) states[STAGES[i]] = 'complete';
      else if (i === idx) states[STAGES[i]] = 'active';
      else states[STAGES[i]] = 'pending';
    }
    return states;
  }

  let stageStates = $derived(computeStates(stage, isTerminal, activePhase, completedPhases));

  // Elapsed timer
  let elapsedSec = $state(0);
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  $effect(() => {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (!isTerminal && startedAt) {
      const start = new Date(startedAt).getTime();
      elapsedSec = Math.floor((Date.now() - start) / 1000);
      tickTimer = setInterval(() => {
        elapsedSec = Math.floor((Date.now() - start) / 1000);
      }, 1000);
    } else if (startedAt) {
      // Terminal: show final elapsed
      elapsedSec = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
    }
  });

  onDestroy(() => {
    if (tickTimer) clearInterval(tickTimer);
  });

  function elapsedDisplay(): string {
    const m = Math.floor(elapsedSec / 60).toString().padStart(2, '0');
    const s = (elapsedSec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  let burnPct = $derived(() => {
    if (!budgetUsd || budgetUsd <= 0 || costUsd == null) return 0;
    return Math.min(100, (costUsd / budgetUsd) * 100);
  });
</script>

<div class="cycle-stage-bar" class:compact>
  <div class="bar-header">
    <div class="stage-row">
      {#each STAGES as s, i}
        <div class="stage-pill {stageStates[s]}" title={MACRO_SUBPHASES[s]?.join(' → ') ?? ''}>
          {#if !compact}
            <span class="stage-num">{i + 1}</span>
          {/if}
          <span class="stage-name">{s}</span>
          {#if stageStates[s] === 'complete'}
            <span class="stage-check">✓</span>
          {:else if stageStates[s] === 'failed'}
            <span class="stage-x">✕</span>
          {/if}
        </div>
        {#if i < STAGES.length - 1}
          <div class="stage-connector {stageStates[STAGES[i]] === 'complete' ? 'done' : stageStates[STAGES[i]] === 'failed' ? 'failed' : ''}"></div>
        {/if}
      {/each}
    </div>
    {#if !compact && startedAt}
      <span class="elapsed-clock">{elapsedDisplay()}</span>
    {/if}
  </div>

  {#if !compact && activePhase}
    <div class="subphase-row">
      {#each STAGES as s}
        {@const subs = MACRO_SUBPHASES[s] ?? []}
        {#if stageStates[s] === 'active' && subs.length > 0}
          <div class="subphase-group">
            {#each subs as sub}
              <span class="subphase-chip {completedPhases.includes(sub) ? 'done' : sub === activePhase ? 'running' : 'pending'}">
                {sub}
                {#if completedPhases.includes(sub)}<span class="subphase-mark">✓</span>{:else if sub === activePhase}<span class="subphase-mark spinner">●</span>{/if}
              </span>
            {/each}
          </div>
        {/if}
      {/each}
    </div>
  {/if}

  {#if !compact && (budgetUsd != null || costUsd != null)}
    <div class="burn-section">
      <div class="burn-label">
        <span>Budget burn</span>
        <span class="burn-amount">
          {costUsd != null ? `$${Number(costUsd).toFixed(2)}` : '—'}
          {#if budgetUsd != null} / ${Number(budgetUsd).toFixed(2)}{/if}
        </span>
      </div>
      <div class="burn-bar">
        <div class="burn-fill" style="width: {burnPct()}%"></div>
      </div>
    </div>
  {/if}
</div>

<style>
  .cycle-stage-bar {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface, var(--color-bg-card));
  }

  .bar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }

  /* ── Stage row ────────────────────────────────────────────────────────────── */
  .stage-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  /* Compact mode: keep everything on one row, shrink to fit. */
  .compact .stage-row {
    flex-wrap: nowrap;
    overflow: hidden;
    gap: 2px;
  }
  .compact {
    padding: var(--space-2) var(--space-3);
  }

  .stage-pill {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-full);
    border: 1px solid var(--color-border);
    background: var(--color-surface-1);
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
    transition: all var(--duration-fast);
  }

  .compact .stage-pill {
    padding: 2px 6px;
    font-size: 9px;
    letter-spacing: 0.02em;
    white-space: nowrap;
    flex: 0 1 auto;
    min-width: 0;
  }
  .compact .stage-check, .compact .stage-x {
    font-size: 9px;
  }

  .stage-pill .stage-num {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--color-surface-3);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-family: var(--font-mono);
  }

  .stage-pill.active {
    color: var(--color-info);
    border-color: rgba(74,158,255,0.5);
    background: rgba(74,158,255,0.08);
    animation: pulse 1.6s ease-in-out infinite;
  }
  .stage-pill.active .stage-num {
    background: var(--color-info);
    color: white;
  }

  .stage-pill.complete {
    color: var(--color-success);
    border-color: rgba(76,175,130,0.5);
    background: rgba(76,175,130,0.08);
  }
  .stage-pill.complete .stage-num {
    background: var(--color-success);
    color: white;
  }

  .stage-pill.failed {
    color: var(--color-danger, #e57373);
    border-color: rgba(229,115,115,0.55);
    background: rgba(229,115,115,0.10);
  }
  .stage-pill.failed .stage-num {
    background: var(--color-danger, #e57373);
    color: white;
  }

  .stage-check {
    color: var(--color-success);
    font-weight: 700;
  }
  .stage-x {
    color: var(--color-danger, #e57373);
    font-weight: 700;
  }

  .stage-connector {
    flex: 0 0 16px;
    height: 2px;
    background: var(--color-border);
    border-radius: 1px;
  }
  .compact .stage-connector {
    flex: 0 0 4px;
    height: 1px;
  }
  .stage-connector.done { background: var(--color-success); }
  .stage-connector.failed { background: var(--color-danger, #e57373); }

  /* ── Sub-phase indicator (full mode only) ──────────────────────────────────── */
  .subphase-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-top: var(--space-2);
    padding-left: 2px;
  }
  .subphase-group {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .subphase-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    font-size: 11px;
    font-family: var(--font-mono);
    text-transform: lowercase;
    background: var(--color-surface-1);
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
  }
  .subphase-chip.done {
    color: var(--color-success);
    background: rgba(76,175,130,0.06);
    border-color: rgba(76,175,130,0.3);
  }
  .subphase-chip.running {
    color: var(--color-info);
    background: rgba(74,158,255,0.08);
    border-color: rgba(74,158,255,0.4);
  }
  .subphase-mark { font-weight: 700; }
  .subphase-mark.spinner {
    animation: subphase-spinner 1.2s ease-in-out infinite;
  }
  @keyframes subphase-spinner {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }

  /* ── Elapsed clock ─────────────────────────────────────────────────────────── */
  .elapsed-clock {
    font-family: var(--font-mono);
    font-size: var(--text-md);
    color: var(--color-brand);
    font-weight: 600;
    flex-shrink: 0;
  }
  .compact .elapsed-clock {
    font-size: var(--text-sm);
  }

  /* ── Burn bar ──────────────────────────────────────────────────────────────── */
  .burn-section { margin-top: var(--space-3); }
  .burn-label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    margin-bottom: var(--space-2);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }
  .burn-amount {
    color: var(--color-text);
    font-family: var(--font-mono);
    text-transform: none;
    letter-spacing: 0;
  }
  .burn-bar {
    width: 100%;
    height: 8px;
    background: var(--color-surface-2);
    border-radius: var(--radius-full);
    overflow: hidden;
    border: 1px solid var(--color-border);
  }
  .burn-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--color-success), var(--color-info));
    transition: width var(--duration-normal, 200ms) ease;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.65; }
  }
  @media (prefers-reduced-motion: reduce) {
    .stage-pill.active { animation: none; }
  }
</style>
