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
  loadPriorGateKnownDebt,
  buildKnownDebtSection,
  type PriorGateContext,
} from '../gate-phase.js';
import { writeMemoryEntry, readMemoryEntries, type GateVerdictMetadata } from '../../../memory/types.js';
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

  it('does NOT match a severity keyword that appears mid-sentence', () => {
    // Narrative prose that happens to contain the keyword should not be treated
    // as a structured finding — only lines where the keyword leads the line count.
    const text = [
      'This is not a critical path change.',
      'No major concerns about this refactor.',
      'The implementation avoids the major footgun mentioned in the RFC.',
    ].join('\n');

    expect(extractFindingsByLevel(text, 'CRITICAL')).toHaveLength(0);
    expect(extractFindingsByLevel(text, 'MAJOR')).toHaveLength(0);
  });

  it('matches bracket-notation findings like "- [CRITICAL] …"', () => {
    const text = [
      '- [CRITICAL] src/auth.ts — token validation is absent',
      '- [MAJOR] src/registry/index.ts:12 — duplicate route handler',
      'Some prose that mentions a [minor] concern.',
    ].join('\n');

    expect(extractFindingsByLevel(text, 'CRITICAL')).toHaveLength(1);
    expect(extractFindingsByLevel(text, 'MAJOR')).toHaveLength(1);
  });

  it('matches bullet-prefixed severity lines like "* CRITICAL: …"', () => {
    const text = '* CRITICAL: Missing null check\n* MAJOR: Unchecked cast';

    expect(extractFindingsByLevel(text, 'CRITICAL')).toHaveLength(1);
    expect(extractFindingsByLevel(text, 'MAJOR')).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// GateVerdictMetadata round-trip
//
// runGatePhase writes entries with:
//   value   = human-readable summary string (not a JSON blob)
//   metadata = GateVerdictMetadata object for structured machine access
//
// These tests verify that the metadata shape survives the JSONL round-trip
// and that machine consumers can access verdict/rationale/findings without
// JSON.parse on the value field.
// ---------------------------------------------------------------------------

describe('gate-verdict metadata round-trip', () => {
  it('metadata field is written and survives the JSONL round-trip', () => {
    const meta: GateVerdictMetadata = {
      cycleId: 'cycle-meta-001',
      verdict: 'rejected',
      rationale: 'Too many CRITICAL findings',
      criticalFindings: ['Auth bypass in middleware'],
      majorFindings: ['Missing retry logic'],
    };

    writeMemoryEntry(tmpRoot, {
      type: 'gate-verdict',
      value: 'Gate rejected: Too many CRITICAL findings. Critical: Auth bypass in middleware. Major: Missing retry logic',
      metadata: meta,
      source: 'cycle-meta-001',
      tags: ['verdict:rejected', 'sprint:v9.5'],
    });

    const entries = readMemoryEntries(tmpRoot, 'gate-verdict', 10);
    expect(entries).toHaveLength(1);

    // metadata is preserved as a structured object (no JSON.parse needed)
    const stored = entries[0]!.metadata as GateVerdictMetadata;
    expect(stored.cycleId).toBe('cycle-meta-001');
    expect(stored.verdict).toBe('rejected');
    expect(stored.rationale).toBe('Too many CRITICAL findings');
    expect(stored.criticalFindings).toEqual(['Auth bypass in middleware']);
    expect(stored.majorFindings).toEqual(['Missing retry logic']);
  });

  it('metadata.verdict is lowercase ("approved" | "rejected") not uppercase', () => {
    const meta: GateVerdictMetadata = {
      cycleId: 'cycle-approve-001',
      verdict: 'approved',
      rationale: 'All tests pass, budget within limits',
      criticalFindings: [],
      majorFindings: [],
    };

    writeMemoryEntry(tmpRoot, {
      type: 'gate-verdict',
      value: 'Gate approved: All tests pass, budget within limits',
      metadata: meta,
      source: 'cycle-approve-001',
      tags: ['verdict:approved', 'sprint:v9.5'],
    });

    const entries = readMemoryEntries(tmpRoot, 'gate-verdict', 10);
    const stored = entries[0]!.metadata as GateVerdictMetadata;
    expect(stored.verdict).toBe('approved');
    // Ensure the verdict tag also uses lowercase for consistency
    expect(entries[0]!.tags).toContain('verdict:approved');
  });

  it('value field is a human-readable summary, not a JSON blob', () => {
    const rationale = 'Sprint v9.5 passed all gates';
    writeMemoryEntry(tmpRoot, {
      type: 'gate-verdict',
      value: `Gate approved: ${rationale}`,
      metadata: {
        cycleId: 'cycle-readable-001',
        verdict: 'approved',
        rationale,
        criticalFindings: [],
        majorFindings: [],
      },
      source: 'cycle-readable-001',
      tags: ['verdict:approved'],
    });

    const entries = readMemoryEntries(tmpRoot, 'gate-verdict', 10);
    const storedValue = entries[0]!.value;

    // value must not be parseable as JSON (it's a human string, not a JSON blob)
    expect(() => JSON.parse(storedValue)).toThrow();
    // The rationale appears verbatim in the human-readable value
    expect(storedValue).toContain(rationale);
  });

  it('audit-phase formatMemoryForPrompt renders metadata-bearing entry as a readable bullet', () => {
    writeMemoryEntry(tmpRoot, {
      type: 'gate-verdict',
      value: 'Gate rejected: Stray temp file committed. Critical: index.html.new must be removed',
      metadata: {
        cycleId: 'cycle-prompt-001',
        verdict: 'rejected',
        rationale: 'Stray temp file committed',
        criticalFindings: ['index.html.new must be removed'],
        majorFindings: [],
      },
      source: 'cycle-prompt-001',
      tags: ['verdict:rejected', 'sprint:v9.4'],
    });

    const entries = readRecentMemoryEntries(tmpRoot, 10);
    const section = formatMemoryForPrompt(entries);

    // The human-readable value (not a JSON blob) should appear in the prompt.
    expect(section).toContain('Gate rejected: Stray temp file committed');
    expect(section).toContain('index.html.new must be removed');
  });

  it('cycleId is captured in metadata.cycleId for empty-string fallback when ctx.cycleId is null', () => {
    // When cycleId is unknown (null/undefined from PhaseContext), metadata.cycleId
    // should be an empty string (not null/undefined) to match the GateVerdictMetadata type.
    const meta: GateVerdictMetadata = {
      cycleId: '',  // empty string fallback
      verdict: 'rejected',
      rationale: 'Agent error: timeout',
      criticalFindings: [],
      majorFindings: [],
    };

    writeMemoryEntry(tmpRoot, {
      type: 'gate-verdict',
      value: 'Gate rejected: Agent error: timeout',
      metadata: meta,
      source: undefined,
      tags: ['verdict:rejected'],
    });

    const entries = readMemoryEntries(tmpRoot, 'gate-verdict', 10);
    const stored = entries[0]!.metadata as GateVerdictMetadata;
    expect(stored.cycleId).toBe('');
    expect(typeof stored.cycleId).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// loadPriorGateKnownDebt
//
// Reads the most recent gate-verdict.jsonl entry and returns structured
// PriorGateContext from its metadata field. Must be null-safe: callers get
// null when no prior verdict exists or the metadata is unreadable.
// ---------------------------------------------------------------------------

describe('loadPriorGateKnownDebt', () => {
  it('returns null when no prior gate-verdict entry exists', () => {
    const result = loadPriorGateKnownDebt(tmpRoot);
    expect(result).toBeNull();
  });

  it('returns null when the entry has no metadata field', () => {
    // Write an entry without metadata (e.g. legacy format).
    writeMemoryEntry(tmpRoot, {
      type: 'gate-verdict',
      value: 'Gate approved: legacy entry',
      source: 'cycle-legacy',
      tags: ['verdict:approved'],
      // No metadata field
    });

    const result = loadPriorGateKnownDebt(tmpRoot);
    expect(result).toBeNull();
  });

  it('returns PriorGateContext from the most recent approved entry', () => {
    const meta: GateVerdictMetadata = {
      cycleId: 'cycle-prior-001',
      verdict: 'approved',
      rationale: 'Shipped with known debt',
      criticalFindings: [],
      majorFindings: ['readCycleRecord duplicated across two packages'],
    };

    writeMemoryEntry(tmpRoot, {
      type: 'gate-verdict',
      value: 'Gate approved: Shipped with known debt. Major: readCycleRecord duplicated across two packages',
      metadata: meta,
      source: 'cycle-prior-001',
      tags: ['verdict:approved', 'sprint:v14.0.0'],
    });

    const result = loadPriorGateKnownDebt(tmpRoot);
    expect(result).not.toBeNull();
    expect(result!.cycleId).toBe('cycle-prior-001');
    expect(result!.verdict).toBe('approved');
    expect(result!.majorFindings).toEqual(['readCycleRecord duplicated across two packages']);
    expect(result!.criticalFindings).toEqual([]);
  });

  it('returns PriorGateContext from a rejected entry', () => {
    const meta: GateVerdictMetadata = {
      cycleId: 'cycle-prior-rej',
      verdict: 'rejected',
      rationale: 'capModelTier has no tests',
      criticalFindings: [],
      majorFindings: ['No tests for capModelTier', 'effort typed as string'],
    };

    writeMemoryEntry(tmpRoot, {
      type: 'gate-verdict',
      value: 'Gate rejected: capModelTier has no tests',
      metadata: meta,
      source: 'cycle-prior-rej',
      tags: ['verdict:rejected', 'sprint:v14.0.0'],
    });

    const result = loadPriorGateKnownDebt(tmpRoot);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('rejected');
    expect(result!.majorFindings).toHaveLength(2);
    expect(result!.majorFindings[0]).toContain('capModelTier');
  });

  it('returns context from the MOST RECENT entry when multiple verdicts exist', () => {
    // Write an older approved entry first.
    writeMemoryEntry(tmpRoot, {
      type: 'gate-verdict',
      value: 'Gate approved: older cycle',
      metadata: {
        cycleId: 'cycle-old',
        verdict: 'approved',
        rationale: 'older',
        criticalFindings: [],
        majorFindings: ['old debt'],
      } satisfies GateVerdictMetadata,
      source: 'cycle-old',
    });

    // Write a newer rejected entry.
    writeMemoryEntry(tmpRoot, {
      type: 'gate-verdict',
      value: 'Gate rejected: newer cycle',
      metadata: {
        cycleId: 'cycle-new',
        verdict: 'rejected',
        rationale: 'newer issue',
        criticalFindings: ['Auth bypass'],
        majorFindings: [],
      } satisfies GateVerdictMetadata,
      source: 'cycle-new',
    });

    const result = loadPriorGateKnownDebt(tmpRoot);
    // Must reflect the most recently written entry.
    expect(result!.cycleId).toBe('cycle-new');
    expect(result!.verdict).toBe('rejected');
    expect(result!.criticalFindings).toEqual(['Auth bypass']);
  });

  it('returns null when metadata.verdict is not a valid GateVerdictMetadata verdict', () => {
    writeMemoryEntry(tmpRoot, {
      type: 'gate-verdict',
      value: 'Gate unknown verdict',
      // Non-GateVerdictMetadata shape — uses a Record instead
      metadata: { verdict: 'UNKNOWN', cycleId: 'cycle-bad' } as Record<string, unknown>,
      source: 'cycle-bad',
    });

    const result = loadPriorGateKnownDebt(tmpRoot);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildKnownDebtSection
//
// Pure function that formats a PriorGateContext into a markdown prompt
// section. Tests cover the four cases: null input, empty findings, approved
// verdict with findings, and rejected verdict with findings.
// ---------------------------------------------------------------------------

describe('buildKnownDebtSection', () => {
  it('returns an empty string when prior is null', () => {
    expect(buildKnownDebtSection(null)).toBe('');
  });

  it('returns an empty string when prior has no findings', () => {
    const prior: PriorGateContext = {
      cycleId: 'cycle-empty',
      verdict: 'approved',
      majorFindings: [],
      criticalFindings: [],
    };
    expect(buildKnownDebtSection(prior)).toBe('');
  });

  it('includes the prior verdict label in the section header', () => {
    const prior: PriorGateContext = {
      cycleId: 'cycle-abc',
      verdict: 'approved',
      majorFindings: ['Some known debt'],
      criticalFindings: [],
    };
    const section = buildKnownDebtSection(prior);
    expect(section).toContain('APPROVED');
    expect(section).toContain('cycle-abc');
  });

  it('formats each major finding as a bullet in the section', () => {
    const prior: PriorGateContext = {
      cycleId: 'cycle-fmt',
      verdict: 'approved',
      majorFindings: ['readCycleRecord duplication', 'no-op ternary in sprints.ts'],
      criticalFindings: [],
    };
    const section = buildKnownDebtSection(prior);
    expect(section).toContain('- readCycleRecord duplication');
    expect(section).toContain('- no-op ternary in sprints.ts');
  });

  it('includes critical findings before major findings in the section', () => {
    const prior: PriorGateContext = {
      cycleId: 'cycle-order',
      verdict: 'rejected',
      majorFindings: ['Major issue'],
      criticalFindings: ['Critical issue'],
    };
    const section = buildKnownDebtSection(prior);
    const critPos = section.indexOf('Critical issue');
    const majPos = section.indexOf('Major issue');
    expect(critPos).toBeGreaterThanOrEqual(0);
    expect(majPos).toBeGreaterThanOrEqual(0);
    expect(critPos).toBeLessThan(majPos);
  });

  it('includes "APPROVED" guidance telling the agent not to reject for known debt', () => {
    const prior: PriorGateContext = {
      cycleId: 'cycle-approved',
      verdict: 'approved',
      majorFindings: ['Debt item A'],
      criticalFindings: [],
    };
    const section = buildKnownDebtSection(prior);
    // The guidance must clearly direct the agent not to reject for these items.
    expect(section).toContain('known pre-existing debt');
    expect(section).toContain('Do NOT let them drive a REJECT');
  });

  it('includes "REJECTED" guidance directing the agent to verify if fixed', () => {
    const prior: PriorGateContext = {
      cycleId: 'cycle-rejected',
      verdict: 'rejected',
      majorFindings: ['capModelTier has no tests'],
      criticalFindings: [],
    };
    const section = buildKnownDebtSection(prior);
    // The guidance must tell the agent to check whether items were fixed.
    expect(section).toContain('REJECTED');
    expect(section).toContain('Verify whether each has been addressed');
  });

  it('includes the section heading "Known pre-existing debt"', () => {
    const prior: PriorGateContext = {
      cycleId: 'cycle-heading',
      verdict: 'approved',
      majorFindings: ['Heading test'],
      criticalFindings: [],
    };
    const section = buildKnownDebtSection(prior);
    expect(section).toContain('Known pre-existing debt');
  });
});
