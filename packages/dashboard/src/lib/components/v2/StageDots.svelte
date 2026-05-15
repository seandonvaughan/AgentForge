<script lang="ts">
  type StageStatus = 'pending' | 'active' | 'done' | 'failed';
  type Size = 'sm' | 'md';

  interface Props {
    stages?: StageStatus[];
    size?: Size;
  }

  let { stages = [], size = 'sm' }: Props = $props();

  const height = $derived(size === 'sm' ? '12px' : '16px');
</script>

<div class="stage-dots">
  {#each stages as s, i (i)}
    <span
      class="stage-brick"
      class:brick-done={s === 'done'}
      class:brick-active={s === 'active'}
      class:brick-failed={s === 'failed'}
      style="height:{height}"
    ></span>
  {/each}
</div>

<style>
  .stage-dots {
    display: flex;
    gap: 1px;
    align-items: center;
  }

  .stage-brick {
    width: 7px;
    border-radius: 1px;
    background: var(--af-border2);
  }

  .brick-done   { background: var(--af-accent); }
  .brick-active { background: var(--af-purple); box-shadow: 0 0 4px var(--af-purple); }
  .brick-failed { background: var(--af-danger); }
</style>
