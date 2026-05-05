import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { runRoutes, getRunLog } from '../run.js';

const coreMocks = vi.hoisted(() => {
  const mockRunResult = {
    response: 'Hello from mock agent',
    model: 'claude-sonnet-4-6',
    inputTokens: 10,
    outputTokens: 20,
    costUsd: 0.0001,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    status: 'completed',
    providerKind: 'anthropic-sdk',
    runtimeModeResolved: 'sdk',
  };

  return {
    loadAgentConfig: vi.fn(),
    mockRunResult,
    runStreaming: vi.fn(),
  };
});

// Mock @agentforge/core so no real Anthropic API calls are made.
// runStreaming calls onChunk before resolving so the SSE emission path
// is exercised the same way it runs in production.
vi.mock('@agentforge/core', () => {
  return {
    AgentRuntime: vi.fn(function () {
      return { runStreaming: coreMocks.runStreaming };
    }),
    RuntimeJobSupervisor: vi.fn(function () {
      return {};
    }),
    loadAgentConfig: coreMocks.loadAgentConfig,
  };
});

// vi.mock is hoisted before const declarations, so we use vi.hoisted()
// to ensure mockEmit is available inside the factory.
const mockEmit = vi.hoisted(() => vi.fn());

// Mock the SSE stream so we can assert on emitted events
vi.mock('../stream.js', () => ({
  globalStream: {
    emit: mockEmit,
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

function installDefaultCoreMocks() {
  coreMocks.loadAgentConfig.mockImplementation(async (agentId: string) => {
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
  });

  coreMocks.runStreaming.mockImplementation(
    async (opts: {
      sessionId?: string;
      onChunk?: (text: string, index: number) => void;
      onEvent?: (event: { type: string; data: unknown }) => void;
    }) => {
      if (opts.onChunk) opts.onChunk(coreMocks.mockRunResult.response, 0);
      const result = {
        ...coreMocks.mockRunResult,
        sessionId: opts.sessionId ?? 'mock-session-1',
      };
      if (opts.onEvent) opts.onEvent({ type: 'done', data: result });
      return result;
    },
  );
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('POST /api/v5/run', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    getRunLog().clear();
    mockEmit.mockClear();
    coreMocks.loadAgentConfig.mockReset();
    coreMocks.runStreaming.mockReset();
    installDefaultCoreMocks();
    app = await buildApp();
  });

  it('returns 202 with a running run entry by default', async () => {
    let resolveRun: ((value: unknown) => void) | undefined;
    coreMocks.runStreaming.mockImplementationOnce(
      (opts: {
        sessionId?: string;
        onChunk?: (text: string, index: number) => void;
        onEvent?: (event: { type: string; data: unknown }) => void;
      }) => new Promise((resolve) => {
        resolveRun = () => {
          opts.onChunk?.(coreMocks.mockRunResult.response, 0);
          const result = {
            ...coreMocks.mockRunResult,
            sessionId: opts.sessionId ?? 'mock-session-1',
          };
          opts.onEvent?.({ type: 'done', data: result });
          resolve(result);
        };
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/v5/run',
      payload: { agentId: 'coder', task: 'Write a hello world function' },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.data).toHaveProperty('sessionId');
    expect(body.data).toHaveProperty('status', 'running');
    expect(body.data.sessionId).toMatch(/^run-/);
    expect(getRunLog().get(body.data.sessionId)?.status).toBe('running');

    resolveRun?.(undefined);
    await flushPromises();
    expect(getRunLog().get(body.data.sessionId)?.status).toBe('completed');
  });

  it('returns 200 with RunResult when wait=true is requested', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v5/run?wait=true',
      payload: { agentId: 'coder', task: 'Write a hello world function' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveProperty('data');
    expect(body.data).toHaveProperty('sessionId');
    expect(body.data.sessionId).toMatch(/^run-/);
    expect(body.data).toHaveProperty('status', 'completed');
    expect(body.data).toHaveProperty('response', 'Hello from mock agent');
    expect(body.data).toHaveProperty('providerKind', 'anthropic-sdk');
    expect(body.data).toHaveProperty('runtimeModeResolved', 'sdk');
  });

  it('persists completed run to in-memory run log', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v5/run?wait=true',
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
    expect(entry!.providerKind).toBe('anthropic-sdk');
    expect(entry!.runtimeModeResolved).toBe('sdk');
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

  it('emits agent_activity SSE events with sessionId and content for streaming output', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v5/run?wait=true',
      payload: { agentId: 'coder', task: 'Write a function' },
    });

    expect(response.statusCode).toBe(200);
    const { sessionId } = response.json().data;

    // The route must emit at least one agent_activity event containing
    // the sessionId so the dashboard SSE consumer can correlate chunks.
    const activityCalls = mockEmit.mock.calls.filter(
      ([evt]) => evt.type === 'agent_activity' && evt.data?.sessionId === sessionId,
    );
    expect(activityCalls.length).toBeGreaterThan(0);

    // At least one event must carry content (the onChunk payload).
    const chunkCalls = activityCalls.filter(([evt]) => typeof evt.data?.content === 'string' && evt.data.content.length > 0);
    expect(chunkCalls.length).toBeGreaterThan(0);
  });

  it('emits workflow_event SSE event on run completion', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v5/run?wait=true',
      payload: { agentId: 'coder', task: 'Write a function' },
    });

    expect(response.statusCode).toBe(200);
    const { sessionId } = response.json().data;

    // The route must emit a workflow_event with status 'completed' so the
    // dashboard can close the SSE connection and update history badges.
    const completionCalls = mockEmit.mock.calls.filter(
      ([evt]) =>
        evt.type === 'workflow_event' &&
        evt.data?.sessionId === sessionId &&
        evt.data?.status === 'completed',
    );
    expect(completionCalls.length).toBe(1);
  });
});

describe('GET /api/v5/run/history', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    getRunLog().clear();
    mockEmit.mockClear();
    coreMocks.loadAgentConfig.mockReset();
    coreMocks.runStreaming.mockReset();
    installDefaultCoreMocks();
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
      url: '/api/v5/run?wait=true',
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
    expect(body.data[0]).toHaveProperty('providerKind', 'anthropic-sdk');
    expect(body.data[0]).toHaveProperty('runtimeModeResolved', 'sdk');
    expect(body.meta.total).toBe(1);
  });
});

describe('GET /api/v5/run/:sessionId', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    getRunLog().clear();
    mockEmit.mockClear();
    coreMocks.loadAgentConfig.mockReset();
    coreMocks.runStreaming.mockReset();
    installDefaultCoreMocks();
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
      url: '/api/v5/run?wait=true',
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
    expect(body.data).toHaveProperty('providerKind', 'anthropic-sdk');
    expect(body.data).toHaveProperty('runtimeModeResolved', 'sdk');
  });
});
