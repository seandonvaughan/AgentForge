import { describe, expect, it, vi } from 'vitest';
import { WorkspaceAdapter } from '@agentforge/db';
import { RuntimeJobSupervisor } from '../runtime-job-supervisor.js';
import type { RunResult } from '../../agent-runtime/types.js';

function buildAdapter(): WorkspaceAdapter {
  return new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
}

function completedResult(sessionId: string): RunResult {
  return {
    sessionId,
    response: 'done',
    model: 'claude-sonnet-4-6',
    inputTokens: 10,
    outputTokens: 20,
    costUsd: 0.001,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    status: 'completed',
    providerKind: 'anthropic-sdk',
    runtimeModeResolved: 'sdk',
  };
}

describe('RuntimeJobSupervisor', () => {
  it('creates, starts, completes, and persists runtime events', async () => {
    const adapter = buildAdapter();
    const onEvent = vi.fn();
    const supervisor = new RuntimeJobSupervisor({ adapter, onEvent });
    const job = supervisor.createJob({ agentId: 'coder', task: 'Ship it', model: 'sonnet' });

    const result = await supervisor.startJob(job.id, async ({ emit }) => {
      emit({
        type: 'chunk',
        message: '[coder] chunk',
        data: { content: 'done', index: 0 },
      });
      return completedResult(job.session_id);
    });

    expect(result?.status).toBe('completed');
    expect(adapter.getRuntimeJob(job.id)?.status).toBe('completed');
    expect(adapter.getRuntimeJob(job.id)?.cost_usd).toBe(0.001);

    const events = adapter.listRuntimeEvents({ jobId: job.id });
    expect(events.map((event) => event.type)).toEqual([
      'job_created',
      'job_started',
      'chunk',
      'job_completed',
    ]);
    expect(JSON.parse(events[2]!.data_json)).toMatchObject({ content: 'done', jobId: job.id });
    expect(onEvent).toHaveBeenCalledTimes(4);

    adapter.close();
  });

  it('aborts an active job when cancelled', async () => {
    const adapter = buildAdapter();
    const supervisor = new RuntimeJobSupervisor({ adapter });
    const job = supervisor.createJob({ agentId: 'coder', task: 'Wait' });

    const started = supervisor.startJob(job.id, async ({ signal }) => {
      await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return completedResult(job.session_id);
    });

    await Promise.resolve();
    const cancelled = supervisor.cancelJob(job.id);
    await started;

    expect(cancelled?.status).toBe('cancelled');
    expect(adapter.getRuntimeJob(job.id)?.status).toBe('cancelled');
    expect(adapter.listRuntimeEvents({ jobId: job.id }).map((event) => event.type)).toContain('job_cancelled');

    adapter.close();
  });
});
