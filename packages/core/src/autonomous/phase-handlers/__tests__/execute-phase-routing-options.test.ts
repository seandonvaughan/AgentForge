import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PhaseContext } from '../../phase-scheduler.js';
import type { ExecutionProviderKind, RuntimeMode } from '../../../runtime/types.js';
import type { ModelTier } from '@agentforge/shared';
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
    providerPreference?: ExecutionProviderKind[];
    tier?: ModelTier;
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

  it('forwards the item-level providerPreference failover chain only when present', async () => {
    writeSprintFile([
      {
        id: 'item-chain',
        title: 'Item carrying an explicit provider failover chain',
        assignee: 'coder',
        providerPreference: ['codex-cli', 'claude-code-compat'],
      },
      {
        id: 'item-nochain',
        title: 'Item with no chain',
        assignee: 'backend-dev',
      },
    ]);

    const runtime = {
      run: vi.fn().mockResolvedValue({ output: 'done', costUsd: 0.01, status: 'completed' }),
    };

    await runExecutePhase(makeCtx(runtime), {
      maxParallelism: 1,
      maxItemRetries: 0,
      disableWorktrees: true,
      selfEvalDisabled: true,
    });

    expect(runtime.run).toHaveBeenCalledTimes(2);
    const withChain = runtime.run.mock.calls[0]![2] as Record<string, unknown>;
    expect(withChain.providerPreference).toEqual(['codex-cli', 'claude-code-compat']);

    const withoutChain = runtime.run.mock.calls[1]![2] as Record<string, unknown>;
    expect(withoutChain).not.toHaveProperty('providerPreference');
  });

  it('persists resolved provider/model/effort in execute artifacts using runtime-returned values', async () => {
    writeSprintFile([
      {
        id: 'item-fallback-provider',
        title: 'Requested provider unavailable should fallback',
        assignee: 'coder',
        runtimeMode: 'auto',
        preferredProvider: 'codex-cli',
      },
      {
        id: 'item-anthropic-provider',
        title: 'Second item resolves to different transport',
        assignee: 'backend-dev',
        runtimeMode: 'sdk',
        preferredProvider: 'anthropic-sdk',
      },
    ]);

    const runtime = {
      run: vi.fn(async (_agentId: string, _task: string, options?: {
        preferredProvider?: ExecutionProviderKind;
      }) => {
        if (options?.preferredProvider === 'codex-cli') {
          return {
            output: 'fell back to OpenAI transport',
            costUsd: 0.02,
            model: 'gpt-5-codex',
            effort: 'high',
            resolvedProvider: 'openai-sdk' as const,
            resolvedRuntimeMode: 'sdk' as const,
            status: 'completed' as const,
          };
        }
        return {
          output: 'used Anthropic transport',
          costUsd: 0.03,
          model: 'claude-sonnet-4-6',
          effort: 'medium',
          resolvedProvider: 'anthropic-sdk' as const,
          resolvedRuntimeMode: 'sdk' as const,
          status: 'completed' as const,
        };
      }),
    };

    await runExecutePhase(makeCtx(runtime), {
      maxParallelism: 1,
      maxItemRetries: 0,
      disableWorktrees: true,
      selfEvalDisabled: true,
    });

    const executeArtifactPath = join(
      tmpRoot,
      '.agentforge',
      'cycles',
      'cycle-routing-1',
      'phases',
      'execute.json',
    );
    const executeArtifact = JSON.parse(readFileSync(executeArtifactPath, 'utf8')) as {
      itemResults: Array<{
        itemId: string;
        resolvedProvider?: string;
        resolvedRuntimeMode?: string;
        resolvedModelId?: string;
        resolvedEffort?: string;
      }>;
    };
    const byId = new Map(executeArtifact.itemResults.map((row) => [row.itemId, row]));

    expect(runtime.run).toHaveBeenCalledTimes(2);
    expect(byId.get('item-fallback-provider')).toMatchObject({
      resolvedProvider: 'openai-sdk',
      resolvedRuntimeMode: 'sdk',
      resolvedModelId: 'gpt-5-codex',
      resolvedEffort: 'high',
    });
    expect(byId.get('item-fallback-provider')?.resolvedProvider).not.toBe('codex-cli');
    expect(byId.get('item-anthropic-provider')).toMatchObject({
      resolvedProvider: 'anthropic-sdk',
      resolvedRuntimeMode: 'sdk',
      resolvedModelId: 'claude-sonnet-4-6',
      resolvedEffort: 'medium',
    });
  });

  it('forwards item.tier as capabilityTier only when it is a valid ModelTier', async () => {
    writeSprintFile([
      {
        id: 'item-tiered',
        title: 'Item with assign-phase tier set to haiku',
        assignee: 'coder',
        tier: 'haiku',
      },
      {
        id: 'item-nottiered',
        title: 'Item with no tier',
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

    // First call: item with tier: 'haiku' → capabilityTier must be 'haiku'
    const tieredOptions = runtime.run.mock.calls[0]![2] as Record<string, unknown>;
    expect(tieredOptions.capabilityTier).toBe('haiku');

    // Second call: item with no tier → capabilityTier must be absent
    const untieredOptions = runtime.run.mock.calls[1]![2] as Record<string, unknown>;
    expect(untieredOptions).not.toHaveProperty('capabilityTier');
  });
});
