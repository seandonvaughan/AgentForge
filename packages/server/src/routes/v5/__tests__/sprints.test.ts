import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { sprintsRoutes } from '../sprints.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmpDir: string;

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-sprints-v5-'));
  mkdirSync(join(tmpDir, '.agentforge/sprints'), { recursive: true });
  return tmpDir;
}

function cleanup() {
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function buildApp(projectRoot: string) {
  const app = Fastify({ logger: false });
  await sprintsRoutes(app, { projectRoot });
  return app;
}

describe('GET /api/v5/sprints', () => {
  let app: ReturnType<typeof Fastify>;

  afterEach(async () => {
    await app.close();
    cleanup();
  });

  it('returns empty array when no sprint files exist', async () => {
    const root = setup();
    app = await buildApp(root);

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
  });

  it('parses flat sprint format (v5.9 style)', async () => {
    const root = setup();
    writeFileSync(join(root, '.agentforge/sprints/v5.9.json'), JSON.stringify({
      version: '5.9',
      name: 'v5.9 - Hardening',
      phase: 'completed',
      startedAt: '2026-03-27T19:48:00.000Z',
      completedAt: '2026-03-27T19:58:00.000Z',
      items: [
        { id: 'p0-1', title: 'Health Check', priority: 'P0', status: 'completed' },
        { id: 'p1-1', title: 'Resilience', priority: 'P1', status: 'completed' },
      ],
    }));
    app = await buildApp(root);

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.length).toBe(1);
    const sprint = body.data[0];
    expect(sprint.version).toBe('5.9');
    expect(sprint.title).toBe('v5.9 - Hardening');
    expect(sprint.status).toBe('completed');
    expect(sprint.items.length).toBe(2);
    expect(sprint.items[0].title).toBe('Health Check');
    expect(sprint.items[0].priority).toBe('P0');
    expect(sprint.items[0].status).toBe('completed');
  });

  it('parses nested sprints array format (v6.0 style)', async () => {
    const root = setup();
    writeFileSync(join(root, '.agentforge/sprints/v6.0.json'), JSON.stringify({
      sprints: [{
        sprintId: 'v60-test',
        version: '6.0',
        title: 'v6.0 - Execution API',
        createdAt: '2026-03-27T00:00:00.000Z',
        phase: 'completed',
        startedAt: '2026-03-27T00:00:00.000Z',
        completedAt: '2026-03-27T23:59:00.000Z',
        items: [
          { id: 'p0-1', title: 'Execution API', priority: 'P0', status: 'completed' },
          { id: 'p0-2', title: 'Streaming', priority: 'P0', status: 'completed' },
          { id: 'p1-1', title: 'Knowledge UI', priority: 'P1', status: 'completed' },
        ],
        budget: 400,
        teamSize: 8,
        successCriteria: ['API works', 'Dashboard loads'],
      }],
      results: [],
    }));
    app = await buildApp(root);

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.length).toBe(1);
    const sprint = body.data[0];
    expect(sprint.version).toBe('6.0');
    expect(sprint.title).toBe('v6.0 - Execution API');
    expect(sprint.status).toBe('completed');
    expect(sprint.items.length).toBe(3);
    expect(sprint.budget).toBe(400);
    expect(sprint.teamSize).toBe(8);
    expect(sprint.successCriteria).toEqual(['API works', 'Dashboard loads']);
  });

  it('returns sprints sorted newest-first', async () => {
    const root = setup();
    writeFileSync(join(root, '.agentforge/sprints/v4.3.json'), JSON.stringify({
      version: '4.3', name: 'v4.3', phase: 'completed', items: [],
    }));
    writeFileSync(join(root, '.agentforge/sprints/v5.1.json'), JSON.stringify({
      version: '5.1', name: 'v5.1', phase: 'completed', items: [],
    }));
    app = await buildApp(root);

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints' });
    const body = res.json();
    expect(body.data.length).toBe(2);
    expect(body.data[0].version).toBe('5.1');
    expect(body.data[1].version).toBe('4.3');
  });

  it('skips files starting with v${ (template artifacts)', async () => {
    const root = setup();
    writeFileSync(join(root, '.agentforge/sprints/v${VERSION}.json'), '{}');
    writeFileSync(join(root, '.agentforge/sprints/v5.0.json'), JSON.stringify({
      version: '5.0', name: 'v5.0', phase: 'completed', items: [],
    }));
    app = await buildApp(root);

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints' });
    const body = res.json();
    expect(body.data.length).toBe(1);
    expect(body.data[0].version).toBe('5.0');
  });

  it('includes item description and assignee in normalized output', async () => {
    const root = setup();
    writeFileSync(join(root, '.agentforge/sprints/v6.1.json'), JSON.stringify({
      version: '6.1',
      name: 'v6.1',
      phase: 'in_progress',
      items: [{
        id: 'p0-1',
        title: 'Sprint normalization',
        description: 'Fix schema parsing',
        priority: 'P0',
        assignee: 'api-specialist',
        status: 'completed',
      }],
    }));
    app = await buildApp(root);

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints' });
    const body = res.json();
    const item = body.data[0].items[0];
    expect(item.description).toBe('Fix schema parsing');
    expect(item.assignee).toBe('api-specialist');
  });

  it('preserves auditFindings and successCriteria fields in list response', async () => {
    const root = setup();
    writeFileSync(join(root, '.agentforge/sprints/v6.3.json'), JSON.stringify({
      version: '6.3',
      name: 'v6.3',
      phase: 'completed',
      items: [],
      successCriteria: ['All tests pass'],
      auditFindings: ['One stale route removed'],
    }));
    app = await buildApp(root);

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const sprint = body.data[0];
    expect(sprint.successCriteria).toEqual(['All tests pass']);
    expect(sprint.auditFindings).toEqual(['One stale route removed']);
  });
});

describe('GET /api/v5/sprints/:version', () => {
  let app: ReturnType<typeof Fastify>;

  afterEach(async () => {
    await app.close();
    cleanup();
  });

  it('returns 404 for nonexistent sprint', async () => {
    const root = setup();
    app = await buildApp(root);

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/99.99' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toMatch(/not found/i);
  });

  it('returns normalized sprint detail for flat format', async () => {
    const root = setup();
    writeFileSync(join(root, '.agentforge/sprints/v5.5.json'), JSON.stringify({
      version: '5.5',
      name: 'v5.5 - Autonomy',
      phase: 'completed',
      startedAt: '2026-03-27T10:00:00.000Z',
      completedAt: '2026-03-27T12:00:00.000Z',
      items: [
        { id: 'p0-1', title: 'WorkflowRunner', priority: 'P0', status: 'completed' },
      ],
      budget: 200,
      teamSize: 5,
    }));
    app = await buildApp(root);

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/5.5' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.version).toBe('5.5');
    expect(body.data.title).toBe('v5.5 - Autonomy');
    expect(body.data.status).toBe('completed');
    expect(body.data.items.length).toBe(1);
    expect(body.data.budget).toBe(200);
    expect(body.data.teamSize).toBe(5);
  });

  it('returns normalized sprint detail for nested sprints-array format', async () => {
    const root = setup();
    writeFileSync(join(root, '.agentforge/sprints/v6.0.json'), JSON.stringify({
      sprints: [{
        version: '6.0',
        title: 'v6.0 - Live Dashboard',
        phase: 'completed',
        items: [
          { id: 'p0-1', title: 'Execution API', priority: 'P0', status: 'completed' },
        ],
        successCriteria: ['API works'],
        auditFindings: ['No live execution path'],
      }],
    }));
    app = await buildApp(root);

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/6.0' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.version).toBe('6.0');
    expect(body.data.successCriteria).toEqual(['API works']);
    expect(body.data.auditFindings).toEqual(['No live execution path']);
  });

  it('preserves explicitly empty auditFindings array without fallback', async () => {
    // Regression guard for the auditFindings falsy-override bug (MAJOR in v10.4.0 review):
    // When auditFindings is explicitly [] the .length === 0 is falsy — any conditional that
    // checks `raw.auditFindings?.length ? ... : fallback` would silently swap it for a
    // fallback value. The current code uses direct assignment, but this test pins that
    // behaviour so it cannot silently regress.
    const root = setup();
    writeFileSync(join(root, '.agentforge/sprints/v6.1.json'), JSON.stringify({
      sprints: [{
        version: '6.1',
        title: 'v6.1 - Empty Findings',
        phase: 'completed',
        items: [],
        successCriteria: ['Criteria A'],
        auditFindings: [],          // explicitly empty — must survive normalisation
      }],
    }));
    app = await buildApp(root);

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/6.1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Must return an empty array, not undefined and not a fallback value
    expect(Array.isArray(body.data.auditFindings)).toBe(true);
    expect(body.data.auditFindings).toHaveLength(0);
    // successCriteria should be unaffected
    expect(body.data.successCriteria).toEqual(['Criteria A']);
  });

  it('returns undefined auditFindings when field is absent from sprint', async () => {
    const root = setup();
    writeFileSync(join(root, '.agentforge/sprints/v6.2.json'), JSON.stringify({
      sprints: [{
        version: '6.2',
        title: 'v6.2 - No Findings Field',
        phase: 'completed',
        items: [],
        successCriteria: ['Criteria A'],
        // auditFindings intentionally absent
      }],
    }));
    app = await buildApp(root);

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/6.2' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Field absent in source → undefined in response (not an empty array, not a string)
    expect(body.data.auditFindings).toBeUndefined();
  });

  it('normalizes dates from startedAt/completedAt fields', async () => {
    const root = setup();
    writeFileSync(join(root, '.agentforge/sprints/v7.0.json'), JSON.stringify({
      version: '7.0',
      name: 'v7.0',
      phase: 'completed',
      startedAt: '2026-04-01T10:00:00.000Z',
      completedAt: '2026-04-01T14:30:00.000Z',
      items: [],
    }));
    app = await buildApp(root);

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/7.0' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.startDate).toBe('2026-04-01T10:00:00.000Z');
    expect(body.data.endDate).toBe('2026-04-01T14:30:00.000Z');
  });

  it('falls back to createdAt for startDate when startedAt is absent', async () => {
    const root = setup();
    writeFileSync(join(root, '.agentforge/sprints/v7.1.json'), JSON.stringify({
      version: '7.1',
      name: 'v7.1',
      phase: 'completed',
      createdAt: '2026-04-02T09:00:00.000Z',
      items: [],
    }));
    app = await buildApp(root);

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/7.1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.startDate).toBe('2026-04-02T09:00:00.000Z');
    expect(body.data.endDate).toBeUndefined();
  });

  it('returns versionDecision with all sub-fields', async () => {
    const root = setup();
    writeFileSync(join(root, '.agentforge/sprints/v8.0.json'), JSON.stringify({
      version: '8.0',
      name: 'v8.0',
      phase: 'completed',
      items: [],
      versionDecision: {
        previousVersion: '7.1',
        nextVersion: '8.1',
        tier: 'minor',
        rationale: 'Added new feature set',
        tagsSeen: ['feature', 'dashboard'],
      },
    }));
    app = await buildApp(root);

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/8.0' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.versionDecision).toEqual({
      previousVersion: '7.1',
      nextVersion: '8.1',
      tier: 'minor',
      rationale: 'Added new feature set',
      tagsSeen: ['feature', 'dashboard'],
    });
  });

  it('returns item tags, estimatedCost (from estimatedCostUsd), and source fields', async () => {
    const root = setup();
    writeFileSync(join(root, '.agentforge/sprints/v8.1.json'), JSON.stringify({
      version: '8.1',
      name: 'v8.1',
      phase: 'in_progress',
      items: [{
        id: 'p0-1',
        title: 'Tagged item',
        priority: 'P0',
        status: 'completed',
        estimatedCostUsd: 12.5,
        tags: ['dashboard', 'ux'],
        source: 'todo-backlog',
      }],
    }));
    app = await buildApp(root);

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/8.1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const item = body.data.items[0];
    expect(item.estimatedCost).toBe(12.5);
    expect(item.tags).toEqual(['dashboard', 'ux']);
    expect(item.source).toBe('todo-backlog');
  });

  it('returns testCount fields and totalCostUsd when present', async () => {
    const root = setup();
    writeFileSync(join(root, '.agentforge/sprints/v9.0.json'), JSON.stringify({
      version: '9.0',
      name: 'v9.0',
      phase: 'completed',
      testCountBefore: 1000,
      testCountAfter: 1250,
      testCountDelta: 250,
      totalCostUsd: 34.72,
      autonomous: true,
      theme: 'Resilience',
      items: [],
    }));
    app = await buildApp(root);

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/9.0' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.testCountBefore).toBe(1000);
    expect(body.data.testCountAfter).toBe(1250);
    expect(body.data.testCountDelta).toBe(250);
    expect(body.data.totalCostUsd).toBe(34.72);
    expect(body.data.autonomous).toBe(true);
    expect(body.data.theme).toBe('Resilience');
  });

  it('extracts testCount fields from nested results object (v5.4-era format)', async () => {
    // v5.4–v5.8 stored test metrics inside a results sub-object rather than at
    // the top level. The normalizer must surface them as first-class fields.
    const root = setup();
    writeFileSync(join(root, '.agentforge/sprints/v5.4.json'), JSON.stringify({
      version: '5.4',
      name: 'v5.4',
      phase: 'completed',
      items: [],
      results: {
        testsPassingBefore: 2708,
        testsPassingAfter: 2914,
        newTests: 206,
        autonomyGates: {
          orchestration: 'PASSED — parallel agents OK',
          sprintLoop: 'PASSED — dry-run clean',
        },
        newFiles: ['packages/core/src/workflow-runner.ts'],
      },
    }));
    app = await buildApp(root);

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/5.4' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.testCountBefore).toBe(2708);
    expect(body.data.testCountAfter).toBe(2914);
    expect(body.data.testCountDelta).toBe(206);
    expect(body.data.autonomyGates).toEqual({
      orchestration: 'PASSED — parallel agents OK',
      sprintLoop: 'PASSED — dry-run clean',
    });
    expect(body.data.newFiles).toEqual(['packages/core/src/workflow-runner.ts']);
  });

  it('extracts testCount from flat testsAdded/testsPrior/testsTotal aliases (v5.7-era format)', async () => {
    const root = setup();
    writeFileSync(join(root, '.agentforge/sprints/v5.7.json'), JSON.stringify({
      version: '5.7',
      name: 'v5.7',
      phase: 'completed',
      items: [],
      testsAdded: 101,
      testsPrior: 3105,
      testsTotal: 3206,
    }));
    app = await buildApp(root);

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/5.7' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.testCountBefore).toBe(3105);
    expect(body.data.testCountAfter).toBe(3206);
    expect(body.data.testCountDelta).toBe(101);
  });

  it('extracts cto_brief alias into ctoBrief field (v5.3-era format)', async () => {
    const root = setup();
    writeFileSync(join(root, '.agentforge/sprints/v5.3.json'), JSON.stringify({
      version: '5.3',
      name: 'v5.3',
      phase: 'completed',
      items: [],
      cto_brief: 'v5.3 crosses the autonomy threshold.',
    }));
    app = await buildApp(root);

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/5.3' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.ctoBrief).toBe('v5.3 crosses the autonomy threshold.');
  });

  it('extracts risks array from sprint (v4.7-era format)', async () => {
    const root = setup();
    writeFileSync(join(root, '.agentforge/sprints/v4.7.json'), JSON.stringify({
      version: '4.7',
      name: 'v4.7',
      phase: 'completed',
      items: [],
      risks: [
        { risk: 'SQLite contention', mitigation: 'WAL mode + pooling', owner: 'dba' },
        { risk: 'SSE backpressure', mitigation: 'Buffer cap at 100 events' },
      ],
    }));
    app = await buildApp(root);

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/4.7' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.data.risks)).toBe(true);
    expect(body.data.risks).toHaveLength(2);
    expect(body.data.risks[0].risk).toBe('SQLite contention');
    expect(body.data.risks[0].mitigation).toBe('WAL mode + pooling');
    expect(body.data.risks[0].owner).toBe('dba');
    expect(body.data.risks[1].owner).toBeUndefined();
  });

  it('extracts newHires array from sprint (v4.7-era format)', async () => {
    const root = setup();
    writeFileSync(join(root, '.agentforge/sprints/v4.7b.json'), JSON.stringify({
      version: '4.7b',
      name: 'v4.7b',
      phase: 'completed',
      items: [],
      newHires: [
        {
          agent: 'data-analyst',
          model: 'sonnet',
          reportsTo: 'cfo',
          rationale: 'Ad-hoc query capability against audit database.',
        },
        {
          agent: 'api-gateway-engineer',
          model: 'sonnet',
          reportsTo: 'engineering-manager-backend',
        },
      ],
    }));
    app = await buildApp(root);

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/4.7b' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.data.newHires)).toBe(true);
    expect(body.data.newHires).toHaveLength(2);
    expect(body.data.newHires[0].agent).toBe('data-analyst');
    expect(body.data.newHires[0].model).toBe('sonnet');
    expect(body.data.newHires[0].reportsTo).toBe('cfo');
    expect(body.data.newHires[0].rationale).toBe('Ad-hoc query capability against audit database.');
    expect(body.data.newHires[1].rationale).toBeUndefined();
  });

  it('top-level testCount fields take precedence over results.* fallback', async () => {
    // Regression guard: if both top-level and results.* are present, the top-level
    // explicit values must win. This matches the ?? operator chain order.
    const root = setup();
    writeFileSync(join(root, '.agentforge/sprints/v9.5.json'), JSON.stringify({
      version: '9.5',
      name: 'v9.5',
      phase: 'completed',
      items: [],
      testCountBefore: 100,
      testCountAfter: 150,
      testCountDelta: 50,
      results: {
        testsPassingBefore: 999,  // must be ignored
        testsPassingAfter: 999,
        newTests: 999,
      },
    }));
    app = await buildApp(root);

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/9.5' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.testCountBefore).toBe(100);
    expect(body.data.testCountAfter).toBe(150);
    expect(body.data.testCountDelta).toBe(50);
  });
});

describe('deriveStatus phase normalization', () => {
  let app: ReturnType<typeof Fastify>;

  afterEach(async () => {
    await app.close();
    cleanup();
  });

  const COMPLETED_PHASES = ['completed', 'done', 'release', 'released', 'shipped', 'closed', 'merged', 'learn', 'complete'];
  const IN_PROGRESS_PHASES = ['in_progress', 'active', 'executing', 'execute', 'review'];
  const PENDING_PHASES = ['planned', 'plan', 'pending', 'draft'];

  for (const phase of COMPLETED_PHASES) {
    it(`maps phase "${phase}" to status "completed"`, async () => {
      const root = setup();
      writeFileSync(join(root, `.agentforge/sprints/vphase-${phase.replace('_', '-')}.json`), JSON.stringify({
        version: `phase-${phase.replace('_', '-')}`,
        name: `phase test ${phase}`,
        phase,
        items: [],
      }));
      app = await buildApp(root);

      const res = await app.inject({ method: 'GET', url: `/api/v5/sprints/phase-${phase.replace('_', '-')}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.status).toBe('completed');
    });
  }

  for (const phase of IN_PROGRESS_PHASES) {
    it(`maps phase "${phase}" to status "in_progress"`, async () => {
      const root = setup();
      writeFileSync(join(root, `.agentforge/sprints/vphase-${phase.replace('_', '-')}.json`), JSON.stringify({
        version: `phase-${phase.replace('_', '-')}`,
        name: `phase test ${phase}`,
        phase,
        items: [],
      }));
      app = await buildApp(root);

      const res = await app.inject({ method: 'GET', url: `/api/v5/sprints/phase-${phase.replace('_', '-')}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.status).toBe('in_progress');
    });
  }

  for (const phase of PENDING_PHASES) {
    it(`maps phase "${phase}" to status "pending"`, async () => {
      const root = setup();
      writeFileSync(join(root, `.agentforge/sprints/vphase-${phase.replace('_', '-')}.json`), JSON.stringify({
        version: `phase-${phase.replace('_', '-')}`,
        name: `phase test ${phase}`,
        phase,
        items: [],
      }));
      app = await buildApp(root);

      const res = await app.inject({ method: 'GET', url: `/api/v5/sprints/phase-${phase.replace('_', '-')}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.status).toBe('pending');
    });
  }
});

// ---------------------------------------------------------------------------
// Security: path-traversal rejection on GET /api/v5/sprints/:version
// ---------------------------------------------------------------------------
// These tests pin the SAFE_VERSION + safeJoin double-guard introduced in the
// v10.5.0 security audit to prevent `.agentforge/sprints/` directory escape.
// They MUST all return 400 — a 200 or a file-read-error means the guard broke.
describe('GET /api/v5/sprints/:version — path traversal guards', () => {
  let app: ReturnType<typeof Fastify>;

  afterEach(async () => {
    await app.close();
    cleanup();
  });

  // Vectors that reach the handler and are rejected by SAFE_VERSION → 400
  const HANDLER_REJECTED_VECTORS = [
    '../etc/passwd',
    '..%2Fetc%2Fpasswd',
    '../../.agentforge/config/settings',
    '.',
    '',
    'v%2F..%2Fetc',
    '%2e%2e',
    'x/../../etc',
    'x/../y',
  ];

  // Vectors that Fastify's URL router normalises away BEFORE reaching the handler
  // (e.g. ".." collapses the path to the parent segment → 404 no-route).
  // Both 400 and 404 are safe — neither returns file contents.
  const ROUTER_NORMALIZED_VECTORS = ['..'];

  for (const vector of HANDLER_REJECTED_VECTORS) {
    it(`rejects version "${vector}" with 400`, async () => {
      const root = setup();
      app = await buildApp(root);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v5/sprints/${encodeURIComponent(vector)}`,
      });
      // SAFE_VERSION regex must reject all of these before any FS access
      expect(res.statusCode).toBe(400);
    });
  }

  for (const vector of ROUTER_NORMALIZED_VECTORS) {
    it(`safely rejects version "${vector}" (router-level or handler-level, not 200)`, async () => {
      const root = setup();
      app = await buildApp(root);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v5/sprints/${encodeURIComponent(vector)}`,
      });
      // Fastify normalises ".." in the URL path before routing — the route
      // handler may never even see it (404 from no-route-match). Either 400
      // or 404 is acceptable; what matters is that 200 is NOT returned.
      expect(res.statusCode).not.toBe(200);
      expect([400, 404]).toContain(res.statusCode);
    });
  }

  it('accepts a valid semver version (e.g. 10.5.0)', async () => {
    const root = setup();
    writeFileSync(join(root, '.agentforge/sprints/v10.5.0.json'), JSON.stringify({
      version: '10.5.0',
      title: 'Valid version',
      phase: 'completed',
      items: [],
    }));
    app = await buildApp(root);

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/10.5.0' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.version).toBe('10.5.0');
  });

  it('accepts a hyphenated sprint name (e.g. phase-active)', async () => {
    const root = setup();
    writeFileSync(join(root, '.agentforge/sprints/vphase-active.json'), JSON.stringify({
      version: 'phase-active',
      title: 'Hyphenated sprint',
      phase: 'in_progress',
      items: [],
    }));
    app = await buildApp(root);

    const res = await app.inject({ method: 'GET', url: '/api/v5/sprints/phase-active' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('in_progress');
  });
});
