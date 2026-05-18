<script lang="ts">
  /**
   * SkillLadder.svelte
   *
   * Renders each skill_id with its mean quality delta vs same agent without
   * that skill. Positive delta → green bar, negative → red.
   *
   * Props:
   *   entries — array of { skillId, delta, sampleSize }
   */

  interface LadderEntry {
    skillId: string;
    delta: number;       // positive = improvement
    sampleSize: number;
  }

  interface Props {
    entries?: LadderEntry[];
  }

  let { entries = [] }: Props = $props();

  const sorted = $derived([...entries].sort((a, b) => b.delta - a.delta));

  const maxAbs = $derived(
    sorted.length > 0 ? Math.max(...sorted.map(e => Math.abs(e.delta))) : 1,
  );

  function pct(delta: number): number {
    return (Math.abs(delta) / (maxAbs || 1)) * 100;
  }

  function fmtDelta(v: number): string {
    const sign = v >= 0 ? '+' : '';
    return `${sign}${v.toFixed(1)}`;
  }
</script>

<div class="skill-ladder">
  {#if sorted.length === 0}
    <div class="empty">No skill-effectiveness data available.</div>
  {:else}
    {#each sorted as entry (entry.skillId)}
      {@const positive = entry.delta >= 0}
      <div class="ladder-row">
        <span class="skill-id">{entry.skillId}</span>
        <div class="bar-track">
          <div
            class="bar-fill"
            class:positive
            class:negative={!positive}
            style="width:{pct(entry.delta)}%"
            aria-label="{entry.skillId} delta {fmtDelta(entry.delta)}"
          ></div>
        </div>
        <span class="delta" class:pos={positive} class:neg={!positive}>{fmtDelta(entry.delta)}</span>
        <span class="samples">n={entry.sampleSize}</span>
      </div>
    {/each}
  {/if}
</div>

<style>
  .skill-ladder {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .empty {
    font-size: 12px;
    color: var(--af-dim);
    padding: 8px 0;
  }

  .ladder-row {
    display: grid;
    grid-template-columns: 160px 1fr 48px 48px;
    align-items: center;
    gap: 8px;
    min-height: 22px;
  }

  .skill-id {
    font-size: 11px;
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    color: var(--af-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bar-track {
    height: 6px;
    background: var(--af-surface2, #1e1e1e);
    border-radius: 3px;
    overflow: hidden;
  }

  .bar-fill {
    height: 100%;
    border-radius: 3px;
    transition: width 400ms ease;
    min-width: 2px;
  }

  .bar-fill.positive {
    background: var(--af-success);
  }

  .bar-fill.negative {
    background: var(--af-danger, #e05353);
  }

  .delta {
    font-size: 11px;
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    text-align: right;
    font-weight: 600;
  }

  .delta.pos { color: var(--af-success); }
  .delta.neg { color: var(--af-danger, #e05353); }

  .samples {
    font-size: 10px;
    color: var(--af-faint);
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    text-align: right;
  }
</style>
