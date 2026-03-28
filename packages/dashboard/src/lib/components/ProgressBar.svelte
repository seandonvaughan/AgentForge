<script lang="ts">
  export let value: number = 0;  // 0-100
  export let label: string = '';
  export let color: string = 'var(--color-brand)';
</script>

<div class="progress-bar">
  <div class="progress-bar-label">{label}</div>
  <div class="progress-bar-track">
    <div class="progress-bar-fill" style="width: {Math.min(Math.max(value, 0), 100)}%; background: {color}"></div>
  </div>
  <div class="progress-bar-value">{value}%</div>
</div>

<style>
  .progress-bar { display: flex; align-items: center; gap: var(--space-3); }
  .progress-bar-label { width: 120px; font-size: var(--text-sm); color: var(--color-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .progress-bar-track { flex: 1; height: 6px; background: var(--color-surface-2); border-radius: var(--radius-full); overflow: hidden; }
  .progress-bar-fill { height: 100%; border-radius: var(--radius-full); transition: width 0.3s ease; }
  .progress-bar-value { width: 40px; text-align: right; font-size: var(--text-sm); font-weight: 600; font-family: var(--font-mono); }
</style>
