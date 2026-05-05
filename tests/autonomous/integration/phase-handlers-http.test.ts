/**
 * phase-handlers-http.test.ts — Task 14 regression baseline
 *
 * Captures the current v6.3 HTTP behavior of
 * `packages/server/src/routes/v5/sprint-orchestration.ts` (1055 lines)
 * BEFORE Task 15 extracts phase handlers into pure functions.
 *
 * Goal: lock in the behavior so Task 15's refactor cannot silently break
 * the HTTP surface. If a test in this file goes red after Task 15, the
 * refactor must be fixed (or the change must be intentional and documented).
 *
 * Coverage strategy:
 * - Real Fastify instance via `app.inject()` (no network)
 * - Tmp dir as project root with seeded sprint JSON files
 * - `@agentforge/core` is mocked so AgentRuntime / loadAgentConfig never
 *   make Anthropic API calls (mirrors the pattern in
 *   packages/server/src/routes/v5/__tests__/run.test.ts).
 * - `globalStream` is mocked so SSE emit calls don't throw or write.
 *
 * What this file does NOT cover (intentional):
 * - The full background-task agent execution path inside `run-phase` for
 *   audit/plan/test/review/gate phases. Those routes reply 202 immediately
 *   and run agents in `void (async () => { ... })()` blocks. We capture
 *   the synchronous reply only — the background work is fire-and-forget
 *   and not observable from `app.inject()`. The mocked AgentRuntime makes
 *   the background path safe even if it does run before the test ends.
 *
 * Routes covered (6 registered by `sprintOrchestrationRoutes`):
 *   1. POST   /api/v5/sprints                              (create)
 *   2. PATCH  /api/v5/sprints/:version/advance             (next phase)
 *   3. PATCH  /api/v5/sprints/:version/items/:itemId       (update item)
 *   4. GET    /api/v5/sprints/:version/status              (read snapshot)
 *   5. POST   /api/v5/sprints/:version/execute             (kick off items)
 *   6. POST   /api/v5/sprints/:version/run-phase           (phase dispatch)
 *
 * Note: there is NO `GET /api/v5/sprints/:version` registered in
 * sprint-orchestration.ts (that route lives in sprints.ts). We assert
 * this absence so Task 15's refactor doesn't accidentally add it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Mocks — applied before importing the route module so the route module
// picks up the mocked versions of @agentforge/core and ../stream.js.
// ---------------------------------------------------------------------------

vi.mock('@agentforge/core', () => {
  const mockRunResult = {
    sessionId: 'mock-phase-session',
    response: 'Mock phase agent response',
    model: 'claude-sonnet-4-6',
    inputTokens: 10,
    outputTokens: 20,
    costUsd: 0.0001,
    startedAt: '2026-04-06T00:00:00.000Z',
    completedAt: '2026-04-06T00:00:01.000Z',
    status: 'completed',
  };

  return {
    AgentRuntime: vi.fn(function () {
      return {
        runStreaming: vi.fn().mockResolvedValue(mockRunResult),
      };
    }),
    loadAgentConfig: vi.fn().mockImplementation(async (agentId: string) => {
      // Return a minimal valid config for any non-empty id so the
      // background phase agent path doesn't throw.
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
  globalStream: {
    emit: vi.fn(),
  },
}));

// Stable ids/timestamps so any disk writes are deterministic.
vi.mock('@agentforge/shared', () => {
  let counter = 0;
  return {
    generateId: vi.fn(() => `test-id-${++counter}`),
    nowIso: vi.fn(() => '2026-04-06T12:00:00.000Z'),
  };
});

// Now safe to import the route module.
import { sprintOrchestrationRoutes } from '../../../packages/server/src/routes/v5/sprint-orchestration.js';

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

interface SeedSprint {
  version: string;
  title?: string;
  phase?: string;
  items?: Array<{
    id: string;
    title: string;
    description?: string;
    priority?: 'P0' | 'P1' | 'P2';
    assignee?: string;
    status?: 'planned' | 'in_progress' | 'completed' | 'blocked' | 'deferred';
  }>;
  budget?: number;
  teamSize?: number;
  successCriteria?: string[];
  auditFindings?: string[];
  agentsInvolved?: string[];
  budgetUsed?: number;
  phaseResults?: unknown[];
  sprintId?: string;
  createdAt?: string;
}

function makeTmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentforge-poh-'));
  mkdirSync(join(dir, '.agentforge/sprints'), { recursive: true });
  return dir;
}

function seedSprint(root: string, sprint: SeedSprint): void {
  const file = join(root, '.agentforge/sprints', `v${sprint.version}.json`);
  const fullSprint = {
    sprintId: sprint.sprintId ?? `seed-${sprint.version}`,
    version: sprint.version,
    title: sprint.title ?? `v${sprint.version} test`,
    createdAt: sprint.createdAt ?? '2026-04-06T00:00:00.000Z',
    phase: sprint.phase ?? 'planned',
    items: sprint.items ?? [],
    budget: sprint.budget ?? 0,
    teamSize: sprint.teamSize ?? 1,
    successCriteria: sprint.successCriteria ?? [],
    auditFindings: sprint.auditFindings ?? [],
    agentsInvolved: sprint.agentsInvolved ?? [],
    budgetUsed: sprint.budgetUsed ?? 0,
    phaseResults: sprint.phaseResults ?? [],
  };
  writeFileSync(file, JSON.stringify(fullSprint, null, 2), 'utf-8');
}

function readSprintFile(root: string, version: string): Record<string, unknown> {
  const file = join(root, '.agentforge/sprints', `v${version}.json`);
  return JSON.parse(readFileSync(file, 'utf-8'));
}

async function buildApp(projectRoot: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await sprintOrchestrationRoutes(app, { projectRoot });
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('sprint-orchestration HTTP routes (v6.3 regression baseline)', () => {
  let app: FastifyInstance;
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = makeTmpRoot();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    if (tmpRoot && existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/v5/sprints — create
  // -------------------------------------------------------------------------

  describe('POST /api/v5/sprints', () => {
    it('creates a sprint in phase "planned" with 201 and { data } envelope', async () => {
      app = await buildApp(tmpRoot);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v5/sprints',
        payload: {
          version: '6.4.test1',
          title: 'Test Sprint',
          items: [
            { title: 'Item A', description: 'desc A', priority: 'P0', assignee: 'coder' },
          ],
          budget: 50,
          teamSize: 2,
          successCriteria: ['ships'],
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toHaveProperty('data');
      expect(body.data.version).toBe('6.4.test1');
      expect(body.data.title).toBe('Test Sprint');
      expect(body.data.phase).toBe('planned');
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0].title).toBe('Item A');
      expect(body.data.items[0].status).toBe('planned');
      expect(body.data.budget).toBe(50);
      expect(body.data.teamSize).toBe(2);
      expect(body.data.successCriteria).toEqual(['ships']);
      expect(body.data.auditFindings).toEqual([]);
      expect(body.data.budgetUsed).toBe(0);
      expect(body.data.phaseResults).toEqual([]);

      // Side effect: file is on disk
      const onDisk = readSprintFile(tmpRoot, '6.4.test1');
      expect(onDisk.version).toBe('6.4.test1');
      expect(onDisk.phase).toBe('planned');
    });

    it('returns 400 when version is missing', async () => {
      app = await buildApp(tmpRoot);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v5/sprints',
        payload: { title: 't', items: [] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/version is required/);
    });

    it('returns 400 when title is missing', async () => {
      app = await buildApp(tmpRoot);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v5/sprints',
        payload: { version: '1.0', items: [] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/title is required/);
    });

    it('returns 400 when items is not an array', async () => {
      app = await buildApp(tmpRoot);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v5/sprints',
        payload: { version: '1.0', title: 't', items: 'nope' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/items must be an array/);
    });

    it('returns 409 SPRINT_EXISTS when sprint file already exists', async () => {
      seedSprint(tmpRoot, { version: '6.4.dup' });
      app = await buildApp(tmpRoot);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v5/sprints',
        payload: { version: '6.4.dup', title: 't', items: [] },
      });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.code).toBe('SPRINT_EXISTS');
      expect(body.error).toMatch(/already exists/);
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /api/v5/sprints/:version/advance
  // -------------------------------------------------------------------------

  describe('PATCH /api/v5/sprints/:version/advance', () => {
    it('returns 404 SPRINT_NOT_FOUND for unknown version', async () => {
      app = await buildApp(tmpRoot);
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v5/sprints/9.9.9/advance',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SPRINT_NOT_FOUND');
    });

    it('transitions phase from planned -> audit', async () => {
      seedSprint(tmpRoot, { version: '6.4.adv1', phase: 'planned' });
      app = await buildApp(tmpRoot);

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v5/sprints/6.4.adv1/advance',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('data');
      expect(body.data.phase).toBe('audit');

      // Side effect: phase persisted to disk
      const onDisk = readSprintFile(tmpRoot, '6.4.adv1');
      expect(onDisk.phase).toBe('audit');
    });

    it('repeated advances walk audit -> plan -> assign', async () => {
      seedSprint(tmpRoot, { version: '6.4.adv2', phase: 'audit' });
      app = await buildApp(tmpRoot);

      const r1 = await app.inject({ method: 'PATCH', url: '/api/v5/sprints/6.4.adv2/advance' });
      expect(r1.statusCode).toBe(200);
      expect(r1.json().data.phase).toBe('plan');

      const r2 = await app.inject({ method: 'PATCH', url: '/api/v5/sprints/6.4.adv2/advance' });
      expect(r2.statusCode).toBe(200);
      expect(r2.json().data.phase).toBe('assign');
    });

    it('returns 422 UNKNOWN_PHASE when current phase is not in the order list', async () => {
      seedSprint(tmpRoot, { version: '6.4.bad', phase: 'wat' });
      app = await buildApp(tmpRoot);

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v5/sprints/6.4.bad/advance',
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('UNKNOWN_PHASE');
    });

    it('returns 409 ALREADY_FINAL_PHASE when sprint is already completed', async () => {
      seedSprint(tmpRoot, { version: '6.4.done', phase: 'completed' });
      app = await buildApp(tmpRoot);

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v5/sprints/6.4.done/advance',
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('ALREADY_FINAL_PHASE');
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /api/v5/sprints/:version/items/:itemId
  // -------------------------------------------------------------------------

  describe('PATCH /api/v5/sprints/:version/items/:itemId', () => {
    it('returns 404 SPRINT_NOT_FOUND when sprint missing', async () => {
      app = await buildApp(tmpRoot);
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v5/sprints/9.9.9/items/x',
        payload: { status: 'completed' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SPRINT_NOT_FOUND');
    });

    it('returns 404 ITEM_NOT_FOUND when item missing', async () => {
      seedSprint(tmpRoot, {
        version: '6.4.itm1',
        items: [{ id: 'a', title: 'A', status: 'planned' }],
      });
      app = await buildApp(tmpRoot);

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v5/sprints/6.4.itm1/items/missing',
        payload: { status: 'completed' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('ITEM_NOT_FOUND');
    });

    it('updates item status, persists to disk, sets completedAt on completion', async () => {
      seedSprint(tmpRoot, {
        version: '6.4.itm2',
        items: [
          { id: 'a', title: 'A', description: 'd', priority: 'P0', assignee: 'coder', status: 'planned' },
        ],
      });
      app = await buildApp(tmpRoot);

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v5/sprints/6.4.itm2/items/a',
        payload: { status: 'completed' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('data');
      expect(body.data.id).toBe('a');
      expect(body.data.status).toBe('completed');
      expect(body.data.completedAt).toBeDefined();

      const onDisk = readSprintFile(tmpRoot, '6.4.itm2') as { items: Array<Record<string, unknown>> };
      expect(onDisk.items[0].status).toBe('completed');
      expect(onDisk.items[0].completedAt).toBeDefined();
    });

    it('updates assignee without changing status when only assignee provided', async () => {
      seedSprint(tmpRoot, {
        version: '6.4.itm3',
        items: [
          { id: 'a', title: 'A', priority: 'P1', assignee: 'old', status: 'in_progress' },
        ],
      });
      app = await buildApp(tmpRoot);

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v5/sprints/6.4.itm3/items/a',
        payload: { assignee: 'new' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.assignee).toBe('new');
      expect(body.data.status).toBe('in_progress');
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v5/sprints/:version/status
  // -------------------------------------------------------------------------

  describe('GET /api/v5/sprints/:version/status', () => {
    it('returns 404 SPRINT_NOT_FOUND for unknown sprint', async () => {
      app = await buildApp(tmpRoot);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v5/sprints/9.9.9/status',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SPRINT_NOT_FOUND');
    });

    it('returns sprint status snapshot with item byStatus tally and agentsInvolved', async () => {
      seedSprint(tmpRoot, {
        version: '6.4.stat',
        title: 'Status Test',
        phase: 'execute',
        items: [
          { id: 'a', title: 'A', priority: 'P0', assignee: 'coder', status: 'completed' },
          { id: 'b', title: 'B', priority: 'P1', assignee: 'researcher', status: 'in_progress' },
          { id: 'c', title: 'C', priority: 'P2', assignee: 'coder', status: 'planned' },
        ],
        budget: 100,
        budgetUsed: 12.34,
        agentsInvolved: ['cto'],
      });
      app = await buildApp(tmpRoot);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v5/sprints/6.4.stat/status',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('data');
      const data = body.data;
      expect(data.version).toBe('6.4.stat');
      expect(data.title).toBe('Status Test');
      expect(data.currentPhase).toBe('execute');
      expect(data.items.total).toBe(3);
      expect(data.items.byStatus).toEqual({
        planned: 1,
        in_progress: 1,
        completed: 1,
        blocked: 0,
        deferred: 0,
      });
      expect(data.budgetTotal).toBe(100);
      expect(data.budgetUsed).toBe(12.34);
      // agentsInvolved is the union of stored list + assignees, deduped
      expect(new Set(data.agentsInvolved)).toEqual(new Set(['cto', 'coder', 'researcher']));
      expect(Array.isArray(data.phaseResults)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v5/sprints/:version/execute
  // -------------------------------------------------------------------------

  describe('POST /api/v5/sprints/:version/execute', () => {
    it('returns 404 SPRINT_NOT_FOUND when sprint missing', async () => {
      app = await buildApp(tmpRoot);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v5/sprints/9.9.9/execute',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SPRINT_NOT_FOUND');
    });

    it('returns 202 with started/skipped/totalInProgress counts and advances phase to execute', async () => {
      seedSprint(tmpRoot, {
        version: '6.4.exec',
        phase: 'plan',
        items: [
          { id: 'a', title: 'A', priority: 'P0', assignee: 'coder', status: 'planned' },
          { id: 'b', title: 'B', priority: 'P1', assignee: 'researcher', status: 'planned' },
          { id: 'c', title: 'C', priority: 'P2', assignee: 'coder', status: 'completed' },
        ],
      });
      app = await buildApp(tmpRoot);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v5/sprints/6.4.exec/execute',
      });

      // Synchronous response shape — this is the observable contract.
      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body).toHaveProperty('data');
      expect(body.data.started).toBe(2);   // 2 planned items moved to in_progress
      expect(body.data.skipped).toBe(1);   // 1 already completed
      expect(body.data.totalInProgress).toBe(2);

      // Phase is advanced to execute synchronously before reply is sent.
      // Item statuses are not asserted against disk here: the route fires
      // background `void (async () => {})()` blocks per item that race
      // with this read. The mocked AgentRuntime resolves instantly so the
      // background block has likely already overwritten items by the time
      // we get here. The synchronous body counts above are the contract.
      const onDisk = readSprintFile(tmpRoot, '6.4.exec') as { phase: string };
      expect(onDisk.phase).toBe('execute');
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v5/sprints/:version/run-phase
  //
  // The route returns 202 immediately for nearly every phase and runs the
  // real work in a background `void (async () => {})()` block. We test the
  // synchronous reply for each phase variant — the background work is
  // tested via the mocked AgentRuntime / AutoDelegationPipeline producing
  // no observable side effect from app.inject() (it may run after the test
  // ends, which is OK because all dependencies are mocked).
  // -------------------------------------------------------------------------

  describe('POST /api/v5/sprints/:version/run-phase', () => {
    it('returns 404 SPRINT_NOT_FOUND when sprint missing', async () => {
      app = await buildApp(tmpRoot);
      const res = await app.inject({
        method: 'POST',
        url: '/api/v5/sprints/9.9.9/run-phase',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SPRINT_NOT_FOUND');
    });

    it('returns 422 UNKNOWN_PHASE when sprint phase is unknown', async () => {
      seedSprint(tmpRoot, { version: '6.4.rpbad', phase: 'wat' });
      app = await buildApp(tmpRoot);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v5/sprints/6.4.rpbad/run-phase',
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('UNKNOWN_PHASE');
    });

    it('returns 409 SPRINT_COMPLETED when phase is already completed', async () => {
      seedSprint(tmpRoot, { version: '6.4.rpdone', phase: 'completed' });
      app = await buildApp(tmpRoot);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v5/sprints/6.4.rpdone/run-phase',
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('SPRINT_COMPLETED');
    });

    it('returns 422 NO_PHASE_AGENT for "planned" phase (no agent mapped)', async () => {
      // The "planned" phase has no agent in PHASE_AGENT_MAP and is not in
      // the inline-handled set (assign/execute/release/learn), so the
      // route falls through to the NO_PHASE_AGENT branch.
      seedSprint(tmpRoot, { version: '6.4.rpplan', phase: 'planned' });
      app = await buildApp(tmpRoot);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v5/sprints/6.4.rpplan/run-phase',
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('NO_PHASE_AGENT');
    });

    it('returns 202 with phase + agentId for "audit" phase (agent: researcher)', async () => {
      seedSprint(tmpRoot, {
        version: '6.4.rpaudit',
        phase: 'audit',
        items: [{ id: 'a', title: 'A', priority: 'P0', assignee: 'coder', status: 'planned' }],
      });
      app = await buildApp(tmpRoot);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v5/sprints/6.4.rpaudit/run-phase',
      });

      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body).toHaveProperty('data');
      expect(body.data.phase).toBe('audit');
      expect(body.data.agentId).toBe('researcher');
      expect(body.data.message).toMatch(/running in background/);
    });

    it('returns 202 with phase + agentId for "plan" phase (agent: cto)', async () => {
      seedSprint(tmpRoot, {
        version: '6.4.rpplan2',
        phase: 'plan',
        items: [{ id: 'a', title: 'A', priority: 'P0', assignee: 'coder', status: 'planned' }],
      });
      app = await buildApp(tmpRoot);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v5/sprints/6.4.rpplan2/run-phase',
      });

      expect(res.statusCode).toBe(202);
      expect(res.json().data.agentId).toBe('cto');
    });

    it('returns 202 with phase + agentId for "test" phase (agent: backend-qa)', async () => {
      seedSprint(tmpRoot, { version: '6.4.rptest', phase: 'test' });
      app = await buildApp(tmpRoot);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v5/sprints/6.4.rptest/run-phase',
      });
      expect(res.statusCode).toBe(202);
      expect(res.json().data.agentId).toBe('backend-qa');
    });

    it('returns 202 with phase + agentId for "review" phase (agent: code-reviewer)', async () => {
      seedSprint(tmpRoot, { version: '6.4.rprev', phase: 'review' });
      app = await buildApp(tmpRoot);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v5/sprints/6.4.rprev/run-phase',
      });
      expect(res.statusCode).toBe(202);
      expect(res.json().data.agentId).toBe('code-reviewer');
    });

    it('returns 202 with phase + agentId for "gate" phase (agent: ceo)', async () => {
      seedSprint(tmpRoot, { version: '6.4.rpgate', phase: 'gate' });
      app = await buildApp(tmpRoot);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v5/sprints/6.4.rpgate/run-phase',
      });
      expect(res.statusCode).toBe(202);
      expect(res.json().data.agentId).toBe('ceo');
    });

    it('returns 202 with auto-delegation message for "assign" phase', async () => {
      seedSprint(tmpRoot, {
        version: '6.4.rpassign',
        phase: 'assign',
        items: [
          { id: 'a', title: 'Add a test', description: 'unit test', priority: 'P0', assignee: '', status: 'planned' },
        ],
      });
      app = await buildApp(tmpRoot);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v5/sprints/6.4.rpassign/run-phase',
      });

      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.data.phase).toBe('assign');
      expect(body.data.message).toMatch(/Auto-delegation running in background/);
    });

    it('returns 202 with execute-delegation message for "execute" phase', async () => {
      seedSprint(tmpRoot, {
        version: '6.4.rpexec',
        phase: 'execute',
        items: [{ id: 'a', title: 'A', priority: 'P0', assignee: 'coder', status: 'planned' }],
      });
      app = await buildApp(tmpRoot);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v5/sprints/6.4.rpexec/run-phase',
      });

      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.data.phase).toBe('execute');
      expect(body.data.message).toMatch(/Execute phase delegated/);
    });

    it('returns 202 and advances phase to "learn" for "release" phase (synchronous)', async () => {
      seedSprint(tmpRoot, {
        version: '6.4.rprel',
        phase: 'release',
      });
      app = await buildApp(tmpRoot);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v5/sprints/6.4.rprel/run-phase',
      });

      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.data.phase).toBe('release');
      expect(body.data.nextPhase).toBe('learn');

      // The release branch synchronously writes to disk before replying.
      const onDisk = readSprintFile(tmpRoot, '6.4.rprel') as {
        phase: string;
        phaseResults: Array<Record<string, unknown>>;
      };
      expect(onDisk.phase).toBe('learn');
      expect(onDisk.phaseResults.length).toBeGreaterThan(0);
      expect(onDisk.phaseResults[0].phase).toBe('release');
    });

    it('returns 202 and marks sprint completed for "learn" phase (synchronous)', async () => {
      seedSprint(tmpRoot, {
        version: '6.4.rplrn',
        phase: 'learn',
        items: [
          { id: 'a', title: 'A', priority: 'P0', assignee: 'coder', status: 'completed' },
        ],
      });
      app = await buildApp(tmpRoot);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v5/sprints/6.4.rplrn/run-phase',
      });

      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.data.phase).toBe('learn');
      expect(body.data.message).toMatch(/marked completed/);

      // The learn branch synchronously writes to disk before replying.
      const onDisk = readSprintFile(tmpRoot, '6.4.rplrn') as {
        phase: string;
        phaseResults: Array<Record<string, unknown>>;
      };
      expect(onDisk.phase).toBe('completed');
      expect(onDisk.phaseResults.length).toBeGreaterThan(0);
      expect(onDisk.phaseResults[0].phase).toBe('learn');
    });
  });

  // -------------------------------------------------------------------------
  // Negative coverage: routes that this module does NOT register.
  //
  // sprint-orchestration.ts only registers the 6 routes above. In particular
  // it does NOT register `GET /api/v5/sprints/:version` (that lives in
  // packages/server/src/routes/v5/sprints.ts). We assert this so Task 15's
  // refactor doesn't accidentally introduce or remove a route.
  // -------------------------------------------------------------------------

  describe('routes NOT registered by sprintOrchestrationRoutes', () => {
    it('does not register GET /api/v5/sprints/:version (lives in sprints.ts)', async () => {
      seedSprint(tmpRoot, { version: '6.4.neg' });
      app = await buildApp(tmpRoot);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v5/sprints/6.4.neg',
      });

      // Fastify replies 404 with no matching route. This locks the
      // boundary between sprint-orchestration.ts and sprints.ts.
      expect(res.statusCode).toBe(404);
    });

    it('does not register GET /api/v5/sprints (list lives in sprints.ts)', async () => {
      app = await buildApp(tmpRoot);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v5/sprints',
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
