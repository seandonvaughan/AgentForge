/**
 * Daemon state persistence — load/save ~/.agentforge/daemon-state.json.
 *
 * State survives daemon restarts. The daemon writes on every meaningful
 * transition (cycle started/finished, pause toggled, cost period rolled).
 * Reads happen exactly once at startup.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { DaemonState } from './types.js';

const STATE_DIR = join(homedir(), '.agentforge');
const STATE_FILE = join(STATE_DIR, 'daemon-state.json');

/** Returns today's date in YYYY-MM-DD form (used for cost period rollover). */
export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function defaultState(): DaemonState {
  const now = new Date().toISOString();
  return {
    startedAt: now,
    lastHeartbeatAt: now,
    paused: false,
    costPeriodDate: todayIsoDate(),
    costPeriodSpentUsd: 0,
    consecutiveFailures: 0,
    shutdownRequested: false,
  };
}

export function loadState(): DaemonState {
  if (!existsSync(STATE_FILE)) return defaultState();
  try {
    const raw = readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<DaemonState>;
    // Merge with defaults so a partial/older state file doesn't crash the daemon.
    return { ...defaultState(), ...parsed };
  } catch {
    // Corrupt state file → start fresh rather than crash-loop the daemon.
    return defaultState();
  }
}

export function saveState(state: DaemonState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Returns the path the state file lives at. Exposed for tests so they can
 * point at a tmpdir without globbing the user's real state.
 */
export function stateFilePath(): string {
  return STATE_FILE;
}
