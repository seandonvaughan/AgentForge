/**
 * Phase 2 thread tests — verifies that an inbox reply correctly stores
 * `thread_id` and that the parent + reply round-trip through the v5 API
 * the way the dashboard `/inbox/[id]` route relies on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceAdapter } from '@agentforge/db';
import { inboxRoutes } from '../inbox.js';

let app: FastifyInstance;
let adapter: WorkspaceAdapter;
let projectRoot: string;

beforeEach(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-inbox-thread-'));
  adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
  app = Fastify({ logger: false });
  await inboxRoutes(app, { adapter, projectRoot });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  adapter.close();
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('Inbox thread round-trip', () => {
  it('stores threadId on reply and surfaces it in the list', async () => {
    const parentRes = await app.inject({
      method: 'POST',
      url: '/api/v5/inbox',
      payload: {
        body: 'gate verdict: rejected (cycle-42)',
        kind: 'action_required',
        sourceType: 'gate-verdict',
        sourceId: 'cycle-42',
        recipients: ['@user'],
      },
    });
    expect(parentRes.statusCode).toBe(201);
    const parentId = (parentRes.json() as { data: { message: { id: string } } }).data.message.id;

    const replyRes = await app.inject({
      method: 'POST',
      url: '/api/v5/inbox',
      payload: {
        body: 'addressing the critical finding now',
        kind: 'info',
        threadId: parentId,
        sourceType: 'user-reply',
        sourceId: parentId,
        recipients: ['@user'],
      },
    });
    expect(replyRes.statusCode).toBe(201);
    const replyId = (replyRes.json() as { data: { message: { id: string } } }).data.message.id;

    // List @user inbox and filter to the thread — exactly what the SSR loader
    // for `/inbox/[id]` does today.
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v5/inbox?recipient=%40user&limit=500',
    });
    expect(listRes.statusCode).toBe(200);
    const list = (listRes.json() as {
      data: Array<{ id: string; threadId: string | null }>;
    }).data;
    const parent = list.find((m) => m.id === parentId);
    const reply = list.find((m) => m.id === replyId);
    expect(parent?.threadId).toBeNull();
    expect(reply?.threadId).toBe(parentId);

    const replies = list.filter((m) => m.threadId === parentId);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.id).toBe(replyId);
  });
});
