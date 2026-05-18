<script lang="ts">
  /** Payload shape of typecheck-failure.json written by CycleLogger.logTypecheckFailure(). */
  export interface TypecheckFailure {
    stdout: string;
    stderr: string;
    files: string[];
    firstError: { file: string; line: number; message: string } | null;
    capturedAt: string;
  }

  interface Props {
    failure: TypecheckFailure;
  }

  let { failure }: Props = $props();

  let expanded = $state(false);

  function toggle(): void {
    expanded = !expanded;
  }

  // Prefer stdout for the expander body (tsc writes errors there).
  const body = $derived(failure.stdout || failure.stderr || '(no output captured)');
</script>

<div class="tc-banner" role="alert" aria-label="Typecheck failure">
  <div class="tc-header">
    <span class="tc-icon">✗</span>
    <div class="tc-title-group">
      <span class="tc-title">Typecheck failure</span>
      {#if failure.firstError}
        <span class="tc-file af2-mono"
          >{failure.firstError.file}:{failure.firstError.line} — {failure.firstError.message}</span
        >
      {:else}
        <span class="tc-file af2-mono">See details below</span>
      {/if}
    </div>
    <button type="button" class="tc-toggle" onclick={toggle} aria-expanded={expanded}>
      {expanded ? 'Hide output ▲' : 'Show output ▼'}
    </button>
  </div>

  {#if expanded}
    <div class="tc-body">
      <pre class="tc-pre">{body}</pre>
    </div>
  {/if}
</div>

<style>
  .tc-banner {
    border: 1px solid color-mix(in srgb, var(--af-danger) 35%, transparent);
    background: color-mix(in srgb, var(--af-danger) 6%, transparent);
    border-radius: 6px;
    margin-bottom: 14px;
    overflow: hidden;
  }

  .tc-header {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 14px;
  }

  .tc-icon {
    color: var(--af-danger);
    font-size: 14px;
    font-weight: 700;
    flex-shrink: 0;
    margin-top: 1px;
  }

  .tc-title-group {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .tc-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--af-danger);
  }

  .tc-file {
    font-size: 11px;
    color: var(--af-text);
    opacity: 0.85;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tc-toggle {
    flex-shrink: 0;
    background: none;
    border: 1px solid color-mix(in srgb, var(--af-danger) 30%, transparent);
    border-radius: 4px;
    color: var(--af-danger);
    font-size: 11px;
    font-weight: 600;
    padding: 3px 8px;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.12s;
  }

  .tc-toggle:hover {
    background: color-mix(in srgb, var(--af-danger) 10%, transparent);
  }

  .tc-body {
    border-top: 1px solid color-mix(in srgb, var(--af-danger) 20%, transparent);
    padding: 12px 14px;
    max-height: 320px;
    overflow-y: auto;
  }

  .tc-pre {
    margin: 0;
    font-family: var(--af-font-mono, monospace);
    font-size: 11px;
    line-height: 1.55;
    color: var(--af-text);
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>
