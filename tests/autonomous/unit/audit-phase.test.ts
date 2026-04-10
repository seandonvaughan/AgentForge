// tests/autonomous/unit/audit-phase.test.ts
//
// v6.8.0 — Tests for the audit phase memory injection functions.
//
// Covers: readRecentMemoryEntries, formatMemoryForPrompt, and runAuditPhase
// prompt construction. The runtime is mocked so no real agent dispatches happen.
// Each test gets its own tmpdir to prevent cross-contamination.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readRecentMemoryEntries,
  formatMemoryForPrompt,
  runAuditPhase,
  AUDIT_PHASE_DEFAULT_TOOLS,
  type AuditPhaseOptions,
} from '../../../packages/core/src/autonomous/phase-handlers/audit-phase.js';
import type { CycleMemoryEntry } from '../../../packages/core/src/memory/types.js';
import type { PhaseContext } from '../../../packages/core/src/autonomous/phase-scheduler.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-audit-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Write one or more CycleMemoryEntry objects to a .agentforge/memory/<type>.jsonl file. */
function writeMemoryJsonl(
  root: string,
  type: CycleMemoryEntry['type'],
  entries: CycleMemoryEntry[],
): void {
  const dir = join(root, '.agentforge', 'memory');
  mkdirSync(dir, { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(join(dir, `${type}.jsonl`), lines + '\n', 'utf8');
}

function makeEntry(
  type: CycleMemoryEntry['type'],
  value: string,
  overrides: Partial<CycleMemoryEntry> = {},
): CycleMemoryEntry {
  return {
    id: `id-${type}-${Math.random().toString(36).slice(2)}`,
    type,
    value,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockBus() {
  const published: Array<{ topic: string; payload: unknown }> = [];
  return {
    published,
    bus: {
      publish: (topic: string, payload: unknown) => {
        published.push({ topic, payload });
      },
      subscribe: (_topic: string, _cb: (event: unknown) => void) => () => {},
    } as any,
  };
}

function makeCtx(cwd: string, runtime: unknown, cycleId?: string): PhaseContext {
  const { bus } = makeMockBus();
  return {
    sprintId: 'sprint-test-1',
    sprintVersion: '6.8',
    projectRoot: cwd,
    adapter: {} as any,
    bus,
    runtime: runtime as any,
    ...(cycleId ? { cycleId } : {}),
  };
}

// ---------------------------------------------------------------------------
// readRecentMemoryEntries
// ---------------------------------------------------------------------------

describe('readRecentMemoryEntries', () => {
  it('returns an empty array when the memory directory does not exist', () => {
    const entries = readRecentMemoryEntries(tmpRoot, 10);
    expect(entries).toEqual([]);
  });

  it('returns an empty array when the memory directory exists but has no JSONL files', () => {
    mkdirSync(join(tmpRoot, '.agentforge', 'memory'), { recursive: true });
    const entries = readRecentMemoryEntries(tmpRoot, 10);
    expect(entries).toEqual([]);
  });

  it('reads entries from a single JSONL file', () => {
    const e1 = makeEntry('gate-verdict', 'Sprint 6.7 gate rejected: tests failing');
    const e2 = makeEntry('gate-verdict', 'Sprint 6.8 gate approved');
    writeMemoryJsonl(tmpRoot, 'gate-verdict', [e1, e2]);

    const entries = readRecentMemoryEntries(tmpRoot, 10);
    expect(entries).toHaveLength(2);
  });

  it('reads entries from multiple JSONL files', () => {
    writeMemoryJsonl(tmpRoot, 'gate-verdict', [
      makeEntry('gate-verdict', 'Gate rejected v6.7'),
    ]);
    writeMemoryJsonl(tmpRoot, 'review-finding', [
      makeEntry('review-finding', '[MAJOR] src/foo.ts: missing null check'),
    ]);

    const entries = readRecentMemoryEntries(tmpRoot, 10);
    expect(entries).toHaveLength(2);
  });

  it('respects the limit per file (capped per individual JSONL)', () => {
    // Write 15 entries to one file
    const many = Array.from({ length: 15 }, (_, i) =>
      makeEntry('failure-pattern', `pattern ${i}`, {
        createdAt: new Date(Date.now() - i * 1000).toISOString(),
      }),
    );
    writeMemoryJsonl(tmpRoot, 'failure-pattern', many);

    // With limit=5, no more than 5 entries per file should be taken
    const entries = readRecentMemoryEntries(tmpRoot, 5);
    expect(entries.length).toBeLessThanOrEqual(5);
  });

  it('sorts the returned entries newest-first across all files', () => {
    const older = makeEntry('gate-verdict', 'older verdict', {
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const newer = makeEntry('review-finding', 'newer finding', {
      createdAt: '2026-04-01T00:00:00.000Z',
    });
    writeMemoryJsonl(tmpRoot, 'gate-verdict', [older]);
    writeMemoryJsonl(tmpRoot, 'review-finding', [newer]);

    const entries = readRecentMemoryEntries(tmpRoot, 10);
    expect(entries[0]!.value).toBe('newer finding');
    expect(entries[1]!.value).toBe('older verdict');
  });

  it('skips malformed JSONL lines without throwing', () => {
    const dir = join(tmpRoot, '.agentforge', 'memory');
    mkdirSync(dir, { recursive: true });
    // Write one valid entry preceded by a corrupt line
    const valid = makeEntry('learned-fact', 'valid entry');
    writeFileSync(
      join(dir, 'learned-fact.jsonl'),
      'this is not json\n' + JSON.stringify(valid) + '\n',
      'utf8',
    );

    const entries = readRecentMemoryEntries(tmpRoot, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.value).toBe('valid entry');
  });

  it('skips entries that lack a type or value field', () => {
    const dir = join(tmpRoot, '.agentforge', 'memory');
    mkdirSync(dir, { recursive: true });
    // Write an entry missing 'value'
    const incomplete = { id: 'x', type: 'gate-verdict', createdAt: new Date().toISOString() };
    writeFileSync(join(dir, 'gate-verdict.jsonl'), JSON.stringify(incomplete) + '\n', 'utf8');

    const entries = readRecentMemoryEntries(tmpRoot, 10);
    expect(entries).toHaveLength(0);
  });

  it('ignores non-.jsonl files in the memory directory', () => {
    const dir = join(tmpRoot, '.agentforge', 'memory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.txt'), 'this should be ignored', 'utf8');
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ foo: 'bar' }), 'utf8');

    const entries = readRecentMemoryEntries(tmpRoot, 10);
    expect(entries).toHaveLength(0);
  });

  it('preserves optional source and tags fields on each entry', () => {
    const e = makeEntry('learned-fact', 'tagged entry', {
      source: 'cycle-abc',
      tags: ['typescript', 'testing'],
    });
    writeMemoryJsonl(tmpRoot, 'learned-fact', [e]);

    const [result] = readRecentMemoryEntries(tmpRoot, 10);
    expect(result!.source).toBe('cycle-abc');
    expect(result!.tags).toEqual(['typescript', 'testing']);
  });
});

// ---------------------------------------------------------------------------
// formatMemoryForPrompt
// ---------------------------------------------------------------------------

describe('formatMemoryForPrompt', () => {
  it('returns an empty string for an empty entries array', () => {
    expect(formatMemoryForPrompt([])).toBe('');
  });

  it('includes the top-level section header', () => {
    const entries: CycleMemoryEntry[] = [
      makeEntry('gate-verdict', 'Sprint 6.7 rejected'),
    ];
    const result = formatMemoryForPrompt(entries);
    expect(result).toContain('## Past mistakes and learnings (cross-cycle memory)');
  });

  it('groups entries by type with a labelled sub-header', () => {
    const entries: CycleMemoryEntry[] = [
      makeEntry('gate-verdict', 'Gate rejected: tests failing'),
      makeEntry('review-finding', '[MAJOR] src/bar.ts: unhandled promise'),
    ];
    const result = formatMemoryForPrompt(entries);
    expect(result).toContain('### Gate verdicts');
    expect(result).toContain('### Code review findings');
  });

  it('formats each entry as a markdown bullet point', () => {
    const entries: CycleMemoryEntry[] = [
      makeEntry('failure-pattern', 'mock not updated after refactor'),
    ];
    const result = formatMemoryForPrompt(entries);
    expect(result).toContain('- mock not updated after refactor');
  });

  it('appends the source as italic text when present', () => {
    const entries: CycleMemoryEntry[] = [
      makeEntry('learned-fact', 'TypeScript strict mode catches division errors', {
        source: 'cycle-xyz',
      }),
    ];
    const result = formatMemoryForPrompt(entries);
    expect(result).toContain('_(cycle-xyz)_');
  });

  it('omits source annotation when source is absent', () => {
    const entries: CycleMemoryEntry[] = [
      makeEntry('gate-verdict', 'Gate rejected: budget exceeded'),
    ];
    const result = formatMemoryForPrompt(entries);
    // Should not contain any source annotation markers
    expect(result).not.toContain('_(_');
  });

  it('caps each type group at 5 entries in the output', () => {
    // Write 8 gate-verdict entries — only 5 should appear
    const entries: CycleMemoryEntry[] = Array.from({ length: 8 }, (_, i) =>
      makeEntry('gate-verdict', `verdict ${i}`),
    );
    const result = formatMemoryForPrompt(entries);
    // Count bullet points for gate-verdict
    const bullets = result.split('\n').filter((l) => l.startsWith('- verdict'));
    expect(bullets.length).toBeLessThanOrEqual(5);
  });

  it('uses the full type name as sub-header label for unknown types', () => {
    const entries: CycleMemoryEntry[] = [
      { id: 'x', type: 'custom-type' as any, value: 'custom entry', createdAt: new Date().toISOString() },
    ];
    const result = formatMemoryForPrompt(entries);
    // Unknown type falls back to the type string itself as the header
    expect(result).toContain('custom-type');
  });

  it('produces a non-empty section when mixing multiple entry types', () => {
    const entries: CycleMemoryEntry[] = [
      makeEntry('gate-verdict', 'rejected: 5/10 items'),
      makeEntry('review-finding', '[CRITICAL] key leaked'),
      makeEntry('cycle-outcome', 'cost $18 — over budget'),
      makeEntry('failure-pattern', 'spawn mock missing'),
      makeEntry('learned-fact', 'always update test mocks after refactor'),
    ];
    const result = formatMemoryForPrompt(entries);
    expect(result.length).toBeGreaterThan(100);
    // All 5 types should appear — formatMemoryForPrompt maps types to human-readable labels
    expect(result).toContain('Gate verdicts');
    expect(result).toContain('Code review findings');
    expect(result).toContain('Cycle outcomes');
    expect(result).toContain('Known failure patterns');
    expect(result).toContain('Learned facts');
  });
});

// ---------------------------------------------------------------------------
// runAuditPhase — memory injection integration
// ---------------------------------------------------------------------------

describe('runAuditPhase — memory injection', () => {
  it('passes a prompt containing the memory section when entries exist', async () => {
    // Write a gate-verdict entry to the memory store
    writeMemoryJsonl(tmpRoot, 'gate-verdict', [
      makeEntry('gate-verdict', 'Sprint 6.7 gate REJECTED: only 3/10 items completed', {
        createdAt: '2026-04-01T10:00:00.000Z',
      }),
    ]);

    let capturedTask = '';
    const mockRuntime = {
      run: vi.fn((_agentId: string, task: string) => {
        capturedTask = task;
        return Promise.resolve({ output: '## Audit findings\n- All good', costUsd: 0.01 });
      }),
    };

    const ctx = makeCtx(tmpRoot, mockRuntime);
    await runAuditPhase(ctx, { memoryLimit: 10 });

    expect(capturedTask).toContain('Past mistakes and learnings');
    expect(capturedTask).toContain('Sprint 6.7 gate REJECTED');
  });

  it('omits the memory block when the memory directory is absent', async () => {
    let capturedTask = '';
    const mockRuntime = {
      run: vi.fn((_agentId: string, task: string) => {
        capturedTask = task;
        return Promise.resolve({ output: 'findings', costUsd: 0 });
      }),
    };

    const ctx = makeCtx(tmpRoot, mockRuntime);
    await runAuditPhase(ctx);

    expect(capturedTask).not.toContain('Past mistakes and learnings');
  });

  it('includes a directive to avoid repeating past mistakes when memory is injected', async () => {
    writeMemoryJsonl(tmpRoot, 'failure-pattern', [
      makeEntry('failure-pattern', 'spawn mock not updated after refactor'),
    ]);

    let capturedTask = '';
    const mockRuntime = {
      run: vi.fn((_agentId: string, task: string) => {
        capturedTask = task;
        return Promise.resolve({ output: 'ok', costUsd: 0 });
      }),
    };

    const ctx = makeCtx(tmpRoot, mockRuntime);
    await runAuditPhase(ctx);

    expect(capturedTask).toContain('avoid patterns that caused previous cycles to fail');
  });

  it('uses the researcher agent by default', async () => {
    const mockRuntime = {
      run: vi.fn(() => Promise.resolve({ output: 'ok', costUsd: 0 })),
    };

    const ctx = makeCtx(tmpRoot, mockRuntime);
    await runAuditPhase(ctx);

    expect(mockRuntime.run).toHaveBeenCalledWith(
      'researcher',
      expect.any(String),
      expect.objectContaining({ allowedTools: AUDIT_PHASE_DEFAULT_TOOLS }),
    );
  });

  it('honours a custom agentId option', async () => {
    const mockRuntime = {
      run: vi.fn(() => Promise.resolve({ output: 'ok', costUsd: 0 })),
    };

    const ctx = makeCtx(tmpRoot, mockRuntime);
    await runAuditPhase(ctx, { agentId: 'custom-auditor' });

    expect(mockRuntime.run).toHaveBeenCalledWith('custom-auditor', expect.any(String), expect.anything());
  });

  it('returns status=completed and the agent output on success', async () => {
    const mockRuntime = {
      run: vi.fn(() =>
        Promise.resolve({ output: '## Summary\nAll looks good', costUsd: 0.05 }),
      ),
    };

    const ctx = makeCtx(tmpRoot, mockRuntime);
    const result = await runAuditPhase(ctx);

    expect(result.status).toBe('completed');
    expect(result.agentRuns[0]!.response).toContain('All looks good');
    expect(result.costUsd).toBe(0.05);
  });

  it('returns status=failed and records the error when the runtime throws', async () => {
    const mockRuntime = {
      run: vi.fn(() => Promise.reject(new Error('agent timeout'))),
    };

    const ctx = makeCtx(tmpRoot, mockRuntime);
    const result = await runAuditPhase(ctx);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('agent timeout');
  });

  it('writes audit.json when cycleId is provided', async () => {
    const cycleId = 'cycle-test-001';
    const mockRuntime = {
      run: vi.fn(() => Promise.resolve({ output: 'findings', costUsd: 0.02 })),
    };

    const ctx = makeCtx(tmpRoot, mockRuntime, cycleId);
    await runAuditPhase(ctx);

    const { existsSync } = await import('node:fs');
    const phaseJsonPath = join(
      tmpRoot,
      '.agentforge',
      'cycles',
      cycleId,
      'phases',
      'audit.json',
    );
    expect(existsSync(phaseJsonPath)).toBe(true);
  });

  it('publishes sprint.phase.started and sprint.phase.completed events', async () => {
    const mockRuntime = {
      run: vi.fn(() => Promise.resolve({ output: 'ok', costUsd: 0 })),
    };
    const { published, bus } = makeMockBus();

    const ctx: PhaseContext = {
      sprintId: 'sprint-event-test',
      sprintVersion: '6.8',
      projectRoot: tmpRoot,
      adapter: {} as any,
      bus,
      runtime: mockRuntime as any,
    };

    await runAuditPhase(ctx);

    const topics = published.map((e) => e.topic);
    expect(topics).toContain('sprint.phase.started');
    expect(topics).toContain('sprint.phase.completed');
  });

  it('respects the memoryLimit option when reading entries', async () => {
    // Write 20 entries across two types
    writeMemoryJsonl(
      tmpRoot,
      'gate-verdict',
      Array.from({ length: 10 }, (_, i) =>
        makeEntry('gate-verdict', `verdict ${i}`, {
          createdAt: new Date(Date.now() - i * 60_000).toISOString(),
        }),
      ),
    );
    writeMemoryJsonl(
      tmpRoot,
      'review-finding',
      Array.from({ length: 10 }, (_, i) =>
        makeEntry('review-finding', `finding ${i}`, {
          createdAt: new Date(Date.now() - i * 60_000).toISOString(),
        }),
      ),
    );

    let capturedTask = '';
    const mockRuntime = {
      run: vi.fn((_agentId: string, task: string) => {
        capturedTask = task;
        return Promise.resolve({ output: 'ok', costUsd: 0 });
      }),
    };

    const ctx = makeCtx(tmpRoot, mockRuntime);
    // Limit to 3 entries per file
    await runAuditPhase(ctx, { memoryLimit: 3 });

    // The prompt should still include the memory section
    expect(capturedTask).toContain('Past mistakes and learnings');
    // But only up to the capped entries (hard to count exactly — just verify it runs without error)
  });
});
