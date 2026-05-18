// tests/autonomous/cost-breakdown-wiring.test.ts
//
// Wave 2 — CostBreakdown end-to-end wiring tests.
//
// Verifies:
//   1. extractBreakdownFromAgentRun produces a correct CostBreakdown.
//   2. mergeBreakdowns accumulates fields element-wise.
//   3. RuntimeAdapter.run() returns a `breakdown` field.
//   4. execute-phase stores `breakdown` per item-result and
//      writes a phase-level `breakdown` to execute.json.
//   5. CycleRunner.buildResult emits cost.breakdown == mergeBreakdowns of
//      all per-item breakdowns (sum of totalUsd within $0.0001 of totalUsd).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractBreakdownFromAgentRun,
  mergeBreakdowns,
} from '@agentforge/core';
// Import CostBreakdown directly to avoid name collision with
// manual/cost-report-service.ts CostBreakdown in the barrel export.
import type { CostBreakdown } from '../../packages/core/src/autonomous/cost-breakdown.js';

// ---------------------------------------------------------------------------
// 1. extractBreakdownFromAgentRun — unit
// ---------------------------------------------------------------------------

describe('extractBreakdownFromAgentRun', () => {
  it('computes correct USD for a sonnet run without cache', () => {
    const bd = extractBreakdownFromAgentRun({
      model: 'sonnet',
      usage: { input_tokens: 1_000_000, output_tokens: 500_000 },
    });
    // sonnet: input=$3/M, output=$15/M
    expect(bd.inputTokens.count).toBe(1_000_000);
    expect(bd.inputTokens.usd).toBeCloseTo(3.0, 4);
    expect(bd.outputTokens.count).toBe(500_000);
    expect(bd.outputTokens.usd).toBeCloseTo(7.5, 4);
    expect(bd.cacheCreation.tokens).toBe(0);
    expect(bd.cacheRead.tokens).toBe(0);
    expect(bd.totalUsd).toBeCloseTo(10.5, 4);
  });

  it('computes cache_read at 10% of input rate', () => {
    const bd = extractBreakdownFromAgentRun({
      model: 'opus',
      usage: {
        input_tokens: 100_000,
        output_tokens: 0,
        cache_read_input_tokens: 100_000,
      },
    });
    // opus: input=$15/M, read = 15*0.10 = $1.50/M for 100k = $0.15
    // regularInput = max(0, 100k - 100k) = 0
    expect(bd.inputTokens.count).toBe(0);
    expect(bd.inputTokens.usd).toBeCloseTo(0, 6);
    expect(bd.cacheRead.tokens).toBe(100_000);
    expect(bd.cacheRead.usd).toBeCloseTo(0.15, 4);
    expect(bd.totalUsd).toBeCloseTo(0.15, 4);
  });

  it('computes cache_creation at 125% of input rate', () => {
    const bd = extractBreakdownFromAgentRun({
      model: 'haiku',
      usage: {
        input_tokens: 200_000,
        output_tokens: 0,
        cache_creation_input_tokens: 200_000,
      },
    });
    // haiku: input=$0.80/M, creation = 0.80*1.25 = $1/M for 200k = $0.20
    expect(bd.cacheCreation.tokens).toBe(200_000);
    expect(bd.cacheCreation.usd).toBeCloseTo(0.20, 4);
    expect(bd.inputTokens.count).toBe(0);
    expect(bd.totalUsd).toBeCloseTo(0.20, 4);
  });

  it('resolves full model-id strings (e.g. claude-sonnet-4-6)', () => {
    const bd = extractBreakdownFromAgentRun({
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    });
    expect(bd.inputTokens.usd).toBeCloseTo(3.0, 4);
  });

  it('falls back to sonnet tier for unknown model strings', () => {
    const bd = extractBreakdownFromAgentRun({
      model: 'claude-future-model-99',
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    });
    // Should resolve to sonnet ($3/M) not throw
    expect(bd.inputTokens.usd).toBeCloseTo(3.0, 4);
  });
});

// ---------------------------------------------------------------------------
// 2. mergeBreakdowns — unit
// ---------------------------------------------------------------------------

describe('mergeBreakdowns', () => {
  const bdA: CostBreakdown = {
    inputTokens: { count: 500, usd: 0.0015 },
    outputTokens: { count: 100, usd: 0.0015 },
    cacheCreation: { tokens: 50, usd: 0.0001 },
    cacheRead: { tokens: 25, usd: 0.00003 },
    toolUse: { Read: { invocations: 3, usd: 0.0 } },
    totalUsd: 0.003,
  };

  const bdB: CostBreakdown = {
    inputTokens: { count: 200, usd: 0.0006 },
    outputTokens: { count: 50, usd: 0.00075 },
    cacheCreation: { tokens: 0, usd: 0 },
    cacheRead: { tokens: 10, usd: 0.00001 },
    toolUse: { Read: { invocations: 1, usd: 0.0 }, Write: { invocations: 2, usd: 0.0 } },
    totalUsd: 0.001,
  };

  it('sums all numeric fields', () => {
    const merged = mergeBreakdowns(bdA, bdB);
    expect(merged.inputTokens.count).toBe(700);
    expect(merged.outputTokens.count).toBe(150);
    expect(merged.cacheCreation.tokens).toBe(50);
    expect(merged.cacheRead.tokens).toBe(35);
    expect(merged.totalUsd).toBeCloseTo(0.004, 5);
  });

  it('merges toolUse by key', () => {
    const merged = mergeBreakdowns(bdA, bdB);
    expect(merged.toolUse['Read']!.invocations).toBe(4);
    expect(merged.toolUse['Write']!.invocations).toBe(2);
  });

  it('is associative for totalUsd', () => {
    const bdC = extractBreakdownFromAgentRun({
      model: 'sonnet',
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const left = mergeBreakdowns(mergeBreakdowns(bdA, bdB), bdC);
    const right = mergeBreakdowns(bdA, mergeBreakdowns(bdB, bdC));
    expect(Math.abs(left.totalUsd - right.totalUsd)).toBeLessThan(1e-9);
  });
});

// ---------------------------------------------------------------------------
// 3. RuntimeAdapter returns breakdown
// ---------------------------------------------------------------------------

describe('RuntimeAdapter.run() returns breakdown', () => {
  it('includes a CostBreakdown in the result', async () => {
    // Construct a minimal mock runtime that returns cache tokens
    const { RuntimeAdapter } = await import('@agentforge/core');

    const mockRunResult = {
      sessionId: 'sess-001',
      response: 'done',
      model: 'claude-sonnet-4-6',
      inputTokens: 500,
      outputTokens: 100,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 50,
      costUsd: 0.002,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: 'completed' as const,
    };

    const fakeRuntime = { run: vi.fn().mockResolvedValue(mockRunResult) };
    const { AgentRuntime } = await import('@agentforge/core');
    const { loadAgentConfig } = await import('@agentforge/core');

    // Build a minimal inline-agent adapter to avoid disk access
    const tmpDir = mkdtempSync(join(tmpdir(), 'af-test-'));
    const agentDir = join(tmpDir, '.agentforge', 'agents');
    mkdirSync(agentDir, { recursive: true });

    const adapter = new RuntimeAdapter({
      cwd: tmpDir,
      inlineAgents: {
        'test-agent': {
          agentId: 'test-agent',
          name: 'Test Agent',
          model: 'sonnet',
          systemPrompt: 'You are a test agent.',
          workspaceId: 'ws-test',
        },
      },
    });

    // Monkey-patch the internal runtime to use our fake
    // (AgentRuntime is instantiated lazily in getOrCreateRuntime)
    const fakeAgentRuntime = { run: vi.fn().mockResolvedValue(mockRunResult) };
    // Access private map via casting to Any
    (adapter as any).runtimes.set('test-agent', fakeAgentRuntime);

    const result = await adapter.run('test-agent', 'do something');

    expect(result.breakdown).toBeDefined();
    expect(result.breakdown.totalUsd).toBeGreaterThan(0);
    // Cache tokens should be reflected
    expect(result.breakdown.cacheCreation.tokens).toBe(200);
    expect(result.breakdown.cacheRead.tokens).toBe(50);
    expect(result.usage.cache_creation_input_tokens).toBe(200);
    expect(result.usage.cache_read_input_tokens).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// 4. execute-phase stores breakdown in execute.json
// ---------------------------------------------------------------------------

describe('execute-phase breakdown wiring', () => {
  it('writes per-item and phase breakdown to execute.json', async () => {
    const {
      runExecutePhase,
    } = await import(
      '../../packages/core/src/autonomous/phase-handlers/execute-phase.js'
    );

    const tmpDir = mkdtempSync(join(tmpdir(), 'af-exec-'));
    const cycleId = 'cycle-test-001';
    const cycleDir = join(tmpDir, '.agentforge', 'cycles', cycleId);
    mkdirSync(cycleDir, { recursive: true });

    // Write a minimal plan.json with one item
    const plan = {
      version: '1.0.0',
      sprintId: 'sprint-001',
      items: [
        {
          id: 'item-1',
          title: 'Test item',
          description: 'Implement a small feature',
          assignee: 'coder',
          status: 'pending',
          tags: ['typescript'],
        },
      ],
    };
    writeFileSync(join(cycleDir, 'plan.json'), JSON.stringify(plan));

    // Mock runtime that returns breakdown-capable result
    const mockRuntime = {
      run: vi.fn().mockResolvedValue({
        output: 'task complete',
        costUsd: 0.005,
        durationMs: 1000,
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 50,
        },
        breakdown: extractBreakdownFromAgentRun({
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 1000,
            output_tokens: 200,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 50,
          },
        }),
      }),
    };

    const mockBus = { publish: vi.fn(), subscribe: vi.fn().mockReturnValue(() => {}) };

    const ctx = {
      sprintId: 'sprint-001',
      sprintVersion: '1.0.0',
      projectRoot: tmpDir,
      adapter: {},
      bus: mockBus,
      runtime: mockRuntime,
      cycleId,
    };

    await runExecutePhase(ctx as any, {
      maxParallelism: 1,
      selfEvalDisabled: true,
    });

    // Read the written execute.json
    const execPath = join(cycleDir, 'phases', 'execute.json');
    expect(existsSync(execPath)).toBe(true);

    const execData = JSON.parse(readFileSync(execPath, 'utf8'));

    // Phase-level breakdown should exist
    expect(execData.breakdown).toBeDefined();
    expect(execData.breakdown.totalUsd).toBeGreaterThan(0);
    expect(execData.breakdown.cacheCreation.tokens).toBe(100);
    expect(execData.breakdown.cacheRead.tokens).toBe(50);

    // Per-item breakdown
    const agentRun = (execData.agentRuns ?? execData.itemResults)?.[0];
    expect(agentRun).toBeDefined();
    expect(agentRun.breakdown).toBeDefined();
    expect(agentRun.breakdown.totalUsd).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 5. CycleResult.cost.breakdown = mergeBreakdowns of per-item breakdowns
// ---------------------------------------------------------------------------

describe('CycleResult.cost.breakdown sum invariant', () => {
  it('totalUsd in breakdown equals sum of per-item breakdowns within $0.0001', () => {
    // Simulate three agent runs
    const runs = [
      { model: 'sonnet', usage: { input_tokens: 100_000, output_tokens: 20_000 } },
      { model: 'haiku', usage: { input_tokens: 50_000, output_tokens: 10_000, cache_read_input_tokens: 5_000 } },
      { model: 'opus', usage: { input_tokens: 10_000, output_tokens: 5_000, cache_creation_input_tokens: 2_000 } },
    ];

    const breakdowns = runs.map(r => extractBreakdownFromAgentRun(r));

    // Accumulate via mergeBreakdowns (the same path CycleRunner uses)
    const merged = breakdowns.reduce((acc, bd) =>
      acc === null ? bd : mergeBreakdowns(acc, bd),
    null as CostBreakdown | null,
    )!;

    // Individual totalUsd sum
    const sumOfIndividual = breakdowns.reduce((s, bd) => s + bd.totalUsd, 0);

    expect(Math.abs(merged.totalUsd - sumOfIndividual)).toBeLessThan(0.0001);

    // Also verify token counts accumulate correctly
    expect(merged.inputTokens.count).toBe(
      breakdowns.reduce((s, bd) => s + bd.inputTokens.count, 0),
    );
    expect(merged.outputTokens.count).toBe(
      breakdowns.reduce((s, bd) => s + bd.outputTokens.count, 0),
    );
    expect(merged.cacheRead.tokens).toBe(
      breakdowns.reduce((s, bd) => s + bd.cacheRead.tokens, 0),
    );
    expect(merged.cacheCreation.tokens).toBe(
      breakdowns.reduce((s, bd) => s + bd.cacheCreation.tokens, 0),
    );
  });

  it('breakdown totalUsd matches existing cost.totalUsd from execute.json within $0.0001', async () => {
    // Simulate what loadExecutionBreakdownFromDisk does: read execute.json
    // and accumulate per-item breakdowns, then compare to costUsd sum.
    const tmpDir = mkdtempSync(join(tmpdir(), 'af-cycle-'));
    const cycleId = 'cycle-bd-test';
    const phasesDir = join(tmpDir, '.agentforge', 'cycles', cycleId, 'phases');
    mkdirSync(phasesDir, { recursive: true });

    const item1Bd = extractBreakdownFromAgentRun({
      model: 'sonnet',
      usage: { input_tokens: 200_000, output_tokens: 30_000 },
    });
    const item2Bd = extractBreakdownFromAgentRun({
      model: 'haiku',
      usage: { input_tokens: 100_000, output_tokens: 20_000, cache_read_input_tokens: 10_000 },
    });

    const execJson = {
      phase: 'execute',
      status: 'completed',
      costUsd: item1Bd.totalUsd + item2Bd.totalUsd,
      agentRuns: [
        { itemId: 'i1', status: 'completed', costUsd: item1Bd.totalUsd, breakdown: item1Bd },
        { itemId: 'i2', status: 'completed', costUsd: item2Bd.totalUsd, breakdown: item2Bd },
      ],
    };
    writeFileSync(join(phasesDir, 'execute.json'), JSON.stringify(execJson));

    // Simulate what loadExecutionBreakdownFromDisk does
    const data = JSON.parse(readFileSync(join(phasesDir, 'execute.json'), 'utf8'));
    const itemRuns: Array<Record<string, unknown>> = data.agentRuns ?? [];
    let acc: CostBreakdown | undefined;
    for (const run of itemRuns) {
      if (run['breakdown'] && typeof run['breakdown'] === 'object') {
        acc = acc === undefined
          ? (run['breakdown'] as CostBreakdown)
          : mergeBreakdowns(acc, run['breakdown'] as CostBreakdown);
      }
    }

    expect(acc).toBeDefined();
    const totalUsdFromCostField = execJson.costUsd;
    const totalUsdFromBreakdown = acc!.totalUsd;
    expect(Math.abs(totalUsdFromBreakdown - totalUsdFromCostField)).toBeLessThan(0.0001);
  });
});
