import { describe, expect, it, vi } from 'vitest';
import { AutopilotBudgetError, CostAutopilot } from '../cost-autopilot.js';
import type { ModelTier, TaskExecutor } from '../cost-autopilot.js';

const COST_BY_MODEL: Record<ModelTier, number> = {
  haiku: 0.001,
  sonnet: 0.003,
  opus: 0.015,
};

function makeExecutor(calls: ModelTier[] = []): TaskExecutor {
  return async (_task, model) => {
    calls.push(model);
    return {
      response: { model },
      costUsd: COST_BY_MODEL[model],
    };
  };
}

describe('CostAutopilot', () => {
  it('fails closed before dispatch when no model fits maxCostUsd', async () => {
    const executor = vi.fn(makeExecutor());
    const autopilot = new CostAutopilot(executor);

    await expect(
      autopilot.process({ task: 'Summarize this diff', complexity: 'low', maxCostUsd: 0.0005 }, executor),
    ).rejects.toBeInstanceOf(AutopilotBudgetError);

    expect(executor).not.toHaveBeenCalled();
    expect(autopilot.getStats().budgetBlocks).toBe(1);
  });

  it('downgrades to the highest affordable model tier under a cap', async () => {
    const calls: ModelTier[] = [];
    const executor = makeExecutor(calls);
    const autopilot = new CostAutopilot(executor);

    const result = await autopilot.process(
      { task: 'Design a migration plan', complexity: 'high', maxCostUsd: 0.003 },
      executor,
    );

    expect(calls).toEqual(['sonnet']);
    expect(result.model).toBe('sonnet');
    expect(result.autopilot?.decision).toMatchObject({
      baselineModel: 'opus',
      model: 'sonnet',
      downgraded: true,
      budgetConstrained: true,
    });
    expect(autopilot.getStats().budgetDowngrades).toBe(1);
  });

  it('prunes duplicate in-flight invocations with the same trace fingerprint', async () => {
    const calls: ModelTier[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor: TaskExecutor = async (_task, model) => {
      calls.push(model);
      await gate;
      return { response: { ok: true, model }, costUsd: COST_BY_MODEL[model] };
    };
    const autopilot = new CostAutopilot(executor);
    const ctx = {
      task: 'Generate cost report',
      complexity: 'medium' as const,
      trace: { cycleId: 'cycle-1', phase: 'synthesis', taskFingerprint: 'report-v1' },
    };

    const first = autopilot.process(ctx, executor);
    const second = autopilot.process(ctx, executor);

    expect(calls).toEqual(['sonnet']);
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.costUsd).toBe(COST_BY_MODEL.sonnet);
    expect(secondResult).toMatchObject({
      costUsd: 0,
      fromCache: true,
      pruned: true,
      model: 'sonnet',
    });
    expect(autopilot.getStats().redundantInvocationsPruned).toBe(1);
  });

  it('keeps traced cache entries isolated by task fingerprint', async () => {
    const calls: ModelTier[] = [];
    const executor = makeExecutor(calls);
    const autopilot = new CostAutopilot(executor);

    await autopilot.process(
      {
        task: 'Summarize build output',
        complexity: 'low',
        trace: { cycleId: 'cycle-1', phase: 'verify', taskFingerprint: 'build-a' },
      },
      executor,
    );
    await autopilot.process(
      {
        task: 'Summarize build output',
        complexity: 'low',
        trace: { cycleId: 'cycle-1', phase: 'verify', taskFingerprint: 'build-b' },
      },
      executor,
    );

    expect(calls).toEqual(['haiku', 'haiku']);
    expect(autopilot.getStats().cacheHits).toBe(0);
  });

  it('passes the selected model tier through batched execution', async () => {
    const calls: ModelTier[] = [];
    const autopilot = new CostAutopilot(makeExecutor(calls), {
      batch: { windowMs: 1, maxBatch: 1 },
    });

    const result = await autopilot.process({
      task: 'Fix typo in docs',
      complexity: 'low',
      allowBatching: true,
    });

    expect(calls).toEqual(['haiku']);
    expect(result.model).toBe('haiku');
    expect(result.autopilot?.decision.model).toBe('haiku');
  });
});

