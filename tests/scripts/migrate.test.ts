/**
 * Tests for scripts/migrate-to-sqlite.ts — P2-6
 *
 * Uses mkdtempSync for fixture directories to ensure isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentDatabase } from '../../src/db/database.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrate, parseSessionJson, parseFeedbackFilename } from '../../scripts/migrate-to-sqlite.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface FixtureDirs {
  root: string;
  sessions: string;
  feedback: string;
  dbPath: string;
}

function makeFixtureDirs(): FixtureDirs {
  const root = mkdtempSync(join(tmpdir(), 'agentforge-migrate-test-'));
  const sessions = join(root, 'sessions');
  const feedback = join(root, 'feedback');
  mkdirSync(sessions, { recursive: true });
  mkdirSync(feedback, { recursive: true });
  const dbPath = join(root, 'audit.db');
  return { root, sessions, feedback, dbPath };
}

function writeSessionFile(dir: string, id: string, data: Record<string, unknown>): void {
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(data));
}

function writeFeedbackFile(dir: string, filename: string, content: string): void {
  writeFileSync(join(dir, filename), content);
}

function makeSessionData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'sess-001',
    agentId: 'cto',
    agentName: 'Chief Technology Officer',
    model: 'claude-opus-4-5',
    task: 'Design the v4.7 architecture',
    status: 'completed',
    startedAt: '2026-03-26T10:00:00Z',
    completedAt: '2026-03-26T10:30:00Z',
    ...overrides,
  };
}

function openAdapter(dbPath: string): SqliteAdapter {
  const db = new AgentDatabase({ path: dbPath });
  return new SqliteAdapter({ db });
}

// ---------------------------------------------------------------------------
// Unit tests — parseSessionJson
// ---------------------------------------------------------------------------

describe('parseSessionJson', () => {
  it('maps camelCase SessionRecord fields correctly', () => {
    const raw = makeSessionData({ sessionId: 'sess-abc', agentId: 'ceo' });
    const result = parseSessionJson(raw, 'sess-abc.json');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('sess-abc');
    expect(result!.agent_id).toBe('ceo');
    expect(result!.task).toBe('Design the v4.7 architecture');
    expect(result!.status).toBe('completed');
  });

  it('maps snake_case fields when camelCase absent', () => {
    const raw = { id: 'snap-1', agent_id: 'qa', task: 'Verify build', started_at: '2026-01-01T00:00:00Z' };
    const result = parseSessionJson(raw, 'snap-1.json');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('snap-1');
    expect(result!.agent_id).toBe('qa');
  });

  it('returns null when agentId is missing (cost-entry style)', () => {
    const raw = { sessionId: 'cost-xyz', model: 'opus', costUsd: 1.23 };
    const result = parseSessionJson(raw, 'cost-entry-xyz.json');
    expect(result).toBeNull();
  });

  it('returns null when id is completely absent', () => {
    const result = parseSessionJson({ agentId: 'cto', task: 'something' }, 'weird.json');
    expect(result).toBeNull();
  });

  it('defaults delegation_depth and resume_count to 0', () => {
    const raw = makeSessionData({ sessionId: 'def-test', agentId: 'qa' });
    const result = parseSessionJson(raw, 'def-test.json');
    expect(result!.delegation_depth).toBe(0);
    expect(result!.resume_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — parseFeedbackFilename
// ---------------------------------------------------------------------------

describe('parseFeedbackFilename', () => {
  it('extracts date and agentId from standard filename', () => {
    const result = parseFeedbackFilename('2026-03-26-ceo-v46-sprint-planning-memo.md');
    expect(result).not.toBeNull();
    expect(result!.date).toBe('2026-03-26T00:00:00Z');
    expect(result!.agentId).toBe('ceo');
  });

  it('handles multi-word agentId via frontmatter', () => {
    const content = '---\nid: abc\nagent: cost-optimization-lead\n---\nFeedback content.';
    const result = parseFeedbackFilename('2026-03-25-cost-optimization-lead-synthesis.md', content);
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe('cost-optimization-lead');
  });

  it('falls back to heuristic agentId when no frontmatter', () => {
    const result = parseFeedbackFilename('2026-03-25-cto-v3-roadmap-decision.md');
    expect(result).not.toBeNull();
    // heuristic stops before 'v3'
    expect(result!.agentId).toBe('cto');
  });

  it('returns null for a filename that does not match the date pattern', () => {
    const result = parseFeedbackFilename('no-date-here.md');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration tests — migrate()
// ---------------------------------------------------------------------------

describe('migrate()', () => {
  let dirs: FixtureDirs;

  beforeEach(() => {
    dirs = makeFixtureDirs();
  });

  afterEach(() => {
    rmSync(dirs.root, { recursive: true, force: true });
  });

  it('inserts sessions from a fixture directory', async () => {
    writeSessionFile(dirs.sessions, 'sess-001', makeSessionData({ sessionId: 'sess-001', agentId: 'cto' }));
    writeSessionFile(dirs.sessions, 'sess-002', makeSessionData({ sessionId: 'sess-002', agentId: 'qa' }));

    const stats = await migrate({
      dryRun: false,
      dbPath: dirs.dbPath,
      sessionsDir: dirs.sessions,
      feedbackDir: dirs.feedback,
    });

    expect(stats.sessionsFound).toBe(2);
    expect(stats.sessionsMigrated).toBe(2);
    expect(stats.sessionsSkipped).toBe(0);
    expect(stats.errors).toHaveLength(0);

    const adapter = openAdapter(dirs.dbPath);
    expect(adapter.getSession('sess-001')).not.toBeNull();
    expect(adapter.getSession('sess-002')).not.toBeNull();
  });

  it('is idempotent — running twice skips already-migrated records', async () => {
    writeSessionFile(dirs.sessions, 'sess-001', makeSessionData({ sessionId: 'sess-001', agentId: 'cto' }));

    const opts = { dryRun: false, dbPath: dirs.dbPath, sessionsDir: dirs.sessions, feedbackDir: dirs.feedback };

    const stats1 = await migrate(opts);
    expect(stats1.sessionsMigrated).toBe(1);
    expect(stats1.sessionsSkipped).toBe(0);

    const stats2 = await migrate(opts);
    expect(stats2.sessionsMigrated).toBe(0);
    expect(stats2.sessionsSkipped).toBe(1);
  });

  it('skips malformed JSON and records an error', async () => {
    writeFileSync(join(dirs.sessions, 'broken.json'), '{ not valid json }');

    const stats = await migrate({
      dryRun: false,
      dbPath: dirs.dbPath,
      sessionsDir: dirs.sessions,
      feedbackDir: dirs.feedback,
    });

    expect(stats.errors.length).toBeGreaterThanOrEqual(1);
    expect(stats.errors[0]).toMatch(/Parse error.*broken\.json/);
  });

  it('dry-run makes no DB changes', async () => {
    writeSessionFile(dirs.sessions, 'sess-dry', makeSessionData({ sessionId: 'sess-dry', agentId: 'cto' }));
    writeFeedbackFile(dirs.feedback, '2026-03-26-ceo-dry-run-memo.md', 'Some feedback content');

    const stats = await migrate({
      dryRun: true,
      dbPath: dirs.dbPath,
      sessionsDir: dirs.sessions,
      feedbackDir: dirs.feedback,
    });

    // Stats should show "would migrate"
    expect(stats.sessionsMigrated).toBe(1);
    expect(stats.feedbackMigrated).toBe(1);

    // But no DB file should contain any records (DB is never opened in dry-run)
    // Verify by opening a fresh adapter — the DB file won't exist yet
    const { existsSync } = await import('node:fs');
    expect(existsSync(dirs.dbPath)).toBe(false);
  });

  it('skips index.json in sessions directory', async () => {
    writeFileSync(join(dirs.sessions, 'index.json'), JSON.stringify([{ sessionId: 'idx' }]));
    writeSessionFile(dirs.sessions, 'sess-001', makeSessionData({ sessionId: 'sess-001', agentId: 'cto' }));

    const stats = await migrate({
      dryRun: false,
      dbPath: dirs.dbPath,
      sessionsDir: dirs.sessions,
      feedbackDir: dirs.feedback,
    });

    expect(stats.sessionsFound).toBe(1); // index.json excluded
    expect(stats.sessionsMigrated).toBe(1);
  });

  it('migrates feedback markdown files', async () => {
    // Include frontmatter so agentId is extracted reliably
    const content = '---\nagent: ceo\n---\n# Sprint Plan\nDetailed feedback here.';
    writeFeedbackFile(dirs.feedback, '2026-03-26-ceo-v47-sprint-planning.md', content);

    const stats = await migrate({
      dryRun: false,
      dbPath: dirs.dbPath,
      sessionsDir: dirs.sessions,
      feedbackDir: dirs.feedback,
    });

    expect(stats.feedbackFound).toBe(1);
    expect(stats.feedbackMigrated).toBe(1);
    expect(stats.feedbackSkipped).toBe(0);

    const adapter = openAdapter(dirs.dbPath);
    const feedback = adapter.listFeedback({ agentId: 'ceo' });
    expect(feedback).toHaveLength(1);
    expect(feedback[0]!.category).toBe('2026-03-26-ceo-v47-sprint-planning.md');
    expect(feedback[0]!.message).toContain('Detailed feedback here.');
  });

  it('skips empty feedback files', async () => {
    writeFeedbackFile(dirs.feedback, '2026-03-26-ceo-empty.md', '   \n  ');

    const stats = await migrate({
      dryRun: false,
      dbPath: dirs.dbPath,
      sessionsDir: dirs.sessions,
      feedbackDir: dirs.feedback,
    });

    expect(stats.feedbackSkipped).toBe(1);
    expect(stats.feedbackMigrated).toBe(0);
  });

  it('skips cost-entry files that lack agentId', async () => {
    writeSessionFile(dirs.sessions, 'cost-entry-abc-123', {
      sessionId: 'cost-abc',
      model: 'opus',
      costUsd: 2.5,
      inputTokens: 1000,
      outputTokens: 500,
    });

    const stats = await migrate({
      dryRun: false,
      dbPath: dirs.dbPath,
      sessionsDir: dirs.sessions,
      feedbackDir: dirs.feedback,
    });

    // cost-entry has no agentId — parseSessionJson returns null → skipped
    expect(stats.sessionsMigrated).toBe(0);
    expect(stats.sessionsSkipped).toBe(1);
    expect(stats.errors).toHaveLength(0);
  });
});
