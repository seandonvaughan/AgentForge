import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const runMock = vi.hoisted(() => vi.fn());
const closeMock = vi.hoisted(() => vi.fn());
const getOrCreateDefaultWorkspaceMock = vi.hoisted(() => vi.fn());
const listCatalogAgentsMock = vi.hoisted(() => vi.fn());
const loadAgentConfigMock = vi.hoisted(() => vi.fn());

vi.mock('../../agent-runtime/index.js', () => ({
  AgentRuntime: vi.fn().mockImplementation(function AgentRuntimeMock() {
    return { run: runMock };
  }),
  loadAgentConfig: loadAgentConfigMock,
}));

vi.mock('../../workspace/index.js', () => ({
  WorkspaceManager: vi.fn().mockImplementation(function WorkspaceManagerMock() {
    return {
      getOrCreateDefaultWorkspace: getOrCreateDefaultWorkspaceMock,
      close: closeMock,
    };
  }),
}));

vi.mock('../agent-catalog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-catalog.js')>();
  return {
    ...actual,
    listCatalogAgents: listCatalogAgentsMock,
  };
});

describe('invokeAgentRun cwd handling', () => {
  let tmpRoot: string;
  let projectRoot: string;
  let previousCwd: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-invoke-cwd-'));
    projectRoot = join(tmpRoot, 'worktree-project');
    mkdirSync(join(projectRoot, '.agentforge', 'agents'), { recursive: true });
    previousCwd = process.cwd();
    process.chdir(dirname(projectRoot));

    vi.clearAllMocks();
    getOrCreateDefaultWorkspaceMock.mockResolvedValue({
      workspace: { id: 'workspace-1', slug: 'default' },
      adapter: {
        getSession: vi.fn().mockReturnValue(undefined),
      },
    });
    listCatalogAgentsMock.mockResolvedValue([
      {
        agentId: 'cli-engineer',
        name: 'CLI Engineer',
        model: 'sonnet',
        description: '',
        skills: [],
        keywords: [],
        filePatterns: [],
      },
    ]);
    loadAgentConfigMock.mockResolvedValue({
      agentId: 'cli-engineer',
      name: 'CLI Engineer',
      model: 'sonnet',
      systemPrompt: 'Edit the requested project.',
      workspaceId: 'default',
    });
    runMock.mockResolvedValue({
      sessionId: 'session-1',
      response: 'done',
      model: 'gpt-5.3-codex',
      capabilityTier: 'sonnet',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      startedAt: '2026-05-27T00:00:00.000Z',
      completedAt: '2026-05-27T00:00:01.000Z',
      status: 'completed',
      providerKind: 'codex-cli',
      runtimeModeResolved: 'codex-cli',
    });
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('runs the selected agent in the resolved project root instead of process.cwd()', async () => {
    const { invokeAgentRun } = await import('../invoke-service.js');

    await invokeAgentRun({
      projectRoot: basename(projectRoot),
      agent: 'cli-engineer',
      task: 'Make a concrete edit.',
      runtimeMode: 'codex-cli',
    });

    expect(listCatalogAgentsMock).toHaveBeenCalledWith(resolve(projectRoot));
    expect(loadAgentConfigMock).toHaveBeenCalledWith(
      'cli-engineer',
      join(resolve(projectRoot), '.agentforge'),
      expect.any(Object),
    );
    expect(runMock).toHaveBeenCalledWith(expect.objectContaining({
      task: 'Make a concrete edit.',
      cwd: resolve(projectRoot),
      runtimeMode: 'codex-cli',
    }));
    expect(runMock.mock.calls[0]?.[0]?.cwd).not.toBe(previousCwd);
  });
});
