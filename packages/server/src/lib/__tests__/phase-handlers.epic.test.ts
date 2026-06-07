import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseContext, SprintFile } from '../phase-handlers.js';

const coreMocks = vi.hoisted(() => ({
  runCoreGatePhase: vi.fn(),
  runCoreReviewPhase: vi.fn(),
  runStreaming: vi.fn(),
  loadAgentConfig: vi.fn(),
  writeMemoryEntry: vi.fn(),
  writeKnowledgeEntry: vi.fn(),
  collectSprintItemTags: vi.fn(),
  parseReviewFindingMetadata: vi.fn(),
  extractFindingsByLevel: vi.fn(),
  loadPriorGateKnownDebt: vi.fn(),
  buildKnownDebtSection: vi.fn(),
  resolveKnownDebt: vi.fn(),
}));

vi.mock('@agentforge/core', () => ({
  AgentRuntime: vi.fn(function () {
    return { runStreaming: coreMocks.runStreaming };
  }),
  loadAgentConfig: coreMocks.loadAgentConfig,
  writeMemoryEntry: coreMocks.writeMemoryEntry,
  writeKnowledgeEntry: coreMocks.writeKnowledgeEntry,
  collectSprintItemTags: coreMocks.collectSprintItemTags,
  parseReviewFindingMetadata: coreMocks.parseReviewFindingMetadata,
  extractFindingsByLevel: coreMocks.extractFindingsByLevel,
  loadPriorGateKnownDebt: coreMocks.loadPriorGateKnownDebt,
  buildKnownDebtSection: coreMocks.buildKnownDebtSection,
  resolveKnownDebt: coreMocks.resolveKnownDebt,
  runGatePhase: coreMocks.runCoreGatePhase,
  runReviewPhase: coreMocks.runCoreReviewPhase,
}));

vi.mock('@agentforge/shared', () => ({
  generateId: vi.fn(() => 'test-id'),
  nowIso: vi.fn(() => '2026-06-06T12:00:00.000Z'),
}));

vi.mock('../../routes/v5/stream.js', () => ({
  globalStream: { emit: vi.fn() },
}));

const bus = {
  publish: vi.fn(),
};

function writeSprint(root: string, phase: 'review' | 'gate'): void {
  const sprint: SprintFile = {
    sprintId: 'sprint-1',
    version: '1.2.3',
    title: 'Server phase handler test',
    createdAt: '2026-06-06T00:00:00.000Z',
    phase,
    items: [],
    budget: 10,
    teamSize: 1,
    successCriteria: [],
    auditFindings: [],
    phaseResults:
      phase === 'gate'
        ? [
            {
              phase: 'review',
              agentId: 'code-reviewer',
              sessionId: 'review-session',
              response: 'No findings.',
              costUsd: 0,
              inputTokens: 0,
              outputTokens: 0,
              status: 'completed',
              ranAt: '2026-06-06T01:00:00.000Z',
            },
          ]
        : [],
  };
  const dir = join(root, '.agentforge', 'sprints');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'v1.2.3.json'), JSON.stringify(sprint, null, 2));
}

function makeCtx(root: string, phase: 'review' | 'gate', objective?: string): PhaseContext {
  writeSprint(root, phase);
  return {
    sprintId: 'sprint-1',
    sprintVersion: '1.2.3',
    projectRoot: root,
    agentforgeDir: join(root, '.agentforge'),
    bus,
    cycleId: 'cycle-1',
    runtime: { run: vi.fn() },
    adapter: {},
    ...(objective !== undefined ? { objective } : {}),
  };
}

describe('server phase handlers epic delegation', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentforge-server-phase-epic-'));
    bus.publish.mockClear();
    for (const mock of Object.values(coreMocks)) mock.mockReset();

    coreMocks.runCoreReviewPhase.mockResolvedValue({
      phase: 'review',
      status: 'completed',
      durationMs: 1,
      costUsd: 0,
      agentRuns: [],
    });
    coreMocks.runCoreGatePhase.mockResolvedValue({
      phase: 'gate',
      status: 'completed',
      durationMs: 1,
      costUsd: 0.01,
      agentRuns: [],
    });
    coreMocks.loadAgentConfig.mockResolvedValue({
      agentId: 'phase-agent',
      name: 'Phase Agent',
      model: 'claude-sonnet-4-6',
      systemPrompt: 'Run phase.',
      workspaceId: 'default',
    });
    coreMocks.runStreaming.mockResolvedValue({
      response: 'APPROVE',
      costUsd: 0.01,
      inputTokens: 10,
      outputTokens: 5,
      status: 'completed',
    });
    coreMocks.collectSprintItemTags.mockReturnValue([]);
    coreMocks.parseReviewFindingMetadata.mockReturnValue({});
    coreMocks.extractFindingsByLevel.mockReturnValue([]);
    coreMocks.loadPriorGateKnownDebt.mockReturnValue(null);
    coreMocks.buildKnownDebtSection.mockReturnValue('');
    coreMocks.resolveKnownDebt.mockReturnValue([]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('delegates review and gate to core when an objective is present', async () => {
    const { runReviewPhase, runGatePhase } = await import('../phase-handlers.js');
    const objective = 'Build the epic feature end to end';

    await expect(runReviewPhase(makeCtx(root, 'review', objective))).resolves.toMatchObject({
      phase: 'review',
      status: 'completed',
    });
    await expect(runGatePhase(makeCtx(root, 'gate', objective))).resolves.toMatchObject({
      phase: 'gate',
      status: 'completed',
    });

    expect(coreMocks.runCoreReviewPhase).toHaveBeenCalledTimes(1);
    expect(coreMocks.runCoreReviewPhase.mock.calls[0]?.[0]).toMatchObject({ objective });
    expect(coreMocks.runCoreGatePhase).toHaveBeenCalledTimes(1);
    expect(coreMocks.runCoreGatePhase.mock.calls[0]?.[0]).toMatchObject({ objective });
    expect(coreMocks.runStreaming).not.toHaveBeenCalled();
  });

  it('keeps the legacy review and gate paths when objective is absent', async () => {
    const { runReviewPhase, runGatePhase } = await import('../phase-handlers.js');

    await runReviewPhase(makeCtx(root, 'review'));
    await runGatePhase(makeCtx(root, 'gate'));

    expect(coreMocks.runCoreReviewPhase).not.toHaveBeenCalled();
    expect(coreMocks.runCoreGatePhase).not.toHaveBeenCalled();
    expect(coreMocks.runStreaming).toHaveBeenCalledTimes(2);
  });
});
