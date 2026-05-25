/**
 * Direct unit tests for WorkspaceAdapter runtime job and event persistence.
 *
 * These tests exercise the runtime_jobs and runtime_events tables at the
 * adapter layer without going through RuntimeJobSupervisor. This gives us:
 *   - Fast isolation (no supervisor lifecycle overhead)
 *   - Clear coverage of each adapter method individually
 *   - Confidence that idempotency and filter logic work at the DB level
 *
 * For integration-level tests (supervisor → adapter → DB round-trip), see
 * packages/core/src/runtime/__tests__/runtime-job-supervisor.test.ts and
 * packages/core/src/autonomous/__tests__/runtime-adapter-supervisor.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkspaceAdapter } from '../workspace-adapter.js';

function buildAdapter(): WorkspaceAdapter {
  return new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
}

describe('WorkspaceAdapter — runtime_jobs table', () => {
  let adapter: WorkspaceAdapter;

  beforeEach(() => {
    adapter = buildAdapter();
  });

  afterEach(() => {
    adapter.close();
  });

  it('createRuntimeJob writes a queued row with correct defaults', () => {
    const job = adapter.createRuntimeJob({
      sessionId: 'sess-1',
      agentId: 'coder',
      task: 'Build a widget',
      model: 'sonnet',
    });

    expect(job.id).toMatch(/^[a-z0-9]+/);
    expect(job.session_id).toBe('sess-1');
    expect(job.trace_id).toBe('trace-sess-1'); // default derivation
    expect(job.agent_id).toBe('coder');
    expect(job.task).toBe('Build a widget');
    expect(job.status).toBe('queued');
    expect(job.model).toBe('sonnet');
    expect(job.input_tokens).toBe(0);
    expect(job.output_tokens).toBe(0);
    expect(job.cost_usd).toBe(0);
    expect(job.cancel_requested).toBe(0);
    expect(job.started_at).toBeNull();
    expect(job.completed_at).toBeNull();
    expect(job.error).toBeNull();
  });

  it('createRuntimeJob accepts an explicit id and traceId', () => {
    const job = adapter.createRuntimeJob({
      id: 'job-explicit',
      sessionId: 'sess-2',
      traceId: 'trace-custom',
      agentId: 'reviewer',
      task: 'Review code',
    });

    expect(job.id).toBe('job-explicit');
    expect(job.trace_id).toBe('trace-custom');
  });

  it('getRuntimeJob returns the persisted row', () => {
    const created = adapter.createRuntimeJob({ sessionId: 's1', agentId: 'a', task: 't' });
    const fetched = adapter.getRuntimeJob(created.id);

    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
  });

  it('getRuntimeJob returns undefined for unknown ids', () => {
    expect(adapter.getRuntimeJob('nonexistent')).toBeUndefined();
  });

  it('getRuntimeJobBySessionId looks up by session_id', () => {
    adapter.createRuntimeJob({ sessionId: 'unique-session', agentId: 'a', task: 't' });
    const found = adapter.getRuntimeJobBySessionId('unique-session');

    expect(found).toBeDefined();
    expect(found!.session_id).toBe('unique-session');
  });

  it('startRuntimeJob transitions queued → running', () => {
    const job = adapter.createRuntimeJob({ sessionId: 'sess-start', agentId: 'a', task: 't' });
    const started = adapter.startRuntimeJob(job.id);

    expect(started).toBeDefined();
    expect(started!.status).toBe('running');
    expect(started!.started_at).not.toBeNull();
  });

  it('startRuntimeJob returns undefined when already running', () => {
    const job = adapter.createRuntimeJob({ sessionId: 'sess-idem', agentId: 'a', task: 't' });
    adapter.startRuntimeJob(job.id);
    const started2 = adapter.startRuntimeJob(job.id);

    expect(started2).toBeUndefined();
    expect(adapter.getRuntimeJob(job.id)?.status).toBe('running');
  });

  it('startRuntimeJob returns undefined on unknown id', () => {
    // No row → status guard fails → returns undefined via getRuntimeJob miss
    const result = adapter.startRuntimeJob('ghost-id');
    expect(result).toBeUndefined();
  });

  it('completeRuntimeJob persists status=completed with metrics', () => {
    const job = adapter.createRuntimeJob({ sessionId: 'sess-c', agentId: 'a', task: 't' });
    adapter.startRuntimeJob(job.id);

    const completed = adapter.completeRuntimeJob(job.id, {
      status: 'completed',
      model: 'claude-sonnet-4-6',
      providerKind: 'anthropic-sdk',
      inputTokens: 100,
      outputTokens: 200,
      costUsd: 0.005,
      result: { response: 'done' },
    });

    expect(completed!.status).toBe('completed');
    expect(completed!.model).toBe('claude-sonnet-4-6');
    expect(completed!.provider_kind).toBe('anthropic-sdk');
    expect(completed!.input_tokens).toBe(100);
    expect(completed!.output_tokens).toBe(200);
    expect(completed!.cost_usd).toBe(0.005);
    expect(completed!.completed_at).not.toBeNull();
    expect(JSON.parse(completed!.result_json)).toMatchObject({ response: 'done' });
  });

  it('completeRuntimeJob persists status=failed with error', () => {
    const job = adapter.createRuntimeJob({ sessionId: 'sess-f', agentId: 'a', task: 't' });
    adapter.startRuntimeJob(job.id);

    const failed = adapter.completeRuntimeJob(job.id, {
      status: 'failed',
      error: 'Rate limit exceeded',
    });

    expect(failed!.status).toBe('failed');
    expect(failed!.error).toBe('Rate limit exceeded');
  });

  it('requestRuntimeJobCancel sets cancel_requested without changing status', () => {
    const job = adapter.createRuntimeJob({ sessionId: 'sess-req', agentId: 'a', task: 't' });
    adapter.startRuntimeJob(job.id);

    const flagged = adapter.requestRuntimeJobCancel(job.id);

    expect(flagged!.status).toBe('running'); // status unchanged
    expect(flagged!.cancel_requested).toBe(1);
  });

  it('cancelRuntimeJob transitions to cancelled and sets cancel_requested', () => {
    const job = adapter.createRuntimeJob({ sessionId: 'sess-cancel', agentId: 'a', task: 't' });
    adapter.startRuntimeJob(job.id);

    const cancelled = adapter.cancelRuntimeJob(job.id, undefined, 'Cancelled by test');

    expect(cancelled!.status).toBe('cancelled');
    expect(cancelled!.cancel_requested).toBe(1);
    expect(cancelled!.error).toBe('Cancelled by test');
    expect(cancelled!.completed_at).not.toBeNull();
  });

  it('cancelRuntimeJob is a no-op on already-terminal status', () => {
    const job = adapter.createRuntimeJob({ sessionId: 'sess-t', agentId: 'a', task: 't' });
    adapter.startRuntimeJob(job.id);
    adapter.completeRuntimeJob(job.id, { status: 'completed' });

    // Attempt to cancel after completion — WHERE guard prevents change
    const result = adapter.cancelRuntimeJob(job.id);
    // The completed row is returned unchanged
    expect(result!.status).toBe('completed');
  });

  it('listRuntimeJobs returns all jobs ordered by created_at DESC', () => {
    adapter.createRuntimeJob({ sessionId: 'a1', agentId: 'x', task: 't1' });
    adapter.createRuntimeJob({ sessionId: 'a2', agentId: 'x', task: 't2' });

    const jobs = adapter.listRuntimeJobs({});
    expect(jobs).toHaveLength(2);
    // Newer job comes first
    expect(jobs[0]!.session_id).toBe('a2');
  });

  it('listRuntimeJobs filters by agentId', () => {
    adapter.createRuntimeJob({ sessionId: 's1', agentId: 'alpha', task: 't' });
    adapter.createRuntimeJob({ sessionId: 's2', agentId: 'beta', task: 't' });

    const alphaJobs = adapter.listRuntimeJobs({ agentId: 'alpha' });
    expect(alphaJobs).toHaveLength(1);
    expect(alphaJobs[0]!.agent_id).toBe('alpha');
  });

  it('listRuntimeJobs filters by status', () => {
    const j1 = adapter.createRuntimeJob({ sessionId: 's1', agentId: 'a', task: 't' });
    adapter.createRuntimeJob({ sessionId: 's2', agentId: 'a', task: 't' });
    adapter.startRuntimeJob(j1.id);

    const running = adapter.listRuntimeJobs({ status: 'running' });
    expect(running).toHaveLength(1);
    expect(running[0]!.id).toBe(j1.id);
  });

  it('countRuntimeJobs returns total and respects filters', () => {
    adapter.createRuntimeJob({ sessionId: 's1', agentId: 'a', task: 't' });
    adapter.createRuntimeJob({ sessionId: 's2', agentId: 'b', task: 't' });

    expect(adapter.countRuntimeJobs({})).toBe(2);
    expect(adapter.countRuntimeJobs({ agentId: 'a' })).toBe(1);
    expect(adapter.countRuntimeJobs({ status: 'running' })).toBe(0);
  });
});

describe('WorkspaceAdapter — runtime_events table', () => {
  let adapter: WorkspaceAdapter;

  beforeEach(() => {
    adapter = buildAdapter();
  });

  afterEach(() => {
    adapter.close();
  });

  function makeJob(suffix: string) {
    return adapter.createRuntimeJob({
      id: `job-${suffix}`,
      sessionId: `sess-${suffix}`,
      agentId: 'coder',
      task: 'test task',
    });
  }

  it('recordRuntimeEvent inserts an event with AUTOINCREMENT sequence', () => {
    const job = makeJob('ev1');
    const ev = adapter.recordRuntimeEvent({
      jobId: job.id,
      sessionId: job.session_id,
      agentId: job.agent_id,
      type: 'job_created',
      message: '[coder] created',
      data: { status: 'queued' },
    });

    expect(ev.id).toBeDefined();
    expect(ev.sequence).toBeGreaterThan(0);
    expect(ev.job_id).toBe(job.id);
    expect(ev.type).toBe('job_created');
    expect(ev.category).toBe('run'); // default
    expect(JSON.parse(ev.data_json)).toMatchObject({ status: 'queued' });
  });

  it('recordRuntimeEvent derives traceId from sessionId when not provided', () => {
    const job = makeJob('ev2');
    const ev = adapter.recordRuntimeEvent({
      jobId: job.id,
      sessionId: 'sess-ev2',
      agentId: 'coder',
      type: 'custom',
      message: 'msg',
    });

    expect(ev.trace_id).toBe('trace-sess-ev2');
  });

  it('getRuntimeEvent fetches by id', () => {
    const job = makeJob('ev3');
    const ev = adapter.recordRuntimeEvent({
      jobId: job.id,
      sessionId: job.session_id,
      agentId: job.agent_id,
      type: 'start',
      message: 'started',
    });

    const fetched = adapter.getRuntimeEvent(ev.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(ev.id);
  });

  it('listRuntimeEvents returns events in sequence ASC order', () => {
    const job = makeJob('ev4');
    adapter.recordRuntimeEvent({ jobId: job.id, sessionId: job.session_id, agentId: 'coder', type: 'first', message: 'm' });
    adapter.recordRuntimeEvent({ jobId: job.id, sessionId: job.session_id, agentId: 'coder', type: 'second', message: 'm' });
    adapter.recordRuntimeEvent({ jobId: job.id, sessionId: job.session_id, agentId: 'coder', type: 'third', message: 'm' });

    const events = adapter.listRuntimeEvents({ jobId: job.id });
    expect(events.map((e) => e.type)).toEqual(['first', 'second', 'third']);
  });

  it('listRuntimeEvents filters by type', () => {
    const job = makeJob('ev5');
    adapter.recordRuntimeEvent({ jobId: job.id, sessionId: job.session_id, agentId: 'coder', type: 'chunk', message: 'm' });
    adapter.recordRuntimeEvent({ jobId: job.id, sessionId: job.session_id, agentId: 'coder', type: 'metadata', message: 'm' });

    const chunks = adapter.listRuntimeEvents({ jobId: job.id, type: 'chunk' });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.type).toBe('chunk');
  });

  it('listRuntimeEvents supports afterSequence cursor for streaming replay', () => {
    const job = makeJob('ev6');
    const ev1 = adapter.recordRuntimeEvent({ jobId: job.id, sessionId: job.session_id, agentId: 'coder', type: 'e1', message: 'm' });
    adapter.recordRuntimeEvent({ jobId: job.id, sessionId: job.session_id, agentId: 'coder', type: 'e2', message: 'm' });
    adapter.recordRuntimeEvent({ jobId: job.id, sessionId: job.session_id, agentId: 'coder', type: 'e3', message: 'm' });

    const after = adapter.listRuntimeEvents({ jobId: job.id, afterSequence: ev1.sequence });
    expect(after).toHaveLength(2);
    expect(after.map((e) => e.type)).toEqual(['e2', 'e3']);
  });

  it('listRuntimeEvents filters by sessionId', () => {
    const job1 = makeJob('ev7a');
    const job2 = makeJob('ev7b');
    adapter.recordRuntimeEvent({ jobId: job1.id, sessionId: 'sess-ev7a', agentId: 'coder', type: 'e1', message: 'm' });
    adapter.recordRuntimeEvent({ jobId: job2.id, sessionId: 'sess-ev7b', agentId: 'coder', type: 'e2', message: 'm' });

    const eventsForSession = adapter.listRuntimeEvents({ sessionId: 'sess-ev7a' });
    expect(eventsForSession).toHaveLength(1);
    expect(eventsForSession[0]!.type).toBe('e1');
  });

  it('full job lifecycle produces correct event sequence', () => {
    // Simulate a complete job: created → started → chunk → completed
    const job = adapter.createRuntimeJob({
      id: 'job-lifecycle',
      sessionId: 'sess-lifecycle',
      agentId: 'coder',
      task: 'Lifecycle test',
    });

    adapter.recordRuntimeEvent({ jobId: job.id, sessionId: job.session_id, agentId: 'coder', type: 'job_created', message: 'created' });
    adapter.startRuntimeJob(job.id);
    adapter.recordRuntimeEvent({ jobId: job.id, sessionId: job.session_id, agentId: 'coder', type: 'job_started', message: 'started' });
    adapter.recordRuntimeEvent({ jobId: job.id, sessionId: job.session_id, agentId: 'coder', type: 'chunk', message: 'chunk', data: { content: 'hello' } });
    adapter.completeRuntimeJob(job.id, { status: 'completed', costUsd: 0.002, inputTokens: 50, outputTokens: 100 });
    adapter.recordRuntimeEvent({ jobId: job.id, sessionId: job.session_id, agentId: 'coder', type: 'job_completed', message: 'done' });

    const finalJob = adapter.getRuntimeJob(job.id)!;
    expect(finalJob.status).toBe('completed');
    expect(finalJob.cost_usd).toBe(0.002);

    const events = adapter.listRuntimeEvents({ jobId: job.id });
    expect(events.map((e) => e.type)).toEqual([
      'job_created',
      'job_started',
      'chunk',
      'job_completed',
    ]);
  });
});
