import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProposalToBacklog } from '../../../packages/core/src/autonomous/proposal-to-backlog.js';
import { DEFAULT_CYCLE_CONFIG } from '../../../packages/core/src/autonomous/config-loader.js';

describe('ProposalToBacklog', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-p2b-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeMockAdapter(overrides: any = {}) {
    return {
      getRecentFailedSessions: overrides.getRecentFailedSessions ?? (async () => []),
      getCostAnomalies: overrides.getCostAnomalies ?? (async () => []),
      getFailedTaskOutcomes: overrides.getFailedTaskOutcomes ?? (async () => []),
      getFlakingTests: overrides.getFlakingTests ?? (async () => []),
    };
  }

  it('returns empty backlog when no data sources have items', async () => {
    const bridge = new ProposalToBacklog(makeMockAdapter(), tmpDir, DEFAULT_CYCLE_CONFIG);
    const items = await bridge.build();
    expect(items).toEqual([]);
  });

  it('converts failed sessions into backlog items with confidence filter', async () => {
    const adapter = makeMockAdapter({
      getRecentFailedSessions: async () => [
        { id: 's1', agent: 'coder', error: 'TypeError: undefined', confidence: 0.8 },
        { id: 's2', agent: 'debugger', error: 'race', confidence: 0.4 }, // below default 0.6
      ],
    });
    const bridge = new ProposalToBacklog(adapter, tmpDir, DEFAULT_CYCLE_CONFIG);
    const items = await bridge.build();
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.every(i => !i.title.includes('race'))).toBe(true); // filtered
  });

  it('scans for TODO(autonomous) markers in the codebase', async () => {
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'src/foo.ts'),
      `// TODO(autonomous): migrate workspace-adapter to postgres\nexport const x = 1;`,
    );
    writeFileSync(
      join(tmpDir, 'src/bar.ts'),
      `// TODO: regular human todo — should be ignored\nexport const y = 2;`,
    );
    writeFileSync(
      join(tmpDir, 'src/baz.ts'),
      `// FIXME(autonomous): broken parser\nexport const z = 3;`,
    );

    const bridge = new ProposalToBacklog(makeMockAdapter(), tmpDir, DEFAULT_CYCLE_CONFIG);
    const items = await bridge.build();

    expect(items.some(i => i.title.includes('migrate workspace-adapter'))).toBe(true);
    expect(items.some(i => i.title.includes('broken parser'))).toBe(true);
    expect(items.some(i => i.title.includes('regular human'))).toBe(false);
  });

  it('deduplicates items with same title', async () => {
    const adapter = makeMockAdapter({
      getRecentFailedSessions: async () => [
        { id: 's1', agent: 'coder', error: 'same error', confidence: 0.8 },
        { id: 's2', agent: 'coder', error: 'same error', confidence: 0.8 },
      ],
    });
    const bridge = new ProposalToBacklog(adapter, tmpDir, DEFAULT_CYCLE_CONFIG);
    const items = await bridge.build();
    const titles = items.map(i => i.title);
    const uniqueTitles = new Set(titles);
    expect(titles.length).toBe(uniqueTitles.size);
  });

  it('assigns priority based on source type', async () => {
    const adapter = makeMockAdapter({
      getRecentFailedSessions: async () => [
        { id: 's1', agent: 'coder', error: 'crash', confidence: 0.9 },
      ],
      getCostAnomalies: async () => [
        { agent: 'runner', anomaly: 'cost spike', confidence: 0.9 },
      ],
    });
    const bridge = new ProposalToBacklog(adapter, tmpDir, DEFAULT_CYCLE_CONFIG);
    const items = await bridge.build();
    expect(items.some(i => i.priority === 'P0')).toBe(true); // crashes = P0
    expect(items.some(i => i.priority === 'P1')).toBe(true); // cost = P1
  });

  it('requires a comment prefix before TODO(autonomous) markers', async () => {
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    // Positive cases — real comment markers in varied styles
    writeFileSync(
      join(tmpDir, 'src/a.ts'),
      [
        '// TODO(autonomous): fix line comment case',
        '  // FIXME(autonomous): indented line comment',
        '/* TODO(autonomous): block comment case */',
        ' * TODO(autonomous): inside block comment',
        '  * v6.4.2: FIXME(autonomous): versioned block comment',
      ].join('\n'),
    );
    writeFileSync(
      join(tmpDir, 'readme.md'),
      '<!-- TODO(autonomous): add docs case -->',
    );
    writeFileSync(
      join(tmpDir, 'src/b.js'),
      '# TODO(autonomous): update YAML case',
    );
    // Negative cases — marker appears inside source strings/regex/object literals
    writeFileSync(
      join(tmpDir, 'src/neg.ts'),
      [
        'const text = "TODO(autonomous): should not match embedded";',
        'const pattern = /TODO\\(autonomous\\):\\s*(.*)/;',
        "const x = { type: 'FIXME(autonomous): nope' };",
      ].join('\n'),
    );

    const bridge = new ProposalToBacklog(makeMockAdapter(), tmpDir, DEFAULT_CYCLE_CONFIG);
    const items = await bridge.build();
    const titles = items.map(i => i.title);

    // Positives must be present
    expect(titles).toContain('fix line comment case');
    expect(titles).toContain('indented line comment');
    expect(titles).toContain('block comment case');
    expect(titles).toContain('inside block comment');
    expect(titles).toContain('versioned block comment');
    expect(titles).toContain('add docs case');
    expect(titles).toContain('update YAML case');

    // Negatives must NOT be present
    expect(titles.some(t => t.includes('should not match embedded'))).toBe(false);
    expect(titles.some(t => t.includes('nope'))).toBe(false);
  });

  it('does not capture TODO(autonomous) that appears inside a nested HTML comment within a line comment', async () => {
    // Regression for the line-68 false-positive: description-of-the-pattern
    // comments (e.g. "// (<!-- TODO(autonomous): ... -->)") must not generate
    // backlog items.  The fix is [^<\n]*? in markerLine which prevents the
    // non-greedy scan from crossing a `<` character.
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'src/meta.ts'),
      [
        '// (<!-- TODO(autonomous): ... -->) and from plain text lines.',
        '// titles from README <!-- TODO(autonomous): X --> are described here',
        '// TODO(autonomous): this one is a real marker',
      ].join('\n'),
    );

    const bridge = new ProposalToBacklog(makeMockAdapter(), tmpDir, DEFAULT_CYCLE_CONFIG);
    const items = await bridge.build();
    const titles = items.map(i => i.title);

    // The real marker must be captured
    expect(titles).toContain('this one is a real marker');

    // The description-of-the-pattern comments must NOT generate items
    expect(titles.some(t => t.includes('from plain text lines'))).toBe(false);
    expect(titles.some(t => t.includes('are described here'))).toBe(false);
    expect(titles.some(t => t.includes('... -->'))).toBe(false);
    expect(titles.some(t => t.includes('X -->'))).toBe(false);
  });

  it('captures plain-text TODO markers in markdown files (no comment prefix)', async () => {
    writeFileSync(
      join(tmpDir, 'NOTES.md'),
      [
        '# Notes',
        '',
        'TODO(autonomous): plain text line in markdown',
        'FIXME(autonomous): plain text fixme in markdown',
        '',
        '<!-- TODO(autonomous): html comment in markdown -->',
      ].join('\n'),
    );

    const bridge = new ProposalToBacklog(makeMockAdapter(), tmpDir, DEFAULT_CYCLE_CONFIG);
    const items = await bridge.build();
    const titles = items.map(i => i.title);

    expect(titles).toContain('plain text line in markdown');
    expect(titles).toContain('plain text fixme in markdown');
    expect(titles).toContain('html comment in markdown');
  });

  it('strips --> closers from captured text', async () => {
    writeFileSync(
      join(tmpDir, 'README.md'),
      [
        '<!-- TODO(autonomous): trailing closer stripped -->',
        '<!-- TODO(autonomous): mid-text arrow -> preserved -->',
      ].join('\n'),
    );

    const bridge = new ProposalToBacklog(makeMockAdapter(), tmpDir, DEFAULT_CYCLE_CONFIG);
    const items = await bridge.build();
    const titles = items.map(i => i.title);

    // Trailing --> must be stripped
    expect(titles).toContain('trailing closer stripped');
    // The -> inside the description text is NOT a closer, should remain
    expect(titles.some(t => t.includes('mid-text arrow -> preserved'))).toBe(true);
    // No title should end with -->
    expect(titles.every(t => !t.trimEnd().endsWith('-->'))).toBe(true);
  });

  it('strips --> artifacts from non-todo-marker items at the output boundary', async () => {
    // Adapter data (session errors, task descriptions) may contain --> from
    // HTML comment fragments.  The output-side sanitizeItems() pass must strip
    // these before they reach the backlog schema.
    const adapter = makeMockAdapter({
      getRecentFailedSessions: async () => [
        { id: 's1', agent: 'coder', error: 'TypeError: undefined -->', confidence: 0.9 },
      ],
      getFailedTaskOutcomes: async () => [
        { taskId: 't1', description: 'broken task -->', confidence: 0.9 },
      ],
    });
    const bridge = new ProposalToBacklog(adapter, tmpDir, DEFAULT_CYCLE_CONFIG);
    const items = await bridge.build();

    expect(items.every(i => !i.title.trimEnd().endsWith('-->'))).toBe(true);
    expect(items.every(i => !i.id.trimEnd().endsWith('-->'))).toBe(true);

    // Content before --> must survive
    const sessionItem = items.find(i => i.id.startsWith('sess-'));
    expect(sessionItem?.title).toContain('TypeError: undefined');
  });

  it('strips --> from description field at the output boundary', async () => {
    // The description field is built from adapter data and may also carry
    // trailing --> tokens.  sanitizeItems() must cover all three string fields.
    const adapter = makeMockAdapter({
      getRecentFailedSessions: async () => [
        { id: 's2', agent: 'planner', error: 'bad plan -->', confidence: 0.9 },
      ],
    });
    const bridge = new ProposalToBacklog(adapter, tmpDir, DEFAULT_CYCLE_CONFIG);
    const items = await bridge.build();

    expect(items.every(i => !i.description.trimEnd().endsWith('-->'))).toBe(true);

    // Text before --> in description must not be lost
    const item = items.find(i => i.id.startsWith('sess-s2'));
    expect(item?.description).toContain('s2');
  });

  it('every BacklogItem has required fields', async () => {
    const adapter = makeMockAdapter({
      getRecentFailedSessions: async () => [
        { id: 's1', agent: 'coder', error: 'error', confidence: 0.8 },
      ],
    });
    const bridge = new ProposalToBacklog(adapter, tmpDir, DEFAULT_CYCLE_CONFIG);
    const items = await bridge.build();
    for (const item of items) {
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('title');
      expect(item).toHaveProperty('description');
      expect(item).toHaveProperty('priority');
      expect(item).toHaveProperty('tags');
      expect(item).toHaveProperty('source');
    }
  });
});
