/**
 * Unit tests for review-phase memory writing:
 *   - parseReviewFindingMetadata (structured extraction from reviewer output)
 *   - parseVerdict
 *
 * Integration tests verify the full round-trip: the review phase writes
 * review-finding JSONL entries that the audit phase can read and inject into
 * the next cycle's prompt to prevent recurrence of the same issues.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseReviewFindingMetadata,
  parseVerdict,
  collectSprintItemTags,
} from '../review-phase.js';
import { writeMemoryEntry, readMemoryEntries } from '../../../memory/types.js';
import {
  readRecentMemoryEntries,
  formatMemoryForPrompt,
} from '../audit-phase.js';
import { readRelevantMemoryEntries } from '../execute-phase.js';
import { mkdirSync, writeFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Temp dir lifecycle
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-review-mem-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseReviewFindingMetadata — file / line extraction
// ---------------------------------------------------------------------------

describe('parseReviewFindingMetadata — file extraction', () => {
  it('extracts a src/ file path from the finding line', () => {
    const meta = parseReviewFindingMetadata(
      'CRITICAL: src/autonomous/phase-scheduler.ts — missing null check',
      'CRITICAL',
    );
    expect(meta.file).toBe('src/autonomous/phase-scheduler.ts');
  });

  it('extracts a packages/ deep path', () => {
    const meta = parseReviewFindingMetadata(
      'MAJOR: packages/core/src/memory/types.ts:42 — lock file not released on error',
      'MAJOR',
    );
    expect(meta.file).toBe('packages/core/src/memory/types.ts');
  });

  it('extracts a tests/ path', () => {
    const meta = parseReviewFindingMetadata(
      'MAJOR: tests/autonomous/review-phase-handler.test.ts:18 — test skipped without reason',
      'MAJOR',
    );
    expect(meta.file).toBe('tests/autonomous/review-phase-handler.test.ts');
  });

  it('returns null for file when no recognisable path is present', () => {
    const meta = parseReviewFindingMetadata(
      'CRITICAL: auth bypass — token validation is completely absent',
      'CRITICAL',
    );
    expect(meta.file).toBeNull();
  });
});

describe('parseReviewFindingMetadata — line number extraction', () => {
  it('extracts the line number following a colon after the file path', () => {
    const meta = parseReviewFindingMetadata(
      'MAJOR: src/registry/memory-registry.ts:88 — applyDecay mutates shared state',
      'MAJOR',
    );
    expect(meta.line).toBe(88);
  });

  it('returns null for line when no colon-number suffix is present', () => {
    const meta = parseReviewFindingMetadata(
      'CRITICAL: src/server/routes.ts — route handler swallows errors',
      'CRITICAL',
    );
    expect(meta.line).toBeNull();
  });

  it('returns null for line when file itself is null', () => {
    const meta = parseReviewFindingMetadata(
      'MAJOR: missing null check on line 42 of something',
      'MAJOR',
    );
    // No structured path prefix → line should be null even if "42" appears.
    expect(meta.file).toBeNull();
    expect(meta.line).toBeNull();
  });
});

describe('parseReviewFindingMetadata — severity passthrough', () => {
  it('stores CRITICAL as the severity', () => {
    const meta = parseReviewFindingMetadata('CRITICAL: some issue', 'CRITICAL');
    expect(meta.severity).toBe('CRITICAL');
  });

  it('stores MAJOR as the severity', () => {
    const meta = parseReviewFindingMetadata('MAJOR: some issue', 'MAJOR');
    expect(meta.severity).toBe('MAJOR');
  });
});

describe('parseReviewFindingMetadata — summary cleaning', () => {
  it('strips the CRITICAL: prefix from the summary', () => {
    const meta = parseReviewFindingMetadata(
      'CRITICAL: Missing token validation',
      'CRITICAL',
    );
    expect(meta.summary).not.toMatch(/^CRITICAL/i);
    expect(meta.summary).toContain('Missing token validation');
  });

  it('strips the MAJOR: prefix from the summary', () => {
    const meta = parseReviewFindingMetadata(
      'MAJOR: Slow query in registry lookup',
      'MAJOR',
    );
    expect(meta.summary).not.toMatch(/^MAJOR/i);
    expect(meta.summary).toContain('Slow query in registry lookup');
  });

  it('strips bullet decoration before the severity keyword', () => {
    const meta = parseReviewFindingMetadata(
      '- CRITICAL: No error boundary in orchestrator',
      'CRITICAL',
    );
    expect(meta.summary).not.toMatch(/^[-*]/);
    expect(meta.summary).toContain('No error boundary');
  });

  it('strips the file:line reference from the summary text', () => {
    const meta = parseReviewFindingMetadata(
      'MAJOR: src/daemon/cost-ceiling.ts:55 — budget ceiling applied after spend, not before',
      'MAJOR',
    );
    expect(meta.summary).not.toContain('src/daemon/cost-ceiling.ts');
    expect(meta.summary).toContain('budget ceiling applied after spend');
  });

  it('produces a non-empty summary even for a minimal finding line', () => {
    const meta = parseReviewFindingMetadata('CRITICAL: bug', 'CRITICAL');
    expect(meta.summary.length).toBeGreaterThan(0);
  });
});

describe('parseReviewFindingMetadata — fix suggestion extraction', () => {
  it('extracts a fix suggestion from "Fix: …" at the end of the line', () => {
    const meta = parseReviewFindingMetadata(
      'CRITICAL: src/auth.ts — token not validated. Fix: call verifyToken() before proceeding',
      'CRITICAL',
    );
    expect(meta.fixSuggestion).not.toBeNull();
    expect(meta.fixSuggestion).toContain('verifyToken()');
  });

  it('extracts a fix suggestion introduced by "Suggestion:"', () => {
    const meta = parseReviewFindingMetadata(
      'MAJOR: missing retry logic. Suggestion: wrap dispatch in exponential-backoff loop',
      'MAJOR',
    );
    expect(meta.fixSuggestion).toContain('wrap dispatch');
  });

  it('returns null for fixSuggestion when no fix clause is present', () => {
    const meta = parseReviewFindingMetadata(
      'MAJOR: src/registry/index.ts — duplicate route registration',
      'MAJOR',
    );
    expect(meta.fixSuggestion).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseVerdict
// ---------------------------------------------------------------------------

describe('parseVerdict', () => {
  it('returns 3 for empty input', () => {
    expect(parseVerdict('')).toBe(3);
  });

  it('parses "verdict: 5/5"', () => {
    expect(parseVerdict('Overall verdict: 5/5 — ship it')).toBe(5);
  });

  it('parses "verdict: 1/5"', () => {
    expect(parseVerdict('My verdict: 1/5 — do not merge')).toBe(1);
  });

  it('parses a bare "N/5" pattern when verdict keyword is absent', () => {
    expect(parseVerdict('I would rate this 4/5')).toBe(4);
  });

  it('falls back to 3 when no score is found', () => {
    expect(parseVerdict('Looks reasonable, no obvious issues')).toBe(3);
  });

  it('rejects out-of-range scores and falls back to 3', () => {
    // "6/5" would not match the 1-5 guard, so falls back to 3.
    expect(parseVerdict('verdict: 6/5')).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: review phase writes → audit phase reads
//
// Simulates what happens between cycles:
//   1. The review phase writes review-finding JSONL entries.
//   2. The next cycle's audit phase reads them and surfaces recurring issues.
// ---------------------------------------------------------------------------

describe('review-finding round-trip (review writes → audit reads)', () => {
  it('review-finding entry is readable by readMemoryEntries after writeMemoryEntry', () => {
    const meta = parseReviewFindingMetadata(
      'CRITICAL: src/registry/memory-registry.ts:42 — lock is never released on error path',
      'CRITICAL',
    );

    writeMemoryEntry(tmpRoot, {
      type: 'review-finding',
      value: 'CRITICAL: src/registry/memory-registry.ts:42 — lock is never released on error path',
      source: 'cycle-001',
      tags: ['review', 'finding', 'critical', 'sprint:v9.3'],
      metadata: meta,
    });

    const entries = readMemoryEntries(tmpRoot, 'review-finding', 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe('review-finding');
    expect(entries[0]!.source).toBe('cycle-001');
  });

  it('stored metadata preserves file, line, severity, and summary', () => {
    const meta = parseReviewFindingMetadata(
      'MAJOR: packages/core/src/autonomous/phase-handlers/gate-phase.ts:88 — verdict not written on agent error',
      'MAJOR',
    );

    writeMemoryEntry(tmpRoot, {
      type: 'review-finding',
      value: 'MAJOR: packages/core/src/autonomous/phase-handlers/gate-phase.ts:88 — verdict not written on agent error',
      source: 'cycle-002',
      tags: ['review', 'finding', 'major', 'sprint:v9.3'],
      metadata: meta,
    });

    const entries = readMemoryEntries(tmpRoot, 'review-finding', 10);
    const stored = entries[0]!;
    const storedMeta = stored.metadata as typeof meta;

    expect(storedMeta.file).toBe('packages/core/src/autonomous/phase-handlers/gate-phase.ts');
    expect(storedMeta.line).toBe(88);
    expect(storedMeta.severity).toBe('MAJOR');
    expect(storedMeta.summary).not.toContain('packages/core');
    expect(storedMeta.summary).toContain('verdict not written on agent error');
  });

  it('CRITICAL finding gets stored with critical tag', () => {
    writeMemoryEntry(tmpRoot, {
      type: 'review-finding',
      value: 'CRITICAL: auth bypass',
      source: 'cycle-003',
      tags: ['review', 'finding', 'critical', 'sprint:v9.3'],
      metadata: parseReviewFindingMetadata('CRITICAL: auth bypass', 'CRITICAL'),
    });

    const entries = readMemoryEntries(tmpRoot, 'review-finding', 10);
    expect(entries[0]!.tags).toContain('critical');
    expect(entries[0]!.tags).toContain('sprint:v9.3');
  });

  it('multiple findings from the same cycle are all persisted', () => {
    const reviewText = [
      'CRITICAL: src/auth.ts — missing token validation',
      'MAJOR: src/registry/index.ts:12 — duplicate route registration',
      'MAJOR: packages/core/src/daemon/cost-ceiling.ts — ceiling applied after spend',
    ];

    for (const line of reviewText) {
      const severity = line.startsWith('CRITICAL') ? 'CRITICAL' : 'MAJOR';
      writeMemoryEntry(tmpRoot, {
        type: 'review-finding',
        value: line,
        source: 'cycle-004',
        tags: ['review', 'finding', severity.toLowerCase(), 'sprint:v9.3'],
        metadata: parseReviewFindingMetadata(line, severity),
      });
    }

    const entries = readMemoryEntries(tmpRoot, 'review-finding', 10);
    expect(entries).toHaveLength(3);
  });

  it('audit-phase readRecentMemoryEntries surfaces review-finding entries', () => {
    writeMemoryEntry(tmpRoot, {
      type: 'review-finding',
      value: 'MAJOR: slow query in registry lookup',
      source: 'cycle-005',
      tags: ['review', 'finding', 'major'],
      metadata: parseReviewFindingMetadata('MAJOR: slow query in registry lookup', 'MAJOR'),
    });

    const entries = readRecentMemoryEntries(tmpRoot, 10);
    const reviewEntries = entries.filter((e) => e.type === 'review-finding');
    expect(reviewEntries).toHaveLength(1);
  });

  it('audit-phase formatMemoryForPrompt renders review-findings under their section label', () => {
    writeMemoryEntry(tmpRoot, {
      type: 'review-finding',
      value: 'CRITICAL: cancelConfirm is dead code — click-outside handler never fires',
      source: 'cycle-006',
      tags: ['review', 'critical'],
      metadata: parseReviewFindingMetadata(
        'CRITICAL: cancelConfirm is dead code — click-outside handler never fires',
        'CRITICAL',
      ),
    });

    const entries = readRecentMemoryEntries(tmpRoot, 10);
    const section = formatMemoryForPrompt(entries);

    expect(section).toContain('Code review findings (recurring issues)');
    expect(section).toContain('cancelConfirm is dead code');
  });

  it('review-finding entry survives the full JSONL round-trip without data loss', () => {
    const rawLine = 'CRITICAL: src/autonomous/cycle-runner.ts:101 — cycle aborts without writing phase.json. Fix: wrap phase dispatch in finally block';
    const meta = parseReviewFindingMetadata(rawLine, 'CRITICAL');

    writeMemoryEntry(tmpRoot, {
      type: 'review-finding',
      value: rawLine,
      source: 'cycle-roundtrip',
      tags: ['review', 'finding', 'critical', 'sprint:v9.3'],
      metadata: meta,
    });

    const [stored] = readMemoryEntries(tmpRoot, 'review-finding', 1);
    expect(stored!.value).toBe(rawLine);
    expect(stored!.source).toBe('cycle-roundtrip');
    expect(stored!.tags).toContain('critical');

    const storedMeta = stored!.metadata as typeof meta;
    expect(storedMeta.file).toBe('src/autonomous/cycle-runner.ts');
    expect(storedMeta.line).toBe(101);
    expect(storedMeta.severity).toBe('CRITICAL');
    expect(storedMeta.fixSuggestion).toContain('wrap phase dispatch');
  });

  it('findings from successive cycles accumulate in the JSONL store', () => {
    for (let i = 1; i <= 4; i++) {
      writeMemoryEntry(tmpRoot, {
        type: 'review-finding',
        value: `MAJOR: recurring issue in cycle ${i}`,
        source: `cycle-${i.toString().padStart(3, '0')}`,
        tags: ['major'],
        metadata: parseReviewFindingMetadata(`MAJOR: recurring issue in cycle ${i}`, 'MAJOR'),
      });
    }

    const entries = readMemoryEntries(tmpRoot, 'review-finding', 10);
    expect(entries).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// collectSprintItemTags — domain tag extraction from sprint JSON
//
// These tags are appended to review-finding memory entries so the execute-phase
// injector can match findings to future items with overlapping domain tags.
// Without this, review findings only carry structural tags (review/finding/
// critical) that never overlap with sprint item domain tags (memory/execute/...).
// ---------------------------------------------------------------------------

describe('collectSprintItemTags', () => {
  function writeSprintFile(
    root: string,
    version: string,
    items: Array<{ id: string; title: string; tags?: string[] }>,
  ): void {
    const dir = join(root, '.agentforge', 'sprints');
    mkdirSync(dir, { recursive: true });
    const sprint = {
      sprints: [
        {
          version,
          sprintId: `v${version}-test`,
          title: `v${version} test`,
          createdAt: new Date().toISOString(),
          phase: 'planned',
          items: items.map((i) => ({ ...i, status: 'planned', priority: 'P1', assignee: 'coder' })),
          budget: 10,
          teamSize: 1,
          successCriteria: [],
        },
      ],
    };
    writeFileSync(join(dir, `v${version}.json`), JSON.stringify(sprint, null, 2), 'utf8');
  }

  it('returns an empty array when the sprint file does not exist', () => {
    const tags = collectSprintItemTags(tmpRoot, '99.99.99');
    expect(tags).toEqual([]);
  });

  it('collects tags from all items in the sprint', () => {
    writeSprintFile(tmpRoot, '9.3.0', [
      { id: 'i1', title: 'memory wiring', tags: ['memory', 'execute', 'backend'] },
      { id: 'i2', title: 'dashboard fix', tags: ['dashboard', 'svelte'] },
    ]);

    const tags = collectSprintItemTags(tmpRoot, '9.3.0');
    expect(tags).toContain('memory');
    expect(tags).toContain('execute');
    expect(tags).toContain('backend');
    expect(tags).toContain('dashboard');
    expect(tags).toContain('svelte');
  });

  it('deduplicates tags that appear in multiple items', () => {
    writeSprintFile(tmpRoot, '9.3.0', [
      { id: 'i1', title: 'item A', tags: ['memory', 'backend'] },
      { id: 'i2', title: 'item B', tags: ['memory', 'frontend'] },
    ]);

    const tags = collectSprintItemTags(tmpRoot, '9.3.0');
    // 'memory' should appear exactly once
    expect(tags.filter((t) => t === 'memory')).toHaveLength(1);
  });

  it('normalises tags to lowercase', () => {
    writeSprintFile(tmpRoot, '9.3.0', [
      { id: 'i1', title: 'item', tags: ['Memory', 'EXECUTE', 'Backend'] },
    ]);

    const tags = collectSprintItemTags(tmpRoot, '9.3.0');
    expect(tags).toContain('memory');
    expect(tags).toContain('execute');
    expect(tags).toContain('backend');
    expect(tags).not.toContain('Memory');
    expect(tags).not.toContain('EXECUTE');
  });

  it('returns an empty array when items have no tags field', () => {
    writeSprintFile(tmpRoot, '9.3.0', [
      { id: 'i1', title: 'untagged item' },
    ]);

    const tags = collectSprintItemTags(tmpRoot, '9.3.0');
    expect(tags).toEqual([]);
  });

  it('survives a corrupt sprint JSON file without throwing', () => {
    const dir = join(tmpRoot, '.agentforge', 'sprints');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'v1.2.3.json'), 'not valid json', 'utf8');

    expect(() => collectSprintItemTags(tmpRoot, '1.2.3')).not.toThrow();
    expect(collectSprintItemTags(tmpRoot, '1.2.3')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: review-finding entries include sprint domain tags so execute-phase
// items with overlapping domain tags find them in the memory store.
// ---------------------------------------------------------------------------

describe('review-finding tag enrichment → execute-phase injection round-trip', () => {
  it('review-finding entries written with sprint domain tags are matched by execute-phase item tags', () => {
    // Simulate writing a review-finding with domain tags from a sprint
    // that had items tagged ['memory', 'execute', 'backend'].
    writeMemoryEntry(tmpRoot, {
      type: 'review-finding',
      value: 'CRITICAL: null check missing in readRelevantMemoryEntries',
      source: 'cycle-001',
      tags: ['review', 'finding', 'critical', 'sprint:v9.2', 'memory', 'execute', 'backend'],
      metadata: parseReviewFindingMetadata(
        'CRITICAL: null check missing in readRelevantMemoryEntries',
        'CRITICAL',
      ),
    });

    // An execute-phase item with tags ['memory', 'execute'] should find this entry.
    const entries = readRelevantMemoryEntries(tmpRoot, ['memory', 'execute']);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe('review-finding');
    expect(entries[0]!.value).toContain('null check missing');
  });

  it('a review-finding with only structural tags is NOT matched by domain item tags', () => {
    // Structural-tags-only entry (the old broken behavior)
    writeMemoryEntry(tmpRoot, {
      type: 'review-finding',
      value: 'MAJOR: some finding',
      source: 'cycle-002',
      tags: ['review', 'finding', 'major', 'sprint:v9.2'],  // no domain tags
      metadata: parseReviewFindingMetadata('MAJOR: some finding', 'MAJOR'),
    });

    // Item tags don't overlap with structural tags — should find nothing.
    const entries = readRelevantMemoryEntries(tmpRoot, ['memory', 'execute', 'backend']);
    expect(entries).toHaveLength(0);
  });
});
