import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PROpener, PROpenerError } from '../../../packages/core/src/autonomous/exec/pr-opener.js';

// Mock child_process so `open()` can be exercised without touching real gh.
vi.mock('node:child_process', () => {
  return {
    execFile: (cmd: string, args: string[], opts: any, cb: any) => {
      const callback = typeof opts === 'function' ? opts : cb;
      // Succeed for gh --version and gh auth status
      if (args[0] === '--version' || (args[0] === 'auth' && args[1] === 'status')) {
        callback(null, { stdout: 'ok', stderr: '' });
        return;
      }
      // Succeed for gh pr create — capture args on a global for assertion.
      if (args[0] === 'pr' && args[1] === 'create') {
        (globalThis as any).__lastPrCreateArgs = args;
        callback(null, {
          stdout: 'https://github.com/owner/repo/pull/99\n',
          stderr: '',
        });
        return;
      }
      callback(new Error(`unmocked gh call: ${args.join(' ')}`));
    },
  };
});

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

  describe('bug #5: self-reviewer filtering', () => {
    beforeEach(() => {
      (globalThis as any).__lastPrCreateArgs = undefined;
    });

    it('filters the authenticated user from reviewers list', async () => {
      const warnings: string[] = [];
      const opener = new PROpener('/tmp/test', {
        getAuthUser: async () => 'seandonvaughan',
        getRepoLabels: async () => [],
        onWarn: (m) => warnings.push(m),
      });
      await opener.open({
        branch: 'x',
        baseBranch: 'main',
        title: 't',
        body: 'b',
        draft: false,
        labels: [],
        reviewers: ['seandonvaughan', 'otheruser'],
      });
      const args: string[] = (globalThis as any).__lastPrCreateArgs;
      expect(args).toContain('--reviewer');
      expect(args).toContain('otheruser');
      expect(args).not.toContain('seandonvaughan');
      expect(warnings.some((w) => w.includes('seandonvaughan'))).toBe(true);
    });

    it('omits --reviewer entirely when filtered list is empty', async () => {
      const opener = new PROpener('/tmp/test', {
        getAuthUser: async () => 'seandonvaughan',
        getRepoLabels: async () => [],
      });
      await opener.open({
        branch: 'x',
        baseBranch: 'main',
        title: 't',
        body: 'b',
        draft: false,
        labels: [],
        reviewers: ['seandonvaughan'],
      });
      const args: string[] = (globalThis as any).__lastPrCreateArgs;
      expect(args).not.toContain('--reviewer');
    });

    it('passes valid non-author reviewers through unchanged', async () => {
      const opener = new PROpener('/tmp/test', {
        getAuthUser: async () => 'seandonvaughan',
        getRepoLabels: async () => [],
      });
      await opener.open({
        branch: 'x',
        baseBranch: 'main',
        title: 't',
        body: 'b',
        draft: false,
        labels: [],
        reviewers: ['alice', 'bob'],
      });
      const args: string[] = (globalThis as any).__lastPrCreateArgs;
      const reviewerIdxs = args
        .map((a, i) => (a === '--reviewer' ? i : -1))
        .filter((i) => i >= 0);
      expect(reviewerIdxs.length).toBe(2);
      expect(args).toContain('alice');
      expect(args).toContain('bob');
    });

    it('does not call getAuthUser when no reviewers requested', async () => {
      let called = false;
      const opener = new PROpener('/tmp/test', {
        getAuthUser: async () => {
          called = true;
          return 'seandonvaughan';
        },
        getRepoLabels: async () => [],
      });
      await opener.open({
        branch: 'x',
        baseBranch: 'main',
        title: 't',
        body: 'b',
        draft: false,
        labels: [],
      });
      expect(called).toBe(false);
      const args: string[] = (globalThis as any).__lastPrCreateArgs;
      expect(args).not.toContain('--reviewer');
    });
  });

  describe('bug #6: unknown label filtering', () => {
    beforeEach(() => {
      (globalThis as any).__lastPrCreateArgs = undefined;
    });

    it('filters out labels that do not exist on the repo', async () => {
      const warnings: string[] = [];
      const opener = new PROpener('/tmp/test', {
        getAuthUser: async () => 'seandonvaughan',
        getRepoLabels: async () => ['autonomous', 'bug'],
        onWarn: (m) => warnings.push(m),
      });
      await opener.open({
        branch: 'x',
        baseBranch: 'main',
        title: 't',
        body: 'b',
        draft: false,
        labels: ['autonomous', 'smoke-test', 'bug'],
      });
      const args: string[] = (globalThis as any).__lastPrCreateArgs;
      expect(args).toContain('autonomous');
      expect(args).toContain('bug');
      expect(args).not.toContain('smoke-test');
      expect(warnings.some((w) => w.includes('smoke-test') && w.includes('label not found'))).toBe(true);
    });

    it('omits --label entirely when all labels are unknown', async () => {
      const opener = new PROpener('/tmp/test', {
        getAuthUser: async () => 'seandonvaughan',
        getRepoLabels: async () => ['autonomous'],
      });
      await opener.open({
        branch: 'x',
        baseBranch: 'main',
        title: 't',
        body: 'b',
        draft: false,
        labels: ['nope1', 'nope2'],
      });
      const args: string[] = (globalThis as any).__lastPrCreateArgs;
      expect(args).not.toContain('--label');
      expect(args).not.toContain('nope1');
      expect(args).not.toContain('nope2');
    });

    it('does not fail PR creation when all labels are unknown', async () => {
      const opener = new PROpener('/tmp/test', {
        getAuthUser: async () => 'seandonvaughan',
        getRepoLabels: async () => [],
      });
      const result = await opener.open({
        branch: 'x',
        baseBranch: 'main',
        title: 't',
        body: 'b',
        draft: false,
        labels: ['missing'],
      });
      expect(result.url).toBe('https://github.com/owner/repo/pull/99');
      expect(result.number).toBe(99);
    });
  });
});
