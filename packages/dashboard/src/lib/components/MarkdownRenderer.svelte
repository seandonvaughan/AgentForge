<script module lang="ts">
  // Create a single shared Marked instance - avoids mutating the global
  // marked singleton on each component mount, which is the correct pattern
  // for marked v7+. async: false ensures parse() always returns string
  // synchronously (no Promise wrapping, safe for Svelte $derived).
  import { Marked, type RendererThis, type Tokens } from 'marked';

  const LINK_PROTOCOLS = new Set(['http', 'https', 'mailto', 'tel']);
  const IMAGE_PROTOCOLS = new Set(['http', 'https']);
  const HTML_ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  function escapeHtml(value: string | null | undefined): string {
    return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
  }

  function entityCodePointToString(point: number): string {
    return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
      ? String.fromCodePoint(point)
      : '';
  }

  function decodeHtmlEntities(value: string): string {
    return value
      .replace(/&#(\d+);?/g, (_, code: string) => {
        const point = Number(code);
        return entityCodePointToString(point);
      })
      .replace(/&#x([0-9a-f]+);?/gi, (_, code: string) => {
        const point = Number.parseInt(code, 16);
        return entityCodePointToString(point);
      })
      .replace(/&(colon|tab|newline);?/gi, (_, entity: string) => {
        const normalized = entity.toLowerCase();
        if (normalized === 'colon') return ':';
        if (normalized === 'tab') return '\t';
        if (normalized === 'newline') return '\n';
        return '';
      });
  }

  function protocolFor(url: string): string | null {
    const normalized = decodeHtmlEntities(url).trim().replace(/[\u0000-\u001F\u007F\s]+/g, '');
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(normalized);
    return match ? match[1]!.toLowerCase() : null;
  }

  function safeUrl(url: string, allowedProtocols: Set<string>): string | null {
    const trimmed = url.trim();
    const protocol = protocolFor(trimmed);
    return protocol === null || allowedProtocols.has(protocol) ? trimmed : null;
  }

  const _renderer = new Marked({
    gfm: true,
    breaks: false,
    async: false,
    renderer: {
      html({ text }: Tokens.HTML | Tokens.Tag): string {
        return escapeHtml(text);
      },
      link(this: RendererThis, { href, title, tokens }: Tokens.Link): string {
        const text = this.parser.parseInline(tokens);
        const url = safeUrl(href, LINK_PROTOCOLS);
        if (url === null) return text;

        const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
        return `<a href="${escapeHtml(url)}"${titleAttr}>${text}</a>`;
      },
      image(this: RendererThis, { href, title, text, tokens }: Tokens.Image): string {
        const alt = tokens ? this.parser.parseInline(tokens, this.parser.textRenderer) : text;
        const url = safeUrl(href, IMAGE_PROTOCOLS);
        if (url === null) return escapeHtml(alt);

        const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
        return `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}"${titleAttr}>`;
      },
    },
  });

  export function renderMarkdown(content: string | null | undefined): string {
    return content ? (_renderer.parse(content) as string) : '';
  }
</script>

<script lang="ts">
  interface Props {
    content: string | null | undefined;
    /** Optional CSS class forwarded to the wrapper element */
    class?: string;
  }
  let { content, class: className = '' }: Props = $props();

  // Derive rendered HTML reactively - if content changes, re-render.
  // _renderer.parse() returns string (not Promise) because async: false.
  let html = $derived(renderMarkdown(content));
</script>

{#if html}
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  <div class="md-body {className}">
    {@html html}
  </div>
{/if}

<style>
  /* Scoped markdown typography — uses the dashboard's CSS variables */
  .md-body {
    font-size: var(--text-sm);
    line-height: 1.7;
    color: var(--color-text);
    overflow-wrap: break-word;
  }

  /* Headings */
  .md-body :global(h1),
  .md-body :global(h2),
  .md-body :global(h3),
  .md-body :global(h4) {
    margin: var(--space-4) 0 var(--space-2);
    font-weight: 600;
    color: var(--color-text);
    line-height: 1.3;
  }
  .md-body :global(h1) { font-size: var(--text-lg); }
  .md-body :global(h2) { font-size: var(--text-md); border-bottom: 1px solid var(--color-border); padding-bottom: var(--space-1); }
  .md-body :global(h3) { font-size: var(--text-sm); }
  .md-body :global(h4) { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-text-muted); }

  /* Paragraphs */
  .md-body :global(p) {
    margin: 0 0 var(--space-3);
  }
  .md-body :global(p:last-child) { margin-bottom: 0; }

  /* Lists */
  .md-body :global(ul),
  .md-body :global(ol) {
    margin: 0 0 var(--space-3) var(--space-5);
    padding: 0;
  }
  .md-body :global(li) { margin-bottom: var(--space-1); }
  .md-body :global(li:last-child) { margin-bottom: 0; }

  /* Inline code */
  .md-body :global(code) {
    font-family: var(--font-mono);
    font-size: 0.875em;
    background: var(--color-surface-2);
    padding: 1px 5px;
    border-radius: var(--radius-sm);
    color: var(--color-text);
  }

  /* Code blocks */
  .md-body :global(pre) {
    background: var(--color-surface-2);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    overflow: auto;
    max-height: 320px;
    margin: 0 0 var(--space-3);
  }
  .md-body :global(pre code) {
    background: transparent;
    padding: 0;
    font-size: var(--text-xs);
    line-height: 1.5;
  }

  /* Blockquotes */
  .md-body :global(blockquote) {
    margin: 0 0 var(--space-3);
    padding: var(--space-2) var(--space-4);
    border-left: 3px solid var(--color-brand);
    background: rgba(74,158,255,0.05);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    color: var(--color-text-muted);
  }

  /* Tables */
  .md-body :global(table) {
    border-collapse: collapse;
    width: 100%;
    font-size: var(--text-xs);
    margin-bottom: var(--space-3);
  }
  .md-body :global(th),
  .md-body :global(td) {
    border: 1px solid var(--color-border);
    padding: var(--space-2) var(--space-3);
    text-align: left;
  }
  .md-body :global(th) {
    background: var(--color-surface-2);
    font-weight: 600;
  }
  .md-body :global(tr:nth-child(even)) { background: var(--color-bg-elevated); }

  /* Horizontal rules */
  .md-body :global(hr) {
    border: none;
    border-top: 1px solid var(--color-border);
    margin: var(--space-4) 0;
  }

  /* Strong / emphasis */
  .md-body :global(strong) { font-weight: 600; color: var(--color-text); }
  .md-body :global(em) { color: var(--color-text-muted); }

  /* Links */
  .md-body :global(a) {
    color: var(--color-info);
    text-decoration: none;
  }
  .md-body :global(a:hover) { text-decoration: underline; }
</style>
