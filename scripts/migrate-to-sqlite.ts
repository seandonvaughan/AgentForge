#!/usr/bin/env npx tsx
/**
 * Migrate historical JSON session files and feedback markdown to SQLite.
 * Idempotent: safe to run multiple times (skips existing records).
 *
 * Usage: npx tsx scripts/migrate-to-sqlite.ts [--dry-run] [--db-path <path>]
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentDatabase } from '../src/db/database.js';
import { SqliteAdapter } from '../src/db/sqlite-adapter.js';
import type { SessionRow } from '../src/db/database.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MigrationStats {
  sessionsFound: number;
  sessionsMigrated: number;
  sessionsSkipped: number;
  feedbackFound: number;
  feedbackMigrated: number;
  feedbackSkipped: number;
  errors: string[];
}

/** Flexible shape of session JSON files on disk (multiple legacy formats). */
interface RawSessionJson {
  sessionId?: string;
  id?: string;
  agentId?: string;
  agent_id?: string;
  agentName?: string;
  agent_name?: string;
  model?: string;
  task?: string;
  objective?: string;
  response?: string;
  status?: string;
  startedAt?: string;
  started_at?: string;
  completedAt?: string;
  completed_at?: string;
  estimatedTokens?: number;
  estimated_tokens?: number;
  autonomyTier?: number;
  autonomy_tier?: number;
  resumeCount?: number;
  resume_count?: number;
  parentSessionId?: string;
  parent_session_id?: string;
  delegationDepth?: number;
  delegation_depth?: number;
  // older task-record fields — used to derive a pseudo-session
  task_id?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a raw JSON object from a session file into a SessionRow-compatible
 * object. Returns null if the record cannot be meaningfully mapped
 * (e.g. cost-entry files that lack session-like data).
 */
export function parseSessionJson(raw: RawSessionJson, filename: string): Omit<SessionRow, 'created_at'> | null {
  // Determine ID — prefer explicit sessionId / id, fall back to task_id
  const id = raw.sessionId ?? raw.id ?? raw.task_id;
  if (!id) return null;

  // Skip cost-entry files — they lack an agentId / agent_id
  const agentId = raw.agentId ?? raw.agent_id;
  if (!agentId) return null;

  const task = raw.task ?? raw.objective ?? '';
  const startedAt = raw.startedAt ?? raw.started_at ?? new Date(0).toISOString();

  return {
    id,
    agent_id: agentId,
    agent_name: raw.agentName ?? raw.agent_name ?? null,
    model: raw.model ?? null,
    task,
    response: raw.response ?? null,
    status: raw.status ?? 'completed',
    started_at: startedAt,
    completed_at: raw.completedAt ?? raw.completed_at ?? null,
    estimated_tokens: raw.estimatedTokens ?? raw.estimated_tokens ?? null,
    autonomy_tier: raw.autonomyTier ?? raw.autonomy_tier ?? null,
    resume_count: raw.resumeCount ?? raw.resume_count ?? 0,
    parent_session_id: raw.parentSessionId ?? raw.parent_session_id ?? null,
    delegation_depth: raw.delegationDepth ?? raw.delegation_depth ?? 0,
  };
}

/**
 * Extract agentId from a feedback filename (and optionally file content).
 * Pattern: <date>-<agentId>-<slug>.md
 * Example: 2026-03-26-ceo-v46-sprint-planning-memo.md → { date: '2026-03-26', agentId: 'ceo' }
 *
 * If fileContent is provided and contains a YAML frontmatter `agent:` field,
 * that value takes precedence over the filename heuristic.
 */
export function parseFeedbackFilename(
  filename: string,
  fileContent?: string,
): { date: string; agentId: string } | null {
  // Remove .md extension
  const base = filename.endsWith('.md') ? filename.slice(0, -3) : filename;
  // Pattern: YYYY-MM-DD-<rest>
  const dateMatch = base.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
  if (!dateMatch) return null;

  const date = dateMatch[1]!;
  const rest = dateMatch[2]!; // everything after the date

  // 1) Try frontmatter: `agent: <agentId>` in the first few lines of content
  if (fileContent) {
    const fmMatch = fileContent.match(/^---[\s\S]*?^agent:\s*([^\n\r]+)/m);
    if (fmMatch) {
      return { date: date + 'T00:00:00Z', agentId: fmMatch[1]!.trim() };
    }
  }

  // 2) Heuristic: split on '-', accumulate non-version, non-numeric parts as agentId
  //    until we hit a version prefix (v\d) or a pure number.
  const parts = rest.split('-');
  const agentParts: string[] = [];
  for (const part of parts) {
    if (/^v\d/.test(part) || /^\d+$/.test(part)) break;
    agentParts.push(part);
  }
  const agentId = agentParts.length > 0 ? agentParts.join('-') : rest;

  return { date: date + 'T00:00:00Z', agentId };
}

// ---------------------------------------------------------------------------
// Core migration function
// ---------------------------------------------------------------------------

export async function migrate(opts: {
  dryRun: boolean;
  dbPath: string;
  sessionsDir?: string;
  feedbackDir?: string;
}): Promise<MigrationStats> {
  const stats: MigrationStats = {
    sessionsFound: 0,
    sessionsMigrated: 0,
    sessionsSkipped: 0,
    feedbackFound: 0,
    feedbackMigrated: 0,
    feedbackSkipped: 0,
    errors: [],
  };

  // Resolve dirs relative to dbPath's parent by default
  const baseDir = resolve(opts.dbPath, '..', '..');
  const sessionsDir = opts.sessionsDir ?? join(baseDir, '.agentforge', 'sessions');
  const feedbackDir = opts.feedbackDir ?? join(baseDir, '.agentforge', 'feedback');

  // Open DB (or skip if dry-run)
  let adapter: SqliteAdapter | null = null;
  if (!opts.dryRun) {
    const db = new AgentDatabase({ path: opts.dbPath });
    adapter = new SqliteAdapter({ db });
  }

  // -------------------------------------------------------------------------
  // Migrate sessions
  // -------------------------------------------------------------------------

  const log = (msg: string) => process.stdout.write(msg + '\n');

  log(`\nScanning ${sessionsDir}...`);

  let sessionFiles: string[] = [];
  try {
    const entries = await readdir(sessionsDir);
    sessionFiles = entries.filter(f => f.endsWith('.json') && f !== 'index.json');
  } catch {
    log(`  (directory not found, skipping sessions)`);
  }

  stats.sessionsFound = sessionFiles.length;
  log(`  Found ${sessionFiles.length} session files`);

  let migrated = 0;
  let skipped = 0;

  for (const filename of sessionFiles) {
    const filePath = join(sessionsDir, filename);
    try {
      const content = await readFile(filePath, 'utf-8');
      let raw: RawSessionJson;
      try {
        raw = JSON.parse(content) as RawSessionJson;
      } catch {
        stats.errors.push(`Parse error: ${filename}`);
        continue;
      }

      const record = parseSessionJson(raw, filename);
      if (!record) {
        // Not a migratable session (e.g. cost entry or malformed)
        skipped++;
        continue;
      }

      if (opts.dryRun) {
        migrated++;
        continue;
      }

      // Check for existing record
      const existing = adapter!.getSession(record.id);
      if (existing) {
        skipped++;
        continue;
      }

      try {
        adapter!.insertSession(record);
        migrated++;
      } catch (err) {
        // Likely a duplicate key — treat as skip
        skipped++;
      }
    } catch (err) {
      stats.errors.push(`Read error: ${filename} — ${String(err)}`);
    }
  }

  stats.sessionsMigrated = migrated;
  stats.sessionsSkipped = skipped;
  log(`  \u2713 Migrated ${migrated} sessions`);
  if (skipped > 0) log(`  \u21B7 Skipped ${skipped} (already exists or non-session)`);

  // -------------------------------------------------------------------------
  // Migrate feedback
  // -------------------------------------------------------------------------

  log(`\nScanning ${feedbackDir}...`);

  let feedbackFiles: string[] = [];
  try {
    const entries = await readdir(feedbackDir);
    feedbackFiles = entries.filter(f => f.endsWith('.md'));
  } catch {
    log(`  (directory not found, skipping feedback)`);
  }

  stats.feedbackFound = feedbackFiles.length;
  log(`  Found ${feedbackFiles.length} feedback files`);

  let fbMigrated = 0;
  let fbSkipped = 0;

  for (const filename of feedbackFiles) {
    const filePath = join(feedbackDir, filename);
    try {
      const content = await readFile(filePath, 'utf-8');
      if (!content.trim()) {
        fbSkipped++;
        continue;
      }

      const meta = parseFeedbackFilename(filename, content);
      if (!meta) {
        stats.errors.push(`Cannot parse filename: ${filename}`);
        fbSkipped++;
        continue;
      }

      if (opts.dryRun) {
        fbMigrated++;
        continue;
      }

      try {
        adapter!.insertFeedback({
          id: randomUUID(),
          agent_id: meta.agentId,
          session_id: null,
          category: filename,
          message: content,
          sentiment: null,
          created_at: meta.date,
        });
        fbMigrated++;
      } catch {
        // Duplicate or constraint violation — skip
        fbSkipped++;
      }
    } catch (err) {
      stats.errors.push(`Read error (feedback): ${filename} — ${String(err)}`);
    }
  }

  stats.feedbackMigrated = fbMigrated;
  stats.feedbackSkipped = fbSkipped;
  log(`  \u2713 Migrated ${fbMigrated} feedback entries`);
  if (fbSkipped > 0) log(`  \u21B7 Skipped ${fbSkipped} (empty or duplicate)`);

  return stats;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const dbPathIdx = args.indexOf('--db-path');
  const dbPath = dbPathIdx !== -1 && args[dbPathIdx + 1]
    ? resolve(args[dbPathIdx + 1]!)
    : resolve('.agentforge', 'audit.db');

  const displayDb = dbPath.replace(process.cwd() + '/', '');
  const mode = dryRun ? 'DRY RUN' : 'LIVE';

  process.stdout.write('AgentForge \u2192 SQLite Migration\n');
  process.stdout.write('==============================\n');
  process.stdout.write(`DB:   ${displayDb}\n`);
  process.stdout.write(`Mode: ${mode}\n`);

  const stats = await migrate({ dryRun, dbPath });

  process.stdout.write('\n==============================\n');

  if (stats.errors.length > 0) {
    process.stdout.write(`Errors:\n`);
    for (const e of stats.errors) {
      process.stdout.write(`  ! ${e}\n`);
    }
  }

  process.stdout.write(
    `Done. ${stats.sessionsMigrated} sessions, ${stats.feedbackMigrated} feedback entries migrated. ` +
    `${stats.errors.length} errors.\n`
  );

  if (stats.errors.length > 0) process.exit(1);
}

// Only run main when invoked directly (not when imported in tests)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    process.stderr.write(String(err) + '\n');
    process.exit(1);
  });
}
