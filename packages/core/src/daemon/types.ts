/**
 * v7.0.0 Persistent Daemon — type definitions.
 *
 * The daemon wraps CycleRunner.start() in a long-running process that triggers
 * cycles automatically. See docs/superpowers/specs/2026-04-07-v7-persistent-daemon-design.md
 * for the full design.
 *
 * This file is the type contract — implementations live alongside it
 * (daemon-runner.ts, daemon-state.ts, cost-ceiling.ts, failure-recovery.ts).
 */

/** Reasons the daemon may be paused. Drives UI badges and recovery logic. */
export type PauseReason =
  | 'manual'
  | 'cost-ceiling'
  | 'consecutive-failures'
  | 'shutdown';

/** A trigger fires when a cycle should be started. */
export type TriggerKind = 'schedule' | 'backlog' | 'queue' | 'webhook' | 'file-watcher';

export interface TriggerEvent {
  kind: TriggerKind;
  /** Workspace this trigger targets. */
  workspaceId: string;
  /** ISO timestamp when the trigger fired. */
  firedAt: string;
  /** Optional human-readable reason — surfaced in the daemon log. */
  reason?: string;
  /** Optional sprintVersion override. Defaults to the workspace's current sprint. */
  sprintVersion?: string;
}

/**
 * Trigger interface — every trigger source implements this.
 * The daemon main loop calls waitForNext() and races them with Promise.race.
 */
export interface Trigger {
  kind: TriggerKind;
  /** Returns a promise that resolves with the next event, or never resolves if disabled. */
  waitForNext(signal: AbortSignal): Promise<TriggerEvent>;
  /** Releases any held resources (timers, watchers, http servers). */
  dispose(): Promise<void>;
}

/** Persisted daemon state — survives restarts via ~/.agentforge/daemon-state.json. */
export interface DaemonState {
  startedAt: string;
  lastHeartbeatAt: string;
  paused: boolean;
  pauseReason?: PauseReason;
  /** ISO date (YYYY-MM-DD) for the current cost-ceiling period. */
  costPeriodDate: string;
  /** Spend in USD for the current period. Reset when costPeriodDate rolls over. */
  costPeriodSpentUsd: number;
  /** Number of consecutive failed cycles. Reset on success. */
  consecutiveFailures: number;
  /** ID of the cycle currently running, if any. */
  currentCycleId?: string;
  /** True if the daemon received SIGTERM/SIGINT and is winding down. */
  shutdownRequested: boolean;
}

/** Cost ceiling configuration. All values in USD. */
export interface CostCeilingConfig {
  dailyUsd: number;
  weeklyUsd: number;
  monthlyUsd: number;
}

/** Failure recovery configuration. */
export interface FailureRecoveryConfig {
  /** Pause the daemon after N consecutive failures. */
  pauseAfterConsecutiveFailures: number;
  /** Wait this long between retries (ms). */
  retryBackoffMs: number;
}

/** Top-level daemon configuration loaded from ~/.agentforge/daemon.yaml. */
export interface DaemonConfig {
  workspaces: string[];
  costCeiling: CostCeilingConfig;
  failureRecovery: FailureRecoveryConfig;
  /** Admin API bind address. Defaults to 127.0.0.1:4760. */
  adminApi: { host: string; port: number };
  /** Trigger definitions — daemon instantiates one Trigger per entry. */
  triggers: TriggerConfigEntry[];
}

/**
 * Discriminated union of trigger config entries. The daemon's trigger factory
 * pattern-matches on `kind` and returns a Trigger implementation.
 */
export type TriggerConfigEntry =
  | { kind: 'schedule'; workspaceId: string; cron: string }
  | { kind: 'backlog'; workspaceId: string; thresholdMarkers: number; pollIntervalMs: number }
  | { kind: 'queue'; workspaceId: string }
  | { kind: 'webhook'; workspaceId: string; path: string }
  | { kind: 'file-watcher'; workspaceId: string; paths: string[]; debounceMs: number };
