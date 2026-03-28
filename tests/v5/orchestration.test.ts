import { describe, it, expect } from 'vitest';
import { WorkflowRunner } from '../../packages/core/src/orchestration/index.js';
import type { WorkflowDefinition } from '../../packages/core/src/orchestration/index.js';

const simpleWorkflow: WorkflowDefinition = {
  id: 'wf-simple',
  name: 'Simple Sequential',
  steps: [
    { type: 'agent', id: 's1', agentId: 'coder', task: 'Write unit tests for auth module' },
    { type: 'agent', id: 's2', agentId: 'linter', task: 'Lint the generated code' },
  ],
};

const parallelWorkflow: WorkflowDefinition = {
  id: 'wf-parallel',
  name: '10-Agent Parallel Fan-out',
  budgetUsd: 10,
  steps: [
    {
      type: 'parallel',
      id: 'p1',
      steps: Array.from({ length: 10 }, (_, i) => ({
        type: 'agent' as const,
        id: `agent-${i}`,
        agentId: 'coder',
        task: `Implement feature module ${i + 1}`,
        model: 'sonnet' as const,
      })),
    },
  ],
};

const budgetWorkflow: WorkflowDefinition = {
  id: 'wf-budget',
  name: 'Budget-Capped',
  budgetUsd: 0.001, // tiny budget — will be exceeded
  steps: [
    { type: 'agent', id: 'b1', agentId: 'coder', task: 'Big expensive task', model: 'opus' as const },
    { type: 'agent', id: 'b2', agentId: 'coder', task: 'Another task' },
  ],
};

const conditionalWorkflow: WorkflowDefinition = {
  id: 'wf-conditional',
  name: 'Conditional Branch',
  steps: [
    {
      type: 'conditional',
      id: 'c1',
      condition: 'true',
      ifTrue: { type: 'agent', id: 'c1-true', agentId: 'architect', task: 'Design the system' },
      ifFalse: { type: 'agent', id: 'c1-false', agentId: 'coder', task: 'Skip to implementation' },
    },
  ],
};

describe('WorkflowRunner', () => {
  it('runs a simple sequential workflow to completion', async () => {
    const runner = new WorkflowRunner();
    const result = await runner.run(simpleWorkflow);
    expect(result.status).toBe('completed');
    expect(result.steps.length).toBe(2);
    expect(result.steps.every(s => s.status === 'completed')).toBe(true);
    expect(result.totalCostUsd).toBeGreaterThan(0);
  });

  it('runs 10 agents in parallel without deadlock', async () => {
    const runner = new WorkflowRunner();
    const t0 = Date.now();
    const result = await runner.run(parallelWorkflow);
    const elapsed = Date.now() - t0;
    expect(result.status).toBe('completed');
    const parallelStep = result.steps[0];
    expect(parallelStep?.children?.length).toBe(10);
    // Parallel should be faster than 10x sequential
    expect(elapsed).toBeLessThan(2000);
  });

  it('halts with budget_exceeded when ceiling is breached', async () => {
    const runner = new WorkflowRunner();
    const result = await runner.run(budgetWorkflow);
    expect(result.status).toBe('budget_exceeded');
  });

  it('executes the correct branch in a conditional step', async () => {
    const runner = new WorkflowRunner();
    const result = await runner.run(conditionalWorkflow);
    expect(result.status).toBe('completed');
    const condStep = result.steps[0];
    expect(condStep?.children?.[0]?.agentId).toBe('architect'); // ifTrue branch
  });

  it('skips ifFalse branch when no ifFalse defined', async () => {
    const runner = new WorkflowRunner();
    const wf: WorkflowDefinition = {
      id: 'wf-skip',
      name: 'Skip Test',
      steps: [{
        type: 'conditional',
        id: 'skip-c',
        condition: 'false',
        ifTrue: { type: 'agent', id: 'skip-t', agentId: 'coder', task: 'should not run' },
      }],
    };
    const result = await runner.run(wf);
    expect(result.status).toBe('completed');
    expect(result.steps[0]?.status).toBe('skipped');
  });

  it('marks workflow failed when required agent step fails', async () => {
    const failExecutor = async () => { throw new Error('agent unavailable'); };
    const runner = new WorkflowRunner(failExecutor);
    const wf: WorkflowDefinition = {
      id: 'wf-fail',
      name: 'Failing Workflow',
      steps: [{ type: 'agent', id: 'f1', agentId: 'coder', task: 'Will fail' }],
    };
    const result = await runner.run(wf);
    expect(result.status).toBe('failed');
  });

  it('continues past optional failed steps', async () => {
    let call = 0;
    const executor = async (agentId: string) => {
      call++;
      if (call === 1) throw new Error('transient failure');
      return { output: 'ok', costUsd: 0.01, durationMs: 10 };
    };
    const runner = new WorkflowRunner(executor);
    const wf: WorkflowDefinition = {
      id: 'wf-optional',
      name: 'Optional Step',
      steps: [
        { type: 'agent', id: 'o1', agentId: 'linter', task: 'optional lint', optional: true },
        { type: 'agent', id: 'o2', agentId: 'coder', task: 'required step' },
      ],
    };
    const result = await runner.run(wf);
    expect(result.status).toBe('completed');
    expect(result.steps[0]?.status).toBe('failed');
    expect(result.steps[1]?.status).toBe('completed');
  });

  it('tracks total cost across all steps', async () => {
    const runner = new WorkflowRunner();
    const result = await runner.run(simpleWorkflow);
    const stepsTotal = result.steps.reduce((s, r) => s + r.costUsd, 0);
    expect(result.totalCostUsd).toBeCloseTo(stepsTotal, 5);
  });
});

describe('WorkflowRunner — sequential step type', () => {
  it('runs an embedded sequential step to completion', async () => {
    const runner = new WorkflowRunner();
    const wf: WorkflowDefinition = {
      id: 'wf-seq',
      name: 'Sequential Step',
      steps: [
        {
          type: 'sequential',
          id: 'seq-1',
          steps: [
            { type: 'agent', id: 'seq-a', agentId: 'coder', task: 'step A' },
            { type: 'agent', id: 'seq-b', agentId: 'linter', task: 'step B' },
          ],
        },
      ],
    };
    const result = await runner.run(wf);
    expect(result.status).toBe('completed');
    expect(result.steps[0]?.children?.length).toBe(2);
    expect(result.steps[0]?.children?.every(c => c.status === 'completed')).toBe(true);
  });

  it('sequential step stops at first failure and marks itself failed', async () => {
    let callCount = 0;
    const executor = async () => {
      callCount++;
      if (callCount === 1) throw new Error('step A failed');
      return { output: 'ok', costUsd: 0.01, durationMs: 5 };
    };
    const runner = new WorkflowRunner(executor);
    const wf: WorkflowDefinition = {
      id: 'wf-seq-fail',
      name: 'Sequential Fail',
      steps: [
        {
          type: 'sequential',
          id: 'seq-fail',
          steps: [
            { type: 'agent', id: 'sf-a', agentId: 'coder', task: 'will fail' },
            { type: 'agent', id: 'sf-b', agentId: 'linter', task: 'should not run' },
          ],
        },
      ],
    };
    const result = await runner.run(wf);
    // sequential step itself fails so workflow fails
    expect(result.steps[0]?.status).toBe('failed');
    expect(callCount).toBe(1); // second step never called
  });

  it('accumulates cost across sequential sub-steps', async () => {
    const runner = new WorkflowRunner();
    const wf: WorkflowDefinition = {
      id: 'wf-seq-cost',
      name: 'Sequential Cost',
      steps: [
        {
          type: 'sequential',
          id: 'sq-c',
          steps: [
            { type: 'agent', id: 'sq-c1', agentId: 'coder', task: 'sub A', model: 'haiku' as const },
            { type: 'agent', id: 'sq-c2', agentId: 'coder', task: 'sub B', model: 'haiku' as const },
          ],
        },
      ],
    };
    const result = await runner.run(wf);
    const seqCost = result.steps[0]?.costUsd ?? 0;
    expect(seqCost).toBeGreaterThan(0);
  });
});

describe('WorkflowRunner — parallel concurrency', () => {
  it('respects concurrency limit by running in batches', async () => {
    const inFlight: number[] = [];
    let maxObserved = 0;
    const executor = async () => {
      inFlight.push(1);
      maxObserved = Math.max(maxObserved, inFlight.length);
      await new Promise(r => setTimeout(r, 20));
      inFlight.pop();
      return { output: 'done', costUsd: 0.01, durationMs: 20 };
    };
    const runner = new WorkflowRunner(executor);
    const wf: WorkflowDefinition = {
      id: 'wf-concurrency',
      name: 'Concurrency Test',
      steps: [
        {
          type: 'parallel',
          id: 'p-conc',
          concurrency: 2,
          steps: Array.from({ length: 6 }, (_, i) => ({
            type: 'agent' as const,
            id: `c${i}`,
            agentId: 'coder',
            task: `task ${i}`,
          })),
        },
      ],
    };
    const result = await runner.run(wf);
    expect(result.status).toBe('completed');
    expect(maxObserved).toBeLessThanOrEqual(2);
    expect(result.steps[0]?.children?.length).toBe(6);
  });

  it('parallel step marked failed when any child fails', async () => {
    let callCount = 0;
    const executor = async () => {
      callCount++;
      if (callCount === 3) throw new Error('third agent failed');
      return { output: 'ok', costUsd: 0.01, durationMs: 5 };
    };
    const runner = new WorkflowRunner(executor);
    const wf: WorkflowDefinition = {
      id: 'wf-par-fail',
      name: 'Parallel Partial Fail',
      steps: [
        {
          type: 'parallel',
          id: 'p-fail',
          steps: Array.from({ length: 5 }, (_, i) => ({
            type: 'agent' as const,
            id: `pf${i}`,
            agentId: 'coder',
            task: `task ${i}`,
          })),
        },
      ],
    };
    const result = await runner.run(wf);
    expect(result.steps[0]?.status).toBe('failed');
  });

  it('parallel workflow with single child step completes', async () => {
    const runner = new WorkflowRunner();
    const wf: WorkflowDefinition = {
      id: 'wf-par-single',
      name: 'Single Parallel',
      steps: [
        {
          type: 'parallel',
          id: 'p-single',
          steps: [{ type: 'agent', id: 'ps1', agentId: 'coder', task: 'single task' }],
        },
      ],
    };
    const result = await runner.run(wf);
    expect(result.status).toBe('completed');
    expect(result.steps[0]?.children?.length).toBe(1);
  });
});

describe('WorkflowRunner — conditional step variants', () => {
  it('executes ifFalse branch when condition is false', async () => {
    const runner = new WorkflowRunner();
    const wf: WorkflowDefinition = {
      id: 'wf-cond-false',
      name: 'Conditional False',
      steps: [
        {
          type: 'conditional',
          id: 'cf1',
          condition: 'false',
          ifTrue: { type: 'agent', id: 'cf-t', agentId: 'coder', task: 'should not run' },
          ifFalse: { type: 'agent', id: 'cf-f', agentId: 'linter', task: 'else branch' },
        },
      ],
    };
    const result = await runner.run(wf);
    expect(result.status).toBe('completed');
    expect(result.steps[0]?.children?.[0]?.agentId).toBe('linter');
  });

  it('handles invalid condition expression gracefully (treats as false)', async () => {
    const runner = new WorkflowRunner();
    const wf: WorkflowDefinition = {
      id: 'wf-cond-invalid',
      name: 'Invalid Condition',
      steps: [
        {
          type: 'conditional',
          id: 'ci1',
          condition: '$$$$invalid javascript',
          ifTrue: { type: 'agent', id: 'ci-t', agentId: 'coder', task: 'should not run' },
          ifFalse: { type: 'agent', id: 'ci-f', agentId: 'linter', task: 'fallback' },
        },
      ],
    };
    const result = await runner.run(wf);
    // Invalid condition → false → executes ifFalse
    expect(result.steps[0]?.children?.[0]?.agentId).toBe('linter');
  });

  it('skips step when condition false and no ifFalse defined', async () => {
    const runner = new WorkflowRunner();
    const wf: WorkflowDefinition = {
      id: 'wf-cond-skip',
      name: 'Skip Both',
      steps: [
        {
          type: 'conditional',
          id: 'cs1',
          condition: 'false',
          ifTrue: { type: 'agent', id: 'cs-t', agentId: 'coder', task: 'never runs' },
        },
      ],
    };
    const result = await runner.run(wf);
    expect(result.status).toBe('completed');
    expect(result.steps[0]?.status).toBe('skipped');
    expect(result.totalCostUsd).toBe(0);
  });
});

describe('WorkflowRunner — budget enforcement', () => {
  it('returns budget_exceeded immediately when starting cost is at limit', async () => {
    const runner = new WorkflowRunner();
    const wf: WorkflowDefinition = {
      id: 'wf-exact-budget',
      name: 'Exact Budget',
      budgetUsd: 0, // zero budget
      steps: [
        { type: 'agent', id: 'eb1', agentId: 'coder', task: 'any task' },
      ],
    };
    const result = await runner.run(wf);
    expect(result.status).toBe('budget_exceeded');
    expect(result.steps.length).toBe(0);
  });

  it('completes first step but halts at budget for second step', async () => {
    // opus costs $0.05. Budget is $0.05 — first step runs (check is >= not >),
    // after it cost accumulates to $0.05 which equals budget, so second step is halted.
    const runner = new WorkflowRunner();
    const wf: WorkflowDefinition = {
      id: 'wf-halfway-budget',
      name: 'Halfway Budget',
      budgetUsd: 0.05,
      steps: [
        { type: 'agent', id: 'hb1', agentId: 'coder', task: 'first task', model: 'opus' as const },
        { type: 'agent', id: 'hb2', agentId: 'coder', task: 'second task', model: 'opus' as const },
      ],
    };
    const result = await runner.run(wf);
    expect(result.status).toBe('budget_exceeded');
    expect(result.steps.length).toBe(1);
    expect(result.steps[0]?.status).toBe('completed');
  });

  it('haiku model has lower cost than opus', async () => {
    const runner = new WorkflowRunner();
    const haikusWf: WorkflowDefinition = {
      id: 'wf-haiku', name: 'Haiku', steps: [
        { type: 'agent', id: 'h1', agentId: 'coder', task: 'task', model: 'haiku' as const },
      ],
    };
    const opusWf: WorkflowDefinition = {
      id: 'wf-opus', name: 'Opus', steps: [
        { type: 'agent', id: 'o1', agentId: 'coder', task: 'task', model: 'opus' as const },
      ],
    };
    const haikuResult = await runner.run(haikusWf);
    const opusResult = await runner.run(opusWf);
    expect(haikuResult.totalCostUsd).toBeLessThan(opusResult.totalCostUsd);
  });
});

describe('WorkflowRunner — result metadata', () => {
  it('result includes workflowId', async () => {
    const runner = new WorkflowRunner();
    const result = await runner.run(simpleWorkflow);
    expect(result.workflowId).toBeDefined();
    expect(typeof result.workflowId).toBe('string');
  });

  it('result includes definitionId matching the workflow definition', async () => {
    const runner = new WorkflowRunner();
    const result = await runner.run(simpleWorkflow);
    expect(result.definitionId).toBe('wf-simple');
  });

  it('result includes startedAt and completedAt timestamps', async () => {
    const runner = new WorkflowRunner();
    const result = await runner.run(simpleWorkflow);
    expect(result.startedAt).toBeDefined();
    expect(result.completedAt).toBeDefined();
    expect(new Date(result.completedAt).getTime()).toBeGreaterThanOrEqual(new Date(result.startedAt).getTime());
  });

  it('totalDurationMs is a non-negative number', async () => {
    const runner = new WorkflowRunner();
    const result = await runner.run(simpleWorkflow);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('each step result carries a stepId matching the definition', async () => {
    const runner = new WorkflowRunner();
    const result = await runner.run(simpleWorkflow);
    expect(result.steps[0]?.stepId).toBe('s1');
    expect(result.steps[1]?.stepId).toBe('s2');
  });

  it('each agent step result carries agentId', async () => {
    const runner = new WorkflowRunner();
    const result = await runner.run(simpleWorkflow);
    expect(result.steps[0]?.agentId).toBe('coder');
    expect(result.steps[1]?.agentId).toBe('linter');
  });

  it('failed step result includes error string', async () => {
    const executor = async () => { throw new Error('something broke'); };
    const runner = new WorkflowRunner(executor);
    const wf: WorkflowDefinition = {
      id: 'wf-err', name: 'Error', steps: [
        { type: 'agent', id: 'e1', agentId: 'coder', task: 'task', optional: true },
      ],
    };
    const result = await runner.run(wf);
    expect(result.steps[0]?.error).toContain('something broke');
  });

  it('empty workflow completes with zero cost', async () => {
    const runner = new WorkflowRunner();
    const wf: WorkflowDefinition = { id: 'wf-empty', name: 'Empty', steps: [] };
    const result = await runner.run(wf);
    expect(result.status).toBe('completed');
    expect(result.totalCostUsd).toBe(0);
    expect(result.steps.length).toBe(0);
  });
});
