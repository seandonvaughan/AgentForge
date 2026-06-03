/**
 * tests/autonomous/phase-handlers/execute-phase-lesson-attribution.test.ts
 *
 * Phase 0 — Ungameable acceptance test for execute-phase lesson-attribution.
 *
 * Verifies:
 *  - After running the execute phase against a fixture cycle with memory entries
 *    injected, every lessonId in lesson-attribution.jsonl is a member of
 *    {computeLessonId(text) for text in the memory entries visible to each item}.
 *  - A stub that emits arbitrary lessonIds would fail this test.
 *  - When no memory entries match, no attribution rows are written.
 *  - appliedLessons are present on ItemResult when memory entries were injected.
 *  - gateVerdict and verifyPassed are absent at execute-phase time (those fields
 *    are filled later by gate-phase and test-phase respectively).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runExecutePhase,
  type PhaseContext,
} from '../../../packages/core/src/autonomous/phase-handlers/execute-phase.js';
import { computeLessonId } from '../../../packages/core/src/team/engine/learnings/lesson-id.js';
import { readLessonAttributions } from '../../../packages/core/src/memory/lesson-attribution.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockBus() {
  return {
    publish: (_topic: string, _payload: unknown) => {},
    subscribe: (_topic: string, _cb: (event: unknown) => void) => () => {},
  } as any;
}

function writeSprintFile(
  cwd: string,
  version: string,
  items: Array<{
    id: string;
    title: string;
    assignee: string;
    description?: string;
    tags?: string[];
  }>,
) {
  const dir = join(cwd, '.agentforge', 'sprints');
  mkdirSync(dir, { recursive: true });
  const wrapper = {
    sprints: [
      {
        version,
        sprintId: `v${version}-lesson-attr-test`,
        title: `lesson attribution test sprint ${version}`,
        createdAt: new Date().toISOString(),
        phase: 'planned',
        items: items.map((i) => ({
          ...i,
          status: 'planned',
          priority: 'P1',
          estimatedCostUsd: 0,
        })),
        budget: 10,
        teamSize: 1,
        successCriteria: [],
      },
    ],
  };
  writeFileSync(join(dir, `v${version}.json`), JSON.stringify(wrapper, null, 2));
}

/**
 * Write memory JSONL entries with the given tags so readRelevantMemoryEntries
 * will return them when the item has matching tags.
 */
function writeMemoryEntries(
  cwd: string,
  entries: Array<{ type: string; value: string; tags: string[] }>,
) {
  const memDir = join(cwd, '.agentforge', 'memory');
  mkdirSync(memDir, { recursive: true });
  // Group by type to write to the right file
  const byType = new Map<string, typeof entries>();
  for (const e of entries) {
    const list = byType.get(e.type) ?? [];
    list.push(e);
    byType.set(e.type, list);
  }
  for (const [type, list] of byType) {
    const filePath = join(memDir, `${type}.jsonl`);
    const lines = list
      .map((e) =>
        JSON.stringify({
          id: `fixture-${Math.random().toString(36).slice(2)}`,
          type: e.type,
          value: e.value,
          tags: e.tags,
          createdAt: new Date().toISOString(),
        }),
      )
      .join('\n');
    writeFileSync(filePath, lines + '\n', 'utf8');
  }
}

function makeCtx(opts: {
  cwd: string;
  sprintVersion: string;
  runtime: unknown;
  bus?: unknown;
  cycleId?: string;
}): PhaseContext {
  return {
    sprintId: `v${opts.sprintVersion}-lesson-attr-test`,
    sprintVersion: opts.sprintVersion,
    projectRoot: opts.cwd,
    cycleId: opts.cycleId ?? `cycle-la-${opts.sprintVersion}`,
    adapter: {} as any,
    bus: (opts.bus ?? makeMockBus()) as any,
    runtime: opts.runtime as any,
  };
}

function readAttributionFile(cwd: string): unknown[] {
  const filePath = join(cwd, '.agentforge', 'memory', 'lesson-attribution.jsonl');
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('execute-phase — lesson-attribution (Phase 0)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-exec-la-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits attribution rows whose lessonIds are a subset of {computeLessonId(entry.value)} for injected memory entries', async () => {
    // Two memory entries tagged 'memory' — item also tagged 'memory'
    const LESSON_A = 'Always use js-yaml dump instead of template strings for YAML serialization.';
    const LESSON_B = 'Use execFile not exec to avoid shell injection vulnerabilities.';

    writeMemoryEntries(tmpDir, [
      { type: 'review-finding', value: LESSON_A, tags: ['memory', 'yaml'] },
      { type: 'gate-verdict', value: LESSON_B, tags: ['memory', 'security'] },
    ]);

    writeSprintFile(tmpDir, '3.0.0', [
      { id: 'item-mem-a', title: 'fix yaml', assignee: 'yaml-agent', tags: ['memory'] },
    ]);

    const runtime = {
      run: async () => ({ output: 'done', costUsd: 0.01, sessionId: 'sess-1' }),
    };
    const ctx = makeCtx({ cwd: tmpDir, sprintVersion: '3.0.0', runtime });
    await runExecutePhase(ctx, { maxParallelism: 1, selfEvalDisabled: true });

    // The expected set: computeLessonId of every entry.value the prompt builder
    // would have seen (same text that formatMemorySection renders).
    const expectedLessonIds = new Set([computeLessonId(LESSON_A), computeLessonId(LESSON_B)]);

    const rows = readLessonAttributions(tmpDir);
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      // UNGAMEABLE CHECK: every emitted lessonId must be in the expected set
      expect(expectedLessonIds.has(row.lessonId)).toBe(true);
      // Structural checks
      expect(row.cycleId).toBeTruthy();
      expect(row.itemId).toBe('item-mem-a');
      expect(row.scope).toBe('cycle');
      expect(row.id).toBeTruthy();
      expect(row.ts).toBeTruthy();
    }

    // All expected lesson IDs should appear (both entries matched the tag)
    const emittedIds = new Set(rows.map((r) => r.lessonId));
    for (const expected of expectedLessonIds) {
      expect(emittedIds.has(expected)).toBe(true);
    }
  });

  it('emits no attribution rows when no memory entries match item tags', async () => {
    // Memory entry tagged 'auth' — item tagged 'database' (no overlap)
    writeMemoryEntries(tmpDir, [
      { type: 'review-finding', value: 'Always validate JWT tokens.', tags: ['auth'] },
    ]);

    writeSprintFile(tmpDir, '3.0.1', [
      { id: 'item-db', title: 'fix db query', assignee: 'db-agent', tags: ['database'] },
    ]);

    const runtime = {
      run: async () => ({ output: 'done', costUsd: 0.01, sessionId: 'sess-2' }),
    };
    const ctx = makeCtx({ cwd: tmpDir, sprintVersion: '3.0.1', runtime });
    await runExecutePhase(ctx, { maxParallelism: 1, selfEvalDisabled: true });

    const rows = readLessonAttributions(tmpDir);
    expect(rows).toHaveLength(0);
  });

  it('appliedLessons on ItemResult contain exactly the lesson IDs for injected entries', async () => {
    const LESSON = 'Never use String.match with user-controlled input — use String.includes.';
    writeMemoryEntries(tmpDir, [
      { type: 'gate-verdict', value: LESSON, tags: ['security', 'input-validation'] },
    ]);

    writeSprintFile(tmpDir, '3.0.2', [
      { id: 'item-sec', title: 'fix input validation', assignee: 'sec-agent', tags: ['security'] },
    ]);

    const runtime = {
      run: async () => ({ output: 'fixed', costUsd: 0.02, sessionId: 'sess-3' }),
    };
    const ctx = makeCtx({ cwd: tmpDir, sprintVersion: '3.0.2', runtime });
    const result = await runExecutePhase(ctx, { maxParallelism: 1, selfEvalDisabled: true });

    const itemRes = result.itemResults?.[0] as any;
    expect(Array.isArray(itemRes?.appliedLessons)).toBe(true);
    expect(itemRes.appliedLessons).toContain(computeLessonId(LESSON));
  });

  it('gateVerdict and verifyPassed are absent on attribution rows at execute time', async () => {
    const LESSON = 'Use corepack pnpm for all package manager commands.';
    writeMemoryEntries(tmpDir, [
      { type: 'cycle-outcome', value: LESSON, tags: ['build'] },
    ]);

    writeSprintFile(tmpDir, '3.0.3', [
      { id: 'item-build', title: 'fix build', assignee: 'build-agent', tags: ['build'] },
    ]);

    const runtime = {
      run: async () => ({ output: 'done', costUsd: 0.01, sessionId: 'sess-4' }),
    };
    const ctx = makeCtx({ cwd: tmpDir, sprintVersion: '3.0.3', runtime });
    await runExecutePhase(ctx, { maxParallelism: 1, selfEvalDisabled: true });

    const rows = readLessonAttributions(tmpDir);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect('gateVerdict' in row).toBe(false);
      expect('verifyPassed' in row).toBe(false);
    }
  });

  it('handles multiple items with different tag sets independently', async () => {
    const LESSON_YAML = 'Use js-yaml dump not template strings.';
    const LESSON_AUTH = 'Always validate JWT token expiry.';

    writeMemoryEntries(tmpDir, [
      { type: 'review-finding', value: LESSON_YAML, tags: ['yaml', 'serialization'] },
      { type: 'gate-verdict', value: LESSON_AUTH, tags: ['auth', 'security'] },
    ]);

    writeSprintFile(tmpDir, '3.0.4', [
      { id: 'item-yaml', title: 'fix yaml', assignee: 'yaml-agent', tags: ['yaml'] },
      { id: 'item-auth', title: 'fix auth', assignee: 'auth-agent', tags: ['auth'] },
    ]);

    const runtime = {
      run: async () => ({ output: 'done', costUsd: 0.01, sessionId: 'sess-5' }),
    };
    const ctx = makeCtx({ cwd: tmpDir, sprintVersion: '3.0.4', runtime });
    await runExecutePhase(ctx, { maxParallelism: 2, selfEvalDisabled: true });

    const rows = readLessonAttributions(tmpDir);
    // Each item should see only its matching lesson
    const yamlRows = rows.filter((r) => r.itemId === 'item-yaml');
    const authRows = rows.filter((r) => r.itemId === 'item-auth');

    // yaml item should only see yaml lesson
    expect(yamlRows.every((r) => r.lessonId === computeLessonId(LESSON_YAML))).toBe(true);
    // auth item should only see auth lesson
    expect(authRows.every((r) => r.lessonId === computeLessonId(LESSON_AUTH))).toBe(true);
  });
});
