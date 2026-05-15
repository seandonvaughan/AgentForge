<script lang="ts">
  type StageStatus = 'pending' | 'active' | 'done' | 'failed';

  interface PhaseInfo {
    durMs?: number;
    agent?: string;
  }

  interface Props {
    stages?: StageStatus[];
    phases?: PhaseInfo[];
    compact?: boolean;
    showAgent?: boolean;
  }

  const NAMES = ['PLAN', 'STAGE', 'RUN', 'VERIFY', 'COMMIT', 'REVIEW'] as const;

  let {
    stages = [],
    phases = [],
    compact = false,
    showAgent = false,
  }: Props = $props();

  function fmtDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }
</script>

<div class="stage-rail">
  {#each NAMES as name, i}
    {@const s = stages[i] ?? 'pending'}
    {@const p = phases[i]}
    {@const isActive = s === 'active'}
    {@const isDone = s === 'done'}
    {@const isFailed = s === 'failed'}

    <div class="stage-item">
      <!-- Track -->
      <div
        class="stage-track"
        class:track-done={isDone}
        class:track-active={isActive}
      >
        {#if isActive}
          <div class="track-flow"></div>
        {/if}
      </div>

      <!-- Node -->
      <div
        class="stage-node"
        class:node-done={isDone}
        class:node-active={isActive}
        class:node-failed={isFailed}
        style={i === 0 ? 'left:0' : 'left:calc(50% - 8px)'}
      >
        {#if isDone}
          <span class="node-check">&#10003;</span>
        {:else if isFailed}
          <span class="node-x">&#x2717;</span>
        {:else if isActive}
          <span class="node-dot"></span>
        {/if}
      </div>

      {#if !compact}
        <!-- Label row -->
        <div class="stage-label-wrap">
          <div
            class="stage-label af2-mono"
            class:label-active={isActive}
            class:label-done={isDone}
            class:label-failed={isFailed}
          >
            {name}
          </div>
          {#if p?.durMs}
            <div class="stage-dur af2-mono">{fmtDuration(p.durMs)}</div>
          {:else}
            <div class="stage-dur"></div>
          {/if}
          {#if showAgent && p?.agent}
            <div class="stage-agent af2-mono">{p.agent}</div>
          {/if}
        </div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .stage-rail {
    display: flex;
    align-items: stretch;
    gap: 0;
    position: relative;
    flex: 1;
  }

  .stage-item {
    flex: 1;
    position: relative;
  }

  .stage-track {
    height: 2px;
    margin-top: 7px;
    background: var(--af-border);
    position: relative;
    overflow: hidden;
  }

  .track-done { background: var(--af-accent); }
  .track-active { background: transparent; }

  .track-flow {
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, var(--af-accent), var(--af-purple), var(--af-accent));
    background-size: 200% 100%;
    animation: af2flow 2.5s linear infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .track-flow { animation: none; background: var(--af-accent); }
  }

  .stage-node {
    position: absolute;
    top: 0;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    box-sizing: border-box;
    background: var(--af-surface);
    border: 2px solid var(--af-border3);
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-size: 9px;
    font-weight: 700;
  }

  .node-done {
    background: var(--af-accent);
    border-color: var(--af-accent);
  }

  .node-active {
    border-color: var(--af-purple);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--af-purple) 13%, transparent);
  }

  .node-failed { border-color: var(--af-danger); }

  .node-check, .node-x { font-size: 9px; }

  .node-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--af-purple);
  }

  .stage-label-wrap { padding-top: 14px; }

  .stage-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: var(--af-faint);
  }

  .label-active { color: var(--af-purple); }
  .label-done   { color: var(--af-text); }
  .label-failed { color: var(--af-danger); }

  .stage-dur {
    font-size: 9px;
    color: var(--af-dim);
    margin-top: 2px;
    height: 12px;
  }

  .stage-agent {
    font-size: 9px;
    color: var(--af-faint);
    margin-top: 1px;
  }

  .af2-mono {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1, 'ss01' 1;
  }

  @keyframes af2flow {
    0%   { background-position: 0% 50%; }
    100% { background-position: 200% 50%; }
  }
</style>
