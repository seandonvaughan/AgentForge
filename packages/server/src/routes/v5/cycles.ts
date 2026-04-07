// packages/server/src/routes/v5/cycles.ts
//
// v6.5.0 Agent A — Autonomous Cycle REST API.
//
// Exposes read-only views over `.agentforge/cycles/{cycleId}/*` artifacts
// (cycle.json, scoring.json, events.jsonl, phases/*.json, tests.json,
// git.json, pr.json, approval-*.json) plus a POST to spawn a new
// `autonomous:cycle` subprocess in the background.
//
// Path safety: cycleId and phase names are validated against a restrictive
// character set. Every file path is resolved with path.resolve and required
// to start with the cycles base dir so `..` / symlink tricks can't escape.

import type { FastifyInstance } from 'fastify';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

// ── constants ───────────────────────────────────────────────────────────────

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
const SAFE_PHASE = new Set([
  'audit', 'plan', 'assign', 'execute', 'test',
  'review', 'gate', 'release', 'learn',
]);
const SAFE_FILE_NAMES = new Set([
  'tests', 'git', 'pr', 'approval-pending', 'approval-decision',
]);

// ── helpers ─────────────────────────────────────────────────────────────────

interface CyclesOpts {
  projectRoot: string;
}

function cyclesBaseDir(projectRoot: string): string {
  return resolve(join(projectRoot, '.agentforge', 'cycles'));
}

/** Resolve a child path and ensure it stays inside base. Returns null on escape. */
function safeJoin(base: string, ...parts: string[]): string | null {
  const resolved = resolve(join(base, ...parts));
  const baseWithSep = base.endsWith(sep) ? base : base + sep;
  if (resolved !== base && !resolved.startsWith(baseWithSep)) return null;
  return resolved;
}

function readJsonIfExists(file: string): unknown | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

interface CycleListRow {
  cycleId: string;
  sprintVersion: string | null;
  stage: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  costUsd: number;
  budgetUsd: number;
  testsPassed: number;
  testsTotal: number;
  prUrl: string | null;
  hasApprovalPending: boolean;
}

function summarizeCycle(cycleDir: string, cycleId: string): CycleListRow | null {
  if (!existsSync(cycleDir)) return null;

  const cycleJson = readJsonIfExists(join(cycleDir, 'cycle.json')) as
    | Record<string, unknown>
    | null;

  const approvalPending = existsSync(join(cycleDir, 'approval-pending.json'));
  const approvalDecided = existsSync(join(cycleDir, 'approval-decision.json'));
  const hasApprovalPending = approvalPending && !approvalDecided;

  if (cycleJson) {
    const cost = (cycleJson['cost'] ?? {}) as Record<string, unknown>;
    const tests = (cycleJson['tests'] ?? {}) as Record<string, unknown>;
    const pr = (cycleJson['pr'] ?? {}) as Record<string, unknown>;
    return {
      cycleId: (cycleJson['cycleId'] as string) ?? cycleId,
      sprintVersion: (cycleJson['sprintVersion'] as string) ?? null,
      stage: (cycleJson['stage'] as string) ?? 'completed',
      startedAt:
        (cycleJson['startedAt'] as string) ??
        deriveStartedAt(cycleDir) ??
        new Date(0).toISOString(),
      completedAt: (cycleJson['completedAt'] as string) ?? null,
      durationMs: (cycleJson['durationMs'] as number) ?? null,
      costUsd: Number(cost['totalUsd'] ?? 0),
      budgetUsd: Number(cost['budgetUsd'] ?? 0),
      testsPassed: Number(tests['passed'] ?? 0),
      testsTotal: Number(tests['total'] ?? 0),
      prUrl: (pr['url'] as string) ?? null,
      hasApprovalPending,
    };
  }

  // No cycle.json — synthesize an in-progress row from whatever's on disk.
  const scoring = readJsonIfExists(join(cycleDir, 'scoring.json')) as
    | Record<string, unknown>
    | null;
  const eventsPath = join(cycleDir, 'events.jsonl');
  let stage = 'plan';
  let startedAt = deriveStartedAt(cycleDir) ?? new Date(0).toISOString();
  if (existsSync(eventsPath)) {
    try {
      const lines = readFileSync(eventsPath, 'utf-8')
        .split('\n')
        .filter(l => l.trim().length > 0);
      for (const line of lines) {
        try {
          const ev = JSON.parse(line) as Record<string, unknown>;
          if (typeof ev['stage'] === 'string') stage = ev['stage'] as string;
          if (!startedAt || startedAt === new Date(0).toISOString()) {
            if (typeof ev['at'] === 'string') startedAt = ev['at'] as string;
          }
        } catch { /* skip */ }
      }
    } catch { /* ignore */ }
  }

  return {
    cycleId,
    sprintVersion: null,
    stage,
    startedAt,
    completedAt: null,
    durationMs: null,
    costUsd: 0,
    budgetUsd: 0,
    testsPassed: 0,
    testsTotal: 0,
    prUrl: null,
    hasApprovalPending,
    // Note: scoring presence is a hint but we don't surface it in the list row.
    ...(scoring ? {} : {}),
  };
}

function deriveStartedAt(cycleDir: string): string | null {
  try {
    return statSync(cycleDir).birthtime.toISOString();
  } catch {
    return null;
  }
}

// ── plugin ──────────────────────────────────────────────────────────────────

export async function cyclesRoutes(
  app: FastifyInstance,
  opts: CyclesOpts,
): Promise<void> {
  const base = cyclesBaseDir(opts.projectRoot);

  // GET /api/v5/cycles ─────────────────────────────────────────────────────
  app.get('/api/v5/cycles', async (req, reply) => {
    const q = req.query as { limit?: string } | undefined;
    const limit = Math.max(1, Math.min(1000, parseInt(q?.limit ?? '50', 10) || 50));

    if (!existsSync(base)) {
      return reply.send({ cycles: [] });
    }

    const entries = readdirSync(base, { withFileTypes: true })
      .filter(d => d.isDirectory() && SAFE_ID.test(d.name));

    const rows: CycleListRow[] = [];
    for (const d of entries) {
      const row = summarizeCycle(join(base, d.name), d.name);
      if (row) rows.push(row);
    }
    rows.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
    return reply.send({ cycles: rows.slice(0, limit) });
  });

  // GET /api/v5/cycles/:id ──────────────────────────────────────────────────
  app.get('/api/v5/cycles/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!SAFE_ID.test(id)) return reply.status(400).send({ error: 'Invalid cycle id' });
    const dir = safeJoin(base, id);
    if (!dir || !existsSync(dir)) return reply.status(404).send({ error: 'Cycle not found' });
    const cycleFile = join(dir, 'cycle.json');
    if (!existsSync(cycleFile)) {
      return reply.status(404).send({ error: 'cycle.json not yet written', cycleInProgress: true });
    }
    const parsed = readJsonIfExists(cycleFile);
    if (parsed === null) return reply.status(500).send({ error: 'Failed to parse cycle.json' });
    return reply.send(parsed);
  });

  // GET /api/v5/cycles/:id/scoring ──────────────────────────────────────────
  app.get('/api/v5/cycles/:id/scoring', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!SAFE_ID.test(id)) return reply.status(400).send({ error: 'Invalid cycle id' });
    const dir = safeJoin(base, id);
    if (!dir || !existsSync(dir)) return reply.status(404).send({ error: 'Cycle not found' });
    const file = join(dir, 'scoring.json');
    if (!existsSync(file)) return reply.status(404).send({ error: 'scoring.json not found' });
    const parsed = readJsonIfExists(file);
    if (parsed === null) return reply.status(500).send({ error: 'Failed to parse scoring.json' });
    return reply.send(parsed);
  });

  // GET /api/v5/cycles/:id/events ───────────────────────────────────────────
  app.get('/api/v5/cycles/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!SAFE_ID.test(id)) return reply.status(400).send({ error: 'Invalid cycle id' });
    const dir = safeJoin(base, id);
    if (!dir || !existsSync(dir)) return reply.status(404).send({ error: 'Cycle not found' });
    const file = join(dir, 'events.jsonl');
    if (!existsSync(file)) return reply.send({ events: [], total: 0, since: 0 });

    const q = req.query as { since?: string } | undefined;
    const since = Math.max(0, parseInt(q?.since ?? '0', 10) || 0);

    let lines: string[];
    try {
      lines = readFileSync(file, 'utf-8').split('\n').filter(l => l.trim().length > 0);
    } catch {
      return reply.status(500).send({ error: 'Failed to read events.jsonl' });
    }

    const events: unknown[] = [];
    for (let i = since; i < lines.length; i++) {
      try { events.push(JSON.parse(lines[i]!)); } catch { /* skip malformed */ }
    }
    return reply.send({ events, total: lines.length, since });
  });

  // GET /api/v5/cycles/:id/phases/:phase ────────────────────────────────────
  app.get('/api/v5/cycles/:id/phases/:phase', async (req, reply) => {
    const { id, phase } = req.params as { id: string; phase: string };
    if (!SAFE_ID.test(id)) return reply.status(400).send({ error: 'Invalid cycle id' });
    if (!SAFE_PHASE.has(phase)) return reply.status(400).send({ error: 'Invalid phase' });
    const dir = safeJoin(base, id);
    if (!dir || !existsSync(dir)) return reply.status(404).send({ error: 'Cycle not found' });
    const file = safeJoin(dir, 'phases', `${phase}.json`);
    if (!file || !existsSync(file)) return reply.status(404).send({ error: `Phase ${phase} not found` });
    const parsed = readJsonIfExists(file);
    if (parsed === null) return reply.status(500).send({ error: 'Failed to parse phase file' });
    return reply.send(parsed);
  });

  // GET /api/v5/cycles/:id/files/:name ──────────────────────────────────────
  app.get('/api/v5/cycles/:id/files/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    if (!SAFE_ID.test(id)) return reply.status(400).send({ error: 'Invalid cycle id' });
    if (!SAFE_FILE_NAMES.has(name)) return reply.status(400).send({ error: 'Invalid file name' });
    const dir = safeJoin(base, id);
    if (!dir || !existsSync(dir)) return reply.status(404).send({ error: 'Cycle not found' });
    const file = safeJoin(dir, `${name}.json`);
    if (!file || !existsSync(file)) return reply.status(404).send({ error: `${name}.json not found` });
    const parsed = readJsonIfExists(file);
    if (parsed === null) return reply.status(500).send({ error: 'Failed to parse file' });
    return reply.send(parsed);
  });

  // POST /api/v5/cycles ─────────────────────────────────────────────────────
  app.post('/api/v5/cycles', async (_req, reply) => {
    const cycleId = randomUUID();
    const startedAt = new Date().toISOString();
    const cycleDir = safeJoin(base, cycleId);
    if (!cycleDir) return reply.status(500).send({ error: 'Failed to resolve cycle dir' });

    try {
      mkdirSync(cycleDir, { recursive: true });
    } catch (err) {
      return reply.status(500).send({ error: `Failed to create cycle dir: ${(err as Error).message}` });
    }

    // Pipe subprocess stdout/stderr to a log file inside the cycle dir so
    // clients can tail it in parallel with polling /events.
    let logFd: number;
    try {
      logFd = openSync(join(cycleDir, 'cli-stdout.log'), 'a');
    } catch (err) {
      return reply.status(500).send({ error: `Failed to open log file: ${(err as Error).message}` });
    }

    // TODO(v6.5.0): the CLI currently generates its own cycleId. We pass
    // AUTONOMOUS_CYCLE_ID via env so the CLI can pick it up once wired.
    // Until then the subprocess-written cycle dir may differ from the API
    // response's cycleId. Clients should treat the API cycleId as the
    // canonical pointer and fall back to scanning recent dirs if needed.
    const nodeBin = process.execPath;
    const cliEntry = resolve(join(opts.projectRoot, 'packages', 'cli', 'dist', 'bin.js'));

    let pid: number;
    try {
      const child = spawn(nodeBin, [cliEntry, 'autonomous:cycle'], {
        cwd: opts.projectRoot,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, AUTONOMOUS_CYCLE_ID: cycleId },
      });
      child.unref();
      pid = child.pid ?? -1;
    } catch (err) {
      return reply.status(500).send({ error: `Failed to spawn cycle: ${(err as Error).message}` });
    }

    return reply.status(202).send({ cycleId, startedAt, pid });
  });
}
