/**
 * Phase 2: `POST /api/v5/inbox` accepts `@team-*` recipients and expands
 * them into the literal agent ids found in `.agentforge/agents/*.yaml` (or
 * the tier groupings in `team.yaml` as a fallback). Unknown aliases return
 * 400 — mirroring the v1 invariant that the recipient set must always
 * resolve to at least one literal recipient.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceAdapter } from '@agentforge/db';
import { inboxRoutes } from '../inbox.js';
import { clearTeamRecipientsCache } from '@agentforge/core';

let app: FastifyInstance;
let adapter: WorkspaceAdapter;
let projectRoot: string;

function writeAgent(name: string, team?: string): void {
  const lines = [`name: ${name}`, 'model: sonnet'];
  if (team !== undefined) lines.push(`team: ${team}`);
  writeFileSync(
    join(projectRoot, '.agentforge', 'agents', `${name}.yaml`),
    lines.join('\n'),
    'utf8',
  );
}

beforeEach(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-team-route-'));
  mkdirSync(join(projectRoot, '.agentforge', 'agents'), { recursive: true });
  adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test' });
  app = Fastify({ logger: false });
  await inboxRoutes(app, { adapter, projectRoot });
  await app.ready();
});

afterEach(async () => {
  clearTeamRecipientsCache();
  await app.close();
  adapter.close();
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('POST /api/v5/inbox — @team-* recipient expansion', () => {
  it('expands a known team alias into N inbox_recipients rows', async () => {
    writeAgent('coder', 'platform');
    writeAgent('dba', 'platform');
    writeAgent('architect', 'strategic');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/inbox',
      payload: {
        body: 'platform team — context broadcast',
        kind: 'info',
        recipients: ['@team-platform'],
      },
    });
    expect(res.statusCode).toBe(201);
    const json = res.json() as {
      data: { recipients: Array<{ recipient: string; status: string }> };
    };
    const ids = json.data.recipients.map((r) => r.recipient).sort();
    expect(ids).toEqual(['coder', 'dba']);
  });

  it('returns 400 for an unknown team alias', async () => {
    writeAgent('coder', 'platform');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/inbox',
      payload: {
        body: 'oops',
        kind: 'info',
        recipients: ['@team-ghosts'],
      },
    });
    expect(res.statusCode).toBe(400);
    const json = res.json() as { error: string };
    expect(json.error).toMatch(/@team-ghosts|not supported/);
  });

  it('handles a mixed @user + @team-* + literal-agent payload', async () => {
    writeAgent('reviewer-a', 'quality');
    writeAgent('reviewer-b', 'quality');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/inbox',
      payload: {
        body: 'cross-post (mixed recipients)',
        kind: 'info',
        recipients: ['@user', '@team-quality', 'reviewer-a'],
      },
    });
    expect(res.statusCode).toBe(201);
    const json = res.json() as {
      data: { recipients: Array<{ recipient: string }> };
    };
    const ids = json.data.recipients.map((r) => r.recipient).sort();
    // @user + reviewer-a + reviewer-b, deduped.
    expect(ids).toEqual(['@user', 'reviewer-a', 'reviewer-b']);
  });
});
