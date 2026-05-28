import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PhaseContext } from '../../phase-scheduler.js';
import type { ExecutionProviderKind, RuntimeMode } from '../../../runtime/types.js';
import { runExecutePhase } from '../execute-phase.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-execute-routing-options-'));
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeBus() {
  return {
    publish: (_topic: string, _payload: unknown) => {},
    subscribe: (_topic: string, _cb: (event: unknown) => void) => () => {},
  };
}

function makeCtx(runtime: unknown): PhaseContext {
  return {
    projectRoot: tmpRoot,
    sprintId: 'sprint-routing-1',
    sprintVersion: '1.0.0',
    cycleId: 'cycle-routing-1',
    adapter: undefined as never,
    bus: makeBus(),
    runtime,
  } as PhaseContext;
}

function writeSprintFile(
  items: Array<{
    id: string;
    title: string;
    assignee: string;
    runtimeMode?: RuntimeMode;
    preferredProvider?: ExecutionProviderKind;
  }>,
) {
  const data = {
    version: '1.0.0',
    sprintId: 'sprint-routing-1',
    items: items.map((item) => ({
      ...item,
      status: 'planned',
      description: `Description for ${item.title}`,
      tags: ['routing'],
    })),
  };
  const cycleDir = join(tmpRoot, '.agentforge', 'cycles', 'cycle-routing-1');
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(join(cycleDir, 'plan.json'), JSON.stringify(data));
}

describe('execute-phase runtime routing options', () => {
  it('forwards item-level runtimeMode and preferredProvider only when present', async () => {
    writeSprintFile([
      {
        id: 'item-routed',
        title: 'Route this item through Codex',
        assignee: 'coder',
        runtimeMode: 'codex-cli',
        preferredProvider: 'codex-cli',
      },
      {
        id: 'item-default',
        title: 'Use default runtime routing',
        assignee: 'backend-dev',
      },
    ]);

    const runtime = {
      run: vi.fn().mockResolvedValue({
        output: 'done',
        costUsd: 0.01,
        status: 'completed',
      }),
    };

    await runExecutePhase(makeCtx(runtime), {
      maxParallelism: 1,
      maxItemRetries: 0,
      disableWorktrees: true,
      selfEvalDisabled: true,
    });

    expect(runtime.run).toHaveBeenCalledTimes(2);

    const routedOptions = runtime.run.mock.calls[0]![2] as Record<string, unknown>;
    expect(routedOptions).toMatchObject({
      runtimeMode: 'codex-cli',
      preferredProvider: 'codex-cli',
    });

    const defaultOptions = runtime.run.mock.calls[1]![2] as Record<string, unknown>;
    expect(defaultOptions).not.toHaveProperty('runtimeMode');
    expect(defaultOptions).not.toHaveProperty('preferredProvider');
  });
});
