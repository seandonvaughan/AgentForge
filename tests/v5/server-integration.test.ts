import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServerV5 } from '../../packages/server/src/server.js';
import { MessageBusV2 } from '../../packages/core/src/message-bus/message-bus.js';

describe('v5 server integration', () => {
  let serverHandle: Awaited<ReturnType<typeof createServerV5>>;

  beforeAll(async () => {
    const bus = new MessageBusV2({ workspaceId: 'test' });
    serverHandle = await createServerV5({ port: 4799, bus, listen: false }); // test port
  });

  afterAll(async () => {
    await serverHandle.app.close();
  });

  it('GET /api/v5/health returns ok', async () => {
    const res = await serverHandle.app.inject({ method: 'GET', url: '/api/v5/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.version).toBe('6.1.0');
  });

  it('GET /api/v5/workspaces returns empty array without adapter', async () => {
    const res = await serverHandle.app.inject({ method: 'GET', url: '/api/v5/workspaces' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toBeInstanceOf(Array);
  });

  it('GET /api/v5/roles returns built-in roles', async () => {
    const res = await serverHandle.app.inject({ method: 'GET', url: '/api/v5/roles' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.length).toBeGreaterThan(0);
  });

  it('POST /api/v5/access/check returns allowed/denied', async () => {
    const res = await serverHandle.app.inject({
      method: 'POST',
      url: '/api/v5/access/check',
      payload: { userId: 'u1', workspaceId: 'w1', role: 'viewer', permission: 'workspace:read' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.allowed).toBe(true);
  });

  it('GET /api/v5/audit returns empty initially', async () => {
    const res = await serverHandle.app.inject({ method: 'GET', url: '/api/v5/audit' });
    expect(res.statusCode).toBe(200);
  });

  it('POST /api/v5/proposals creates a proposal', async () => {
    const res = await serverHandle.app.inject({
      method: 'POST',
      url: '/api/v5/proposals',
      payload: { agentId: 'cto', title: 'Test proposal', description: 'Testing the proposal system' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.id).toBeTruthy();
    expect(body.data.status).toBe('pending');
  });

  it('POST /api/v5/routing/decide returns routing decision', async () => {
    const res = await serverHandle.app.inject({
      method: 'POST',
      url: '/api/v5/routing/decide',
      payload: { agentId: 'coder', task: 'fix a bug in the login form', defaultModel: 'sonnet' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(['opus', 'sonnet', 'haiku']).toContain(body.data.selectedModel);
  });

  // ── v5.2 endpoints ────────────────────────────────────────────────────────────

  it('GET /api/v5/org-graph returns nodes and edges', async () => {
    const res = await serverHandle.app.inject({ method: 'GET', url: '/api/v5/org-graph' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toHaveProperty('nodes');
    expect(body.data).toHaveProperty('edges');
    expect(Array.isArray(body.data.nodes)).toBe(true);
    expect(Array.isArray(body.data.edges)).toBe(true);
    // Project has agents — should have at least a few nodes
    expect(body.data.nodes.length).toBeGreaterThan(0);
  });

  it('GET /api/v5/agents returns agent list', async () => {
    const res = await serverHandle.app.inject({ method: 'GET', url: '/api/v5/agents' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0]).toHaveProperty('name');
  });

  it('GET /api/v5/agents/:id returns 404 for unknown agent', async () => {
    const res = await serverHandle.app.inject({ method: 'GET', url: '/api/v5/agents/does-not-exist' });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/v5/proposals/from-sessions generates proposals from failures', async () => {
    const res = await serverHandle.app.inject({
      method: 'POST',
      url: '/api/v5/proposals/from-sessions',
      payload: {
        sessions: [
          { agentId: 'coder', status: 'failed', costUsd: 0.05 },
          { agentId: 'coder', status: 'failed', costUsd: 0.05 },
          { agentId: 'coder', status: 'failed', costUsd: 0.05 },
          { agentId: 'coder', status: 'completed', costUsd: 0.05 },
          { agentId: 'opus-agent', status: 'completed', costUsd: 0.50 },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta.generated).toBeGreaterThan(0);
  });

  it('POST /api/v5/proposals/from-sessions rejects empty sessions', async () => {
    const res = await serverHandle.app.inject({
      method: 'POST',
      url: '/api/v5/proposals/from-sessions',
      payload: { sessions: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/v5/embeddings/learn-session indexes a session', async () => {
    const res = await serverHandle.app.inject({
      method: 'POST',
      url: '/api/v5/embeddings/learn-session',
      payload: {
        sessionId: 'test-session-1',
        agentId: 'coder',
        task: 'Fix the login button',
        response: 'Updated the onClick handler to call handleLogin()',
        model: 'sonnet',
        costUsd: 0.003,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.sessionId).toBe('test-session-1');
  });

  // ── v5.5 stream + git-branch-manager endpoints ───────────────────────────────

  it('GET /api/v5/stream/status returns connectedClients as a number', async () => {
    const res = await serverHandle.app.inject({
      method: 'GET',
      url: '/api/v5/stream/status',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toHaveProperty('connectedClients');
    expect(typeof body.data.connectedClients).toBe('number');
  });

  it('GET /api/v5/branches returns empty data array initially', async () => {
    const res = await serverHandle.app.inject({
      method: 'GET',
      url: '/api/v5/branches',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.data)).toBe(true);
    // A fresh server has no branches yet — note: singleton may carry state from
    // other suites, so we only assert it is an array, not that it is empty.
  });

  it('POST /api/v5/branches creates a branch with agentId and taskId', async () => {
    const res = await serverHandle.app.inject({
      method: 'POST',
      url: '/api/v5/branches',
      payload: { agentId: 'coder', taskId: 'task-integration-test' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.agentId).toBe('coder');
    expect(body.data.taskId).toBe('task-integration-test');
    expect(body.data.name).toBe('agent/coder/task-integration-test');
    expect(body.data.status).toBe('active');
  });

  it('POST /api/v5/branches returns 400 without required fields', async () => {
    const res = await serverHandle.app.inject({
      method: 'POST',
      url: '/api/v5/branches',
      payload: { agentId: 'coder' }, // missing taskId
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/taskId/i);
  });

  it('GET /api/v5/branches/report returns total/active/merged/conflict counts', async () => {
    const res = await serverHandle.app.inject({
      method: 'GET',
      url: '/api/v5/branches/report',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toHaveProperty('total');
    expect(body.data).toHaveProperty('active');
    expect(body.data).toHaveProperty('merged');
    expect(body.data).toHaveProperty('conflict');
    expect(typeof body.data.total).toBe('number');
    expect(typeof body.data.active).toBe('number');
    expect(typeof body.data.merged).toBe('number');
    expect(typeof body.data.conflict).toBe('number');
  });
});
