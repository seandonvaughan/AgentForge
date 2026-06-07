import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PhaseContext, SprintFile } from '../phase-handlers.js';

const mocks = vi.hoisted(() => ({
  runStreaming: vi.fn(),
}));

vi.mock('@agentforge/core', async () => {
  const real = await vi.importActual<typeof import('@agentforge/core')>('@agentforge/core');
  return {
    ...real,
    AgentRuntime: vi.fn(function () {
      return {
        runStreaming: mocks.runStreaming,
      };
    }),
    loadAgentConfig: vi.fn().mockImplementation(async (agentId: string) => ({
      agentId,
      name: agentId,
      model: 'sonnet',
      systemPrompt: 'mock system prompt',
      workspaceId: 'default',
    })),
  };
});

vi.mock('../../routes/v5/stream.js', () => ({
  globalStream: {
    emit: vi.fn(),
  },
}));

import { runGatePhase, runReviewPhase, type EventBus } from '../phase-handlers.js';

const cycleId = 'cycle-server-epic';
let tmpRoot: string;

function phasesDir(): string {
  return join(tmpRoot, '.agentforge', 'cycles', cycleId, 'phases');
}

function makeBus(): EventBus {
  return { publish: vi.fn() };
}

function makeCtx(objective?: string): PhaseContext {
  return {
    sprintId: 'sprint-server-epic',
    sprintVersion: '1.2.3',
    projectRoot: tmpRoot,
    agentforgeDir: join(tmpRoot, '.agentforge'),
    bus: makeBus(),
    cycleId,
    ...(objective !== undefined ? { objective } : {}),
    baseBranch: 'main',
    runtime: {
      run: async (agentId: string, task: string, opts: unknown) => {
        void agentId;
        void task;
        void opts;
        return {
          output: JSON.stringify({
            verdict: 'APPROVE',
            rationale: 'epic objective satisfied',
            faultedItems: [],
          }),
          costUsd: 0.25,
          schemaValidation: { ok: true },
        };
      },
    },
  } as PhaseContext & {
    objective?: string;
    baseBranch: string;
    runtime: { run: (agentId: string, task: string, opts: unknown) => Promise<unknown> };
  };
}

function writeSprint(phase: string): void {
  mkdirSync(join(tmpRoot, '.agentforge', 'sprints'), { recursive: true });
  const sprint: SprintFile = {
    sprintId: 'sprint-server-epic',
    version: '1.2.3',
    title: 'Server epic phase handlers',
    createdAt: '2026-06-06T00:00:00.000Z',
    phase,
    items: [
      {
        id: 'item-1',
        title: 'Wire epic review',
        description: 'Delegate server phase handlers',
        priority: 'P1',
        assignee: 'backend',
        status: 'completed',
        tags: ['server-phase-handlers', 'epic-review'],
      },
    ],
    budget: 10,
    teamSize: 1,
    successCriteria: ['epic review artifact exists'],
    auditFindings: [],
    agentsInvolved: [],
    budgetUsed: 0,
    phaseResults: [
      {
        phase: 'test',
        agentId: 'backend-qa',
        sessionId: 'test-session',
        response: 'tests passed',
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        status: 'completed',
        ranAt: '2026-06-06T00:00:00.000Z',
      },
    ],
  };
  writeFileSync(
    join(tmpRoot, '.agentforge', 'sprints', 'v1.2.3.json'),
    JSON.stringify(sprint, null, 2),
    'utf8',
  );
}

function writeEpicCycleFiles(): void {
  mkdirSync(join(tmpRoot, '.agentforge', 'cycles', cycleId), { recursive: true });
  writeFileSync(
    join(tmpRoot, '.agentforge', 'cycles', cycleId, 'plan.json'),
    JSON.stringify({
      items: [
        {
          id: 'item-1',
          title: 'Wire epic review',
          description: 'Delegate server phase handlers',
          files: ['packages/server/src/lib/phase-handlers.ts'],
          status: 'completed',
        },
      ],
    }),
    'utf8',
  );
  mkdirSync(phasesDir(), { recursive: true });
  writeFileSync(
    join(phasesDir(), 'execute.json'),
    JSON.stringify({
      phase: 'execute',
      status: 'completed',
      epicIntegration: { branch: 'codex/epic-server', epicId: 'epic-server' },
    }),
    'utf8',
  );
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-server-epic-'));
  mkdirSync(join(tmpRoot, '.agentforge', 'agents'), { recursive: true });
  mocks.runStreaming.mockReset();
  mocks.runStreaming.mockResolvedValue({
    sessionId: 'legacy-session',
    response: 'APPROVE legacy path',
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.01,
    status: 'completed',
  });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('server phase handlers epic path', () => {
  it('delegates gate to core epic review when objective is present and writes the epic verdict', async () => {
    writeSprint('gate');
    writeEpicCycleFiles();

    const ctx = makeCtx('Ship the server epic review path');
    const result = await runGatePhase(ctx);

    expect(result.status).toBe('completed');
    expect(result.costUsd).toBe(0.25);
    expect(mocks.runStreaming).not.toHaveBeenCalled();

    const artifact = JSON.parse(readFileSync(join(phasesDir(), 'epic-review.json'), 'utf8'));
    expect(artifact.mode).toBe('epic-review');
    expect(artifact.verdict).toBe('APPROVE');
    expect(artifact.rationale).toBe('epic objective satisfied');

    const gateJson = JSON.parse(readFileSync(join(phasesDir(), 'gate.json'), 'utf8'));
    expect(gateJson.mode).toBe('epic-review');
    expect(gateJson.verdict).toBe('APPROVE');
  });

  it('delegates review to the core epic skip when objective is present', async () => {
    writeSprint('review');

    const result = await runReviewPhase(makeCtx('Ship the server epic review path'));

    expect(result.status).toBe('completed');
    expect(result.costUsd).toBe(0);
    expect(result.agentRuns).toEqual([]);
    expect(mocks.runStreaming).not.toHaveBeenCalled();

    const reviewJson = JSON.parse(readFileSync(join(phasesDir(), 'review.json'), 'utf8'));
    expect(reviewJson.skipped).toBe(true);
    expect(reviewJson.reason).toContain('epic path');
  });

  it('keeps the legacy server LLM path when objective is absent', async () => {
    writeSprint('review');

    const reviewResult = await runReviewPhase(makeCtx());
    const gateResult = await runGatePhase(makeCtx());

    expect(reviewResult.status).toBe('completed');
    expect(gateResult.status).toBe('completed');
    expect(mocks.runStreaming).toHaveBeenCalledTimes(2);
    expect(existsSync(join(phasesDir(), 'epic-review.json'))).toBe(false);
  });
});
