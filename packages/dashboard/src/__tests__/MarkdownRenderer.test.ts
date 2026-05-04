import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { transformWithEsbuild } from 'vite';

type RenderMarkdown = (content: string | null | undefined) => string;

let renderMarkdown: RenderMarkdown;

async function loadRenderMarkdown(): Promise<RenderMarkdown> {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const componentPath = resolve(testDir, '../lib/components/MarkdownRenderer.svelte');
  const markedPath = resolve(testDir, '../../node_modules/marked/lib/marked.esm.js');
  const source = await readFile(componentPath, 'utf8');
  const moduleScript = /<script module lang="ts">([\s\S]*?)<\/script>/.exec(source)?.[1];
  if (!moduleScript) throw new Error('MarkdownRenderer module script was not found');

  const transformedImports = moduleScript.replace(
    /from 'marked';/,
    `from '${pathToFileURL(markedPath).href}';`,
  );
  const { code } = await transformWithEsbuild(transformedImports, `${componentPath}.ts`, {
    format: 'esm',
    loader: 'ts',
    target: 'es2022',
  });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  const module = (await import(moduleUrl)) as { renderMarkdown: RenderMarkdown };
  return module.renderMarkdown;
}

describe('MarkdownRenderer', () => {
  beforeAll(async () => {
    renderMarkdown = await loadRenderMarkdown();
  });

  it('preserves common markdown output', () => {
    const html = renderMarkdown([
      '## Review',
      '',
      '- **Pass** normal lists',
      '- `inline code`',
      '',
      '| Name | Link |',
      '| --- | --- |',
      '| Docs | [Open](https://example.com/docs) |',
    ].join('\n'));

    expect(html).toContain('<h2>Review</h2>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<strong>Pass</strong>');
    expect(html).toContain('<code>inline code</code>');
    expect(html).toContain('<table>');
    expect(html).toContain('<a href="https://example.com/docs">Open</a>');
  });

  it('escapes raw script tags instead of rendering executable HTML', () => {
    const html = renderMarkdown('<script>alert(1)</script>');

    expect(html).not.toMatch(/<script\b/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes event handlers and inline styles in raw HTML', () => {
    const html = renderMarkdown('<button onclick="alert(1)" style="background:url(javascript:alert(1))">x</button>');

    expect(html).not.toMatch(/<button\b/i);
    expect(html).not.toMatch(/<[^>]+\son\w+=/i);
    expect(html).not.toMatch(/<[^>]+\sstyle=/i);
    expect(html).toContain('&lt;button');
  });

  it('blocks javascript URLs in markdown links', () => {
    const html = renderMarkdown('[click me](javascript:alert(1))');

    expect(html).not.toMatch(/<a\b/i);
    expect(html).not.toContain('javascript:');
    expect(html).toContain('click me');
  });

  it('blocks unsafe image and SVG payloads', () => {
    const html = renderMarkdown([
      '![bad](javascript:alert(1))',
      '![svg](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)',
      '<svg onload="alert(1)"><script>alert(1)</script></svg>',
    ].join('\n\n'));

    expect(html).not.toMatch(/<(img|svg|script)\b/i);
    expect(html).not.toMatch(/\s(?:src|href)="(?:javascript|data):/i);
    expect(html).not.toMatch(/<[^>]+\son\w+=/i);
    expect(html).toContain('bad');
    expect(html).toContain('svg');
    expect(html).toContain('&lt;svg');
  });

  it('handles the marked control-character DoS payload without throwing', () => {
    expect(() => renderMarkdown('\x09\x0b\n')).not.toThrow();
    expect(renderMarkdown('\x09\x0b\n')).not.toMatch(/<script|javascript:|on\w+=/i);
  });

  it('handles malformed URL entities without throwing', () => {
    expect(() => renderMarkdown('[bad](java&#9999999999;script:alert(1))')).not.toThrow();
    expect(renderMarkdown('[bad](java&#9999999999;script:alert(1))')).not.toMatch(/javascript:/i);
  });
});
