import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { WorkspaceAdapter } from '@agentforge/db';
import { RuntimeJobSupervisor } from '@agentforge/core';
import { jobsRoutes } from '../jobs.js';

describe('/api/v5/jobs', () => {
  let adapter: WorkspaceAdapter;
  let supervisor: RuntimeJobSupervisor;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
    supervisor = new RuntimeJobSupervisor({ adapter });
    app = Fastify({ logger: false });
    await jobsRoutes(app, { adapter, supervisor });
  });

  afterEach(async () => {
    await app.close();
    adapter.close();
  });

  it('lists durable runtime jobs', async () => {
    const job = supervisor.createJob({ agentId: 'coder', task: 'Build a widget', model: 'sonnet' });

    const response = await app.inject({ method: 'GET', url: '/api/v5/jobs' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.meta.total).toBe(1);
    expect(body.data[0]).toMatchObject({
      jobId: job.id,
      sessionId: job.session_id,
      agentId: 'coder',
      status: 'queued',
    });
  });

  it('returns job detail and ordered persisted events', async () => {
    const job = supervisor.createJob({ agentId: 'coder', task: 'Build a widget' });
    supervisor.emitForJob(job.id, {
      type: 'metadata',
      message: '[coder] metadata',
      data: { providerKind: 'anthropic-sdk' },
    });

    const detail = await app.inject({ method: 'GET', url: `/api/v5/jobs/${job.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data).toMatchObject({ jobId: job.id, status: 'queued' });

    const events = await app.inject({ method: 'GET', url: `/api/v5/jobs/${job.id}/events` });
    expect(events.statusCode).toBe(200);
    expect(events.json().data.map((event: { type: string }) => event.type)).toEqual([
      'job_created',
      'metadata',
    ]);
  });

  it('cancels a queued job', async () => {
    const job = supervisor.createJob({ agentId: 'coder', task: 'Cancel this' });

    const response = await app.inject({ method: 'POST', url: `/api/v5/jobs/${job.id}/cancel` });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      jobId: job.id,
      status: 'cancelled',
      cancelRequested: true,
    });
  });

  it('returns 404 for unknown jobs', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v5/jobs/missing' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'JOB_NOT_FOUND' });
  });
});
