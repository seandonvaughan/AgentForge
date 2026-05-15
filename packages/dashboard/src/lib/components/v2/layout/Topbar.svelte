<script lang="ts">
  import { goto } from '$app/navigation';
  import { Search, ChevronRight } from 'lucide-svelte';

  // ── Types ──────────────────────────────────────────────────────────────
  type StageStatus = 'done' | 'active' | 'failed' | 'pending';

  interface RunningCycle {
    id: string;
    short: string;
    stages: StageStatus[];
    elapsedDisplay: string;
    costUsd: number;
    budgetUsd: number;
  }

  interface CyclesResponse {
    data: Array<{
      cycleId: string;
      short?: string;
      stages?: StageStatus[];
      elapsedMs?: number;
      costUsd?: number;
      budgetUsd?: number;
      status?: string;
    }>;
  }

  // ── State ──────────────────────────────────────────────────────────────
  let runningCycle: RunningCycle | null = $state(null);

  // ── Polling: active cycle ──────────────────────────────────────────────
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function msToDisplay(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  async function fetchActiveCycle(): Promise<void> {
    if (document.visibilityState === 'hidden') return;
    try {
      const res = await fetch('/api/v5/cycles?limit=1&status=running');
      if (!res.ok) return;
      const json: CyclesResponse = await res.json() as CyclesResponse;
      const c = json.data?.[0];
      if (c && c.status === 'running') {
        runningCycle = {
          id: c.cycleId,
          short: c.short ?? c.cycleId.slice(0, 8),
          stages: c.stages ?? Array(6).fill('pending' as StageStatus),
          elapsedDisplay: c.elapsedMs != null ? msToDisplay(c.elapsedMs) : '—',
          costUsd: c.costUsd ?? 0,
          budgetUsd: c.budgetUsd ?? 20,
        };
      } else {
        runningCycle = null;
      }
    } catch {
      // Silently ignore network errors during polling
    }
  }

  $effect(() => {
    void fetchActiveCycle();
    pollTimer = setInterval(() => void fetchActiveCycle(), 5000);

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void fetchActiveCycle();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      if (pollTimer !== null) clearInterval(pollTimer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  });

  // ── Reduced motion ─────────────────────────────────────────────────────
  const reducedMotion = $derived(
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );

  // ── Navigate to cycle ──────────────────────────────────────────────────
  function openCycle(): void {
    if (runningCycle) void goto(`/cycles/${runningCycle.id}`);
  }

  // ── Stage brick colour ─────────────────────────────────────────────────
  function brickBg(s: StageStatus): string {
    if (s === 'done') return 'var(--af-accent)';
    if (s === 'active') return 'var(--af-purple)';
    if (s === 'failed') return 'var(--af-danger)';
    return 'var(--af-border2)';
  }
</script>

<header class="topbar">
  <!-- Left: logo + search -->
  <div class="topbar-left">
    <button class="logo-btn" onclick={() => void goto('/')} aria-label="AgentForge home">
      <span class="logo-mark" aria-hidden="true">◣</span>
      <span class="logo-text">AgentForge</span>
    </button>

    <!-- Search -->
    <div class="search-wrap" role="search">
      <Search size={13} class="search-icon" aria-hidden="true" />
      <span class="search-placeholder">Search cycles, agents, sessions…</span>
      <kbd class="search-kbd">⌘K</kbd>
    </div>
  </div>

  <!-- Right: running-cycle widget + avatar -->
  <div class="topbar-right">
    {#if runningCycle !== null}
      {@const c = runningCycle}
      <button
        class="cycle-widget"
        onclick={openCycle}
        aria-label="Open running cycle {c.short}"
      >
        <span
          class="pulse-dot"
          class:pulse-anim={!reducedMotion}
          aria-hidden="true"
        ></span>
        <span class="cycle-label font-mono">RUN</span>
        <span class="cycle-short font-mono">{c.short}</span>

        <!-- Stage bricks -->
        <span class="stage-bricks" aria-label="Pipeline stages" role="img">
          {#each c.stages as stage, i (i)}
            <span
              class="brick"
              class:brick-active={stage === 'active' && !reducedMotion}
              style="background:{brickBg(stage)};"
            ></span>
          {/each}
        </span>

        <span class="cycle-elapsed font-mono">{c.elapsedDisplay}</span>
        <span class="sep" aria-hidden="true"></span>
        <span class="cycle-cost font-mono">${c.costUsd.toFixed(2)}</span>
        <span class="cycle-budget font-mono">/${c.budgetUsd}</span>
        <span class="cycle-open-pill">
          View <ChevronRight size={10} aria-hidden="true" />
        </span>
      </button>
    {/if}

    <!-- Help -->
    <button class="icon-btn" aria-label="Help">?</button>

    <!-- Avatar -->
    <div class="avatar" aria-label="User menu" role="img">SV</div>
  </div>
</header>

<style>
  .topbar {
    grid-column: 1 / -1;
    grid-row: 1 / 2;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 18px;
    border-bottom: 1px solid var(--af-border);
    background: var(--af-bg);
    height: 44px;
    z-index: 20;
  }

  .topbar-left {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  /* Logo */
  .logo-btn {
    display: flex;
    align-items: center;
    gap: 10px;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
    flex-shrink: 0;
  }

  .logo-mark {
    width: 22px;
    height: 22px;
    border-radius: 5px;
    background: var(--af-grad, linear-gradient(135deg, #6366f1, #a855f7));
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-weight: 800;
    font-size: 11px;
    line-height: 1;
    flex-shrink: 0;
  }

  .logo-text {
    font-weight: 600;
    font-size: 13px;
    color: var(--af-text);
    letter-spacing: -0.005em;
    white-space: nowrap;
  }

  /* Search */
  .search-wrap {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 10px;
    background: var(--af-surface);
    border: 1px solid var(--af-border2);
    border-radius: 6px;
    min-width: 300px;
    height: 28px;
    cursor: pointer;
    color: var(--af-faint);
    font-size: 12px;
    transition: border-color 150ms ease;
  }

  .search-wrap:hover {
    border-color: var(--af-border3);
  }

  :global(.search-icon) {
    flex-shrink: 0;
    color: var(--af-faint);
  }

  .search-placeholder {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--af-faint);
  }

  .search-kbd {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    padding: 1px 5px;
    background: var(--af-border);
    border-radius: 3px;
    color: var(--af-dim);
    flex-shrink: 0;
  }

  /* Right cluster */
  .topbar-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* Running cycle widget */
  .cycle-widget {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 4px 0 10px;
    background: var(--af-surface);
    border: 1px solid var(--af-border2);
    border-radius: 7px;
    height: 30px;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 150ms ease;
  }

  .cycle-widget:hover {
    border-color: var(--af-border3);
  }

  /* Pulse dot */
  .pulse-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--af-purple);
    position: relative;
    flex-shrink: 0;
  }

  .pulse-anim::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: var(--af-purple);
    opacity: 0.5;
    animation: topbar-pulse 1.6s ease-out infinite;
  }

  @keyframes topbar-pulse {
    0%  { transform: scale(1); opacity: 0.6; }
    100% { transform: scale(2.4); opacity: 0; }
  }

  .cycle-label {
    font-size: 10px;
    color: var(--af-purple);
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  .cycle-short {
    font-size: 11px;
    color: var(--af-text);
    font-weight: 600;
  }

  .stage-bricks {
    display: flex;
    gap: 2px;
    align-items: center;
  }

  .brick {
    width: 12px;
    height: 4px;
    border-radius: 1px;
    flex-shrink: 0;
    transition: box-shadow 200ms ease;
  }

  .brick-active {
    box-shadow: 0 0 4px var(--af-purple);
  }

  .cycle-elapsed {
    font-size: 11px;
    color: var(--af-muted);
  }

  .sep {
    width: 1px;
    height: 14px;
    background: var(--af-border2);
    flex-shrink: 0;
  }

  .cycle-cost {
    font-size: 11px;
    color: var(--af-text);
    font-weight: 600;
  }

  .cycle-budget {
    font-size: 10px;
    color: var(--af-faint);
  }

  .cycle-open-pill {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 8px;
    height: 22px;
    background: var(--af-border);
    border-radius: 4px;
    color: var(--af-text);
    font-size: 10px;
    font-weight: 500;
    white-space: nowrap;
  }

  /* Icon button */
  .icon-btn {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    background: var(--af-surface);
    border: 1px solid var(--af-border2);
    color: var(--af-dim);
    font-size: 13px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: inherit;
    transition: border-color 150ms ease, color 150ms ease;
  }

  .icon-btn:hover {
    color: var(--af-muted);
    border-color: var(--af-border3);
  }

  /* Avatar */
  .avatar {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: var(--af-grad, linear-gradient(135deg, #6366f1, #a855f7));
    font-size: 10px;
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    flex-shrink: 0;
    cursor: pointer;
    font-family: 'JetBrains Mono', monospace;
  }

  .font-mono {
    font-family: 'JetBrains Mono', monospace;
    font-feature-settings: 'tnum' 1;
    font-variant-numeric: tabular-nums;
  }
</style>
