import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { WorkspaceAdapter } from '@agentforge/db';
import { RuntimeJobSupervisor } from '@agentforge/core';
import { runRoutes, getRunLog } from '../run.js';

const coreMocks = vi.hoisted(() => ({
  loadAgentConfig: vi.fn(),
  runStreaming: vi.fn(),
}));

vi.mock('@agentforge/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentforge/core')>();
  return {
    ...actual,
    AgentRuntime: vi.fn(function () {
      return { runStreaming: coreMocks.runStreaming };
    }),
    loadAgentConfig: coreMocks.loadAgentConfig,
  };
});

describe('POST /api/v5/run durable jobs', () => {
  let adapter: WorkspaceAdapter;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    getRunLog().clear();
    adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
    const supervisor = new RuntimeJobSupervisor({ adapter });
    app = Fastify({ logger: false });
    await runRoutes(app, { adapter, supervisor });

    coreMocks.loadAgentConfig.mockReset();
    coreMocks.runStreaming.mockReset();
    coreMocks.loadAgentConfig.mockResolvedValue({
      agentId: 'coder',
      name: 'Coder',
      model: 'sonnet',
      systemPrompt: 'You are a coder agent.',
      workspaceId: 'default',
    });
  });

  afterEach(async () => {
    await app.close();
    adapter.close();
  });

  it('returns durable job identity by default and completes in the background', async () => {
    let finishRun: (() => void) | undefined;
    coreMocks.runStreaming.mockImplementationOnce((opts: {
      sessionId?: string;
      onChunk?: (text: string, index: number) => void;
      onEvent?: (event: { type: string; data: unknown }) => void;
    }) => new Promise((resolve) => {
      finishRun = () => {
        opts.onChunk?.('hello', 0);
        const result = {
          sessionId: opts.sessionId ?? 'run-missing',
          response: 'hello',
          model: 'claude-sonnet-4-6',
          inputTokens: 1,
          outputTokens: 2,
          costUsd: 0.0001,
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:00:01.000Z',
          status: 'completed',
          providerKind: 'anthropic-sdk',
          runtimeModeResolved: 'sdk',
        };
        opts.onEvent?.({ type: 'done', data: result });
        resolve(result);
      };
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/v5/run',
      payload: { agentId: 'coder', task: 'Write a durable run' },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.data).toMatchObject({
      status: 'running',
      agentId: 'coder',
      model: 'sonnet',
    });
    expect(body.data.jobId).toMatch(/^job-/);
    expect(body.data.sessionId).toMatch(/^run-/);
    expect(adapter.getRuntimeJob(body.data.jobId)?.status).toBe('running');

    finishRun?.();
    await new Promise((resolve) => setImmediate(resolve));

    expect(adapter.getRuntimeJob(body.data.jobId)?.status).toBe('completed');
    expect(adapter.listRuntimeEvents({ jobId: body.data.jobId }).map((event) => event.type)).toContain('job_completed');
    expect(getRunLog().get(body.data.sessionId)?.status).toBe('completed');
  });
});

describe('GET /api/v5/run/history (adapter-backed)', () => {
  let adapter: WorkspaceAdapter;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    getRunLog().clear();
    adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
    const supervisor = new RuntimeJobSupervisor({ adapter });
    app = Fastify({ logger: false });
    await runRoutes(app, { adapter, supervisor });
  });

  afterEach(async () => {
    await app.close();
    adapter.close();
  });

  it('returns sessions persisted in the adapter when in-memory log is empty (cross-restart history)', async () => {
    // Simulate a session written by a prior server process — runLog is empty
    const session = adapter.createSession({
      agentId: 'coder',
      task: 'Write a sorting algorithm',
      model: 'claude-sonnet-4-6',
    });
    adapter.completeSession(session.id, 'completed', 0.0025, {
      model: 'claude-sonnet-4-6',
      inputTokens: 500,
      outputTokens: 200,
    });

    expect(getRunLog().size).toBe(0);

    const response = await app.inject({ method: 'GET', url: '/api/v5/run/history' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.length).toBe(1);
    expect(body.data[0]).toMatchObject({
      sessionId: session.id,
      agentId: 'coder',
      task: 'Write a sorting algorithm',
      status: 'completed',
      costUsd: 0.0025,
    });
    expect(body.meta.total).toBe(1);
  });

  it('merges adapter sessions with in-memory runLog without duplicating shared sessions', async () => {
    // Session exists in both the adapter DB and the in-memory runLog
    const session = adapter.createSession({
      agentId: 'researcher',
      task: 'Research quantum computing',
      model: 'claude-opus-4-5',
    });
    adapter.completeSession(session.id, 'completed', 0.01);

    getRunLog().set(session.id, {
      sessionId: session.id,
      agentId: 'researcher',
      task: 'Research quantum computing',
      model: 'claude-opus-4-5',
      status: 'completed',
      response: 'Quantum computing uses qubits...',
      costUsd: 0.01,
      inputTokens: 1000,
      outputTokens: 400,
      startedAt: session.started_at,
    } as Parameters<ReturnType<typeof getRunLog>['set']>[1]);

    const response = await app.inject({ method: 'GET', url: '/api/v5/run/history' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Must not duplicate the session — it should appear exactly once
    expect(body.data.length).toBe(1);
    expect(body.data[0].sessionId).toBe(session.id);
    expect(body.meta.total).toBe(1);
  });

  it('returns sessions sorted by startedAt descending', async () => {
    // Create two sessions in the adapter with different start times
    const older = adapter.createSession({ agentId: 'coder', task: 'Old task', model: 'sonnet' });
    const newer = adapter.createSession({ agentId: 'coder', task: 'New task', model: 'sonnet' });

    const response = await app.inject({ method: 'GET', url: '/api/v5/run/history' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.length).toBe(2);
    // Newer session should come first (DESC sort)
    expect(body.data[0].sessionId).toBe(newer.id);
    expect(body.data[1].sessionId).toBe(older.id);
  });

  it('excludes cycle sub-agent sessions (parent_session_id != null) from history unless already in runLog', async () => {
    // Top-level runner session — should appear
    const topLevel = adapter.createSession({
      agentId: 'coder',
      task: 'User runner task',
      model: 'claude-sonnet-4-6',
    });

    // Sub-agent session from a cycle — should NOT appear
    const parent = adapter.createSession({ agentId: 'cycle-root', task: 'cycle', model: 'claude-opus-4-6' });
    const subAgent = adapter.createSession({
      agentId: 'coder',
      task: 'Implement sprint item 7',
      model: 'claude-sonnet-4-6',
      parentSessionId: parent.id,
    });

    expect(getRunLog().size).toBe(0);

    const response = await app.inject({ method: 'GET', url: '/api/v5/run/history' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Only top-level runner sessions visible; parent root and sub-agent are filtered out
    const ids = body.data.map((r: { sessionId: string }) => r.sessionId);
    expect(ids).toContain(topLevel.id);
    expect(ids).not.toContain(subAgent.id);
    // parent itself also has no parentSessionId so it appears (it's a top-level cycle session,
    // not spawned by the runner, but indistinguishable without a source field)
    expect(ids).toContain(parent.id);
  });
});
