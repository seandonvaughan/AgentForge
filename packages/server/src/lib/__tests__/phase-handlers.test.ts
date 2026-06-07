import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const coreMocks = vi.hoisted(() => ({
  loadAgentConfig: vi.fn(),
  runCoreGatePhase: vi.fn(),
  runCoreReviewPhase: vi.fn(),
  runStreaming: vi.fn(),
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
  AgentRuntime: class {
    runStreaming = coreMocks.runStreaming;
  },
  loadAgentConfig: coreMocks.loadAgentConfig,
  runGatePhase: coreMocks.runCoreGatePhase,
  runReviewPhase: coreMocks.runCoreReviewPhase,
  writeMemoryEntry: coreMocks.writeMemoryEntry,
  writeKnowledgeEntry: coreMocks.writeKnowledgeEntry,
  collectSprintItemTags: coreMocks.collectSprintItemTags,
  parseReviewFindingMetadata: coreMocks.parseReviewFindingMetadata,
  extractFindingsByLevel: coreMocks.extractFindingsByLevel,
  loadPriorGateKnownDebt: coreMocks.loadPriorGateKnownDebt,
  buildKnownDebtSection: coreMocks.buildKnownDebtSection,
  resolveKnownDebt: coreMocks.resolveKnownDebt,
}));

import type { PhaseContext } from '../phase-handlers.js';
import { runGatePhase, runReviewPhase } from '../phase-handlers.js';

function writeMinimalSprint(root: string, version = '1.0.0'): void {
  const sprintsDir = join(root, '.agentforge', 'sprints');
  mkdirSync(sprintsDir, { recursive: true });
  writeFileSync(
    join(sprintsDir, `v${version}.json`),
    JSON.stringify(
      {
        sprintId: 'sprint-1',
        version,
        title: 'Test sprint',
        createdAt: '2026-06-06T00:00:00.000Z',
        phase: 'review',
        items: [],
        budget: 100,
        teamSize: 1,
        successCriteria: [],
        auditFindings: [],
      },
      null,
      2,
    ),
  );
}

function makeCtx(root: string, overrides: Partial<PhaseContext> & { objective?: string } = {}) {
  return {
    sprintId: 'sprint-1',
    sprintVersion: '1.0.0',
    projectRoot: root,
    agentforgeDir: join(root, '.agentforge'),
    bus: { publish: vi.fn() },
    ...overrides,
  } as PhaseContext & { objective?: string };
}

describe('server phase handlers epic path delegation', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentforge-server-phase-handlers-'));
    writeMinimalSprint(root);

    coreMocks.loadAgentConfig.mockResolvedValue({});
    coreMocks.runCoreGatePhase.mockResolvedValue({
      phase: 'gate',
      status: 'completed',
      durationMs: 1,
      costUsd: 0,
      agentRuns: [],
    });
    coreMocks.runCoreReviewPhase.mockResolvedValue({
      phase: 'review',
      status: 'completed',
      durationMs: 1,
      costUsd: 0,
      agentRuns: [],
    });
    coreMocks.runStreaming.mockResolvedValue({
      status: 'completed',
      response: 'APPROVE',
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      sessionId: 'session-1',
    });
    coreMocks.collectSprintItemTags.mockReturnValue([]);
    coreMocks.parseReviewFindingMetadata.mockReturnValue({});
    coreMocks.extractFindingsByLevel.mockReturnValue([]);
    coreMocks.loadPriorGateKnownDebt.mockReturnValue([]);
    coreMocks.buildKnownDebtSection.mockReturnValue('');
    coreMocks.resolveKnownDebt.mockReturnValue([]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('delegates review to the core epic skip only when an objective is present', async () => {
    await runReviewPhase(makeCtx(root, { objective: 'Build the widget feature' }));

    expect(coreMocks.runCoreReviewPhase).toHaveBeenCalledTimes(1);
    expect(coreMocks.runCoreReviewPhase).toHaveBeenCalledWith(
      expect.objectContaining({ objective: 'Build the widget feature' }),
    );
    expect(coreMocks.runStreaming).not.toHaveBeenCalled();

    vi.clearAllMocks();
    await runReviewPhase(makeCtx(root));

    expect(coreMocks.runCoreReviewPhase).not.toHaveBeenCalled();
    expect(coreMocks.runStreaming).toHaveBeenCalledTimes(1);
  });

  it('delegates gate to the core epic review only when an objective is present', async () => {
    await runGatePhase(makeCtx(root, { objective: 'Build the widget feature' }));

    expect(coreMocks.runCoreGatePhase).toHaveBeenCalledTimes(1);
    expect(coreMocks.runCoreGatePhase).toHaveBeenCalledWith(
      expect.objectContaining({ objective: 'Build the widget feature' }),
    );
    expect(coreMocks.runStreaming).not.toHaveBeenCalled();

    vi.clearAllMocks();
    await runGatePhase(makeCtx(root));

    expect(coreMocks.runCoreGatePhase).not.toHaveBeenCalled();
    expect(coreMocks.runStreaming).toHaveBeenCalledTimes(1);
  });
});
