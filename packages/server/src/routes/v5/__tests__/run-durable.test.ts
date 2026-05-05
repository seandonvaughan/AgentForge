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
