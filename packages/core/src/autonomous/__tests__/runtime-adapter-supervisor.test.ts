/**
 * Tests that RuntimeAdapter with a supervisor writes durable runtime_job
 * and runtime_event rows to the WorkspaceAdapter DB on each agent run.
 *
 * This covers the v15.0.0 sprint item: "Persist RuntimeJobSupervisor writes
 * to the existing runtime_jobs and runtime_events tables (0 rows currently)."
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkspaceAdapter } from '@agentforge/db';
import { RuntimeJobSupervisor } from '../../runtime/runtime-job-supervisor.js';
import { RuntimeAdapter } from '../runtime-adapter.js';

// ---------------------------------------------------------------------------
// Mock AgentRuntime so the test never calls the real Claude API.
// The mock's run() returns a minimal RunResult.
// ---------------------------------------------------------------------------

const mockRun = vi.fn();

vi.mock('../../agent-runtime/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-runtime/index.js')>();
  return {
    ...actual,
    AgentRuntime: vi.fn(function () {
      return { run: mockRun };
    }),
    loadAgentConfig: vi.fn(async (_agentId: string, _dir: string) => ({
      agentId: 'coder',
      name: 'Coder',
      model: 'sonnet' as const,
      systemPrompt: 'You are a coder.',
      workspaceId: 'default',
    })),
  };
});

// ---------------------------------------------------------------------------

describe('RuntimeAdapter with supervisor', () => {
  let adapter: WorkspaceAdapter;
  let supervisor: RuntimeJobSupervisor;

  beforeEach(() => {
    adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
    supervisor = new RuntimeJobSupervisor({ adapter });
    mockRun.mockReset();
  });

  afterEach(() => {
    adapter.close();
  });

  it('persists a completed agent run to runtime_jobs and runtime_events', async () => {
    mockRun.mockResolvedValueOnce({
      sessionId: 'sess-1',
      response: 'here is the code',
      model: 'claude-sonnet-4-6',
      inputTokens: 100,
      outputTokens: 200,
      costUsd: 0.002,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:05.000Z',
      status: 'completed' as const,
    });

    const runtimeAdapter = new RuntimeAdapter({
      cwd: '/tmp/fake-project',
      supervisor,
    });

    const result = await runtimeAdapter.run('coder', 'Build a widget');

    // Verify adapter returned the correct result shape
    expect(result.output).toBe('here is the code');
    expect(result.usage.input_tokens).toBe(100);
    expect(result.usage.output_tokens).toBe(200);
    expect(result.costUsd).toBe(0.002);
    expect(result.model).toBe('claude-sonnet-4-6');

    // Verify a job row was persisted with completed status
    const jobs = adapter.listRuntimeJobs({});
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      agent_id: 'coder',
      task: 'Build a widget',
      status: 'completed',
      input_tokens: 100,
      output_tokens: 200,
      cost_usd: 0.002,
    });

    // Verify runtime_events were recorded: job_created, job_started, job_completed
    const events = adapter.listRuntimeEvents({ jobId: jobs[0]!.id });
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('job_created');
    expect(eventTypes).toContain('job_started');
    expect(eventTypes).toContain('job_completed');
  });

  it('persists a failed agent run to runtime_jobs and throws', async () => {
    mockRun.mockResolvedValueOnce({
      sessionId: 'sess-2',
      response: '',
      model: 'claude-sonnet-4-6',
      inputTokens: 50,
      outputTokens: 0,
      costUsd: 0,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      status: 'failed' as const,
      error: 'Rate limit exceeded',
    });

    const runtimeAdapter = new RuntimeAdapter({
      cwd: '/tmp/fake-project',
      supervisor,
    });

    await expect(runtimeAdapter.run('coder', 'Build a failing widget'))
      .rejects.toThrow('Rate limit exceeded');

    // The job should be recorded as failed in the DB
    const jobs = adapter.listRuntimeJobs({});
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe('failed');
    expect(jobs[0]!.error).toBe('Rate limit exceeded');

    // Events should include job_created, job_started, job_failed
    const events = adapter.listRuntimeEvents({ jobId: jobs[0]!.id });
    expect(events.map((e) => e.type)).toContain('job_failed');
  });

  it('works correctly without supervisor (no rows written)', async () => {
    mockRun.mockResolvedValueOnce({
      sessionId: 'sess-3',
      response: 'done',
      model: 'claude-sonnet-4-6',
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.001,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      status: 'completed' as const,
    });

    // No supervisor — uses original path
    const runtimeAdapter = new RuntimeAdapter({ cwd: '/tmp/fake-project' });
    const result = await runtimeAdapter.run('coder', 'Simple task');

    expect(result.output).toBe('done');
    // No rows written because no supervisor
    expect(adapter.listRuntimeJobs({})).toHaveLength(0);
  });

  it('persists multiple concurrent runs as separate jobs', async () => {
    const makeResult = (n: number) => ({
      sessionId: `sess-${n}`,
      response: `result-${n}`,
      model: 'claude-sonnet-4-6',
      inputTokens: n * 10,
      outputTokens: n * 20,
      costUsd: n * 0.001,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      status: 'completed' as const,
    });

    mockRun.mockResolvedValueOnce(makeResult(1));
    mockRun.mockResolvedValueOnce(makeResult(2));

    const runtimeAdapter = new RuntimeAdapter({
      cwd: '/tmp/fake-project',
      supervisor,
    });

    await Promise.all([
      runtimeAdapter.run('coder', 'Task 1'),
      runtimeAdapter.run('coder', 'Task 2'),
    ]);

    const jobs = adapter.listRuntimeJobs({});
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.status === 'completed')).toBe(true);
  });

  it('threads timeoutMs parameter to AgentRuntime.run()', async () => {
    mockRun.mockResolvedValueOnce({
      sessionId: 'sess-timeout-test',
      response: 'done with custom timeout',
      model: 'claude-sonnet-4-6',
      inputTokens: 100,
      outputTokens: 200,
      costUsd: 0.002,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:05.000Z',
      status: 'completed' as const,
    });

    const runtimeAdapter = new RuntimeAdapter({ cwd: '/tmp/fake-project' });
    const customTimeoutMs = 45 * 60 * 1000; // 45 minutes

    // Call run() with a custom timeout
    const result = await runtimeAdapter.run('coder', 'Heavy reasoning task', {
      allowedTools: ['Read', 'Write'],
      timeoutMs: customTimeoutMs,
    });

    expect(result.output).toBe('done with custom timeout');

    // Verify that mockRun was called with options containing the timeoutMs
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'Heavy reasoning task',
        timeoutMs: customTimeoutMs,
      }),
    );
  });

  it('threads timeoutMs through supervisor path', async () => {
    mockRun.mockResolvedValueOnce({
      sessionId: 'sess-timeout-supervisor',
      response: 'done with supervisor timeout',
      model: 'claude-sonnet-4-6',
      inputTokens: 100,
      outputTokens: 200,
      costUsd: 0.002,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:05.000Z',
      status: 'completed' as const,
    });

    const runtimeAdapter = new RuntimeAdapter({
      cwd: '/tmp/fake-project',
      supervisor,
    });
    const customTimeoutMs = 50 * 60 * 1000; // 50 minutes

    const result = await runtimeAdapter.run('coder', 'Heavy task', {
      allowedTools: ['Read'],
      timeoutMs: customTimeoutMs,
    });

    expect(result.output).toBe('done with supervisor timeout');

    // Verify mockRun was called with the timeout
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: customTimeoutMs,
      }),
    );
  });
});
