/**
 * Cycle session manager — tracks every live autonomous cycle process so the
 * dashboard, the stop endpoint, and the reaper can find them.
 *
 * Single source of truth: `~/.agentforge/sessions.json` (0o600 perms).
 *
 * Why this exists: pre-v6.7.4, killing a cycle's parent process via `kill PID`
 * left the spawned `claude -p` child subprocesses running because they were
 * started with `detached: true`. The zombies kept consuming tokens and showed
 * up in `ps` long after the cycle was supposedly stopped. The fix is two-part:
 *   1. spawn cycles as process-group leaders (this file's `register()` records
 *      the pgid alongside the pid)
 *   2. kill via `process.kill(-pgid)` — the negative pgid sends the signal
 *      to every process in the group, taking down the parent and all children
 *      atomically
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';

const SESSIONS_DIR = join(homedir(), '.agentforge');
const SESSIONS_FILE = join(SESSIONS_DIR, 'sessions.json');

export type CycleSessionStatus = 'running' | 'completed' | 'failed' | 'killed' | 'crashed';

export interface CycleSession {
  cycleId: string;
  pid: number;
  /** Process group id — used for kill -pgid to take down all children. */
  pgid: number;
  workspaceId: string;
  workspaceRoot: string;
  startedAt: string;
  lastSeenAt: string;
  status: CycleSessionStatus;
  /** Optional terminal note when status moves off "running". */
  exitNote?: string;
}

interface SessionsFile {
  version: 1;
  cycles: CycleSession[];
}

function emptyFile(): SessionsFile {
  return { version: 1, cycles: [] };
}

function readSessionsFile(): SessionsFile {
  if (!existsSync(SESSIONS_FILE)) return emptyFile();
  try {
    const raw = readFileSync(SESSIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SessionsFile>;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.cycles)) {
      return emptyFile();
    }
    return parsed as SessionsFile;
  } catch {
    return emptyFile();
  }
}

function writeSessionsFile(file: SessionsFile): void {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { mode: 0o700, recursive: true });
  writeFileSync(SESSIONS_FILE, JSON.stringify(file, null, 2), { mode: 0o600 });
  try { chmodSync(SESSIONS_FILE, 0o600); } catch { /* best effort */ }
}

/**
 * Test whether a PID is alive. `process.kill(pid, 0)` sends signal 0 which
 * doesn't actually deliver a signal but raises ESRCH if the pid is gone.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    // EPERM means the pid exists but we don't own it — still alive
    return code === 'EPERM';
  }
}

/** Register a freshly-spawned cycle. Caller passes the spawned process ref. */
export function register(input: {
  cycleId: string;
  pid: number;
  pgid: number;
  workspaceId: string;
  workspaceRoot: string;
}): void {
  const file = readSessionsFile();
  const now = new Date().toISOString();
  // Drop any prior entry for the same cycleId
  file.cycles = file.cycles.filter((c) => c.cycleId !== input.cycleId);
  file.cycles.push({
    cycleId: input.cycleId,
    pid: input.pid,
    pgid: input.pgid,
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    startedAt: now,
    lastSeenAt: now,
    status: 'running',
  });
  writeSessionsFile(file);
}

/** Get a single session by cycleId, or null. */
export function get(cycleId: string): CycleSession | null {
  const file = readSessionsFile();
  return file.cycles.find((c) => c.cycleId === cycleId) ?? null;
}

/** List every known session. Caller can filter by status. */
export function list(filter?: { status?: CycleSessionStatus }): CycleSession[] {
  const file = readSessionsFile();
  if (!filter?.status) return file.cycles;
  return file.cycles.filter((c) => c.status === filter.status);
}

/** Mark a session terminal. Idempotent. */
export function markTerminal(cycleId: string, status: Exclude<CycleSessionStatus, 'running'>, exitNote?: string): void {
  const file = readSessionsFile();
  const entry = file.cycles.find((c) => c.cycleId === cycleId);
  if (!entry || entry.status !== 'running') return;
  entry.status = status;
  entry.lastSeenAt = new Date().toISOString();
  if (exitNote) entry.exitNote = exitNote;
  writeSessionsFile(file);
}

/**
 * Stop a running cycle by sending SIGTERM to the entire process group, then
 * SIGKILL after a grace period if anything is still alive. Returns the new
 * status. Safe to call on already-terminal sessions (no-op).
 */
export async function stop(cycleId: string, opts?: { graceMs?: number }): Promise<{
  ok: boolean;
  status: CycleSessionStatus;
  message: string;
}> {
  const session = get(cycleId);
  if (!session) {
    return { ok: false, status: 'crashed', message: 'no session record found' };
  }
  if (session.status !== 'running') {
    return { ok: true, status: session.status, message: 'already terminal' };
  }
  if (!isPidAlive(session.pid)) {
    markTerminal(cycleId, 'crashed', 'PID was not alive at stop time');
    return { ok: true, status: 'crashed', message: 'PID was not alive — marked crashed' };
  }

  const graceMs = opts?.graceMs ?? 10_000;

  // Send SIGTERM to the entire process group. The negative pgid tells the
  // kernel to deliver to every process whose pgid matches.
  try {
    process.kill(-session.pgid, 'SIGTERM');
  } catch {
    // pgid may have died between probe and kill — fall through
  }

  // Wait up to graceMs for the parent PID to exit.
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(session.pid)) {
      markTerminal(cycleId, 'killed', 'SIGTERM accepted within grace period');
      return { ok: true, status: 'killed', message: 'stopped gracefully' };
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  // Hard kill — SIGKILL to the group.
  try {
    process.kill(-session.pgid, 'SIGKILL');
  } catch { /* ignore */ }
  markTerminal(cycleId, 'killed', 'SIGKILL after grace period expired');
  return { ok: true, status: 'killed', message: 'force-killed after grace period' };
}

/**
 * Reaper sweep — probe every running session, mark dead PIDs as crashed.
 * Returns the count of cycles that flipped from running → crashed.
 */
export function reap(): { reaped: number; stillRunning: number } {
  const file = readSessionsFile();
  let reaped = 0;
  let stillRunning = 0;
  let dirty = false;
  const now = new Date().toISOString();
  for (const c of file.cycles) {
    if (c.status !== 'running') continue;
    if (isPidAlive(c.pid)) {
      stillRunning++;
      c.lastSeenAt = now;
      dirty = true;
    } else {
      c.status = 'crashed';
      c.exitNote = 'PID disappeared (reaper sweep)';
      c.lastSeenAt = now;
      reaped++;
      dirty = true;
    }
  }
  if (dirty) writeSessionsFile(file);
  return { reaped, stillRunning };
}

/**
 * Start a periodic reaper that sweeps every `intervalMs`. Returns a stop
 * handle. The Fastify server boots one of these on startup.
 */
export function startReaper(intervalMs = 30_000): { stop: () => void } {
  const handle = setInterval(() => {
    try { reap(); } catch { /* swallow */ }
  }, intervalMs);
  // Don't keep the event loop alive solely for the reaper.
  if (typeof (handle as unknown as { unref?: () => void }).unref === 'function') {
    (handle as unknown as { unref: () => void }).unref();
  }
  return {
    stop: () => clearInterval(handle),
  };
}

/** Path accessor for tests. */
export function sessionsFilePath(): string {
  return SESSIONS_FILE;
}
