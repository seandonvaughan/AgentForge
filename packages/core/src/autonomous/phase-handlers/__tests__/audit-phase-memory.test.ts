/**
 * Unit tests for audit-phase memory injection + audit.json recording.
 *
 * Verifies that:
 *  1. readRecentMemoryEntries / formatMemoryForPrompt behave correctly
 *  2. runAuditPhase writes `memoriesInjected` into audit.json — the signal
 *     used by computeMemoryStats() to compute a precise flywheel hit rate.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readRecentMemoryEntries,
  formatMemoryForPrompt,
  runAuditPhase,
} from '../audit-phase.js';
import type { PhaseContext } from '../../phase-scheduler.js';
import type { CycleMemoryEntry, MemoryEntryType } from '../../../memory/types.js';

// ---------------------------------------------------------------------------
// Temp dir lifecycle
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-audit-mem-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeMemoryFile(filename: string, entries: object[]): void {
  const memDir = join(tmpRoot, '.agentforge', 'memory');
  mkdirSync(memDir, { recursive: true });
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(memDir, filename), content, 'utf8');
}

/** Minimal PhaseContext stub that captures what the agent was asked. */
function makeCtx(cycleId = 'test-cycle-001'): {
  ctx: PhaseContext;
  capturedTask: () => string;
} {
  let lastTask = '';
  const ctx: PhaseContext = {
    projectRoot: tmpRoot,
    cycleId,
    sprintId: 'sprint-1',
    sprintVersion: '9.0.0',
    adapter: undefined as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    bus: {
      publish: () => undefined,
      subscribe: () => () => undefined,
    } as unknown as PhaseContext['bus'],
    runtime: {
      run: async (_agentId: string, task: string) => {
        lastTask = task;
        return { output: '## Audit findings\n- all looks good', costUsd: 0.01 };
      },
    } as unknown as PhaseContext['runtime'],
  };
  return { ctx, capturedTask: () => lastTask };
}

function makeEntry(
  id: string,
  type: MemoryEntryType,
  value: string,
  createdAt: string,
  extra: Partial<CycleMemoryEntry> = {},
): CycleMemoryEntry {
  return { id, type, value, createdAt, ...extra };
}

// ---------------------------------------------------------------------------
// readRecentMemoryEntries
// ---------------------------------------------------------------------------

describe('readRecentMemoryEntries', () => {
  it('returns [] when memory directory does not exist', () => {
    const entries = readRecentMemoryEntries(tmpRoot);
    expect(entries).toEqual([]);
  });

  it('returns [] when memory dir is empty', () => {
    mkdirSync(join(tmpRoot, '.agentforge', 'memory'), { recursive: true });
    expect(readRecentMemoryEntries(tmpRoot)).toEqual([]);
  });

  it('reads entries from JSONL files', () => {
    writeMemoryFile('cycle-outcome.jsonl', [
      makeEntry('1', 'cycle-outcome', 'cycle A completed', '2026-01-01T10:00:00Z'),
      makeEntry('2', 'cycle-outcome', 'cycle B failed',    '2026-01-02T10:00:00Z'),
    ]);
    const entries = readRecentMemoryEntries(tmpRoot);
    expect(entries).toHaveLength(2);
  });

  it('respects per-type limit', () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      makeEntry(String(i), 'cycle-outcome', `entry ${i}`, `2026-01-${String(i + 1).padStart(2, '0')}T10:00:00Z`),
    );
    writeMemoryFile('cycle-outcome.jsonl', entries);
    // Default limit is 10
    const result = readRecentMemoryEntries(tmpRoot, 10);
    expect(result).toHaveLength(10);
  });

  it('skips entries without type or value fields', () => {
    // Mix valid JSONL with malformed objects (raw JSON, not typed)
    const memDir = join(tmpRoot, '.agentforge', 'memory');
    mkdirSync(memDir, { recursive: true });
    const lines = [
      JSON.stringify({ id: '1', type: 'cycle-outcome', value: 'valid', createdAt: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ id: '2' }), // missing type + value
      JSON.stringify({ id: '3', type: 'gate-verdict' }), // missing value
    ].join('\n') + '\n';
    writeFileSync(join(memDir, 'bad.jsonl'), lines, 'utf8');
    const result = readRecentMemoryEntries(tmpRoot);
    expect(result).toHaveLength(1);
    expect(result[0]?.value).toBe('valid');
  });
});

// ---------------------------------------------------------------------------
// formatMemoryForPrompt
// ---------------------------------------------------------------------------

describe('formatMemoryForPrompt', () => {
  it('returns "" for empty entries', () => {
    expect(formatMemoryForPrompt([])).toBe('');
  });

  it('groups entries by type with labelled headings', () => {
    const entries: CycleMemoryEntry[] = [
      makeEntry('1', 'gate-verdict',   'REJECT: costs too high',   '2026-01-01T00:00:00Z'),
      makeEntry('2', 'cycle-outcome',  'passed all tests',          '2026-01-01T00:00:00Z'),
      makeEntry('3', 'review-finding', 'avoid console.log in prod', '2026-01-01T00:00:00Z'),
    ];
    const result = formatMemoryForPrompt(entries);
    expect(result).toContain('Past mistakes and learnings');
    expect(result).toContain('Gate verdicts');
    expect(result).toContain('Cycle outcomes');
    expect(result).toContain('Code review findings');
  });

  it('includes source reference when present', () => {
    const entries: CycleMemoryEntry[] = [
      makeEntry('1', 'cycle-outcome', 'cycle failed', '2026-01-01T00:00:00Z', { source: 'abc123' }),
    ];
    const result = formatMemoryForPrompt(entries);
    expect(result).toContain('abc123');
  });
});

// ---------------------------------------------------------------------------
// runAuditPhase — memoriesInjected recording
// ---------------------------------------------------------------------------

describe('runAuditPhase — memoriesInjected in audit.json', () => {
  it('writes memoriesInjected: 0 when no memory entries exist', async () => {
    const { ctx } = makeCtx('cycle-no-mem');

    await runAuditPhase(ctx);

    const auditPath = join(tmpRoot, '.agentforge/cycles/cycle-no-mem/phases/audit.json');
    expect(existsSync(auditPath)).toBe(true);
    const written = JSON.parse(readFileSync(auditPath, 'utf-8')) as { memoriesInjected: number };
    expect(written.memoriesInjected).toBe(0);
  });

  it('writes memoriesInjected: N when N memory entries exist', async () => {
    // Write 3 memory entries before running the audit phase
    writeMemoryFile('cycle-outcome.jsonl', [
      makeEntry('1', 'cycle-outcome', 'prev cycle passed', '2026-01-01T00:00:00Z'),
      makeEntry('2', 'cycle-outcome', 'prev cycle failed', '2026-01-02T00:00:00Z'),
    ]);
    writeMemoryFile('gate-verdict.jsonl', [
      makeEntry('3', 'gate-verdict',  'REJECT cost high',  '2026-01-03T00:00:00Z'),
    ]);
    const { ctx } = makeCtx('cycle-with-mem');

    await runAuditPhase(ctx, { memoryLimit: 10 });

    const auditPath = join(tmpRoot, '.agentforge/cycles/cycle-with-mem/phases/audit.json');
    expect(existsSync(auditPath)).toBe(true);
    const written = JSON.parse(readFileSync(auditPath, 'utf-8')) as { memoriesInjected: number };
    expect(written.memoriesInjected).toBe(3);
  });

  it('includes memory section in prompt when entries exist', async () => {
    writeMemoryFile('cycle-outcome.jsonl', [
      makeEntry('1', 'cycle-outcome', 'cycle A failed due to timeout', '2026-01-01T00:00:00Z'),
    ]);
    const { ctx, capturedTask } = makeCtx('cycle-prompt-test');

    await runAuditPhase(ctx);

    expect(capturedTask()).toContain('Past mistakes and learnings');
    expect(capturedTask()).toContain('cycle A failed due to timeout');
  });

  it('does NOT include memory section in prompt when no entries exist', async () => {
    const { ctx, capturedTask } = makeCtx('cycle-no-context');

    await runAuditPhase(ctx);

    expect(capturedTask()).not.toContain('Past mistakes and learnings');
  });
});
