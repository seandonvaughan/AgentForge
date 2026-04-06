import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PROpener, PROpenerError } from '../../../packages/core/src/autonomous/exec/pr-opener.js';

describe('PROpener', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dry-run returns synthetic URL without subprocess', async () => {
    const opener = new PROpener('/tmp/test');
    const result = await opener.open({
      branch: 'autonomous/v6.4.0',
      baseBranch: 'main',
      title: 'test',
      body: 'body',
      draft: false,
      labels: ['autonomous'],
      dryRun: true,
    });
    expect(result.url).toMatch(/^https:\/\/github\.com\//);
    expect(result.number).toBe(1);
  });

  it('dry-run preserves draft flag in result', async () => {
    const opener = new PROpener('/tmp/test');
    const result = await opener.open({
      branch: 'autonomous/v6.4.0',
      baseBranch: 'main',
      title: 'test',
      body: 'body',
      draft: true,
      labels: [],
      dryRun: true,
    });
    expect(result.draft).toBe(true);
  });

  it('renderArgs builds correct gh pr create arguments', () => {
    const opener = new PROpener('/tmp/test');
    const args = opener.renderArgs({
      branch: 'autonomous/v6.4.0',
      baseBranch: 'main',
      title: 'autonomous(v6.4.0): test',
      body: 'body',
      draft: false,
      labels: ['autonomous', 'needs-review'],
      reviewers: ['seandonvaughan'],
    });
    expect(args).toContain('pr');
    expect(args).toContain('create');
    expect(args).toContain('--title');
    expect(args).toContain('autonomous(v6.4.0): test');
    expect(args).toContain('--body-file');
    expect(args).toContain('-');
    expect(args).toContain('--base');
    expect(args).toContain('main');
    expect(args).toContain('--head');
    expect(args).toContain('autonomous/v6.4.0');
    expect(args).toContain('--label');
    expect(args).toContain('autonomous');
    expect(args).toContain('needs-review');
    expect(args).toContain('--reviewer');
    expect(args).toContain('seandonvaughan');
  });

  it('renderArgs includes --draft when draft=true', () => {
    const opener = new PROpener('/tmp/test');
    const args = opener.renderArgs({
      branch: 'x',
      baseBranch: 'main',
      title: 't',
      body: 'b',
      draft: true,
      labels: [],
    });
    expect(args).toContain('--draft');
  });

  it('renderArgs does not include --draft when draft=false', () => {
    const opener = new PROpener('/tmp/test');
    const args = opener.renderArgs({
      branch: 'x',
      baseBranch: 'main',
      title: 't',
      body: 'b',
      draft: false,
      labels: [],
    });
    expect(args).not.toContain('--draft');
  });

  it('parsePrNumber extracts number from URL', () => {
    const opener = new PROpener('/tmp/test');
    expect(opener.parsePrNumber('https://github.com/owner/repo/pull/42')).toBe(42);
    expect(opener.parsePrNumber('https://github.com/o/r/pull/1234')).toBe(1234);
  });

  it('parsePrNumber throws on malformed URL', () => {
    const opener = new PROpener('/tmp/test');
    expect(() => opener.parsePrNumber('not-a-url')).toThrow();
  });
});
