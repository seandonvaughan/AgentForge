import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { agentRoutes } from '../agents.js';

const coreMocks = vi.hoisted(() => ({
  loadAgentConfig: vi.fn(),
  recordManualInvokeMemory: vi.fn(),
  run: vi.fn(),
}));

vi.mock('@agentforge/core', () => ({
  AgentRuntime: vi.fn(function () {
    return { run: coreMocks.run };
  }),
  loadAgentConfig: coreMocks.loadAgentConfig,
  recordManualInvokeMemory: coreMocks.recordManualInvokeMemory,
  resolveProviderModelProfile: vi.fn(() => ({ modelId: 'gpt-5.3-codex', effort: 'high' })),
}));

async function buildApp() {
  const app = Fastify({ logger: false });
  await agentRoutes(app, { projectRoot: 'C:/tmp/agentforge-test' });
  return app;
}

function installDefaultMocks() {
  coreMocks.loadAgentConfig.mockResolvedValue({
    agentId: 'coder',
    name: 'Coder',
    model: 'sonnet',
    systemPrompt: 'You are a coder.',
    workspaceId: 'default',
    skillIds: ['af-tdd'],
  });
  coreMocks.run.mockResolvedValue({
    sessionId: 'sess-agent-run',
    response: 'done',
    model: 'gpt-5.3-codex',
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.01,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    status: 'completed',
  });
}

describe('POST /api/v5/agents/:id/run memory', () => {
  beforeEach(() => {
    coreMocks.loadAgentConfig.mockReset();
    coreMocks.recordManualInvokeMemory.mockReset();
    coreMocks.run.mockReset();
    installDefaultMocks();
  });

  it('records canonical memory for direct agent route invokes', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v5/agents/coder/run',
      payload: { task: 'Implement the thing', runtimeMode: 'codex-cli' },
    });

    expect(response.statusCode).toBe(200);
    expect(coreMocks.recordManualInvokeMemory).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: 'C:/tmp/agentforge-test',
      agent: { agentId: 'coder', skills: ['af-tdd'] },
      task: 'Implement the thing',
      result: expect.objectContaining({ status: 'completed' }),
    }));
  });

  it('records canonical failure memory when direct agent route invoke throws', async () => {
    coreMocks.run.mockRejectedValueOnce(new Error('direct route exploded'));
    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v5/agents/coder/run',
      payload: { task: 'Fail usefully', runtimeMode: 'codex-cli' },
    });

    expect(response.statusCode).toBe(500);
    expect(coreMocks.recordManualInvokeMemory).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: 'C:/tmp/agentforge-test',
      agent: { agentId: 'coder', skills: ['af-tdd'] },
      task: 'Fail usefully',
      error: 'direct route exploded',
    }));
  });
});
