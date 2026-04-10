/**
 * Unit tests for gate-phase memory writing helpers:
 *   - extractFindingsByLevel
 *   - parseGateVerdict
 *
 * Integration tests verify the full round-trip: gate-phase writes a
 * gate-verdict JSONL entry that the audit-phase can read and inject into
 * the next cycle's prompt.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractFindingsByLevel,
  parseGateVerdict,
} from '../gate-phase.js';
import { writeMemoryEntry, readMemoryEntries } from '../../../memory/types.js';
import {
  readRecentMemoryEntries,
  formatMemoryForPrompt,
} from '../audit-phase.js';
import { readRelevantMemoryEntries } from '../execute-phase.js';
import { writeFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Temp dir lifecycle
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-gate-mem-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// extractFindingsByLevel
// ---------------------------------------------------------------------------

describe('extractFindingsByLevel', () => {
  it('returns an empty array for empty review text', () => {
    expect(extractFindingsByLevel('', 'CRITICAL')).toEqual([]);
  });

  it('returns an empty array when no lines match the level', () => {
    const text = 'Everything looks fine.\nNo major concerns.';
    expect(extractFindingsByLevel(text, 'CRITICAL')).toEqual([]);
  });

  it('extracts CRITICAL lines from review text', () => {
    const text = [
      'This is fine.',
      'CRITICAL: Auth bypass in middleware',
      'Another normal line.',
    ].join('\n');

    const findings = extractFindingsByLevel(text, 'CRITICAL');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('Auth bypass');
  });

  it('extracts MAJOR lines from review text', () => {
    const text = [
      'MAJOR: Missing null check in route handler',
      'CRITICAL: Buffer overflow in parser',
      'MAJOR: Slow query in registry lookup',
    ].join('\n');

    const findings = extractFindingsByLevel(text, 'MAJOR');
    expect(findings).toHaveLength(2);
    expect(findings[0]).toContain('Missing null check');
    expect(findings[1]).toContain('Slow query');
  });

  it('is case-insensitive for the level keyword', () => {
    const text = 'critical: lowercase check\ncritical finding here';
    const findings = extractFindingsByLevel(text, 'CRITICAL');
    expect(findings).toHaveLength(2);
  });

  it('caps results at 10 entries to prevent memory bloat', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `CRITICAL: Issue ${i}`);
    const text = lines.join('\n');

    const findings = extractFindingsByLevel(text, 'CRITICAL');
    expect(findings).toHaveLength(10);
  });

  it('trims whitespace from each extracted line', () => {
    const text = '  CRITICAL: Padded line  ';
    const findings = extractFindingsByLevel(text, 'CRITICAL');
    expect(findings[0]).not.toMatch(/^\s|\s$/);
  });

  it('skips empty or whitespace-only lines', () => {
    const text = 'CRITICAL: real finding\n\n   \nCRITICAL: another';
    const findings = extractFindingsByLevel(text, 'CRITICAL');
    expect(findings).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// parseGateVerdict
// ---------------------------------------------------------------------------

describe('parseGateVerdict', () => {
  it('parses a strict JSON APPROVE verdict', () => {
    const result = parseGateVerdict(
      JSON.stringify({ verdict: 'APPROVE', rationale: 'All tests passed' }),
    );
    expect(result.verdict).toBe('APPROVE');
    expect(result.rationale).toBe('All tests passed');
  });

  it('parses a strict JSON REJECT verdict', () => {
    const result = parseGateVerdict(
      JSON.stringify({ verdict: 'REJECT', rationale: 'Budget exceeded by 40%' }),
    );
    expect(result.verdict).toBe('REJECT');
    expect(result.rationale).toBe('Budget exceeded by 40%');
  });

  it('normalises lowercase verdict to uppercase', () => {
    const result = parseGateVerdict(
      JSON.stringify({ verdict: 'approve', rationale: 'ok' }),
    );
    expect(result.verdict).toBe('APPROVE');
  });

  it('extracts a JSON object embedded in surrounding prose', () => {
    const text =
      'After careful review, my decision is: {"verdict": "REJECT", "rationale": "tests failing"}. That concludes my analysis.';
    const result = parseGateVerdict(text);
    expect(result.verdict).toBe('REJECT');
    expect(result.rationale).toContain('tests failing');
  });

  it('defaults to REJECT with raw text as rationale for malformed input', () => {
    const result = parseGateVerdict('Not valid JSON at all');
    expect(result.verdict).toBe('REJECT');
    expect(result.rationale).toBe('Not valid JSON at all');
  });

  it('defaults to REJECT with fallback message for empty input', () => {
    const result = parseGateVerdict('');
    expect(result.verdict).toBe('REJECT');
    expect(result.rationale).toBe('Malformed gate response');
  });

  it('treats an unknown verdict value as malformed and returns REJECT', () => {
    const result = parseGateVerdict(
      JSON.stringify({ verdict: 'MAYBE', rationale: 'uncertain' }),
    );
    expect(result.verdict).toBe('REJECT');
  });

  it('uses an empty string for rationale when the field is absent', () => {
    const result = parseGateVerdict(JSON.stringify({ verdict: 'APPROVE' }));
    expect(result.verdict).toBe('APPROVE');
    expect(result.rationale).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Round-trip: gate writes → audit reads
//
// These tests simulate what happens across two consecutive cycles:
//   1. The gate phase writes a gate-verdict JSONL entry.
//   2. The audit phase of the NEXT cycle reads it and includes it in the prompt.
// ---------------------------------------------------------------------------

describe('gate-verdict round-trip (gate writes → audit reads)', () => {
  it('gate-verdict entry is readable by readMemoryEntries after writeMemoryEntry', () => {
    writeMemoryEntry(tmpRoot, {
      type: 'gate-verdict',
      value: JSON.stringify({
        cycleId: 'cycle-001',
        sprintVersion: '6.8',
        verdict: 'REJECT',
        rationale: 'Too many failing tests',
        criticalFindings: ['Null pointer in orchestrator'],
        majorFindings: ['Missing retry logic'],
      }),
      source: 'cycle-001',
      tags: ['verdict:reject', 'sprint:v6.8'],
    });

    const entries = readMemoryEntries(tmpRoot, 'gate-verdict', 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe('gate-verdict');

    const payload = JSON.parse(entries[0]!.value);
    expect(payload.cycleId).toBe('cycle-001');
    expect(payload.verdict).toBe('REJECT');
    expect(payload.rationale).toBe('Too many failing tests');
    expect(payload.criticalFindings).toEqual(['Null pointer in orchestrator']);
    expect(payload.majorFindings).toEqual(['Missing retry logic']);
  });

  it('audit-phase readRecentMemoryEntries picks up gate-verdict.jsonl', () => {
    writeMemoryEntry(tmpRoot, {
      type: 'gate-verdict',
      value: JSON.stringify({
        cycleId: 'cycle-002',
        verdict: 'REJECT',
        rationale: 'Budget overrun',
        criticalFindings: [],
        majorFindings: ['Cost 3x budget cap'],
      }),
      source: 'cycle-002',
      tags: ['verdict:reject'],
    });

    const entries = readRecentMemoryEntries(tmpRoot, 10);
    const gateEntries = entries.filter((e) => e.type === 'gate-verdict');
    expect(gateEntries).toHaveLength(1);
  });

  it('audit-phase formatMemoryForPrompt includes gate-verdict rationale in the injected section', () => {
    writeMemoryEntry(tmpRoot, {
      type: 'gate-verdict',
      value: JSON.stringify({
        cycleId: 'cycle-003',
        verdict: 'REJECT',
        rationale: 'Auth bypass found in review',
        criticalFindings: ['Middleware skips token check'],
        majorFindings: [],
      }),
      source: 'cycle-003',
    });

    const entries = readRecentMemoryEntries(tmpRoot, 10);
    const section = formatMemoryForPrompt(entries);

    // formatMemoryForPrompt renders the type as a human label in the heading.
    expect(section).toContain('Gate verdicts (recent APPROVE/REJECT decisions)');
    // The raw JSON value string should appear in the prompt so the audit
    // agent can extract context from it.
    expect(section).toContain('Auth bypass found in review');
  });

  it('multiple gate-verdict entries from successive cycles are all surfaced', () => {
    for (let i = 1; i <= 3; i++) {
      writeMemoryEntry(tmpRoot, {
        type: 'gate-verdict',
        value: JSON.stringify({
          cycleId: `cycle-${i.toString().padStart(3, '0')}`,
          verdict: i === 2 ? 'APPROVE' : 'REJECT',
          rationale: `Cycle ${i} outcome`,
          criticalFindings: [],
          majorFindings: [],
        }),
        source: `cycle-${i.toString().padStart(3, '0')}`,
      });
    }

    const entries = readMemoryEntries(tmpRoot, 'gate-verdict', 10);
    expect(entries).toHaveLength(3);
  });

  it('stores tags that allow execute-phase to filter by verdict type', () => {
    writeMemoryEntry(tmpRoot, {
      type: 'gate-verdict',
      value: JSON.stringify({
        cycleId: 'cycle-tag-test',
        verdict: 'REJECT',
        rationale: 'Tests regressed',
        criticalFindings: [],
        majorFindings: [],
      }),
      source: 'cycle-tag-test',
      tags: ['verdict:reject', 'sprint:v6.9'],
    });

    const entries = readMemoryEntries(tmpRoot, 'gate-verdict', 10);
    expect(entries[0]!.tags).toContain('verdict:reject');
    expect(entries[0]!.tags).toContain('sprint:v6.9');
  });

  it('gate-verdict entry survives the full JSONL round-trip without data loss', () => {
    const original = {
      cycleId: 'cycle-roundtrip',
      sprintVersion: '6.9',
      verdict: 'APPROVE',
      rationale: 'All P0 items shipped, 100% test pass rate',
      criticalFindings: [] as string[],
      majorFindings: ['Minor: one flaky test quarantined'],
    };

    writeMemoryEntry(tmpRoot, {
      type: 'gate-verdict',
      value: JSON.stringify(original),
      source: original.cycleId,
      tags: [`verdict:${original.verdict.toLowerCase()}`],
    });

    const [stored] = readMemoryEntries(tmpRoot, 'gate-verdict', 1);
    const parsed = JSON.parse(stored!.value);

    expect(parsed).toEqual(original);
    expect(stored!.source).toBe('cycle-roundtrip');
    expect(stored!.tags).toContain('verdict:approve');
  });
});

// ---------------------------------------------------------------------------
// Gate-verdict domain tag enrichment → execute-phase injection round-trip
//
// Gate verdicts must carry sprint item domain tags so that future execute-phase
// items with overlapping domain tags can find them and avoid repeating
// patterns that led to a prior rejection.
// ---------------------------------------------------------------------------

describe('gate-verdict tag enrichment → execute-phase injection round-trip', () => {
  it('gate-verdict entries written with sprint domain tags are matched by execute-phase item tags', () => {
    // Simulate a gate-verdict written with domain tags ['memory', 'execute', 'backend']
    // collected from the sprint's items (the new behaviour after the fix).
    writeMemoryEntry(tmpRoot, {
      type: 'gate-verdict',
      value: JSON.stringify({
        verdict: 'REJECT',
        rationale: 'Test coverage too low on execute-phase memory injection',
        criticalFindings: ['zero test for readRelevantMemoryEntries edge cases'],
        majorFindings: [],
      }),
      source: 'cycle-rejected',
      tags: ['verdict:reject', 'sprint:v9.2', 'memory', 'execute', 'backend'],
    });

    // An execute-phase item tagged ['memory', 'execute'] should find this entry.
    const entries = readRelevantMemoryEntries(tmpRoot, ['memory', 'execute']);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe('gate-verdict');

    const payload = JSON.parse(entries[0]!.value);
    expect(payload.verdict).toBe('REJECT');
  });

  it('gate-verdict with only structural tags is NOT matched by domain item tags', () => {
    // The old broken behavior — only structural tags.
    writeMemoryEntry(tmpRoot, {
      type: 'gate-verdict',
      value: JSON.stringify({ verdict: 'REJECT', rationale: 'tests failing' }),
      source: 'cycle-old',
      tags: ['verdict:reject', 'sprint:v9.0'],  // no domain tags
    });

    // Item tags ['memory', 'execute'] should not match structural-only tags.
    const entries = readRelevantMemoryEntries(tmpRoot, ['memory', 'execute']);
    expect(entries).toHaveLength(0);
  });

  it('gate-verdict written with domain tags appears in audit-phase prompt', () => {
    writeMemoryEntry(tmpRoot, {
      type: 'gate-verdict',
      value: 'Sprint rejected: execute-phase memory injection missing',
      source: 'cycle-tagged',
      tags: ['verdict:reject', 'sprint:v9.2', 'memory', 'execute'],
    });

    const entries = readRecentMemoryEntries(tmpRoot, 10);
    const section = formatMemoryForPrompt(entries);
    expect(section).toContain('execute-phase memory injection missing');
  });
});
