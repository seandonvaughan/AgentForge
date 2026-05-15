<script lang="ts">
  interface Props {
    value?: number;
    decimals?: number;
    duration?: number;
    prefix?: string;
    suffix?: string;
    mono?: boolean;
  }

  let {
    value = 0,
    decimals = 0,
    duration = 600,
    prefix = '',
    suffix = '',
    mono = true,
  }: Props = $props();

  let display = $state(value);
  let prevValue = value;
  let rafId: number | undefined;

  // Cubic-out easing
  function cubicOut(t: number): number {
    return 1 - Math.pow(1 - t, 3);
  }

  $effect(() => {
    const from = prevValue ?? 0;
    const to = value;

    // Skip animation in reduced-motion environments
    if (
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      display = to;
      prevValue = to;
      return;
    }

    if (rafId !== undefined) cancelAnimationFrame(rafId);
    const start = performance.now();

    function step(now: number) {
      const t = Math.min(1, (now - start) / duration);
      const eased = cubicOut(t);
      display = from + (to - from) * eased;
      if (t < 1) {
        rafId = requestAnimationFrame(step);
      } else {
        prevValue = to;
        rafId = undefined;
      }
    }

    rafId = requestAnimationFrame(step);
    return () => { if (rafId !== undefined) cancelAnimationFrame(rafId); };
  });
</script>

<span
  class:af2-mono={mono}
  style="font-variant-numeric:tabular-nums"
>
  {prefix}{display.toFixed(decimals)}{suffix}
</span>

<style>
  .af2-mono {
    font-family: var(--af-font-mono, 'JetBrains Mono', monospace);
    font-feature-settings: 'tnum' 1, 'ss01' 1;
  }
</style>
