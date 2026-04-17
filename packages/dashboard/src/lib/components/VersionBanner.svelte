<script lang="ts">
  import { versionFull } from '$lib/stores/version.js';

  const changelogHref =
    'https://github.com/seandonvaughan/AgentForge/blob/main/CHANGELOG.md';
</script>

<div class="version-banner" aria-label="AgentForge version information">
  <span class="version-banner__label">AgentForge</span>
  {#if $versionFull === '…'}
    <span class="version-banner__version version-banner__version--loading" aria-busy="true">
      v…
    </span>
  {:else}
    <span class="version-banner__version">
      v{$versionFull}
    </span>
  {/if}
  <a
    class="version-banner__changelog"
    href={changelogHref}
    target="_blank"
    rel="noopener noreferrer"
    title="Open CHANGELOG for v{$versionFull}"
    aria-label="View CHANGELOG for version {$versionFull}"
  >
    changelog ↗
  </a>
</div>

<style>
  .version-banner {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3);
    border-top: 1px solid var(--color-border);
    background: var(--color-bg);
  }

  .version-banner__label {
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    color: var(--color-text-faint);
    flex-shrink: 0;
  }

  .version-banner__version {
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    font-weight: 600;
    color: var(--color-brand);
    background: rgba(91, 138, 245, 0.1);
    border: 1px solid rgba(91, 138, 245, 0.2);
    border-radius: var(--radius-sm);
    padding: 1px 5px;
    flex-shrink: 0;
    line-height: 1.5;
  }

  .version-banner__version--loading {
    color: var(--color-text-faint);
    background: rgba(255, 255, 255, 0.03);
    border-color: var(--color-border);
    animation: version-pulse 1.5s ease-in-out infinite;
  }

  .version-banner__changelog {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    text-decoration: none;
    margin-left: auto;
    flex-shrink: 0;
    transition: color var(--duration-fast);
  }

  .version-banner__changelog:hover {
    color: var(--color-brand-hover);
    text-decoration: underline;
  }

  @keyframes version-pulse {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.4; }
  }

  @media (prefers-reduced-motion: reduce) {
    .version-banner__version--loading { animation: none; }
    .version-banner__changelog { transition: none; }
  }
</style>
