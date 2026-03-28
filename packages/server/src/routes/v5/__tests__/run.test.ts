import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { runRoutes, getRunLog } from '../run.js';

// Mock @agentforge/core so no real Anthropic API calls are made
vi.mock('@agentforge/core', () => {
  const mockRunResult = {
    sessionId: 'mock-session-1',
    response: 'Hello from mock agent',
    model: 'claude-sonnet-4-6',
    inputTokens: 10,
    outputTokens: 20,
    costUsd: 0.0001,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    status: 'completed',
  };

  return {
    AgentRuntime: vi.fn().mockImplementation(() => ({
      runStreaming: vi.fn().mockResolvedValue(mockRunResult),
    })),
    loadAgentConfig: vi.fn().mockImplementation(async (agentId: string) => {
      if (agentId === 'coder') {
        return {
          agentId: 'coder',
          name: 'Coder',
          model: 'sonnet' as const,
          systemPrompt: 'You are a coder agent.',
          workspaceId: 'default',
        };
      }
      return null;
    }),
  };
});

// Mock the SSE stream so events don't throw
vi.mock('../stream.js', () => ({
  globalStream: {
    emit: vi.fn(),
  },
}));

// Mock @agentforge/shared for generateId and nowIso
vi.mock('@agentforge/shared', () => {
  let counter = 0;
  return {
    generateId: vi.fn(() => `test-id-${++counter}`),
    nowIso: vi.fn(() => '2026-03-27T12:00:00.000Z'),
  };
});

async function buildApp() {
  const app = Fastify({ logger: false });
  await runRoutes(app);
  return app;
}

describe('POST /api/v5/run', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    getRunLog().clear();
    app = await buildApp();
  });

  it('returns 200 with RunResult when given a valid agentId and task', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v5/run',
      payload: { agentId: 'coder', task: 'Write a hello world function' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('data');
    expect(body.data).toHaveProperty('sessionId');
    expect(body.data.sessionId).toMatch(/^run-/);
    expect(body.data).toHaveProperty('status', 'completed');
    expect(body.data).toHaveProperty('response', 'Hello from mock agent');
  });

  it('persists completed run to in-memory run log', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v5/run',
      payload: { agentId: 'coder', task: 'Test persistence' },
    });

    expect(response.statusCode).toBe(200);
    const { sessionId } = response.json().data;

    expect(getRunLog().has(sessionId)).toBe(true);
    const entry = getRunLog().get(sessionId);
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('completed');
    expect(entry!.agentId).toBe('coder');
    expect(entry!.task).toBe('Test persistence');
  });

  it('returns 404 when agentId does not match any agent YAML', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v5/run',
      payload: { agentId: 'unknown-agent-xyz', task: 'Do something' },
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body).toHaveProperty('error', 'Agent not found');
  });

  it('returns 400 when task is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v5/run',
      payload: { agentId: 'coder' },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body).toHaveProperty('error', 'task is required');
  });

  it('returns 400 when agentId is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v5/run',
      payload: { task: 'Do something' },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body).toHaveProperty('error', 'agentId is required');
  });
});

describe('GET /api/v5/run/history', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    getRunLog().clear();
    app = await buildApp();
  });

  it('returns empty array when no runs exist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v5/run/history',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
  });

  it('returns runs after a POST /api/v5/run', async () => {
    // Create a run first
    await app.inject({
      method: 'POST',
      url: '/api/v5/run',
      payload: { agentId: 'coder', task: 'Build a widget' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v5/run/history',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.length).toBe(1);
    expect(body.data[0]).toHaveProperty('agentId', 'coder');
    expect(body.data[0]).toHaveProperty('status', 'completed');
    expect(body.meta.total).toBe(1);
  });
});

describe('GET /api/v5/run/:sessionId', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    getRunLog().clear();
    app = await buildApp();
  });

  it('returns 404 when session does not exist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v5/run/nonexistent-session',
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body).toHaveProperty('error');
    expect(body.error).toMatch(/not found/i);
  });

  it('returns run data when session exists in run log', async () => {
    // Create a run first
    const runResponse = await app.inject({
      method: 'POST',
      url: '/api/v5/run',
      payload: { agentId: 'coder', task: 'Test retrieval' },
    });

    const { sessionId } = runResponse.json().data;

    const response = await app.inject({
      method: 'GET',
      url: `/api/v5/run/${sessionId}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveProperty('sessionId', sessionId);
    expect(body.data).toHaveProperty('agentId', 'coder');
    expect(body.data).toHaveProperty('status', 'completed');
  });
});
