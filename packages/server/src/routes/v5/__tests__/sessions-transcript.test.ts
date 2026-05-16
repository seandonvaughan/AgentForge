/**
 * Fix 4: Session transcript field
 *
 * Tests for loadSessionTranscript() and the session endpoints.
 *
 * Tests:
 *   - transcript loaded from structured transcript.json when present
 *   - transcript loaded from flat session file when structured file absent
 *   - transcript is null / omitted when no file exists (old sessions)
 *   - transcript is null on malformed JSON (doesn't crash)
 *   - transcript is null when flat file has no task/response fields
 *   - flat file: task → user entry, response → assistant entry
 *   - structured transcript.json: role/content/ts preserved
 *   - GET /api/v5/sessions/:id includes transcript when file present
 *   - GET /api/v5/sessions/:id omits transcript when file absent
 *   - GET /api/v5/sessions returns transcript on each session item when file present
 *   - transcript entries have correct shape: role, content, ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { WorkspaceAdapter } from '@agentforge/db';
import { loadSessionTranscript, registerV5Routes } from '../index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let sessionsDir: string;

function setupTmpDir(): void {
  tmpDir = mkdtempSync(join(tmpdir(), 'sessions-transcript-test-'));
  sessionsDir = join(tmpDir, '.agentforge', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
}

function teardownTmpDir(): void {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

function writeStructuredTranscript(sessionId: string, entries: Array<{ role: string; content: string; ts: string }>): void {
  const sessionDir = join(sessionsDir, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'transcript.json'), JSON.stringify(entries), 'utf8');
}

function writeFlatSessionFile(sessionId: string, data: Record<string, unknown>): void {
  writeFileSync(join(sessionsDir, `${sessionId}-123456.json`), JSON.stringify(data), 'utf8');
}

// ---------------------------------------------------------------------------
// loadSessionTranscript unit tests
// ---------------------------------------------------------------------------

describe('loadSessionTranscript()', () => {
  beforeEach(() => { setupTmpDir(); });
  afterEach(() => { teardownTmpDir(); });

  it('returns null when no session file exists', () => {
    const result = loadSessionTranscript('nonexistent-id', tmpDir);
    expect(result).toBeNull();
  });

  it('loads entries from structured transcript.json', () => {
    const entries = [
      { role: 'user', content: 'Hello', ts: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', content: 'Hi there!', ts: '2026-01-01T00:00:01.000Z' },
    ];
    writeStructuredTranscript('sess-001', entries);

    const result = loadSessionTranscript('sess-001', tmpDir);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0]!.role).toBe('user');
    expect(result![0]!.content).toBe('Hello');
    expect(result![0]!.ts).toBe('2026-01-01T00:00:00.000Z');
    expect(result![1]!.role).toBe('assistant');
  });

  it('structured transcript takes priority over flat file', () => {
    writeStructuredTranscript('sess-002', [
      { role: 'user', content: 'Structured', ts: '2026-01-01T00:00:00.000Z' },
    ]);
    writeFlatSessionFile('sess-002', { task: 'Flat task', response: 'Flat response', startedAt: '2026-01-01T00:00:00.000Z' });

    const result = loadSessionTranscript('sess-002', tmpDir);
    expect(result).not.toBeNull();
    expect(result![0]!.content).toBe('Structured');
  });

  it('loads user/assistant entries from flat session file with task+response', () => {
    writeFlatSessionFile('sess-003', {
      task: 'Build the system',
      response: 'Done!',
      startedAt: '2026-01-01T10:00:00.000Z',
      completedAt: '2026-01-01T10:05:00.000Z',
    });

    const result = loadSessionTranscript('sess-003', tmpDir);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0]!.role).toBe('user');
    expect(result![0]!.content).toBe('Build the system');
    expect(result![1]!.role).toBe('assistant');
    expect(result![1]!.content).toBe('Done!');
  });

  it('returns null for malformed JSON in transcript file (no crash)', () => {
    const sessionDir = join(sessionsDir, 'sess-bad');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'transcript.json'), '{ invalid json }', 'utf8');

    const result = loadSessionTranscript('sess-bad', tmpDir);
    expect(result).toBeNull();
  });

  it('returns null when flat file has malformed JSON', () => {
    writeFileSync(join(sessionsDir, 'sess-malformed-9999.json'), '{ broken', 'utf8');
    const result = loadSessionTranscript('sess-malformed', tmpDir);
    expect(result).toBeNull();
  });

  it('returns null when flat file has no task or response fields', () => {
    writeFlatSessionFile('sess-empty', {
      someOtherField: 'value',
      anotherField: 123,
    });

    const result = loadSessionTranscript('sess-empty', tmpDir);
    expect(result).toBeNull();
  });

  it('each transcript entry has role, content, ts fields', () => {
    writeStructuredTranscript('sess-shape', [
      { role: 'user', content: 'Hello', ts: '2026-01-01T00:00:00.000Z' },
    ]);

    const result = loadSessionTranscript('sess-shape', tmpDir);
    expect(result).not.toBeNull();
    const entry = result![0]!;
    expect(typeof entry.role).toBe('string');
    expect(typeof entry.content).toBe('string');
    expect(typeof entry.ts).toBe('string');
  });

  it('flat file uses objective field as task alternative', () => {
    writeFlatSessionFile('sess-objective', {
      objective: 'Run the plan',
      startedAt: '2026-01-01T00:00:00.000Z',
    });

    const result = loadSessionTranscript('sess-objective', tmpDir);
    expect(result).not.toBeNull();
    expect(result![0]!.content).toBe('Run the plan');
    expect(result![0]!.role).toBe('user');
  });
});

// ---------------------------------------------------------------------------
// Route integration tests
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let adapter: WorkspaceAdapter;

describe('GET /api/v5/sessions — transcript integration', () => {
  beforeEach(async () => {
    setupTmpDir();
    adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test-ws' });
    app = Fastify({ logger: false });

    // Register only what we need by creating a minimal registry mock
    const registry = {
      listWorkspaces: () => [],
      getWorkspace: () => undefined,
    } as unknown as import('@agentforge/db').WorkspaceRegistry;

    await registerV5Routes(app, { adapter, registry, projectRoot: tmpDir });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    adapter.close();
    teardownTmpDir();
  });

  it('GET /api/v5/sessions/:id omits transcript when no file exists', async () => {
    const session = adapter.createSession({ agentId: 'agent-1', task: 'test task' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/sessions/${session.id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; transcript?: unknown } }>();
    expect(body.data.id).toBe(session.id);
    expect(body.data.transcript).toBeUndefined();
  });

  it('GET /api/v5/sessions/:id includes transcript when file present', async () => {
    const session = adapter.createSession({ agentId: 'agent-2', task: 'run task' });

    writeStructuredTranscript(session.id, [
      { role: 'user', content: 'run task', ts: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', content: 'done', ts: '2026-01-01T00:01:00.000Z' },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/sessions/${session.id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { transcript?: Array<{ role: string; content: string; ts: string }> } }>();
    expect(Array.isArray(body.data.transcript)).toBe(true);
    expect(body.data.transcript!).toHaveLength(2);
    expect(body.data.transcript![0]!.role).toBe('user');
    expect(body.data.transcript![1]!.role).toBe('assistant');
  });

  it('GET /api/v5/sessions returns transcript on items that have files', async () => {
    const s1 = adapter.createSession({ agentId: 'agent-a', task: 'task a' });
    const s2 = adapter.createSession({ agentId: 'agent-b', task: 'task b' });

    // Only s1 has a transcript file
    writeFlatSessionFile(s1.id, {
      task: 'task a',
      response: 'done a',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:01:00.000Z',
    });

    const res = await app.inject({ method: 'GET', url: '/api/v5/sessions' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{ id: string; transcript?: unknown }>
    }>();
    const item1 = body.data.find(d => d.id === s1.id);
    const item2 = body.data.find(d => d.id === s2.id);
    expect(item1).toBeDefined();
    expect(item2).toBeDefined();
    expect(Array.isArray(item1!.transcript)).toBe(true);
    expect(item2!.transcript).toBeUndefined();
  });
});
