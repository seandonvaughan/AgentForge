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
});
