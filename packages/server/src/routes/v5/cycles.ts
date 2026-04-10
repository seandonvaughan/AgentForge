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
  writeFileSync,
  statSync,
  mkdirSync,
  openSync,
  open as fsOpen,
  read as fsRead,
  close as fsClose,
} from 'node:fs';
import { join, resolve, sep, basename, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { globalStream } from './stream.js';
import { getWorkspace } from '@agentforge/core';
import * as cycleSessions from '../../lib/cycle-sessions.js';

/**
 * v6.6.0 — resolve which project root a request targets.
 *
 * Returns:
 *   { projectRoot } if no workspaceId was supplied (use server default)
 *   { projectRoot } if the supplied workspaceId resolves to a workspace
 *   { error: 404 } if the workspaceId is unknown
 *
 * Reads workspaceId from the `?workspaceId=` query param OR the
 * `x-workspace-id` header (query takes precedence).
 */
function resolveProjectRoot(
  req: { query: unknown; headers: Record<string, unknown> },
  fallbackRoot: string,
): { projectRoot: string } | { error: { status: number; body: unknown } } {
  const q = (req.query ?? {}) as { workspaceId?: string };
  const headerVal = req.headers['x-workspace-id'];
  const workspaceId =
    (typeof q.workspaceId === 'string' && q.workspaceId.length > 0
      ? q.workspaceId
      : typeof headerVal === 'string' && headerVal.length > 0
        ? headerVal
        : null);
  if (!workspaceId) return { projectRoot: fallbackRoot };
  const ws = getWorkspace(workspaceId);
  if (!ws) {
    return { error: { status: 404, body: { error: 'workspace not found', workspaceId } } };
  }
  return { projectRoot: ws.path };
}

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
    let costUsd = Number(cost['totalUsd'] ?? 0);
    let testsPassed = Number(tests['passed'] ?? 0);
    let testsTotal = Number(tests['total'] ?? 0);
    // v6.7.4 cost heal: cycle.json with $0 cost on a gate-rejected cycle
    // is missing real spend. Aggregate from phases/*.json same way the
    // detail endpoint does.
    if (costUsd === 0 && existsSync(join(cycleDir, 'phases'))) {
      const phasesDir = join(cycleDir, 'phases');
      for (const name of ['audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate', 'release', 'learn']) {
        const pf = join(phasesDir, `${name}.json`);
        if (!existsSync(pf)) continue;
        try {
          const ph = JSON.parse(readFileSync(pf, 'utf-8')) as Record<string, unknown>;
          if (typeof ph['costUsd'] === 'number') costUsd += ph['costUsd'] as number;
          if (name === 'test') {
            if (typeof ph['passed'] === 'number') testsPassed = ph['passed'] as number;
            if (typeof ph['total'] === 'number') testsTotal = ph['total'] as number;
          }
        } catch { /* skip */ }
      }
    }
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
      costUsd,
      budgetUsd: Number(cost['budgetUsd'] ?? 200),
      testsPassed,
      testsTotal,
      prUrl: (pr['url'] as string) ?? null,
      hasApprovalPending,
    };
  }

  // No cycle.json — synthesize an in-progress row from whatever's on disk.
  const eventsPath = join(cycleDir, 'events.jsonl');
  let stage = 'plan';
  let startedAt = deriveStartedAt(cycleDir) ?? new Date(0).toISOString();
  let lastEventAt = 0;
  if (existsSync(eventsPath)) {
    try {
      const lines = readFileSync(eventsPath, 'utf-8')
        .split('\n')
        .filter(l => l.trim().length > 0);
      for (const line of lines) {
        try {
          const ev = JSON.parse(line) as Record<string, unknown>;
          if (typeof ev['stage'] === 'string') stage = ev['stage'] as string;
          else if (ev['type'] === 'phase.start' && typeof ev['phase'] === 'string') {
            stage = ev['phase'] as string;
          }
          if (!startedAt || startedAt === new Date(0).toISOString()) {
            if (typeof ev['at'] === 'string') startedAt = ev['at'] as string;
          }
          if (typeof ev['at'] === 'string') {
            const t = new Date(ev['at'] as string).getTime();
            if (t > lastEventAt) lastEventAt = t;
          }
        } catch { /* skip */ }
      }
    } catch { /* ignore */ }
  }

  // v6.7.4 stale-cycle detection: if the last event is older than 5 minutes
  // AND the session manager has no live record of this cycle, the parent
  // process must be dead. Mark it crashed instead of showing it as running
  // forever. This catches cycles spawned before the session manager existed
  // and parent processes that died without writing cycle.json.
  if (lastEventAt > 0 && Date.now() - lastEventAt > 5 * 60_000) {
    try {
      const cycleSessions = require('../../lib/cycle-sessions.js') as typeof import('../../lib/cycle-sessions.js');
      const session = cycleSessions.get(cycleId);
      const isLive = session && session.status === 'running' && cycleSessions.isPidAlive(session.pid);
      if (!isLive) {
        stage = 'crashed';
      }
    } catch { /* if session manager unavailable, fall through */ }
  }

  // Aggregate live cost + test totals from phases/<name>.json so the list
  // row matches what the detail page shows. Without this, running cycles
  // appear as "$0.00 / 0 tests" until they write cycle.json at terminal.
  const phasesDir = join(cycleDir, 'phases');
  let costUsd = 0;
  let testsPassed = 0;
  let testsTotal = 0;
  let executeJsonExists = false;
  if (existsSync(phasesDir)) {
    for (const name of ['audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate', 'release', 'learn']) {
      const phaseFile = join(phasesDir, `${name}.json`);
      if (!existsSync(phaseFile)) continue;
      if (name === 'execute') executeJsonExists = true;
      try {
        const phase = JSON.parse(readFileSync(phaseFile, 'utf-8')) as Record<string, unknown>;
        if (typeof phase['costUsd'] === 'number') costUsd += phase['costUsd'] as number;
        if (name === 'test') {
          if (typeof phase['passed'] === 'number') testsPassed = phase['passed'] as number;
          if (typeof phase['total'] === 'number') testsTotal = phase['total'] as number;
        }
      } catch { /* skip */ }
    }
  }

  // Fallback: if execute.json isn't written yet, synthesize cost from
  // the sprint file item estimatedCostUsd sums — but ONLY when this
  // cycle has its own sprint-link.json. Without the link we cannot
  // know which sprint file belongs to this cycle, and the previous
  // mtime-based "newest sprint" fallback caused PLAN-stage cycles to
  // show $143 by reading a leftover sprint from a totally unrelated
  // earlier cycle (v6.7.4 user-reported bug).
  if (!executeJsonExists) {
    try {
      const linkFile = join(cycleDir, 'sprint-link.json');
      if (existsSync(linkFile)) {
        const sprintVersion = JSON.parse(readFileSync(linkFile, 'utf-8'))?.sprintVersion ?? null;
        if (sprintVersion) {
          const sprintFile = join(process.cwd(), '.agentforge/sprints', `v${sprintVersion}.json`);
          if (existsSync(sprintFile)) {
            const raw = JSON.parse(readFileSync(sprintFile, 'utf-8'));
            const sprint = Array.isArray(raw.sprints) ? raw.sprints[0] : raw;
            const items = sprint?.items ?? [];
            for (const it of items) {
              if ((it.status === 'completed' || it.status === 'in_progress') && typeof it.estimatedCostUsd === 'number') {
                costUsd += it.estimatedCostUsd;
              }
            }
          }
        }
      }
    } catch { /* non-fatal */ }
  }

  return {
    cycleId,
    sprintVersion: null,
    stage,
    startedAt,
    completedAt: null,
    durationMs: Date.now() - new Date(startedAt).getTime(),
    costUsd,
    budgetUsd: 200,
    testsPassed,
    testsTotal,
    prUrl: null,
    hasApprovalPending,
  };
}

function deriveStartedAt(cycleDir: string): string | null {
  try {
    return statSync(cycleDir).birthtime.toISOString();
  } catch {
    return null;
  }
}

// ── cycle events watcher (v6.5.3-B) ─────────────────────────────────────────
//
// Polls .agentforge/cycles/*/events.jsonl files every 500ms. Tracks the byte
// offset per file at the moment we first see it so historical events are NOT
// re-emitted on server start. Only bytes appended after the watcher began
// are parsed and pushed to the SSE stream.

export interface CycleEventsWatcher {
  stop: () => void;
  /** Process one tick immediately. Exposed for testing. */
  tick: () => Promise<void>;
}

interface WatcherPublish {
  emit: (msg: { cycleId: string; type: string; phase?: string; at: string; payload: unknown }) => void;
}

export function startCycleEventsWatcher(
  projectRoot: string,
  publish: WatcherPublish = {
    emit: (msg) => globalStream.emit({
      type: 'cycle_event',
      category: msg.type,
      message: `${msg.cycleId.slice(0, 8)} · ${msg.type}${msg.phase ? ` · ${msg.phase}` : ''}`,
      data: msg as unknown as Record<string, unknown>,
    }),
  },
  intervalMs = 500,
): CycleEventsWatcher {
  const base = cyclesBaseDir(projectRoot);
  // Map from absolute file path -> last-known byte offset (cycle id derived from path)
  const offsets = new Map<string, number>();
  // Leftover buffer for partial last lines (no trailing newline yet)
  const leftover = new Map<string, string>();

  function discoverFiles(): string[] {
    if (!existsSync(base)) return [];
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      return [];
    }
    const files: string[] = [];
    for (const d of entries) {
      if (!d.isDirectory() || !SAFE_ID.test(d.name)) continue;
      const f = join(base, d.name, 'events.jsonl');
      if (existsSync(f)) files.push(f);
    }
    return files;
  }

  async function tick(): Promise<void> {
    const files = discoverFiles();
    for (const file of files) {
      let size: number;
      try {
        size = statSync(file).size;
      } catch {
        continue;
      }
      const known = offsets.get(file);
      if (known === undefined) {
        // First time seeing this file — anchor at current size, do NOT emit history.
        offsets.set(file, size);
        continue;
      }
      if (size <= known) {
        // No new bytes (or file truncated/rotated — reset anchor)
        if (size < known) offsets.set(file, size);
        continue;
      }
      // Read appended bytes
      const len = size - known;
      const buf = Buffer.alloc(len);
      try {
        await new Promise<void>((res, rej) => {
          fsOpen(file, 'r', (err, fd) => {
            if (err) return rej(err);
            fsRead(fd, buf, 0, len, known, (rerr) => {
              fsClose(fd, () => {
                if (rerr) rej(rerr); else res();
              });
            });
          });
        });
      } catch {
        continue;
      }
      offsets.set(file, size);
      const text = (leftover.get(file) ?? '') + buf.toString('utf-8');
      const lines = text.split('\n');
      const last = lines.pop() ?? '';
      leftover.set(file, last); // partial trailing line, may complete next tick
      const cycleId = basename(dirname(file));
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }
        const msg: { cycleId: string; type: string; phase?: string; at: string; payload: unknown } = {
          cycleId,
          type: typeof parsed['type'] === 'string' ? (parsed['type'] as string) : 'event',
          at: typeof parsed['at'] === 'string'
            ? (parsed['at'] as string)
            : (typeof parsed['timestamp'] === 'string' ? (parsed['timestamp'] as string) : new Date().toISOString()),
          payload: parsed,
        };
        if (typeof parsed['phase'] === 'string') msg.phase = parsed['phase'] as string;
        publish.emit(msg);
      }
    }
  }

  let stopped = false;
  const handle = setInterval(() => {
    if (stopped) return;
    void tick().catch(() => { /* swallow */ });
  }, intervalMs);
  // Don't keep the event loop alive solely for the watcher
  if (typeof (handle as unknown as { unref?: () => void }).unref === 'function') {
    (handle as unknown as { unref: () => void }).unref();
  }

  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
    tick,
  };
}

// ── plugin ──────────────────────────────────────────────────────────────────

export async function cyclesRoutes(
  app: FastifyInstance,
  opts: CyclesOpts,
): Promise<void> {
  const defaultBase = cyclesBaseDir(opts.projectRoot);

  // v6.5.3-B: fan cycle events out to the SSE stream.
  const watcher = startCycleEventsWatcher(opts.projectRoot);
  // v6.7.4: cycle session manager — periodic reaper that catches dead PIDs
  // and flips their session status to crashed. Probes every 30s.
  cycleSessions.reap();
  const reaper = cycleSessions.startReaper(30_000);
  app.addHook('onClose', async () => {
    watcher.stop();
    reaper.stop();
  });

  // GET /api/v5/cycle-sessions ────────────────────────────────────────────
  // Lists every cycle the session manager knows about (running + terminal).
  // Path is /cycle-sessions (not /cycles/sessions) so it doesn't collide
  // with the /cycles/:id parameterized route.
  //
  // v6.7.4+: each session row now includes `hasApprovalPending` — true when
  // approval-pending.json exists but approval-decision.json does not. The
  // dashboard approvals store uses this flag to drive the review modal without
  // having to scan the full cycles list endpoint.
  app.get('/api/v5/cycle-sessions', async (_req, reply) => {
    cycleSessions.reap();
    const sessions = cycleSessions.list();

    const enriched = sessions.map((s) => {
      let hasApprovalPending = false;
      try {
        const cycleDir = join(cyclesBaseDir(s.workspaceRoot), s.cycleId);
        const pendingFile = join(cycleDir, 'approval-pending.json');
        const decisionFile = join(cycleDir, 'approval-decision.json');
        hasApprovalPending = existsSync(pendingFile) && !existsSync(decisionFile);
      } catch { /* workspace may not be accessible — treat as no pending */ }
      return { ...s, hasApprovalPending };
    });

    return reply.send({
      sessions: enriched,
      counts: {
        total: enriched.length,
        running: enriched.filter((s) => s.status === 'running').length,
        crashed: enriched.filter((s) => s.status === 'crashed').length,
        killed: enriched.filter((s) => s.status === 'killed').length,
        approvalPending: enriched.filter((s) => s.hasApprovalPending).length,
      },
    });
  });

  // POST /api/v5/cycle-sessions/reap ───────────────────────────────────────
  app.post('/api/v5/cycle-sessions/reap', async (_req, reply) => {
    return reply.send(cycleSessions.reap());
  });

  // GET /api/v5/cycles/:id/approval ─────────────────────────────────────────
  // Returns the approval-pending.json contents if a cycle is awaiting human
  // approval, or 404 if there's nothing to approve. Drives the dashboard
  // approval modal.
  app.get('/api/v5/cycles/:id/approval', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!SAFE_ID.test(id)) return reply.status(400).send({ error: 'Invalid cycle id' });
    const br = baseForRequest(req);
    if ('error' in br) return reply.status(br.error.status).send(br.error.body);
    const dir = safeJoin(br.base, id);
    if (!dir) return reply.status(404).send({ error: 'Cycle not found' });
    const pendingFile = join(dir, 'approval-pending.json');
    if (!existsSync(pendingFile)) return reply.status(404).send({ error: 'No pending approval' });
    const decisionFile = join(dir, 'approval-decision.json');
    if (existsSync(decisionFile)) return reply.status(409).send({ error: 'Already decided' });
    try {
      const pending = JSON.parse(readFileSync(pendingFile, 'utf8')) as Record<string, unknown>;
      // v9.4+: enrich with sprintVersion from sprint-link.json so the dashboard
      // modal can show which sprint this cycle was assigned to.
      const sprintLinkFile = join(dir, 'sprint-link.json');
      if (existsSync(sprintLinkFile)) {
        try {
          const link = JSON.parse(readFileSync(sprintLinkFile, 'utf8')) as { sprintVersion?: string };
          if (link.sprintVersion) pending.sprintVersion = link.sprintVersion;
        } catch { /* sprint-link.json unreadable — omit sprintVersion */ }
      }
      return reply.send(pending);
    } catch (err) {
      return reply.status(500).send({ error: `Failed to read approval-pending.json: ${(err as Error).message}` });
    }
  });

  // POST /api/v5/cycles/:id/approve ──────────────────────────────────────────
  // Writes the approval-decision.json that BudgetApproval.pollDecisionFile
  // is waiting for. Body shape: { approvedItemIds: string[], rejectedItemIds?: string[] }
  // If body.approveAll === true, every within-budget item is approved and
  // every overflow item rejected (the common "yes, ship the within-budget
  // batch" path). Drives the dashboard approval modal.
  app.post('/api/v5/cycles/:id/approve', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!SAFE_ID.test(id)) return reply.status(400).send({ error: 'Invalid cycle id' });
    const br = baseForRequest(req);
    if ('error' in br) return reply.status(br.error.status).send(br.error.body);
    const dir = safeJoin(br.base, id);
    if (!dir) return reply.status(404).send({ error: 'Cycle not found' });
    const pendingFile = join(dir, 'approval-pending.json');
    if (!existsSync(pendingFile)) return reply.status(404).send({ error: 'No pending approval' });
    const decisionFile = join(dir, 'approval-decision.json');
    if (existsSync(decisionFile)) return reply.status(409).send({ error: 'Already decided' });

    const body = (req.body ?? {}) as {
      approveAll?: boolean;
      approvedItemIds?: string[];
      rejectedItemIds?: string[];
      decidedBy?: string;
    };

    let approvedItemIds: string[] = [];
    let rejectedItemIds: string[] = [];
    if (body.approveAll) {
      try {
        const pending = JSON.parse(readFileSync(pendingFile, 'utf8'));
        approvedItemIds = (pending?.withinBudget?.items ?? []).map((i: any) => i.itemId);
        rejectedItemIds = (pending?.overflow?.items ?? []).map((i: any) => i.itemId);
      } catch (err) {
        return reply.status(500).send({ error: `Failed to read approval-pending.json: ${(err as Error).message}` });
      }
    } else {
      approvedItemIds = Array.isArray(body.approvedItemIds) ? body.approvedItemIds : [];
      rejectedItemIds = Array.isArray(body.rejectedItemIds) ? body.rejectedItemIds : [];
    }

    if (approvedItemIds.length === 0 && rejectedItemIds.length === 0) {
      return reply.status(400).send({ error: 'No items provided. Pass approveAll: true or approvedItemIds: [...]' });
    }

    const decision = {
      cycleId: id,
      decision: approvedItemIds.length > 0 ? 'approved' : 'rejected',
      approvedItemIds,
      rejectedItemIds,
      decidedBy: body.decidedBy ?? 'dashboard',
      decidedAt: new Date().toISOString(),
    };
    try {
      writeFileSync(decisionFile, JSON.stringify(decision, null, 2));
      return reply.send({ ok: true, decision });
    } catch (err) {
      return reply.status(500).send({ error: `Failed to write decision: ${(err as Error).message}` });
    }
  });

  // POST /api/v5/cycles/:id/stop ────────────────────────────────────────────
  // Graceful stop: SIGTERM to the process group, wait 10s, then SIGKILL.
  app.post('/api/v5/cycles/:id/stop', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!SAFE_ID.test(id)) return reply.status(400).send({ error: 'Invalid cycle id' });
    const session = cycleSessions.get(id);
    if (!session) return reply.status(404).send({ error: 'No session for this cycle id' });
    const result = await cycleSessions.stop(id);
    return reply.send({ cycleId: id, ...result });
  });

  /**
   * v6.6.0 — given an inbound request, return either the cycles base
   * directory to use for that request, or a 404-shaped error object.
   * Default base (server's projectRoot) is used when no workspaceId is
   * supplied — backwards compatible.
   */
  function baseForRequest(
    req: { query: unknown; headers: Record<string, unknown> },
  ): { base: string } | { error: { status: number; body: unknown } } {
    const r = resolveProjectRoot(req, opts.projectRoot);
    if ('error' in r) return r;
    if (r.projectRoot === opts.projectRoot) return { base: defaultBase };
    return { base: cyclesBaseDir(r.projectRoot) };
  }

  // GET /api/v5/cycles ─────────────────────────────────────────────────────
  app.get('/api/v5/cycles', async (req, reply) => {
    const q = req.query as { limit?: string } | undefined;
    const limit = Math.max(1, Math.min(1000, parseInt(q?.limit ?? '50', 10) || 50));

    const br = baseForRequest(req);
    if ('error' in br) return reply.status(br.error.status).send(br.error.body);
    const base = br.base;

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
    const br = baseForRequest(req);
    if ('error' in br) return reply.status(br.error.status).send(br.error.body);
    const base = br.base;
    const dir = safeJoin(base, id);
    if (!dir || !existsSync(dir)) return reply.status(404).send({ error: 'Cycle not found' });
    const cycleFile = join(dir, 'cycle.json');
    if (existsSync(cycleFile)) {
      const parsed = readJsonIfExists(cycleFile) as Record<string, unknown> | null;
      if (parsed === null) return reply.status(500).send({ error: 'Failed to parse cycle.json' });
      // v6.7.4 heal: cycles that fail at gate have cycle.json with
      // cost.totalUsd = 0 even though phases/*.json contain real costs.
      // Roll those forward so the dashboard shows truth.
      const cost = (parsed.cost as Record<string, unknown> | undefined) ?? {};
      const costZero = (cost.totalUsd ?? 0) === 0;
      if (costZero && existsSync(join(dir, 'phases'))) {
        const phasesDir = join(dir, 'phases');
        let totalCostUsd = 0;
        const costByPhase: Record<string, number> = {};
        const costByAgent: Record<string, number> = {};
        let agentRunCount = 0;
        let tp = 0; let tf = 0; let tt = 0;
        for (const name of ['audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate', 'release', 'learn']) {
          const pf = join(phasesDir, `${name}.json`);
          if (!existsSync(pf)) continue;
          try {
            const ph = JSON.parse(readFileSync(pf, 'utf8')) as Record<string, unknown>;
            const c = typeof ph.costUsd === 'number' ? ph.costUsd : 0;
            totalCostUsd += c;
            if (c > 0) costByPhase[name] = c;
            if (Array.isArray(ph.agentRuns)) {
              for (const run of ph.agentRuns as any[]) {
                agentRunCount++;
                const aid = run.agentId ?? 'unknown';
                const rc = typeof run.costUsd === 'number' ? run.costUsd : 0;
                costByAgent[aid] = (costByAgent[aid] ?? 0) + rc;
              }
            }
            if (name === 'test') {
              if (typeof ph.passed === 'number') tp = ph.passed;
              if (typeof ph.failed === 'number') tf = ph.failed;
              if (typeof ph.total === 'number') tt = ph.total;
            }
          } catch { /* skip */ }
        }
        if (totalCostUsd > 0 || agentRunCount > 0) {
          (parsed as any).cost = {
            totalUsd: totalCostUsd,
            budgetUsd: (cost.budgetUsd as number | undefined) ?? 200,
            byAgent: costByAgent,
            byPhase: costByPhase,
          };
          if (tt > 0) {
            (parsed as any).tests = { passed: tp, failed: tf, skipped: 0, total: tt, passRate: tp / tt, newFailures: [] };
          }
          (parsed as any).agentRunCount = agentRunCount;
          (parsed as any).costHealedFromPhases = true;
        }
      }
      return reply.send(parsed);
    }
    // cycle.json is only written at terminal stage. While the cycle is still
    // running, synthesize a partial payload from events.jsonl so the dashboard
    // detail page can render the live feed instead of showing HTTP 404.
    const eventsFile = join(dir, 'events.jsonl');
    let lastStage = 'plan';
    let startedAt: string | null = null;
    let sprintVersion: string | null = null;
    if (existsSync(eventsFile)) {
      try {
        const text = readFileSync(eventsFile, 'utf8');
        const lines = text.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const ev = JSON.parse(line) as { type?: string; phase?: string; stage?: string; at?: string; sprintVersion?: string };
            if (!startedAt && ev.at) startedAt = ev.at;
            if (ev.sprintVersion && !sprintVersion) sprintVersion = ev.sprintVersion;
            if (ev.stage) lastStage = ev.stage;
            else if (ev.type === 'phase.start' && ev.phase) lastStage = ev.phase;
          } catch { /* skip malformed lines */ }
        }
      } catch { /* fall through to defaults */ }
    }
    // Aggregate live progress from phases/<name>.json. Each phase handler
    // writes its own JSON on completion with costUsd / durationMs / agentRuns.
    // This gives the dashboard real numbers (cost, agent activity, test
    // pass/fail) without waiting for terminal cycle.json to be written.
    const phasesDir = join(dir, 'phases');
    let totalCostUsd = 0;
    const costByPhase: Record<string, number> = {};
    const costByAgent: Record<string, number> = {};
    let testsPassed = 0;
    let testsFailed = 0;
    let testsTotal = 0;
    let agentRunCount = 0;
    if (existsSync(phasesDir)) {
      for (const name of ['audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate', 'release', 'learn']) {
        const phaseFile = join(phasesDir, `${name}.json`);
        if (!existsSync(phaseFile)) continue;
        try {
          const phase = JSON.parse(readFileSync(phaseFile, 'utf8'));
          const phaseCost = typeof phase.costUsd === 'number' ? phase.costUsd : 0;
          totalCostUsd += phaseCost;
          if (phaseCost > 0) costByPhase[name] = phaseCost;
          if (Array.isArray(phase.agentRuns)) {
            for (const run of phase.agentRuns) {
              agentRunCount++;
              const aid = run.agentId ?? 'unknown';
              const c = typeof run.costUsd === 'number' ? run.costUsd : 0;
              costByAgent[aid] = (costByAgent[aid] ?? 0) + c;
            }
          }
          if (name === 'test') {
            if (typeof phase.passed === 'number') testsPassed = phase.passed;
            if (typeof phase.failed === 'number') testsFailed = phase.failed;
            if (typeof phase.total === 'number') testsTotal = phase.total;
          }
        } catch { /* skip malformed phase file */ }
      }
    }
    const passRate = testsTotal > 0 ? testsPassed / testsTotal : 0;
    return reply.send({
      cycleId: id,
      sprintVersion,
      stage: lastStage,
      startedAt: startedAt ?? new Date().toISOString(),
      completedAt: null,
      durationMs: startedAt ? Date.now() - new Date(startedAt).getTime() : null,
      cost: { totalUsd: totalCostUsd, budgetUsd: 200, byAgent: costByAgent, byPhase: costByPhase },
      tests: { passed: testsPassed, failed: testsFailed, skipped: 0, total: testsTotal, passRate, newFailures: [] },
      git: { branch: '', commitSha: null, filesChanged: [] },
      pr: { url: null, number: null, draft: false },
      agentRunCount,
      cycleInProgress: true,
    });
  });

  // GET /api/v5/cycles/:id/sprint ────────────────────────────────────────────
  // Returns the live sprint file for this cycle so the UI can render the
  // same beautiful kanban view used on /sprints/[version] inside the cycle
  // detail page. Execute phase writes this file incrementally on every
  // item completion, so polling this endpoint shows real-time progress
  // (completed/planned/in_progress item counts) while execute is running —
  // the missing live feedback that made the cost look "stuck".
  app.get('/api/v5/cycles/:id/sprint', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!SAFE_ID.test(id)) return reply.status(400).send({ error: 'Invalid cycle id' });
    const br = baseForRequest(req);
    if ('error' in br) return reply.status(br.error.status).send(br.error.body);
    const base = br.base;
    const dir = safeJoin(base, id);
    if (!dir || !existsSync(dir)) return reply.status(404).send({ error: 'Cycle not found' });

    // Fast path: cycle writes sprint-link.json right after plan phase,
    // containing the authoritative sprintVersion for this cycle. Check
    // that first — no timestamp matching needed.
    const linkFile = join(dir, 'sprint-link.json');
    if (existsSync(linkFile)) {
      try {
        const link = JSON.parse(readFileSync(linkFile, 'utf8'));
        if (link?.sprintVersion) {
          const sprintFile = join(opts.projectRoot, '.agentforge/sprints', `v${link.sprintVersion}.json`);
          if (existsSync(sprintFile)) {
            const raw = JSON.parse(readFileSync(sprintFile, 'utf8'));
            const sprint = Array.isArray(raw.sprints) ? raw.sprints[0] : raw;
            return reply.send({ file: `v${link.sprintVersion}.json`, sprint });
          }
        }
      } catch { /* fall through to timestamp matching */ }
    }

    // Legacy path: match by cycle startedAt ↔ sprint createdAt proximity.
    // Only used for cycles started before sprint-link.json existed.
    const cycleStartedAt = (() => {
      const eventsFile = join(dir, 'events.jsonl');
      if (!existsSync(eventsFile)) return null;
      try {
        const first = readFileSync(eventsFile, 'utf8').split('\n').find(Boolean);
        if (!first) return null;
        const ev = JSON.parse(first);
        return typeof ev.at === 'string' ? new Date(ev.at).getTime() : null;
      } catch { return null; }
    })();
    if (cycleStartedAt === null) return reply.status(404).send({ error: 'Cannot determine cycle start time' });

    const sprintsDir = join(opts.projectRoot, '.agentforge/sprints');
    if (!existsSync(sprintsDir)) return reply.status(404).send({ error: 'No sprints directory' });

    let bestMatch: { file: string; sprint: any; delta: number } | null = null;
    for (const name of readdirSync(sprintsDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(readFileSync(join(sprintsDir, name), 'utf8'));
        const sprint = Array.isArray(raw.sprints) ? raw.sprints[0] : raw;
        if (!sprint?.createdAt) continue;
        const createdAt = new Date(sprint.createdAt).getTime();
        // Match if sprint createdAt is within 2 minutes of cycle start (either direction)
        const delta = Math.abs(createdAt - cycleStartedAt);
        if (delta > 120_000) continue;
        if (bestMatch === null || delta < bestMatch.delta) {
          bestMatch = { file: name, sprint, delta };
        }
      } catch { /* skip */ }
    }
    if (!bestMatch) return reply.status(404).send({ error: 'No matching sprint file found for this cycle' });
    return reply.send({ file: bestMatch.file, sprint: bestMatch.sprint });
  });

  // GET /api/v5/cycles/:id/agents ────────────────────────────────────────────
  // Returns a flat list of agent runs aggregated across every phase JSON
  // in the cycle dir, plus per-agent totals. Drives the dashboard Agents
  // tab on the cycle detail page. Updates live because the execute phase
  // now writes incremental execute.json snapshots on every item finish.
  app.get('/api/v5/cycles/:id/agents', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!SAFE_ID.test(id)) return reply.status(400).send({ error: 'Invalid cycle id' });
    const br = baseForRequest(req);
    if ('error' in br) return reply.status(br.error.status).send(br.error.body);
    const base = br.base;
    const dir = safeJoin(base, id);
    if (!dir || !existsSync(dir)) return reply.status(404).send({ error: 'Cycle not found' });

    const phasesDir = join(dir, 'phases');
    if (!existsSync(phasesDir)) return reply.send({ runs: [], byAgent: {}, totalCostUsd: 0, totalRuns: 0 });

    interface AgentRunRow {
      phase: string;
      agentId: string;
      itemId?: string;
      status: string;
      costUsd: number;
      durationMs: number;
      response?: string;
      error?: string;
      attempts?: number;
      model?: string;
      effort?: string;
    }

    // Load default model + effort for each agent from .agentforge/agents/*.yaml.
    // Used as a fallback when phase JSONs don't record the model actually used
    // (legacy runs, or the synthesized sprint-file fallback below). Read once
    // per request and cached in this closure. Also honors the runtime-adapter's
    // fallback classification when the exact agentId YAML doesn't exist.
    const agentYamlDefaults = new Map<string, { model?: string; effort?: string }>();
    function resolveFallbackAgentId(agentId: string): string {
      const lower = agentId.toLowerCase();
      if (/doc|writer|tech-writer/.test(lower)) return 'documentation-writer';
      if (/test|qa/.test(lower)) return 'backend-qa';
      if (/review/.test(lower)) return 'code-reviewer';
      return 'coder';
    }
    function getAgentDefaults(agentId: string): { model?: string; effort?: string } {
      if (agentYamlDefaults.has(agentId)) return agentYamlDefaults.get(agentId)!;
      const tryRead = (id: string): { model?: string; effort?: string } | null => {
        try {
          const yamlPath = join(opts.projectRoot, '.agentforge/agents', `${id}.yaml`);
          if (!existsSync(yamlPath)) return null;
          const content = readFileSync(yamlPath, 'utf-8');
          const out: { model?: string; effort?: string } = {};
          const m = content.match(/^model:\s*(\S+)/m);
          if (m) out.model = m[1]!;
          const e = content.match(/^effort:\s*(\S+)/m);
          if (e) out.effort = e[1]!;
          return out;
        } catch { return null; }
      };
      const direct = tryRead(agentId);
      const out = direct ?? tryRead(resolveFallbackAgentId(agentId)) ?? { model: 'opus', effort: 'high' };
      agentYamlDefaults.set(agentId, out);
      return out;
    }
    const runs: AgentRunRow[] = [];
    const byAgent: Record<string, { runs: number; totalCostUsd: number; totalDurationMs: number; phases: Set<string> }> = {};

    const seenExecuteItemIds = new Set<string>();
    for (const name of ['audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate', 'release', 'learn']) {
      const phaseFile = join(phasesDir, `${name}.json`);
      if (!existsSync(phaseFile)) continue;
      try {
        const phase = JSON.parse(readFileSync(phaseFile, 'utf8'));
        const phaseRuns = Array.isArray(phase.agentRuns) ? phase.agentRuns : [];
        for (const run of phaseRuns) {
          const agentId = String(run.agentId ?? 'unknown');
          const defaults = getAgentDefaults(agentId);
          const row: AgentRunRow = {
            phase: name,
            agentId,
            itemId: typeof run.itemId === 'string' ? run.itemId : undefined,
            status: String(run.status ?? 'unknown'),
            costUsd: typeof run.costUsd === 'number' ? run.costUsd : 0,
            durationMs: typeof run.durationMs === 'number' ? run.durationMs : 0,
            response: typeof run.response === 'string' ? run.response : undefined,
            error: typeof run.error === 'string' ? run.error : undefined,
            attempts: typeof run.attempts === 'number' ? run.attempts : undefined,
            model: typeof run.model === 'string' ? run.model : defaults.model,
            effort: typeof run.effort === 'string' ? run.effort : (defaults.effort ?? 'high'),
          };
          runs.push(row);
          if (row.itemId && name === 'execute') seenExecuteItemIds.add(row.itemId);
          if (!byAgent[agentId]) {
            byAgent[agentId] = { runs: 0, totalCostUsd: 0, totalDurationMs: 0, phases: new Set() };
          }
          byAgent[agentId].runs++;
          byAgent[agentId].totalCostUsd += row.costUsd;
          byAgent[agentId].totalDurationMs += row.durationMs;
          byAgent[agentId].phases.add(name);
        }
      } catch { /* skip malformed */ }
    }

    // Fallback: if phases/execute.json hasn't been written yet, synthesize
    // execute runs from this cycle's sprint file — but ONLY if the cycle
    // has its own sprint-link.json. The previous mtime-based "newest sprint"
    // fallback caused PLAN-stage cycles to display fake $148 / 20 runs
    // sourced from a totally unrelated previous cycle's sprint (v6.7.4
    // user-reported bug — same root cause as the cost list bleed).
    try {
      const linkFile = join(dir, 'sprint-link.json');
      let sprintVersion: string | null = null;
      if (existsSync(linkFile)) {
        const link = JSON.parse(readFileSync(linkFile, 'utf8'));
        sprintVersion = link?.sprintVersion ?? null;
      }
      if (sprintVersion) {
        const sprintFile = join(opts.projectRoot, '.agentforge/sprints', `v${sprintVersion}.json`);
        if (existsSync(sprintFile)) {
          const raw = JSON.parse(readFileSync(sprintFile, 'utf8'));
          const sprint = Array.isArray(raw.sprints) ? raw.sprints[0] : raw;
          const sprintItems = sprint?.items ?? [];
          for (const it of sprintItems) {
            if (seenExecuteItemIds.has(it.id)) continue;
            if (it.status !== 'completed' && it.status !== 'failed' && it.status !== 'in_progress') continue;
            const agentId = String(it.assignee ?? 'unknown');
            const defaults = getAgentDefaults(agentId);
            const synthesized: AgentRunRow = {
              phase: 'execute',
              agentId,
              itemId: it.id,
              status: it.status,
              // We can't know actual cost until execute.json is written,
              // so use the estimated cost as a placeholder for UI display.
              costUsd: typeof it.estimatedCostUsd === 'number' ? it.estimatedCostUsd : 0,
              durationMs: 0,
              // response, error, attempts intentionally omitted (optional)
              ...(defaults.model !== undefined ? { model: defaults.model } : {}),
              effort: defaults.effort ?? 'high',
            };
            runs.push(synthesized);
            if (!byAgent[agentId]) {
              byAgent[agentId] = { runs: 0, totalCostUsd: 0, totalDurationMs: 0, phases: new Set() };
            }
            byAgent[agentId].runs++;
            byAgent[agentId].totalCostUsd += synthesized.costUsd;
            byAgent[agentId].phases.add('execute');
          }
        }
      }
    } catch { /* non-fatal */ }

    // Convert phases Set → array for JSON
    const byAgentSerialized: Record<string, { runs: number; totalCostUsd: number; totalDurationMs: number; phases: string[] }> = {};
    for (const [k, v] of Object.entries(byAgent)) {
      byAgentSerialized[k] = { runs: v.runs, totalCostUsd: v.totalCostUsd, totalDurationMs: v.totalDurationMs, phases: Array.from(v.phases) };
    }

    return reply.send({
      runs,
      byAgent: byAgentSerialized,
      totalCostUsd: runs.reduce((s, r) => s + r.costUsd, 0),
      totalRuns: runs.length,
    });
  });

  // GET /api/v5/cycles/:id/scoring ──────────────────────────────────────────
  app.get('/api/v5/cycles/:id/scoring', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!SAFE_ID.test(id)) return reply.status(400).send({ error: 'Invalid cycle id' });
    const br = baseForRequest(req);
    if ('error' in br) return reply.status(br.error.status).send(br.error.body);
    const base = br.base;
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
    const br = baseForRequest(req);
    if ('error' in br) return reply.status(br.error.status).send(br.error.body);
    const base = br.base;
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
    const br = baseForRequest(req);
    if ('error' in br) return reply.status(br.error.status).send(br.error.body);
    const base = br.base;
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
    const br = baseForRequest(req);
    if ('error' in br) return reply.status(br.error.status).send(br.error.body);
    const base = br.base;
    const dir = safeJoin(base, id);
    if (!dir || !existsSync(dir)) return reply.status(404).send({ error: 'Cycle not found' });
    const file = safeJoin(dir, `${name}.json`);
    if (!file || !existsSync(file)) return reply.status(404).send({ error: `${name}.json not found` });
    const parsed = readJsonIfExists(file);
    if (parsed === null) return reply.status(500).send({ error: 'Failed to parse file' });
    return reply.send(parsed);
  });

  // POST /api/v5/cycles ─────────────────────────────────────────────────────
  app.post('/api/v5/cycles', async (req, reply) => {
    const r = resolveProjectRoot(req as any, opts.projectRoot);
    if ('error' in r) return reply.status(r.error.status).send(r.error.body);
    const reqProjectRoot = r.projectRoot;
    const base = cyclesBaseDir(reqProjectRoot);
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
    // CLI binary always lives in the server's project root (it's the
    // AgentForge monorepo), NOT in the target workspace.
    const cliEntry = resolve(join(opts.projectRoot, 'packages', 'cli', 'dist', 'bin.js'));

    let pid: number;
    let pgid: number;
    try {
      // detached: true makes the child a process group leader (pgid === pid),
      // which lets the stop endpoint kill the entire group via -pgid.
      const child = spawn(nodeBin, [cliEntry, 'autonomous:cycle'], {
        cwd: reqProjectRoot,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, AUTONOMOUS_CYCLE_ID: cycleId },
      });
      child.unref();
      pid = child.pid ?? -1;
      pgid = pid;
    } catch (err) {
      return reply.status(500).send({ error: `Failed to spawn cycle: ${(err as Error).message}` });
    }

    if (pid > 0) {
      try {
        cycleSessions.register({
          cycleId,
          pid,
          pgid,
          workspaceId: 'default',
          workspaceRoot: reqProjectRoot,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[cycles] failed to register session ${cycleId}:`, err);
      }
    }

    return reply.status(202).send({ cycleId, startedAt, pid, pgid });
  });
}
