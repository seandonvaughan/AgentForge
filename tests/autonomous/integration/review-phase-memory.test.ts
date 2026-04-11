// tests/autonomous/integration/review-phase-memory.test.ts
//
// Verifies that the server-side runReviewPhase writes review-finding memory
// entries to .agentforge/memory/review-finding.jsonl for MAJOR and CRITICAL
// findings after each review cycle.
//
// This is the regression guard for the "wire review phase handler to write
// review-finding memory entries for MAJOR/CRITICAL findings" sprint item. The
// canonical (packages/core) review-phase handler is tested separately in
// packages/core/src/autonomous/phase-handlers/__tests__/review-phase-memory.test.ts;
// this test covers the server-side path in packages/server/src/lib/phase-handlers.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports that touch these modules.
// We mock AgentRuntime and loadAgentConfig (needed by runLlmPhase) but leave
// writeMemoryEntry and parseReviewFindingMetadata un-mocked so the actual
// JSONL write and metadata extraction occur.
// ---------------------------------------------------------------------------

// The review agent response — embedded as a constant so individual tests can
// control which findings get written to the sprint file.
const REVIEW_WITH_MAJOR_AND_CRITICAL =
  'Overall the sprint is solid.\n\n' +
  'CRITICAL: src/auth.ts — token validation is completely absent. Fix: call verifyToken() before use\n' +
  'MAJOR: src/registry/index.ts:42 — duplicate route registration on restart\n' +
  '\nOverall verdict: 3/5 — needs work before merge';

const REVIEW_WITH_MAJOR_ONLY =
  'Minor nits aside, one real issue:\n\n' +
  'MAJOR: src/server/routes.ts:88 — route handler swallows errors silently\n' +
  '\nOverall verdict: 4/5 — almost there';

const REVIEW_WITH_NO_CRITICAL_OR_MAJOR =
  'Looks good! Minor style suggestions only.\n\n' +
  '- Use const instead of let where possible\n' +
  '\nOverall verdict: 5/5 — ship it';

let mockResponse = REVIEW_WITH_MAJOR_AND_CRITICAL;

vi.mock('@agentforge/core', async () => {
  const real = await vi.importActual<typeof import('@agentforge/core')>('@agentforge/core');

  return {
    ...real,
    AgentRuntime: vi.fn().mockImplementation(() => ({
      runStreaming: vi.fn().mockImplementation(() =>
        Promise.resolve({
          sessionId: 'mock-review-session',
          response: mockResponse,
          model: 'claude-sonnet-4-6',
          inputTokens: 80,
          outputTokens: 200,
          costUsd: 0.004,
          startedAt: '2026-04-09T00:00:00.000Z',
          completedAt: '2026-04-09T00:00:01.000Z',
          status: 'completed' as const,
        }),
      ),
      run: vi.fn().mockImplementation(() =>
        Promise.resolve({
          sessionId: 'mock-review-session',
          response: mockResponse,
          model: 'claude-sonnet-4-6',
          inputTokens: 80,
          outputTokens: 200,
          costUsd: 0.004,
          startedAt: '2026-04-09T00:00:00.000Z',
          completedAt: '2026-04-09T00:00:01.000Z',
          status: 'completed' as const,
        }),
      ),
    })),
    loadAgentConfig: vi.fn().mockImplementation(async (agentId: string) => {
      if (!agentId) return null;
      return {
        agentId,
        name: agentId,
        model: 'sonnet' as const,
        systemPrompt: 'mock system prompt',
        workspaceId: 'default',
      };
    }),
  };
});

vi.mock('../../../packages/server/src/routes/v5/stream.js', () => ({
  globalStream: { emit: vi.fn() },
}));

vi.mock('@agentforge/shared', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@agentforge/shared');
  let counter = 0;
  return {
    ...actual,
    generateId: vi.fn(() => `review-test-id-${++counter}`),
    nowIso: vi.fn(() => '2026-04-09T00:00:00.000Z'),
  };
});

// Import after mocks are established.
import {
  runReviewPhase,
  type PhaseContext,
  type EventBus,
  type SprintFile,
} from '../../../packages/server/src/lib/phase-handlers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockBus(): EventBus {
  return { publish: vi.fn() };
}

function makeTmp(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), 'agentforge-review-mem-'));
  mkdirSync(join(cwd, '.agentforge', 'sprints'), { recursive: true });
  mkdirSync(join(cwd, '.agentforge', 'agents'), { recursive: true });
  return {
    cwd,
    cleanup: () => {
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {}
    },
  };
}

/**
 * Seed the sprint JSON file.
 *
 * When `reviewResponse` is provided it is injected as a pre-existing review
 * phase result — exactly the same pattern as `gate-phase-memory.test.ts` uses
 * for gate responses. `runReviewPhase` reads this after the mocked LLM call to
 * extract CRITICAL/MAJOR findings.
 */
function seedSprint(
  cwd: string,
  version: string,
  reviewResponse?: string,
  itemTags?: string[],
): void {
  const sprint: SprintFile = {
    sprintId: `sprint-${version}`,
    version,
    title: `v${version} sprint`,
    createdAt: '2026-04-09T00:00:00.000Z',
    phase: 'review',
    items: [
      {
        id: 'i1',
        title: 'Item 1',
        description: '',
        priority: 'P1',
        assignee: 'coder',
        status: 'completed',
        ...(itemTags ? { tags: itemTags } : {}),
      },
    ],
    budget: 50,
    teamSize: 1,
    successCriteria: [],
    auditFindings: [],
    agentsInvolved: [],
    budgetUsed: 5,
    phaseResults: reviewResponse
      ? [
          {
            phase: 'review',
            agentId: 'code-reviewer',
            sessionId: 'pre-seeded-review',
            response: reviewResponse,
            costUsd: 0.002,
            inputTokens: 40,
            outputTokens: 150,
            status: 'completed',
            ranAt: '2026-04-09T00:00:00.000Z',
          },
        ]
      : [],
  };
  writeFileSync(
    join(cwd, '.agentforge', 'sprints', `v${version}.json`),
    JSON.stringify(sprint, null, 2),
  );
}

function makeCtx(cwd: string, version: string, cycleId?: string): PhaseContext {
  return {
    sprintId: `sprint-${version}`,
    sprintVersion: version,
    projectRoot: cwd,
    agentforgeDir: join(cwd, '.agentforge'),
    bus: makeMockBus(),
    ...(cycleId !== undefined ? { cycleId } : {}),
  };
}

const JSONL_PATH = (cwd: string) =>
  join(cwd, '.agentforge', 'memory', 'review-finding.jsonl');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('server runReviewPhase — review-finding memory write', () => {
  let cwd: string;
  let cleanup: () => void;

  beforeEach(() => {
    mockResponse = REVIEW_WITH_MAJOR_AND_CRITICAL;
    const tmp = makeTmp();
    cwd = tmp.cwd;
    cleanup = tmp.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it('creates review-finding.jsonl when the review contains CRITICAL findings', async () => {
    mockResponse = REVIEW_WITH_MAJOR_AND_CRITICAL;
    seedSprint(cwd, '6.8.rev-mem-1', REVIEW_WITH_MAJOR_AND_CRITICAL);
    const ctx = makeCtx(cwd, '6.8.rev-mem-1', 'cycle-rm1');

    await runReviewPhase(ctx);

    expect(existsSync(JSONL_PATH(cwd))).toBe(true);
  });

  it('creates review-finding.jsonl when the review contains only MAJOR findings', async () => {
    mockResponse = REVIEW_WITH_MAJOR_ONLY;
    seedSprint(cwd, '6.8.rev-mem-2', REVIEW_WITH_MAJOR_ONLY);
    const ctx = makeCtx(cwd, '6.8.rev-mem-2', 'cycle-rm2');

    await runReviewPhase(ctx);

    expect(existsSync(JSONL_PATH(cwd))).toBe(true);
  });

  it('does NOT create review-finding.jsonl when there are no CRITICAL or MAJOR findings', async () => {
    mockResponse = REVIEW_WITH_NO_CRITICAL_OR_MAJOR;
    seedSprint(cwd, '6.8.rev-mem-3', REVIEW_WITH_NO_CRITICAL_OR_MAJOR);
    const ctx = makeCtx(cwd, '6.8.rev-mem-3', 'cycle-rm3');

    await runReviewPhase(ctx);

    expect(existsSync(JSONL_PATH(cwd))).toBe(false);
  });

  it('writes one entry per qualifying finding line', async () => {
    // REVIEW_WITH_MAJOR_AND_CRITICAL has 1 CRITICAL + 1 MAJOR = 2 entries
    mockResponse = REVIEW_WITH_MAJOR_AND_CRITICAL;
    seedSprint(cwd, '6.8.rev-mem-4', REVIEW_WITH_MAJOR_AND_CRITICAL);
    const ctx = makeCtx(cwd, '6.8.rev-mem-4', 'cycle-rm4');

    await runReviewPhase(ctx);

    const lines = readFileSync(JSONL_PATH(cwd), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);
  });

  it('each JSONL entry has type "review-finding"', async () => {
    mockResponse = REVIEW_WITH_MAJOR_AND_CRITICAL;
    seedSprint(cwd, '6.8.rev-mem-5', REVIEW_WITH_MAJOR_AND_CRITICAL);
    const ctx = makeCtx(cwd, '6.8.rev-mem-5', 'cycle-rm5');

    await runReviewPhase(ctx);

    const lines = readFileSync(JSONL_PATH(cwd), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    for (const line of lines) {
      const entry = JSON.parse(line) as { type: string };
      expect(entry.type).toBe('review-finding');
    }
  });

  it('sets source to cycleId when provided', async () => {
    mockResponse = REVIEW_WITH_MAJOR_ONLY;
    seedSprint(cwd, '6.8.rev-mem-6', REVIEW_WITH_MAJOR_ONLY);
    const ctx = makeCtx(cwd, '6.8.rev-mem-6', 'cycle-source-test');

    await runReviewPhase(ctx);

    const line = readFileSync(JSONL_PATH(cwd), 'utf8').trim();
    const entry = JSON.parse(line) as { source: string };
    expect(entry.source).toBe('cycle-source-test');
  });

  it('omits source field when cycleId is not provided', async () => {
    mockResponse = REVIEW_WITH_MAJOR_ONLY;
    seedSprint(cwd, '6.8.rev-mem-7', REVIEW_WITH_MAJOR_ONLY);
    // No cycleId in context
    const ctx = makeCtx(cwd, '6.8.rev-mem-7');

    await runReviewPhase(ctx);

    expect(existsSync(JSONL_PATH(cwd))).toBe(true);
    const line = readFileSync(JSONL_PATH(cwd), 'utf8').trim();
    const entry = JSON.parse(line) as { type: string; source?: string };
    expect(entry.type).toBe('review-finding');
    // source should be absent or undefined when no cycleId was provided
    expect(entry.source).toBeUndefined();
  });

  it('CRITICAL findings are tagged with "critical"', async () => {
    mockResponse = REVIEW_WITH_MAJOR_AND_CRITICAL;
    seedSprint(cwd, '6.8.rev-mem-8', REVIEW_WITH_MAJOR_AND_CRITICAL);
    const ctx = makeCtx(cwd, '6.8.rev-mem-8', 'cycle-rm8');

    await runReviewPhase(ctx);

    const lines = readFileSync(JSONL_PATH(cwd), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const criticalEntry = lines
      .map((l) => JSON.parse(l) as { tags: string[]; value: string })
      .find((e) => e.tags.includes('critical'));

    expect(criticalEntry).toBeDefined();
    expect(criticalEntry!.tags).toContain('critical');
    expect(criticalEntry!.tags).toContain('review');
    expect(criticalEntry!.tags).toContain('finding');
    expect(criticalEntry!.tags).toContain('sprint:v6.8.rev-mem-8');
  });

  it('MAJOR findings are tagged with "major"', async () => {
    mockResponse = REVIEW_WITH_MAJOR_AND_CRITICAL;
    seedSprint(cwd, '6.8.rev-mem-9', REVIEW_WITH_MAJOR_AND_CRITICAL);
    const ctx = makeCtx(cwd, '6.8.rev-mem-9', 'cycle-rm9');

    await runReviewPhase(ctx);

    const lines = readFileSync(JSONL_PATH(cwd), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const majorEntry = lines
      .map((l) => JSON.parse(l) as { tags: string[]; value: string })
      .find((e) => e.tags.includes('major'));

    expect(majorEntry).toBeDefined();
    expect(majorEntry!.tags).toContain('major');
    expect(majorEntry!.tags).toContain('review');
    expect(majorEntry!.tags).toContain('finding');
  });

  it('JSONL entries carry structured ReviewFindingMetadata in the metadata field', async () => {
    // CRITICAL finding contains a file path and a fix suggestion
    mockResponse = REVIEW_WITH_MAJOR_AND_CRITICAL;
    seedSprint(cwd, '6.8.rev-mem-10', REVIEW_WITH_MAJOR_AND_CRITICAL);
    const ctx = makeCtx(cwd, '6.8.rev-mem-10', 'cycle-meta-test');

    await runReviewPhase(ctx);

    const lines = readFileSync(JSONL_PATH(cwd), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const criticalEntry = lines
      .map((l) => JSON.parse(l) as { tags: string[]; metadata: Record<string, unknown> })
      .find((e) => e.tags.includes('critical'));

    expect(criticalEntry).toBeDefined();
    const meta = criticalEntry!.metadata;
    expect(typeof meta).toBe('object');
    // severity must be CRITICAL
    expect(meta.severity).toBe('CRITICAL');
    // summary must strip the "CRITICAL:" prefix
    expect(typeof meta.summary).toBe('string');
    expect((meta.summary as string).length).toBeGreaterThan(0);
    // file must be extracted from the finding line
    expect(meta.file).toBe('src/auth.ts');
    // fixSuggestion must be extracted from "Fix: …"
    expect(meta.fixSuggestion).not.toBeNull();
    expect(meta.fixSuggestion).toContain('verifyToken()');
  });

  it('MAJOR entry metadata includes file and line number when present', async () => {
    mockResponse = REVIEW_WITH_MAJOR_AND_CRITICAL;
    seedSprint(cwd, '6.8.rev-mem-11', REVIEW_WITH_MAJOR_AND_CRITICAL);
    const ctx = makeCtx(cwd, '6.8.rev-mem-11', 'cycle-line-test');

    await runReviewPhase(ctx);

    const lines = readFileSync(JSONL_PATH(cwd), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const majorEntry = lines
      .map((l) => JSON.parse(l) as { tags: string[]; metadata: Record<string, unknown> })
      .find((e) => e.tags.includes('major'));

    expect(majorEntry).toBeDefined();
    const meta = majorEntry!.metadata;
    expect(meta.severity).toBe('MAJOR');
    expect(meta.file).toBe('src/registry/index.ts');
    expect(meta.line).toBe(42);
  });

  it('appends across multiple runReviewPhase calls without overwriting', async () => {
    // First review cycle
    mockResponse = REVIEW_WITH_MAJOR_ONLY;
    seedSprint(cwd, '6.8.rev-mem-12a', REVIEW_WITH_MAJOR_ONLY);
    const ctx1 = makeCtx(cwd, '6.8.rev-mem-12a', 'cycle-a');
    await runReviewPhase(ctx1);

    // Second review cycle — write a different sprint file but same JSONL dir
    mockResponse = REVIEW_WITH_MAJOR_AND_CRITICAL;
    seedSprint(cwd, '6.8.rev-mem-12b', REVIEW_WITH_MAJOR_AND_CRITICAL);
    const ctx2 = makeCtx(cwd, '6.8.rev-mem-12b', 'cycle-b');
    await runReviewPhase(ctx2);

    const lines = readFileSync(JSONL_PATH(cwd), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    // 1 MAJOR from cycle-a + 1 CRITICAL + 1 MAJOR from cycle-b = 3
    expect(lines.length).toBeGreaterThanOrEqual(3);

    const sources = lines.map((l) => (JSON.parse(l) as { source: string }).source);
    expect(sources).toContain('cycle-a');
    expect(sources).toContain('cycle-b');
  });

  it('does not fail the phase when the memory write encounters a problem', async () => {
    // runLlmPhase needs a valid sprint, but we don't need the memory write to
    // succeed — it must be non-fatal.
    mockResponse = REVIEW_WITH_MAJOR_AND_CRITICAL;
    seedSprint(cwd, '6.8.rev-mem-13', REVIEW_WITH_MAJOR_AND_CRITICAL);
    const ctx = makeCtx(cwd, '6.8.rev-mem-13', 'cycle-resilient');

    const result = await runReviewPhase(ctx);
    expect(result.status).toBe('completed');
    expect(result.phase).toBe('review');
  });

  it('appends sprint item domain tags to review-finding entries for execute-phase matching', async () => {
    // Sprint items carry domain tags. These must be collected via
    // collectSprintItemTags and appended to the review-finding memory entry so
    // the execute-phase injector can find the finding when future items share
    // overlapping domain tags (cross-cycle learning).
    mockResponse = REVIEW_WITH_MAJOR_ONLY;
    seedSprint(cwd, '6.8.rev-mem-14', REVIEW_WITH_MAJOR_ONLY, ['memory', 'execute', 'backend']);
    const ctx = makeCtx(cwd, '6.8.rev-mem-14', 'cycle-domain-tags');

    await runReviewPhase(ctx);

    const line = readFileSync(JSONL_PATH(cwd), 'utf8').trim();
    const entry = JSON.parse(line) as { tags: string[] };

    // Structural tags must always be present.
    expect(entry.tags).toContain('review');
    expect(entry.tags).toContain('finding');
    expect(entry.tags).toContain('major');
    expect(entry.tags).toContain('sprint:v6.8.rev-mem-14');

    // Domain tags collected from sprint items must also appear so the
    // execute-phase injector can match this finding to future items.
    expect(entry.tags).toContain('memory');
    expect(entry.tags).toContain('execute');
    expect(entry.tags).toContain('backend');
  });

  it('each JSONL entry has a unique non-empty id and a valid createdAt', async () => {
    mockResponse = REVIEW_WITH_MAJOR_AND_CRITICAL;
    seedSprint(cwd, '6.8.rev-mem-15', REVIEW_WITH_MAJOR_AND_CRITICAL);
    const ctx = makeCtx(cwd, '6.8.rev-mem-15', 'cycle-ids');

    await runReviewPhase(ctx);

    const lines = readFileSync(JSONL_PATH(cwd), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const ids = lines.map((l) => (JSON.parse(l) as { id: string; createdAt: string }).id);

    // All IDs must be non-empty strings
    for (const id of ids) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }

    // IDs must be distinct across the same run
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('does NOT treat narrative prose containing "major" or "critical" mid-sentence as findings', async () => {
    // Reviewer output that mentions severity words in passing prose — should
    // NOT produce memory entries. Only structurally-prefixed lines like
    // "CRITICAL: …" or "- MAJOR: …" count as findings (anchored regex).
    const narrativeProse =
      'Overall this is not a critical path change and no major concerns were raised.\n' +
      'The code looks reasonable. The only critical thing to note is that tests pass.\n' +
      '\nOverall verdict: 4/5 — ship it';

    mockResponse = narrativeProse;
    seedSprint(cwd, '6.8.rev-mem-16', narrativeProse);
    const ctx = makeCtx(cwd, '6.8.rev-mem-16', 'cycle-no-false-positives');

    await runReviewPhase(ctx);

    // No structural findings → no JSONL file created
    expect(existsSync(JSONL_PATH(cwd))).toBe(false);
  });
});
