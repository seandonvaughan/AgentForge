<script lang="ts">
  interface Props {
    color?: string;
    size?: number;
    ring?: boolean;
  }

  let { color = 'var(--af-success)', size = 8, ring = true }: Props = $props();
</script>

<span
  class="pulse-wrap"
  style="width:{size}px;height:{size}px"
  aria-hidden="true"
>
  <span class="pulse-core" style="background:{color}"></span>
  {#if ring}
    <span class="pulse-ring" style="background:{color}"></span>
  {/if}
</span>

<style>
  .pulse-wrap {
    position: relative;
    display: inline-block;
    flex-shrink: 0;
  }

  .pulse-core {
    position: absolute;
    inset: 0;
    border-radius: 50%;
  }

  .pulse-ring {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    opacity: 0.5;
    animation: af2pulse 1.6s ease-out infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .pulse-ring { animation: none; opacity: 0; }
  }

  @keyframes af2pulse {
    0%   { transform: scale(1); opacity: 0.6; }
    100% { transform: scale(2.4); opacity: 0; }
  }
</style>
