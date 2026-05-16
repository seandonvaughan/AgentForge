// tests/autonomous/integration/knowledge-entry-injection.test.ts
//
// Regression guard for the sprint item:
//   "Inject writeKnowledgeEntry() calls in audit-phase.ts and review-phase.ts
//    after findings produced" — root cause of always-empty /knowledge page.
//
// The server-side phase handlers (packages/server/src/lib/phase-handlers.ts) are
// the production execution path. These tests verify that both runAuditPhase and
// runReviewPhase write entity entries to .agentforge/knowledge/entities.jsonl
// after each cycle so the /knowledge page is populated.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Module mocks — established before any imports of the tested modules.
// We mock AgentRuntime and loadAgentConfig so no real subprocess is spawned;
// writeKnowledgeEntry uses the REAL implementation so the actual file write
// happens (the ...real spread preserves it unchanged).
// ---------------------------------------------------------------------------

const AUDIT_RESPONSE =
  '## Audit Summary\n\n' +
  'The SprintRunner is functioning correctly.\n\n' +
  'Findings:\n' +
  '- KnowledgeGraph entities are never written to disk\n' +
  '- ReviewPhase is missing writeKnowledgeEntry call\n' +
  '- AuditPhase also needs the injection\n' +
  '- EntityExtractor should find CamelCase words like SprintPlanner';

const REVIEW_RESPONSE =
  'Overall the sprint is solid.\n\n' +
  'CRITICAL: src/auth.ts — TokenValidator is completely absent. Fix: call verifyToken() before use\n' +
  'MAJOR: src/registry/index.ts:42 — duplicate RouteRegistration on restart\n' +
  '\nOverall verdict: 3/5 — needs work before merge';

let mockAuditResponse = AUDIT_RESPONSE;
let mockReviewResponse = REVIEW_RESPONSE;

// We need separate response vars since both phases can be tested in the same
// file and mockResponse would be ambiguous. The vi.fn implementation closes
// over the phase to pick the right var.
let currentPhase = 'audit';

vi.mock('@agentforge/core', async () => {
  const real = await vi.importActual<typeof import('@agentforge/core')>('@agentforge/core');

  return {
    ...real,
    AgentRuntime: vi.fn(function () {
      return {
        runStreaming: vi.fn().mockImplementation(() => {
          const response =
            currentPhase === 'audit' ? mockAuditResponse : mockReviewResponse;
          return Promise.resolve({
            sessionId: `mock-${currentPhase}-session`,
            response,
            model: 'claude-sonnet-4-6',
            inputTokens: 80,
            outputTokens: 200,
            costUsd: 0.004,
            startedAt: '2026-04-09T00:00:00.000Z',
            completedAt: '2026-04-09T00:00:01.000Z',
            status: 'completed' as const,
          });
        }),
        run: vi.fn().mockImplementation(() => {
          const response =
            currentPhase === 'audit' ? mockAuditResponse : mockReviewResponse;
          return Promise.resolve({
            sessionId: `mock-${currentPhase}-session`,
            response,
            model: 'claude-sonnet-4-6',
            inputTokens: 80,
            outputTokens: 200,
            costUsd: 0.004,
            startedAt: '2026-04-09T00:00:00.000Z',
            completedAt: '2026-04-09T00:00:01.000Z',
            status: 'completed' as const,
          });
        }),
      };
    }),
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
    generateId: vi.fn(() => `kg-test-id-${++counter}`),
    nowIso: vi.fn(() => '2026-04-09T00:00:00.000Z'),
  };
});

// Import after mocks.
import {
  runAuditPhase,
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
  const cwd = mkdtempSync(join(tmpdir(), 'agentforge-kg-inject-'));
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

/** Seed a minimal sprint JSON for the given phase. */
function seedSprint(
  cwd: string,
  version: string,
  phase: 'audit' | 'review',
  priorResponse?: string,
): void {
  const phaseResults = priorResponse
    ? [
        {
          phase,
          agentId: phase === 'audit' ? 'researcher' : 'code-reviewer',
          sessionId: `pre-seeded-${phase}`,
          response: priorResponse,
          costUsd: 0.002,
          inputTokens: 40,
          outputTokens: 150,
          status: 'completed',
          ranAt: '2026-04-09T00:00:00.000Z',
        },
      ]
    : [];

  const sprint: SprintFile = {
    sprintId: `sprint-${version}`,
    version,
    title: `v${version} sprint`,
    createdAt: '2026-04-09T00:00:00.000Z',
    phase,
    items: [
      {
        id: 'i1',
        title: 'Item 1',
        description: '',
        priority: 'P1',
        assignee: 'coder',
        status: 'completed',
        tags: ['knowledge', 'feature'],
      },
    ],
    budget: 50,
    teamSize: 1,
    successCriteria: [],
    auditFindings: [],
    agentsInvolved: [],
    budgetUsed: 5,
    phaseResults,
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

const ENTITIES_PATH = (cwd: string) =>
  join(cwd, '.agentforge', 'knowledge', 'entities.jsonl');

// ---------------------------------------------------------------------------
// runAuditPhase — knowledge entry injection
// ---------------------------------------------------------------------------

describe('server runAuditPhase — knowledge entry injection', () => {
  let cwd: string;
  let cleanup: () => void;

  beforeEach(() => {
    currentPhase = 'audit';
    mockAuditResponse = AUDIT_RESPONSE;
    const tmp = makeTmp();
    cwd = tmp.cwd;
    cleanup = tmp.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it('creates entities.jsonl after a successful audit phase', async () => {
    seedSprint(cwd, '16.kg-audit-1', 'audit');
    const ctx = makeCtx(cwd, '16.kg-audit-1', 'cycle-kg-a1');

    await runAuditPhase(ctx);

    expect(existsSync(ENTITIES_PATH(cwd))).toBe(true);
  });

  it('entities written by audit phase have source="audit"', async () => {
    seedSprint(cwd, '16.kg-audit-2', 'audit');
    const ctx = makeCtx(cwd, '16.kg-audit-2', 'cycle-kg-a2');

    await runAuditPhase(ctx);

    const lines = readFileSync(ENTITIES_PATH(cwd), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      const entity = JSON.parse(line) as { properties: { source: string } };
      expect(entity.properties.source).toBe('audit');
    }
  });

  it('entity properties carry the sprint tag and cycleId', async () => {
    seedSprint(cwd, '16.kg-audit-3', 'audit');
    const ctx = makeCtx(cwd, '16.kg-audit-3', 'cycle-kg-a3');

    await runAuditPhase(ctx);

    const lines = readFileSync(ENTITIES_PATH(cwd), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);

    // Every entity should carry sprint tag and cycleId
    for (const line of lines) {
      const entity = JSON.parse(line) as {
        properties: { source: string; tags?: string[]; cycleId?: string };
      };
      expect(entity.properties.tags).toContain('sprint:v16.kg-audit-3');
      expect(entity.properties.tags).toContain('audit-findings');
      expect(entity.properties.cycleId).toBe('cycle-kg-a3');
    }
  });

  it('entities.jsonl has well-formed JSONL (id, name, type, createdAt)', async () => {
    seedSprint(cwd, '16.kg-audit-4', 'audit');
    const ctx = makeCtx(cwd, '16.kg-audit-4', 'cycle-kg-a4');

    await runAuditPhase(ctx);

    const lines = readFileSync(ENTITIES_PATH(cwd), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      const entity = JSON.parse(line) as {
        id: string;
        name: string;
        type: string;
        createdAt: string;
      };
      expect(typeof entity.id).toBe('string');
      expect(entity.id.length).toBeGreaterThan(0);
      expect(typeof entity.name).toBe('string');
      expect(entity.name.length).toBeGreaterThanOrEqual(3);
      expect(typeof entity.type).toBe('string');
      expect(typeof entity.createdAt).toBe('string');
    }
  });

  it('audit phase result is unaffected by knowledge write (non-fatal)', async () => {
    seedSprint(cwd, '16.kg-audit-5', 'audit');
    const ctx = makeCtx(cwd, '16.kg-audit-5', 'cycle-kg-a5');

    const result = await runAuditPhase(ctx);

    // Phase must succeed even if entities.jsonl write were to fail
    expect(result.status).toBe('completed');
    expect(result.phase).toBe('audit');
  });
});

// ---------------------------------------------------------------------------
// runReviewPhase — knowledge entry injection
// ---------------------------------------------------------------------------

describe('server runReviewPhase — knowledge entry injection', () => {
  let cwd: string;
  let cleanup: () => void;

  beforeEach(() => {
    currentPhase = 'review';
    mockReviewResponse = REVIEW_RESPONSE;
    const tmp = makeTmp();
    cwd = tmp.cwd;
    cleanup = tmp.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it('creates entities.jsonl after a successful review phase', async () => {
    seedSprint(cwd, '16.kg-review-1', 'review', REVIEW_RESPONSE);
    const ctx = makeCtx(cwd, '16.kg-review-1', 'cycle-kg-r1');

    await runReviewPhase(ctx);

    expect(existsSync(ENTITIES_PATH(cwd))).toBe(true);
  });

  it('entities written by review phase have source="review"', async () => {
    seedSprint(cwd, '16.kg-review-2', 'review', REVIEW_RESPONSE);
    const ctx = makeCtx(cwd, '16.kg-review-2', 'cycle-kg-r2');

    await runReviewPhase(ctx);

    const lines = readFileSync(ENTITIES_PATH(cwd), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      const entity = JSON.parse(line) as { properties: { source: string } };
      expect(entity.properties.source).toBe('review');
    }
  });

  it('entity properties carry sprint tag and cycleId', async () => {
    seedSprint(cwd, '16.kg-review-3', 'review', REVIEW_RESPONSE);
    const ctx = makeCtx(cwd, '16.kg-review-3', 'cycle-kg-r3');

    await runReviewPhase(ctx);

    const lines = readFileSync(ENTITIES_PATH(cwd), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      const entity = JSON.parse(line) as {
        properties: { source: string; tags?: string[]; cycleId?: string };
      };
      expect(entity.properties.tags).toContain('sprint:v16.kg-review-3');
      expect(entity.properties.tags).toContain('code-review');
      expect(entity.properties.cycleId).toBe('cycle-kg-r3');
    }
  });

  it('review knowledge injection is additive — appends to existing entities.jsonl', async () => {
    // Audit phase writes first; review phase appends.
    currentPhase = 'audit';
    seedSprint(cwd, '16.kg-review-4a', 'audit');
    await runAuditPhase(makeCtx(cwd, '16.kg-review-4a', 'cycle-kg-r4a'));

    const auditCount = readFileSync(ENTITIES_PATH(cwd), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0).length;
    expect(auditCount).toBeGreaterThan(0);

    currentPhase = 'review';
    seedSprint(cwd, '16.kg-review-4b', 'review', REVIEW_RESPONSE);
    await runReviewPhase(makeCtx(cwd, '16.kg-review-4b', 'cycle-kg-r4b'));

    const totalCount = readFileSync(ENTITIES_PATH(cwd), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0).length;
    expect(totalCount).toBeGreaterThan(auditCount);

    // Both sources must be present
    const lines = readFileSync(ENTITIES_PATH(cwd), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const sources = lines.map(
      (l) => (JSON.parse(l) as { properties: { source: string } }).properties.source,
    );
    expect(sources).toContain('audit');
    expect(sources).toContain('review');
  });

  it('review phase result is unaffected by knowledge write (non-fatal)', async () => {
    seedSprint(cwd, '16.kg-review-5', 'review', REVIEW_RESPONSE);
    const ctx = makeCtx(cwd, '16.kg-review-5', 'cycle-kg-r5');

    const result = await runReviewPhase(ctx);

    expect(result.status).toBe('completed');
    expect(result.phase).toBe('review');
  });

  it('sprint domain tags from items appear in entity properties', async () => {
    // Sprint items have tags ['knowledge', 'feature'] from seedSprint
    seedSprint(cwd, '16.kg-review-6', 'review', REVIEW_RESPONSE);
    const ctx = makeCtx(cwd, '16.kg-review-6', 'cycle-kg-r6');

    await runReviewPhase(ctx);

    const lines = readFileSync(ENTITIES_PATH(cwd), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);

    // Entity tags should include the sprint item domain tags
    for (const line of lines) {
      const entity = JSON.parse(line) as {
        properties: { tags?: string[] };
      };
      expect(entity.properties.tags).toContain('knowledge');
      expect(entity.properties.tags).toContain('feature');
    }
  });
});
