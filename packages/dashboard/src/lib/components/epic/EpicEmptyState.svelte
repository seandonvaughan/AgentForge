<script lang="ts">
  interface Props {
    title?: string;
    message?: string;
    class?: string;
  }

  let {
    title = 'Artifact not generated yet',
    message = 'No decomposition or spend report has been generated for this cycle yet.',
    class: className = '',
  }: Props = $props();
</script>

<section class={['epic-empty-state', className].filter(Boolean).join(' ')} aria-label={title}>
  <div class="epic-empty-icon" aria-hidden="true">∅</div>
  <p class="epic-empty-title">{title}</p>
  <p class="epic-empty-message">{message}</p>
</section>

<style>
  .epic-empty-state {
    display: flex;
    min-height: 180px;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2, 8px);
    padding: var(--space-8, 32px) var(--space-4, 16px);
    border: 1px dashed color-mix(in srgb, var(--color-border, var(--af-border, #2a2f3a)) 70%, transparent);
    border-radius: var(--radius-2, 8px);
    background: color-mix(in srgb, var(--color-surface, var(--af-surface, #111827)) 72%, transparent);
    color: var(--color-muted, var(--af-muted, #9ca3af));
    text-align: center;
  }

  .epic-empty-icon {
    color: var(--color-faint, var(--af-faint, #6b7280));
    font-size: 28px;
    line-height: 1;
  }

  .epic-empty-title,
  .epic-empty-message {
    margin: 0;
  }

  .epic-empty-title {
    color: var(--color-text, var(--af-text, #f9fafb));
    font-size: 13px;
    font-weight: 600;
  }

  .epic-empty-message {
    max-width: 360px;
    color: var(--color-dim, var(--af-dim, #9ca3af));
    font-size: 12px;
    line-height: 1.5;
  }
</style>
