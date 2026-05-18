// packages/server/src/routes/v5/cycles.ts
//
// v6.5.0 Agent A — Autonomous Cycle REST API.
//
// Exposes read-only views over `.agentforge/cycles/{cycleId}/*` artifacts
// (cycle.json, scoring.json, events.jsonl, phases/*.json, tests.json,
// git.json, pr.json, approval-*.json) plus a POST to spawn a new
// `cycle run` subprocess in the background.
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
  watch as fsWatch,
} from 'node:fs';
import { join, resolve, sep, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { globalStream } from './stream.js';
import { getWorkspace } from '@agentforge/core';
import * as cycleSessions from '../../lib/cycle-sessions.js';
import { openAuditDb, appendAuditEntry } from './audit.js';
import { safeJoin } from '../../lib/safe-join.js';

/**
 * Resolve the AgentForge CLI binary path relative to THIS module's location.
 *
 * This is intentionally NOT relative to the external project root — the CLI
 * binary ships inside the AgentForge package installation.  When AgentForge
 * runs against an external project (e.g. `--project /some/other/repo`),
 * `opts.projectRoot` points there but the CLI still lives here.
 *
 * Layout (from compiled server output):
 *   packages/server/dist/routes/v5/cycles.js   (this file)
 *   packages/cli/dist/bin.js                   (CLI target)
 *
 * Walking up 4 levels from __dirname and down into packages/cli/dist/bin.js.
 */
function resolveAgentForgeCli(metaUrl: string): string {
  const thisFile = fileURLToPath(metaUrl);
  const packagesDir = resolve(dirname(thisFile), '..', '..', '..', '..', '..');
  return resolve(join(packagesDir, 'packages', 'cli', 'dist', 'bin.js'));
}

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
  // No workspaceId, or the literal sentinel "default" — use server root.
  // cycleSessions persists workspaceId="default" for cycles launched without
  // an explicit workspace selection; without this fallthrough every such
  // cycle's detail + approval endpoint 404s once the dashboard passes the
  // sentinel back as a query param.
  if (!workspaceId || workspaceId === 'default') return { projectRoot: fallbackRoot };
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
  'tests', 'git', 'pr', 'approval-pending', 'approval-decision', 'typecheck-failure',
]);
/** Allowlist for raw .log file access via GET /api/v5/cycles/:id/logs/:name */
const SAFE_LOG_NAMES = new Set(['cli-stdout', 'tests-raw']);
/** 2 MB cap for log reads unless ?full=1 is passed. */
const LOG_READ_CAP_BYTES = 2 * 1024 * 1024;

// ── helpers ─────────────────────────────────────────────────────────────────

interface CyclesOpts {
  projectRoot: string;
}

function cyclesBaseDir(projectRoot: string): string {
  return resolve(join(projectRoot, '.agentforge', 'cycles'));
}

function currentGitBranch(projectRoot: string): string | null {
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return branch && isSafeGitBranchName(branch) ? branch : null;
  } catch {
    return null;
  }
}

function isSafeGitBranchName(value: string): boolean {
  if (value.length === 0 || value.length > 200) return false;
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/')) return false;
  if (value.includes('..') || value.endsWith('.lock')) return false;
  if ([...value].some((char) => char.charCodeAt(0) <= 32)) return false;
  if (/[~^:?*[\\]/.test(value)) return false;
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function readJsonIfExists(file: string): unknown | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

interface CycleCheckpoint {
  resumeFromPhase: string;
  capturedAt: string;
  completedPhases: string[];
}

/**
 * Read .agentforge/cycles/<cycleId>/checkpoint.json and return a typed
 * checkpoint object, or undefined if the file is missing or malformed.
 *
 * Path safety: cycleId is validated by the caller against SAFE_ID before
 * being passed here. We use match-then-use: the validated `id` (not raw
 * request input) is used to construct the path, so the analyzer can trace
 * a sanitized value through to the file read.
 */
function readCycleCheckpoint(dir: string): CycleCheckpoint | undefined {
  const file = join(dir, 'checkpoint.json');
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    const resumeFromPhase = typeof raw['resumeFromPhase'] === 'string' ? raw['resumeFromPhase'] : null;
    const capturedAt = typeof raw['capturedAt'] === 'string' ? raw['capturedAt'] : null;
    const completedPhases = Array.isArray(raw['completedPhases'])
      ? (raw['completedPhases'] as unknown[]).filter((p): p is string => typeof p === 'string')
      : null;
    if (!resumeFromPhase || !capturedAt || !completedPhases) return undefined;
    return { resumeFromPhase, capturedAt, completedPhases };
  } catch {
    return undefined;
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
  /** True when approval-pending.json AND approval-decision.json both exist. */
  hasApprovalDecision: boolean;
  /** 'approved' | 'rejected' when hasApprovalDecision is true, else null. */
  approvalDecision: string | null;
  /** Agent ids that participated in this cycle, sourced from session data. */
  agents: string[];
  runtimeMode?: string | null;
  branchPrefix?: string | null;
  baseBranch?: string | null;
  dryRun?: boolean | null;
  maxAgents?: number | null;
  tags?: string[];
  fallbackEnabled?: boolean | null;
  launchConfig?: Record<string, unknown>;
}

function readCycleLaunchConfig(cycleDir: string): Record<string, unknown> {
  const config = readJsonIfExists(join(cycleDir, 'cycle-config.json'));
  return config && typeof config === 'object' && !Array.isArray(config)
    ? config as Record<string, unknown>
    : {};
}

function launchConfigFields(config: Record<string, unknown>): Pick<
  CycleListRow,
  'runtimeMode' | 'branchPrefix' | 'baseBranch' | 'dryRun' | 'maxAgents' | 'tags' | 'fallbackEnabled' | 'launchConfig'
> {
  return {
    runtimeMode: typeof config['runtimeMode'] === 'string' ? config['runtimeMode'] : null,
    branchPrefix: typeof config['branchPrefix'] === 'string' ? config['branchPrefix'] : null,
    baseBranch: typeof config['baseBranch'] === 'string' ? config['baseBranch'] : null,
    dryRun: typeof config['dryRun'] === 'boolean' ? config['dryRun'] : null,
    maxAgents: typeof config['maxAgents'] === 'number' ? config['maxAgents'] : null,
    tags: Array.isArray(config['tags'])
      ? config['tags'].filter((tag): tag is string => typeof tag === 'string')
      : [],
    fallbackEnabled: typeof config['fallbackEnabled'] === 'boolean' ? config['fallbackEnabled'] : null,
    launchConfig: config,
  };
}

function attachLaunchConfig<T extends Record<string, unknown>>(cycleDir: string, payload: T): T {
  const config = readCycleLaunchConfig(cycleDir);
  const fields = launchConfigFields(config) as Record<string, unknown>;
  const target = payload as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) target[key] = value;
  }
  return payload;
}

function isTerminalCyclePayload(cycleJson: Record<string, unknown>): boolean {
  return typeof cycleJson['stage'] === 'string'
    || typeof cycleJson['completedAt'] === 'string'
    || typeof cycleJson['durationMs'] === 'number'
    || typeof cycleJson['cost'] === 'object'
    || typeof cycleJson['tests'] === 'object'
    || typeof cycleJson['git'] === 'object'
    || typeof cycleJson['pr'] === 'object';
}

function summarizeCycle(cycleDir: string, cycleId: string, projectRoot?: string): CycleListRow | null {
  if (!existsSync(cycleDir)) return null;
  const configFields = launchConfigFields(readCycleLaunchConfig(cycleDir));

  const cycleJson = readJsonIfExists(join(cycleDir, 'cycle.json')) as
    | Record<string, unknown>
    | null;

  const approvalPending = existsSync(join(cycleDir, 'approval-pending.json'));
  const approvalDecisionFile = join(cycleDir, 'approval-decision.json');
  const approvalDecided = existsSync(approvalDecisionFile);
  const hasApprovalPending = approvalPending && !approvalDecided;
  const hasApprovalDecision = approvalPending && approvalDecided;
  // Read the decision field (approved/rejected) without failing loudly.
  let approvalDecision: string | null = null;
  if (hasApprovalDecision) {
    try {
      const dec = JSON.parse(readFileSync(approvalDecisionFile, 'utf-8')) as Record<string, unknown>;
      approvalDecision = (dec['decision'] as string) ?? null;
    } catch { /* non-fatal — leave null */ }
  }

  if (cycleJson && isTerminalCyclePayload(cycleJson)) {
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
    // Fix 2: collect agent ids from phase agentRuns for the list row.
    const agentSet = new Set<string>();
    if (existsSync(join(cycleDir, 'phases'))) {
      for (const name of ['audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate', 'release', 'learn']) {
        const pf = join(cycleDir, 'phases', `${name}.json`);
        if (!existsSync(pf)) continue;
        try {
          const ph = JSON.parse(readFileSync(pf, 'utf-8')) as Record<string, unknown>;
          if (Array.isArray(ph['agentRuns'])) {
            for (const run of ph['agentRuns'] as Record<string, unknown>[]) {
              const aid = run['agentId'];
              if (typeof aid === 'string' && aid.length > 0) agentSet.add(aid);
            }
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
      hasApprovalDecision,
      approvalDecision,
      agents: Array.from(agentSet),
      ...configFields,
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

  // v10.7.0: consult the session registry as the authoritative source of truth
  // for terminal state. A cycle that was stopped via POST /cycles/:id/stop has
  // session.status === 'killed' — use that exact word so the list matches the
  // detail page. A session with status === 'crashed' / 'failed' / 'completed'
  // propagates the same way. This replaces the old 5-minute staleness +
  // stage='crashed' heuristic, which produced list/detail disagreement because
  // the detail endpoint now consults the session registry directly.
  //
  // Fallback: if no session record exists (cycles predating the registry) OR
  // the session still shows running but last event is >5min old, stamp the row
  // as 'crashed' so the UI doesn't show an obviously-dead cycle as in-progress.
  const TERMINAL_STATUSES = new Set(['killed', 'crashed', 'failed', 'completed']);
  try {
    const session = cycleSessions.get(cycleId);
    if (session && TERMINAL_STATUSES.has(session.status)) {
      stage = session.status;
    } else if (
      lastEventAt > 0 &&
      Date.now() - lastEventAt > 5 * 60_000 &&
      (!session || !cycleSessions.isPidAlive(session.pid))
    ) {
      stage = 'crashed';
    }
  } catch { /* session manager unavailable — leave stage as derived from events */ }

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
          // Prefer injected projectRoot; fall back to AGENTFORGE_PROJECT_ROOT env var, then cwd.
          const sprintBase = projectRoot ?? process.env['AGENTFORGE_PROJECT_ROOT'] ?? process.cwd();
          const sprintFile = join(sprintBase, '.agentforge/sprints', `v${sprintVersion}.json`);
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

  // Fix 2 (in-progress path): collect agent ids from whatever phases exist.
  const liveAgentSet = new Set<string>();
  if (existsSync(phasesDir)) {
    for (const name of ['audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate', 'release', 'learn']) {
      const pf = join(phasesDir, `${name}.json`);
      if (!existsSync(pf)) continue;
      try {
        const ph = JSON.parse(readFileSync(pf, 'utf-8')) as Record<string, unknown>;
        if (Array.isArray(ph['agentRuns'])) {
          for (const run of ph['agentRuns'] as Record<string, unknown>[]) {
            const aid = run['agentId'];
            if (typeof aid === 'string' && aid.length > 0) liveAgentSet.add(aid);
          }
        }
      } catch { /* skip */ }
    }
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
    hasApprovalDecision,
    approvalDecision,
    agents: Array.from(liveAgentSet),
    ...configFields,
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

  // Open audit DB for SOC-2 logging of cycle mutations.
  const auditDb = openAuditDb(opts.projectRoot);

  // v6.5.3-B: fan cycle events out to the SSE stream.
  const watcher = startCycleEventsWatcher(opts.projectRoot);
  // v6.7.4: cycle session manager — periodic reaper that catches dead PIDs
  // and flips their session status to crashed. Probes every 30s.
  cycleSessions.reap();
  const reaper = cycleSessions.startReaper(30_000);
  app.addHook('onClose', async () => {
    watcher.stop();
    reaper.stop();
    auditDb.close();
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

  // POST /api/v5/cycles/:id/approval (canonical) ──────────────────────────────
  // POST /api/v5/cycles/:id/approve  (legacy alias — kept for backward compat)
  //
  // Writes the approval-decision.json that BudgetApproval.pollDecisionFile
  // is waiting for. Body shape: { approvedItemIds: string[], rejectedItemIds?: string[] }
  // If body.approveAll === true, every within-budget item is approved and
  // every overflow item rejected (the common "yes, ship the within-budget
  // batch" path). Drives the dashboard ApprovalModal (via approvalsStore SSE).
  //
  // Both /approval (GET+POST) and /approve (POST alias) share the same handler
  // so the REST resource is uniform: GET /approval reads, POST /approval writes.
  async function handleApprovalDecision(req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) {
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
      // Broadcast an SSE event immediately so all connected dashboards update
      // without waiting for the 15-second approval-store poll.
      globalStream.emit({
        type: 'cycle_event',
        category: 'approval.decision',
        message: `${id.slice(0, 8)} · approval.decision · ${decision.decision}`,
        data: {
          cycleId: id,
          type: 'approval.decision',
          decision: decision.decision,
          decidedBy: decision.decidedBy,
          at: decision.decidedAt,
        } as unknown as Record<string, unknown>,
      });
      return reply.send({ ok: true, decision });
    } catch (err) {
      return reply.status(500).send({ error: `Failed to write decision: ${(err as Error).message}` });
    }
  }

  // Canonical endpoint: GET+POST share the same /approval resource URL.
  app.post('/api/v5/cycles/:id/approval', handleApprovalDecision);
  // Legacy alias — kept so existing CLI/curl scripts still work.
  app.post('/api/v5/cycles/:id/approve', handleApprovalDecision);

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
  ): { base: string; projectRoot: string } | { error: { status: number; body: unknown } } {
    const r = resolveProjectRoot(req, opts.projectRoot);
    if ('error' in r) return r;
    if (r.projectRoot === opts.projectRoot) return { base: defaultBase, projectRoot: opts.projectRoot };
    return { base: cyclesBaseDir(r.projectRoot), projectRoot: r.projectRoot };
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
      const row = summarizeCycle(join(base, d.name), d.name, br.projectRoot);
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
      if (isTerminalCyclePayload(parsed)) {
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
      const cp = readCycleCheckpoint(dir);
      if (cp !== undefined) (parsed as any).checkpoint = cp;
      return reply.send(attachLaunchConfig(dir, parsed));
      }
    }
    // cycle.json is only written at terminal stage. While the cycle is still
    // running, synthesize a partial payload from events.jsonl so the dashboard
    // detail page can render the live feed instead of showing HTTP 404.
    const eventsFile = join(dir, 'events.jsonl');
    let lastStage = 'plan';
    let startedAt: string | null = null;
    let sprintVersion: string | null = null;
    // lastEventAt tracks the epoch ms of the most-recent event — used by the
    // v15.1.0 staleness heuristic to infer crashed cycles whose session record
    // was lost on server restart.
    let lastEventAt = 0;
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
            if (ev.at) {
              const t = new Date(ev.at).getTime();
              if (t > lastEventAt) lastEventAt = t;
            }
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

    // Cross-check the session registry before deciding "in progress". A killed
    // or crashed cycle never writes cycle.json, so filesystem-only inference
    // is ambiguous: we cannot tell "running, about to write cycle.json" apart
    // from "dead, never will". cycle-sessions knows the truth because it
    // tracked the process lifecycle. If the session shows a terminal status,
    // emit a 200 with the partial data plus status/exitNote so the dashboard
    // renders a final state instead of polling forever.
    const session = cycleSessions.get(id);
    const TERMINAL: cycleSessions.CycleSessionStatus[] = ['killed', 'crashed', 'failed', 'completed'];
    if (session && TERMINAL.includes(session.status)) {
      const completedAt = session.lastSeenAt ?? new Date().toISOString();
      const startIso = startedAt ?? session.startedAt ?? completedAt;
      const sessionCheckpoint = readCycleCheckpoint(dir);
      const sessionPayload: Record<string, unknown> = {
        cycleId: id,
        sprintVersion,
        stage: session.status === 'killed' ? 'killed' : lastStage,
        status: session.status,
        exitNote: session.exitNote ?? null,
        startedAt: startIso,
        completedAt,
        durationMs: Date.now() - new Date(startIso).getTime(),
        cost: { totalUsd: totalCostUsd, budgetUsd: 200, byAgent: costByAgent, byPhase: costByPhase },
        tests: { passed: testsPassed, failed: testsFailed, skipped: 0, total: testsTotal, passRate, newFailures: [] },
        git: { branch: '', commitSha: null, filesChanged: [] },
        pr: { url: null, number: null, draft: false },
        agentRunCount,
        cycleInProgress: false,
        partialTerminal: true,
      };
      if (sessionCheckpoint !== undefined) sessionPayload['checkpoint'] = sessionCheckpoint;
      return reply.status(200).send(attachLaunchConfig(dir, sessionPayload));
    }

    // v15.1.0: Gap fix — killed cycles with no session registry entry.
    //
    // When budget enforcement kills a cycle between server restarts the session
    // record is gone.  Without this check the endpoint returns 404+cycleInProgress
    // forever because the filesystem alone cannot confirm the cycle is dead.
    // The staleness heuristic closes that gap: if there is NO session record at
    // all AND every event is more than 5 minutes old, the cycle is almost
    // certainly dead.  We promote it to 200+partialTerminal so the dashboard
    // stops polling and shows a useful final state.
    //
    // We only apply this when !session (not when session.status === 'running')
    // to avoid false-positives during a slow phase where an alive process has
    // not emitted events recently.
    if (!session && lastEventAt > 0 && Date.now() - lastEventAt > 5 * 60_000) {
      const completedAt = new Date(lastEventAt).toISOString();
      const startIso = startedAt ?? completedAt;
      const inferredStage =
        lastStage === 'killed' || lastStage === 'crashed' || lastStage === 'failed'
          ? lastStage
          : 'crashed';
      const stalenessCheckpoint = readCycleCheckpoint(dir);
      const stalenessPayload: Record<string, unknown> = {
        cycleId: id,
        sprintVersion,
        stage: inferredStage,
        status: inferredStage,
        exitNote: `Session record unavailable — inferred as ${inferredStage} from event staleness (last event ${completedAt})`,
        startedAt: startIso,
        completedAt,
        durationMs: lastEventAt - new Date(startIso).getTime(),
        cost: { totalUsd: totalCostUsd, budgetUsd: 200, byAgent: costByAgent, byPhase: costByPhase },
        tests: { passed: testsPassed, failed: testsFailed, skipped: 0, total: testsTotal, passRate, newFailures: [] },
        git: { branch: '', commitSha: null, filesChanged: [] },
        pr: { url: null, number: null, draft: false },
        agentRunCount,
        cycleInProgress: false,
        partialTerminal: true,
      };
      if (stalenessCheckpoint !== undefined) stalenessPayload['checkpoint'] = stalenessCheckpoint;
      return reply.status(200).send(attachLaunchConfig(dir, stalenessPayload));
    }

    // cycle.json absent and session is still running (or unknown) — classic
    // in-progress case. Return 404 + cycleInProgress: true so callers can
    // distinguish "not found" from "running but not yet terminal". The 404
    // status prevents stale cache hits while the partial payload lets the
    // dashboard render a live feed.
    //
    // v15.0.0: startedAt fallback now uses session.startedAt before falling
    // through to Date.now(). The old fallback emitted a fresh "now" on every
    // poll, which made the dashboard's elapsed timer snap to 00:00 every
    // poll cycle. The session registry tracks the real spawn time.
    const inProgressStartedAt = startedAt ?? session?.startedAt ?? new Date().toISOString();
    return reply.status(404).send(attachLaunchConfig(dir, {
      cycleId: id,
      sprintVersion,
      stage: lastStage,
      startedAt: inProgressStartedAt,
      completedAt: null,
      durationMs: Date.now() - new Date(inProgressStartedAt).getTime(),
      cost: { totalUsd: totalCostUsd, budgetUsd: 200, byAgent: costByAgent, byPhase: costByPhase },
      tests: { passed: testsPassed, failed: testsFailed, skipped: 0, total: testsTotal, passRate, newFailures: [] },
      git: { branch: '', commitSha: null, filesChanged: [] },
      pr: { url: null, number: null, draft: false },
      agentRunCount,
      cycleInProgress: true,
    }));
  });

  // GET /api/v5/cycles/:id/plan ─────────────────────────────────────────────
  // Returns plan.json from the cycle directory — canonical source of truth for
  // new cycles (Track D). Returns 404 for legacy cycles that pre-date plan.json.
  app.get('/api/v5/cycles/:id/plan', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!SAFE_ID.test(id)) return reply.status(400).send({ error: 'Invalid cycle id' });
    const br = baseForRequest(req);
    if ('error' in br) return reply.status(br.error.status).send(br.error.body);
    const base = br.base;
    const dir = safeJoin(base, id);
    if (!dir || !existsSync(dir)) return reply.status(404).send({ error: 'Cycle not found' });
    const planFile = join(dir, 'plan.json');
    if (!existsSync(planFile)) {
      return reply.status(404).send({ error: 'plan.json not found — cycle may predate this feature' });
    }
    const parsed = readJsonIfExists(planFile);
    if (parsed === null) return reply.status(500).send({ error: 'Failed to parse plan.json' });
    return reply.send(parsed);
  });

  // GET /api/v5/cycles/:id/sprint ────────────────────────────────────────────
  // Returns the live sprint/plan for this cycle. Priority: (1) plan.json in cycle
  // dir (new cycles), (2) sprint-link.json → legacy sprints/ file, (3) timestamp
  // proximity fallback. Execute phase updates plan.json incrementally so polling
  // this shows real-time item progress while execute is running.
  app.get('/api/v5/cycles/:id/sprint', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!SAFE_ID.test(id)) return reply.status(400).send({ error: 'Invalid cycle id' });
    const br = baseForRequest(req);
    if ('error' in br) return reply.status(br.error.status).send(br.error.body);
    const base = br.base;
    const dir = safeJoin(base, id);
    if (!dir || !existsSync(dir)) return reply.status(404).send({ error: 'Cycle not found' });

    // Fast path 1: plan.json in cycle dir (new cycles — Track D migration).
    const planFile = join(dir, 'plan.json');
    if (existsSync(planFile)) {
      try {
        const sprint = JSON.parse(readFileSync(planFile, 'utf8'));
        return reply.send({ file: 'plan.json', sprint });
      } catch { /* fall through */ }
    }

    // Fast path 2: sprint-link.json → legacy sprints/ directory.
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
    const archiveDir = join(sprintsDir, 'archive');
    const dirs = [sprintsDir, archiveDir].filter(d => existsSync(d));
    if (dirs.length === 0) return reply.status(404).send({ error: 'No sprints directory' });

    let bestMatch: { file: string; sprint: any; delta: number } | null = null;
    for (const dir of dirs) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        try {
          const raw = JSON.parse(readFileSync(join(dir, name), 'utf8'));
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

  // GET /api/v5/cycles/:id/logs/:name ──────────────────────────────────────
  // Returns a raw log file as plain text. `name` must be in SAFE_LOG_NAMES.
  // Caps response at 2 MB unless ?full=1 is supplied.
  app.get('/api/v5/cycles/:id/logs/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    if (!SAFE_ID.test(id)) return reply.status(400).send({ error: 'Invalid cycle id' });
    if (!SAFE_LOG_NAMES.has(name)) return reply.status(400).send({ error: 'Invalid log name' });
    const br = baseForRequest(req);
    if ('error' in br) return reply.status(br.error.status).send(br.error.body);
    const base = br.base;
    const dir = safeJoin(base, id);
    if (!dir || !existsSync(dir)) return reply.status(404).send({ error: 'Cycle not found' });
    const file = safeJoin(dir, `${name}.log`);
    if (!file || !existsSync(file)) return reply.status(404).send({ error: `${name}.log not found` });

    const q = req.query as { full?: string } | undefined;
    const full = q?.full === '1';

    let text: string;
    try {
      const stat = statSync(file);
      if (!full && stat.size > LOG_READ_CAP_BYTES) {
        // Read last LOG_READ_CAP_BYTES so the most recent output is always visible
        const buf = Buffer.alloc(LOG_READ_CAP_BYTES);
        const offset = stat.size - LOG_READ_CAP_BYTES;
        await new Promise<void>((res, rej) => {
          fsOpen(file, 'r', (err, fd) => {
            if (err) return rej(err);
            fsRead(fd, buf, 0, LOG_READ_CAP_BYTES, offset, (rerr) => {
              fsClose(fd, () => { if (rerr) rej(rerr); else res(); });
            });
          });
        });
        text = `[... truncated — showing last 2 MB of ${Math.round(stat.size / 1024)} KB ...]\n` + buf.toString('utf-8');
      } else {
        text = readFileSync(file, 'utf-8');
      }
    } catch (err) {
      return reply.status(500).send({ error: `Failed to read ${name}.log: ${(err as Error).message}` });
    }

    reply.header('Content-Type', 'text/plain; charset=utf-8');
    return reply.send(text);
  });

  // GET /api/v5/cycles/:id/logs/:name/stream ─────────────────────────────────
  // SSE endpoint that tails the log file and emits new lines as data events.
  // Closes automatically when the cycle reaches terminal state or the client
  // disconnects. For active cycles subscribe here; for terminal cycles use the
  // plain GET above (one-shot fetch).
  app.get('/api/v5/cycles/:id/logs/:name/stream', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    if (!SAFE_ID.test(id)) return reply.status(400).send({ error: 'Invalid cycle id' });
    if (!SAFE_LOG_NAMES.has(name)) return reply.status(400).send({ error: 'Invalid log name' });
    const br = baseForRequest(req);
    if ('error' in br) return reply.status(br.error.status).send(br.error.body);
    const base = br.base;
    const dir = safeJoin(base, id);
    if (!dir || !existsSync(dir)) return reply.status(404).send({ error: 'Cycle not found' });
    const fileOrNull = safeJoin(dir, `${name}.log`);
    if (!fileOrNull) return reply.status(404).send({ error: `${name}.log not found` });
    const file: string = fileOrNull;

    const reqOrigin = req.headers['origin'];
    // Mirror the pattern used by all other SSE routes (stream.ts, streaming.ts,
    // run-stream.ts): HTTP-only, both localhost and 127.0.0.1, any port.
    // https:// is intentionally excluded — this server runs HTTP-only locally.
    const isLocalhost = typeof reqOrigin === 'string' &&
      /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(reqOrigin);
    const corsOrigin = isLocalhost ? reqOrigin : 'http://localhost:4751';

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': corsOrigin,
      'X-Accel-Buffering': 'no',
    });

    let offset = 0;
    // Seed offset to end of existing file so we don't re-emit history.
    // The client must fetch full log separately for history.
    try {
      if (existsSync(file)) {
        offset = statSync(file).size;
      }
    } catch { /* file may not exist yet — start from 0 */ }

    let closed = false;
    let watcher: ReturnType<typeof fsWatch> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    function sendLine(line: string) {
      try {
        reply.raw.write(`data: ${JSON.stringify({ line })}\n\n`);
      } catch { closed = true; }
    }

    async function checkNewBytes(): Promise<void> {
      if (closed) return;
      if (!existsSync(file)) return;
      let size: number;
      try { size = statSync(file).size; } catch { return; }
      if (size <= offset) return;
      const len = size - offset;
      const buf = Buffer.alloc(len);
      try {
        await new Promise<void>((res, rej) => {
          fsOpen(file, 'r', (err, fd) => {
            if (err) return rej(err);
            fsRead(fd, buf, 0, len, offset, (rerr) => {
              fsClose(fd, () => { if (rerr) rej(rerr); else res(); });
            });
          });
        });
      } catch { return; }
      offset = size;
      const lines = buf.toString('utf-8').split('\n');
      // Last element may be a partial line — don't emit it yet; wait for newline.
      for (let i = 0; i < lines.length - 1; i++) {
        const l = lines[i]!;
        if (l.length > 0) sendLine(l);
      }
    }

    function cleanup() {
      closed = true;
      try { watcher?.close(); } catch { /* ignore */ }
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    // Use fs.watch for low-latency change events, fall back to polling.
    try {
      watcher = fsWatch(file, () => { void checkNewBytes(); });
    } catch {
      // File may not exist yet; poll will pick it up
    }
    // Polling fallback at 500ms handles the race where file is created after watch setup
    pollTimer = setInterval(() => { void checkNewBytes(); }, 500);

    // Check if cycle is already terminal; if so, close after draining
    function checkTerminal() {
      try {
        const session = cycleSessions.get(id);
        const TERMINAL_S = new Set(['killed', 'crashed', 'failed', 'completed']);
        if (session && TERMINAL_S.has(session.status)) {
          // Drain once more then close
          void checkNewBytes().then(() => {
            try { reply.raw.write('data: {"done":true}\n\n'); } catch { /* ignore */ }
            cleanup();
            try { reply.raw.end(); } catch { /* ignore */ }
          });
          return true;
        }
      } catch { /* session manager unavailable */ }
      return false;
    }

    // Poll for terminal state every 5s
    const terminalTimer = setInterval(() => {
      if (checkTerminal()) clearInterval(terminalTimer);
    }, 5000);

    req.raw.on('close', () => {
      cleanup();
      clearInterval(terminalTimer);
    });

    // Keep the connection alive until client disconnects
    await new Promise<void>((resolve) => { req.raw.on('close', resolve); });
  });

  // POST /api/v5/cycles ─────────────────────────────────────────────────────
  app.post('/api/v5/cycles', async (req, reply) => {
    const r = resolveProjectRoot(req as any, opts.projectRoot);
    if ('error' in r) return reply.status(r.error.status).send(r.error.body);
    const reqProjectRoot = r.projectRoot;
    const base = cyclesBaseDir(reqProjectRoot);

    // Honour launch-time budget / item-cap overrides from the request body.
    // These are handed to the subprocess via env vars; the CLI's runCycleAction
    // mirrors the previewCycle pattern and mutates config before constructing
    // CycleRunner. Without this thread-through the cycle-runner always uses
    // loadCycleConfig() defaults, so dashboard-supplied budgets are silently
    // ignored — which is how cycle 75bfaf96 ran at $200 despite a $500 launch.
    const body = (req.body ?? {}) as {
      budgetUsd?: unknown;
      maxItems?: unknown;
      modelCap?: string;
      effortCap?: string;
      branchPrefix?: unknown;
      baseBranch?: unknown;
      dryRun?: unknown;
      comment?: unknown;
      // Fix 1 — new fields
      maxAgents?: number;
      tags?: unknown;
      fallbackEnabled?: unknown;
    };

    if (body.budgetUsd !== undefined) {
      if (typeof body.budgetUsd !== 'number' || !Number.isFinite(body.budgetUsd) || body.budgetUsd <= 0) {
        return reply.status(400).send({ error: 'budgetUsd must be a positive number' });
      }
    }
    if (body.maxItems !== undefined) {
      if (typeof body.maxItems !== 'number' || !Number.isInteger(body.maxItems) || body.maxItems <= 0) {
        return reply.status(400).send({ error: 'maxItems must be a positive integer' });
      }
    }
    if (body.modelCap !== undefined && body.modelCap !== 'opus' && body.modelCap !== 'sonnet' && body.modelCap !== 'haiku') {
      return reply.status(400).send({ error: 'modelCap must be one of: opus, sonnet, haiku' });
    }
    if (
      body.effortCap !== undefined &&
      body.effortCap !== 'low' &&
      body.effortCap !== 'medium' &&
      body.effortCap !== 'high' &&
      body.effortCap !== 'xhigh' &&
      body.effortCap !== 'max'
    ) {
      return reply.status(400).send({ error: 'effortCap must be one of: low, medium, high, xhigh, max' });
    }
    // Fix 1: validate maxAgents, tags, fallbackEnabled before using.
    if (body.maxAgents !== undefined) {
      if (typeof body.maxAgents !== 'number' || !Number.isInteger(body.maxAgents) || body.maxAgents <= 0) {
        return reply.status(400).send({ error: 'maxAgents must be a positive integer' });
      }
    }
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags) || (body.tags as unknown[]).some((t) => typeof t !== 'string')) {
        return reply.status(400).send({ error: 'tags must be an array of strings' });
      }
    }
    if (body.fallbackEnabled !== undefined && typeof body.fallbackEnabled !== 'boolean') {
      return reply.status(400).send({ error: 'fallbackEnabled must be a boolean' });
    }
    if (body.branchPrefix !== undefined && typeof body.branchPrefix !== 'string') {
      return reply.status(400).send({ error: 'branchPrefix must be a string' });
    }
    if (body.baseBranch !== undefined && typeof body.baseBranch !== 'string') {
      return reply.status(400).send({ error: 'baseBranch must be a string' });
    }
    if (typeof body.baseBranch === 'string' && body.baseBranch.trim().length > 0 && !isSafeGitBranchName(body.baseBranch.trim())) {
      return reply.status(400).send({ error: 'baseBranch must be a valid git branch name' });
    }
    if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
      return reply.status(400).send({ error: 'dryRun must be a boolean' });
    }
    if (body.comment !== undefined && typeof body.comment !== 'string') {
      return reply.status(400).send({ error: 'comment must be a string' });
    }

    const budgetEnv = typeof body.budgetUsd === 'number' && body.budgetUsd > 0
      ? { AUTONOMOUS_BUDGET_USD: String(body.budgetUsd) }
      : {};
    const maxItemsEnv = typeof body.maxItems === 'number' && body.maxItems > 0
      ? { AUTONOMOUS_MAX_ITEMS: String(body.maxItems) }
      : {};
    const modelCapEnv = (body.modelCap === 'opus' || body.modelCap === 'sonnet' || body.modelCap === 'haiku')
      ? { AUTONOMOUS_MODEL_CAP: body.modelCap }
      : {};
    const effortCapEnv = (body.effortCap === 'low' || body.effortCap === 'medium' || body.effortCap === 'high' || body.effortCap === 'xhigh' || body.effortCap === 'max')
      ? { AUTONOMOUS_EFFORT_CAP: body.effortCap }
      : {};
    // Fix 1: pass maxAgents and fallbackEnabled via env vars.
    const maxAgentsEnv = typeof body.maxAgents === 'number' && body.maxAgents > 0
      ? { AUTONOMOUS_MAX_AGENTS: String(body.maxAgents) }
      : {};
    const fallbackEnv = typeof body.fallbackEnabled === 'boolean'
      ? { AUTONOMOUS_FALLBACK_ENABLED: body.fallbackEnabled ? 'true' : 'false' }
      : {};
    const branchPrefixEnv = typeof body.branchPrefix === 'string' && body.branchPrefix.trim().length > 0
      ? { AUTONOMOUS_BRANCH_PREFIX: body.branchPrefix.trim() }
      : {};
    const resolvedBaseBranch = typeof body.baseBranch === 'string' && body.baseBranch.trim().length > 0
      ? body.baseBranch.trim()
      : currentGitBranch(reqProjectRoot);
    const baseBranchEnv = resolvedBaseBranch !== null
      ? { AUTONOMOUS_BASE_BRANCH: resolvedBaseBranch }
      : {};
    const dryRunEnv = body.dryRun === true ? { AUTONOMOUS_DRY_RUN: 'true' } : {};

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

    // Pass AUTONOMOUS_CYCLE_ID so the CLI uses the same pre-allocated id.
    // CycleRunner and CycleLogger both honour options.cycleId (injected by the
    // CLI) which takes priority over the env var, which in turn takes priority
    // over a fresh UUID — so the cycle dir always matches this API response.
    const nodeBin = process.execPath;
    // CLI binary lives inside the AgentForge package installation, NOT in the
    // external project root.  Use import.meta.url to locate the server module
    // and walk up to find the sibling packages/cli/dist/bin.js.  This ensures
    // `agentforge --project /external/repo cycle run` works correctly.
    const cliEntry = resolveAgentForgeCli(import.meta.url);
    if (!existsSync(cliEntry)) {
      return reply.status(500).send({ error: `AgentForge CLI entry not found at ${cliEntry}` });
    }

    // Fix 1: persist launch config to cycle-config.json so GET /cycles can surface it.
    const tags = Array.isArray(body.tags) ? (body.tags as string[]) : [];
    const cycleConfig: Record<string, unknown> = {
      cycleId,
      startedAt,
      budgetUsd: body.budgetUsd ?? null,
      maxItems: body.maxItems ?? null,
      modelCap: body.modelCap ?? null,
      effortCap: body.effortCap ?? null,
      branchPrefix: typeof body.branchPrefix === 'string' ? body.branchPrefix.trim() : null,
      baseBranch: resolvedBaseBranch,
      dryRun: body.dryRun ?? null,
      comment: typeof body.comment === 'string' ? body.comment.trim() : null,
      maxAgents: body.maxAgents ?? null,
      tags,
      fallbackEnabled: body.fallbackEnabled ?? null,
      runtimeMode: 'codex-cli',
    };
    try {
      writeFileSync(join(cycleDir, 'cycle-config.json'), JSON.stringify(cycleConfig, null, 2));
    } catch { /* non-fatal — cycle still starts, config just isn't persisted */ }

    let pid: number;
    let pgid: number;
    try {
      // detached: true makes the child a process group leader (pgid === pid),
      // which lets the stop endpoint kill the entire group via -pgid.
      const child = spawn(nodeBin, [cliEntry, 'cycle', 'run'], {
        cwd: reqProjectRoot,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: {
          ...process.env,
          AGENTFORGE_RUNTIME: 'codex-cli',
          AUTONOMOUS_CYCLE_ID: cycleId,
          ...budgetEnv,
          ...maxItemsEnv,
          ...modelCapEnv,
          ...effortCapEnv,
          ...maxAgentsEnv,
          ...fallbackEnv,
          ...branchPrefixEnv,
          ...baseBranchEnv,
          ...dryRunEnv,
        },
      });
      if (typeof child.once === 'function') {
        child.once('error', (err) => {
          cycleSessions.markTerminal(cycleId, 'crashed', `spawn error: ${err.message}`);
        });
        child.once('exit', (code, signal) => {
          if (code !== null && code !== 0) {
            cycleSessions.markTerminal(cycleId, 'crashed', `cycle process exited with code ${code}`);
          } else if (signal) {
            cycleSessions.markTerminal(cycleId, 'killed', `cycle process exited from signal ${signal}`);
          }
        });
      }
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

    return reply.status(202).send({
      cycleId,
      startedAt,
      pid,
      pgid,
      runtimeMode: 'codex-cli',
      branchPrefix: typeof body.branchPrefix === 'string' ? body.branchPrefix.trim() : null,
      baseBranch: resolvedBaseBranch,
      dryRun: body.dryRun ?? null,
      maxAgents: body.maxAgents ?? null,
      tags,
      fallbackEnabled: body.fallbackEnabled ?? null,
    });
  });

  // POST /api/v5/cycles/:id/cancel ────────────────────────────────────────────
  // Fix 3: Cancel a running cycle. Sets status → 'killed' (same as /stop),
  // but also writes a kill-switch marker to the cycle dir and audit-logs it.
  // Idempotent: cancelling an already-terminal cycle returns 409.
  app.post('/api/v5/cycles/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!SAFE_ID.test(id)) return reply.status(400).send({ error: 'Invalid cycle id' });

    // Check session state first for idempotency.
    const session = cycleSessions.get(id);
    const TERMINAL = new Set(['killed', 'crashed', 'failed', 'completed']);
    if (session && TERMINAL.has(session.status)) {
      return reply.status(409).send({
        error: 'Cycle is already terminal',
        status: session.status,
        cycleId: id,
      });
    }

    // Also check if cycle.json exists with a terminal stage (no session record).
    const br = baseForRequest(req);
    if ('error' in br) return reply.status(br.error.status).send(br.error.body);
    const cycleDir = safeJoin(br.base, id);
    if (cycleDir) {
      const cycleJsonPath = join(cycleDir, 'cycle.json');
      if (existsSync(cycleJsonPath)) {
        try {
          const cj = JSON.parse(readFileSync(cycleJsonPath, 'utf-8')) as Record<string, unknown>;
          const terminalStages = new Set(['killed', 'crashed', 'failed', 'completed']);
          if (typeof cj['stage'] === 'string' && terminalStages.has(cj['stage'] as string)) {
            return reply.status(409).send({
              error: 'Cycle is already terminal',
              status: cj['stage'],
              cycleId: id,
            });
          }
        } catch { /* non-fatal — continue with cancel */ }
      }
    }

    // Stop the cycle process (SIGTERM → SIGKILL).
    let stopResult: { ok: boolean; status: cycleSessions.CycleSessionStatus; message: string };
    if (session) {
      stopResult = await cycleSessions.stop(id);
    } else {
      // No session — mark as killed in registry best-effort.
      stopResult = { ok: true, status: 'killed', message: 'no session record; marking killed' };
      cycleSessions.markTerminal(id, 'killed', 'cancelled via API with no session record');
    }

    // Write kill-switch marker to cycle dir so the dashboard shows the reason.
    if (cycleDir && existsSync(cycleDir)) {
      try {
        writeFileSync(
          join(cycleDir, 'kill-switch.json'),
          JSON.stringify({ reason: 'manualCancel', cancelledAt: new Date().toISOString(), triggeredBy: 'api' }, null, 2),
        );
      } catch { /* non-fatal */ }
    }

    // SOC-2 audit log.
    appendAuditEntry(auditDb, {
      actor: 'api',
      action: 'cycle.cancel',
      target: id,
      details: { stopMessage: stopResult.message, triggeredBy: 'api' },
    });

    globalStream.emit({
      type: 'cycle_event',
      category: 'cycle.cancelled',
      message: `${id.slice(0, 8)} · cycle.cancelled`,
      data: { cycleId: id, type: 'cycle.cancelled', at: new Date().toISOString() } as unknown as Record<string, unknown>,
    });

    return reply.send({ ok: stopResult.ok, cycleId: id, status: stopResult.status, message: stopResult.message });
  });

  // POST /api/v5/cycles/:id/resume ─────────────────────────────────────────────
  // Resume an interrupted cycle from its checkpoint using the same Codex runtime
  // launch contract as first-run and rerun.
  app.post('/api/v5/cycles/:id/resume', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!SAFE_ID.test(id)) return reply.status(400).send({ error: 'Invalid cycle id' });

    const r = resolveProjectRoot(req as { query: unknown; headers: Record<string, unknown> }, opts.projectRoot);
    if ('error' in r) return reply.status(r.error.status).send(r.error.body);
    const reqProjectRoot = r.projectRoot;
    const base = cyclesBaseDir(reqProjectRoot);
    const cycleDir = safeJoin(base, id);
    if (!cycleDir || !existsSync(cycleDir)) return reply.status(404).send({ error: 'Cycle not found' });

    const existing = cycleSessions.get(id);
    if (existing?.status === 'running' && cycleSessions.isPidAlive(existing.pid)) {
      return reply.status(409).send({ error: 'Cycle is already running', cycleId: id, pid: existing.pid });
    }

    const checkpoint = readCycleCheckpoint(cycleDir);
    if (checkpoint === undefined) {
      return reply.status(409).send({ error: 'Cycle has no resumable checkpoint', cycleId: id });
    }

    let sourceConfig: Record<string, unknown> = {};
    const configPath = join(cycleDir, 'cycle-config.json');
    if (existsSync(configPath)) {
      try {
        sourceConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      } catch { /* use empty defaults */ }
    }

    let logFd: number;
    try {
      logFd = openSync(join(cycleDir, 'cli-stdout.log'), 'a');
    } catch (err) {
      return reply.status(500).send({ error: `Failed to open log file: ${(err as Error).message}` });
    }

    const nodeBin = process.execPath;
    const cliEntry = resolveAgentForgeCli(import.meta.url);
    if (!existsSync(cliEntry)) {
      return reply.status(500).send({ error: `AgentForge CLI entry not found at ${cliEntry}` });
    }

    const env: NodeJS.ProcessEnv = { ...process.env, AGENTFORGE_RUNTIME: 'codex-cli', AUTONOMOUS_CYCLE_ID: id };
    if (typeof sourceConfig['budgetUsd'] === 'number' && sourceConfig['budgetUsd'] > 0) {
      env['AUTONOMOUS_BUDGET_USD'] = String(sourceConfig['budgetUsd']);
    }
    if (typeof sourceConfig['maxItems'] === 'number' && sourceConfig['maxItems'] > 0) {
      env['AUTONOMOUS_MAX_ITEMS'] = String(sourceConfig['maxItems']);
    }
    if (typeof sourceConfig['maxAgents'] === 'number' && sourceConfig['maxAgents'] > 0) {
      env['AUTONOMOUS_MAX_AGENTS'] = String(sourceConfig['maxAgents']);
    }
    const modelCap = sourceConfig['modelCap'];
    if (modelCap === 'opus' || modelCap === 'sonnet' || modelCap === 'haiku') {
      env['AUTONOMOUS_MODEL_CAP'] = modelCap;
    }
    const effortCap = sourceConfig['effortCap'];
    if (effortCap === 'low' || effortCap === 'medium' || effortCap === 'high' || effortCap === 'xhigh' || effortCap === 'max') {
      env['AUTONOMOUS_EFFORT_CAP'] = effortCap;
    }
    if (typeof sourceConfig['fallbackEnabled'] === 'boolean') {
      env['AUTONOMOUS_FALLBACK_ENABLED'] = sourceConfig['fallbackEnabled'] ? 'true' : 'false';
    }
    if (typeof sourceConfig['branchPrefix'] === 'string' && sourceConfig['branchPrefix'].trim().length > 0) {
      env['AUTONOMOUS_BRANCH_PREFIX'] = sourceConfig['branchPrefix'].trim();
    }
    if (typeof sourceConfig['baseBranch'] === 'string' && sourceConfig['baseBranch'].trim().length > 0) {
      env['AUTONOMOUS_BASE_BRANCH'] = sourceConfig['baseBranch'].trim();
    } else {
      const baseBranch = currentGitBranch(reqProjectRoot);
      if (baseBranch !== null) env['AUTONOMOUS_BASE_BRANCH'] = baseBranch;
    }
    if (sourceConfig['dryRun'] === true) {
      env['AUTONOMOUS_DRY_RUN'] = 'true';
    }

    let pid: number;
    let pgid: number;
    try {
      const child = spawn(nodeBin, [cliEntry, 'cycle', 'run', '--resume', id], {
        cwd: reqProjectRoot,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env,
      });
      if (typeof child.once === 'function') {
        child.once('error', (err) => {
          cycleSessions.markTerminal(id, 'crashed', `spawn error: ${err.message}`);
        });
        child.once('exit', (code, signal) => {
          if (code !== null && code !== 0) {
            cycleSessions.markTerminal(id, 'crashed', `cycle process exited with code ${code}`);
          } else if (signal) {
            cycleSessions.markTerminal(id, 'killed', `cycle process exited from signal ${signal}`);
          }
        });
      }
      child.unref();
      pid = child.pid ?? -1;
      pgid = pid;
    } catch (err) {
      return reply.status(500).send({ error: `Failed to spawn resume cycle: ${(err as Error).message}` });
    }

    if (pid > 0) {
      try {
        cycleSessions.register({ cycleId: id, pid, pgid, workspaceId: 'default', workspaceRoot: reqProjectRoot });
      } catch { /* non-fatal */ }
    }

    appendAuditEntry(auditDb, {
      actor: 'api',
      action: 'cycle.resume',
      target: id,
      details: { resumeFromPhase: checkpoint.resumeFromPhase, pid, pgid },
    });

    globalStream.emit({
      type: 'cycle_event',
      category: 'cycle.resumed',
      message: `${id.slice(0, 8)} · cycle.resumed`,
      data: { cycleId: id, type: 'cycle.resumed', at: new Date().toISOString(), resumeFromPhase: checkpoint.resumeFromPhase } as unknown as Record<string, unknown>,
    });

    return reply.status(202).send({
      cycleId: id,
      resumedAt: new Date().toISOString(),
      pid,
      pgid,
      runtimeMode: 'codex-cli',
      resumeFromPhase: checkpoint.resumeFromPhase,
    });
  });

  // POST /api/v5/cycles/:id/rerun ──────────────────────────────────────────────
  // Fix 4: Spawn a new cycle with the same config as the source cycle.
  // Returns the new cycleId. Audit-logged. Source cycle id captured in metadata.
  app.post('/api/v5/cycles/:id/rerun', async (req, reply) => {
    const { id: sourceId } = req.params as { id: string };
    if (!SAFE_ID.test(sourceId)) return reply.status(400).send({ error: 'Invalid cycle id' });

    const r = resolveProjectRoot(req as { query: unknown; headers: Record<string, unknown> }, opts.projectRoot);
    if ('error' in r) return reply.status(r.error.status).send(r.error.body);
    const reqProjectRoot = r.projectRoot;
    const base = cyclesBaseDir(reqProjectRoot);

    // Read source cycle-config.json to inherit its settings.
    const sourceDir = safeJoin(base, sourceId);
    let sourceConfig: Record<string, unknown> = {};
    if (sourceDir && existsSync(sourceDir)) {
      const configPath = join(sourceDir, 'cycle-config.json');
      if (existsSync(configPath)) {
        try {
          sourceConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
        } catch { /* use empty defaults */ }
      }
      // Also try reading from cycle.json cost.budgetUsd if config file is missing.
      if (Object.keys(sourceConfig).length === 0) {
        const cjPath = join(sourceDir, 'cycle.json');
        if (existsSync(cjPath)) {
          try {
            const cj = JSON.parse(readFileSync(cjPath, 'utf-8')) as Record<string, unknown>;
            const cost = (cj['cost'] ?? {}) as Record<string, unknown>;
            sourceConfig = { budgetUsd: cost['budgetUsd'] ?? null };
          } catch { /* use defaults */ }
        }
      }
    }

    const newCycleId = randomUUID();
    const startedAt = new Date().toISOString();
    const newCycleDir = safeJoin(base, newCycleId);
    if (!newCycleDir) return reply.status(500).send({ error: 'Failed to resolve new cycle dir' });

    try {
      mkdirSync(newCycleDir, { recursive: true });
    } catch (err) {
      return reply.status(500).send({ error: `Failed to create cycle dir: ${(err as Error).message}` });
    }

    // Persist inherited config + source reference.
    const rerunConfig: Record<string, unknown> = {
      cycleId: newCycleId,
      startedAt,
      sourceCycleId: sourceId,
      budgetUsd: sourceConfig['budgetUsd'] ?? null,
      maxItems: sourceConfig['maxItems'] ?? null,
      modelCap: sourceConfig['modelCap'] ?? null,
      effortCap: sourceConfig['effortCap'] ?? null,
      branchPrefix: sourceConfig['branchPrefix'] ?? null,
      baseBranch: sourceConfig['baseBranch'] ?? currentGitBranch(reqProjectRoot),
      dryRun: sourceConfig['dryRun'] ?? null,
      comment: sourceConfig['comment'] ?? null,
      maxAgents: sourceConfig['maxAgents'] ?? null,
      tags: Array.isArray(sourceConfig['tags']) ? sourceConfig['tags'] : [],
      fallbackEnabled: sourceConfig['fallbackEnabled'] ?? null,
      runtimeMode: 'codex-cli',
    };
    try {
      writeFileSync(join(newCycleDir, 'cycle-config.json'), JSON.stringify(rerunConfig, null, 2));
    } catch { /* non-fatal */ }

    let logFd: number;
    try {
      logFd = openSync(join(newCycleDir, 'cli-stdout.log'), 'a');
    } catch (err) {
      return reply.status(500).send({ error: `Failed to open log file: ${(err as Error).message}` });
    }

    const nodeBin = process.execPath;
    // Same fix as the start-cycle handler: resolve CLI binary relative to the
    // AgentForge package installation, not the external project root.
    const cliEntry = resolveAgentForgeCli(import.meta.url);
    if (!existsSync(cliEntry)) {
      return reply.status(500).send({ error: `AgentForge CLI entry not found at ${cliEntry}` });
    }

    // Build env overrides from inherited config.
    const env: NodeJS.ProcessEnv = { ...process.env, AGENTFORGE_RUNTIME: 'codex-cli', AUTONOMOUS_CYCLE_ID: newCycleId };
    if (typeof sourceConfig['budgetUsd'] === 'number' && sourceConfig['budgetUsd'] > 0) {
      env['AUTONOMOUS_BUDGET_USD'] = String(sourceConfig['budgetUsd']);
    }
    if (typeof sourceConfig['maxItems'] === 'number' && sourceConfig['maxItems'] > 0) {
      env['AUTONOMOUS_MAX_ITEMS'] = String(sourceConfig['maxItems']);
    }
    const modelCap = sourceConfig['modelCap'];
    if (modelCap === 'opus' || modelCap === 'sonnet' || modelCap === 'haiku') {
      env['AUTONOMOUS_MODEL_CAP'] = modelCap;
    }
    const effortCap = sourceConfig['effortCap'];
    if (effortCap === 'low' || effortCap === 'medium' || effortCap === 'high' || effortCap === 'xhigh' || effortCap === 'max') {
      env['AUTONOMOUS_EFFORT_CAP'] = effortCap;
    }
    if (typeof sourceConfig['maxAgents'] === 'number' && sourceConfig['maxAgents'] > 0) {
      env['AUTONOMOUS_MAX_AGENTS'] = String(sourceConfig['maxAgents']);
    }
    if (typeof sourceConfig['fallbackEnabled'] === 'boolean') {
      env['AUTONOMOUS_FALLBACK_ENABLED'] = sourceConfig['fallbackEnabled'] ? 'true' : 'false';
    }
    if (typeof sourceConfig['branchPrefix'] === 'string' && sourceConfig['branchPrefix'].trim().length > 0) {
      env['AUTONOMOUS_BRANCH_PREFIX'] = sourceConfig['branchPrefix'].trim();
    }
    if (typeof sourceConfig['baseBranch'] === 'string' && sourceConfig['baseBranch'].trim().length > 0) {
      env['AUTONOMOUS_BASE_BRANCH'] = sourceConfig['baseBranch'].trim();
    } else {
      const baseBranch = currentGitBranch(reqProjectRoot);
      if (baseBranch !== null) env['AUTONOMOUS_BASE_BRANCH'] = baseBranch;
    }
    if (sourceConfig['dryRun'] === true) {
      env['AUTONOMOUS_DRY_RUN'] = 'true';
    }

    let pid: number;
    let pgid: number;
    try {
      const child = spawn(nodeBin, [cliEntry, 'cycle', 'run'], {
        cwd: reqProjectRoot,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env,
      });
      if (typeof child.once === 'function') {
        child.once('error', (err) => {
          cycleSessions.markTerminal(newCycleId, 'crashed', `spawn error: ${err.message}`);
        });
        child.once('exit', (code, signal) => {
          if (code !== null && code !== 0) {
            cycleSessions.markTerminal(newCycleId, 'crashed', `cycle process exited with code ${code}`);
          } else if (signal) {
            cycleSessions.markTerminal(newCycleId, 'killed', `cycle process exited from signal ${signal}`);
          }
        });
      }
      child.unref();
      pid = child.pid ?? -1;
      pgid = pid;
    } catch (err) {
      return reply.status(500).send({ error: `Failed to spawn rerun cycle: ${(err as Error).message}` });
    }

    if (pid > 0) {
      try {
        cycleSessions.register({ cycleId: newCycleId, pid, pgid, workspaceId: 'default', workspaceRoot: reqProjectRoot });
      } catch { /* non-fatal */ }
    }

    // SOC-2 audit log.
    appendAuditEntry(auditDb, {
      actor: 'api',
      action: 'cycle.rerun',
      target: newCycleId,
      details: { sourceCycleId: sourceId, inheritedConfig: rerunConfig },
    });

    return reply.status(202).send({ cycleId: newCycleId, sourceCycleId: sourceId, startedAt, pid, pgid });
  });
}
