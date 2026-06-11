// packages/core/src/autonomous/phase-scheduler.ts
// Event-driven phase auto-advance for autonomous development cycles.
// Subscribes to sprint.phase.completed/failed on the EventBus and triggers
// the next phase in sequence. Kill switch checked between every phase.
// See docs/superpowers/specs/2026-04-06-autonomous-loop-design.md §7.3
import { join } from 'node:path';
import type { KillSwitch } from './kill-switch.js';
import type { CycleLogger } from './cycle-logger.js';
import { CycleKilledError, PhaseFailedError } from './types.js';
import { GateRejectedError } from './phase-handlers/gate-phase.js';
import {
  writeCheckpoint,
  type CycleCheckpoint,
} from './cycle-artifacts/cycle-checkpoint.js';

export type PhaseName =
  | 'audit'
  | 'plan'
  | 'assign'
  | 'execute'
  | 'test'
  | 'review'
  | 'gate'
  | 'release'
  | 'learn';

export const PHASE_SEQUENCE: PhaseName[] = [
  'audit',
  'plan',
  'assign',
  'execute',
  'test',
  'review',
  'gate',
  'release',
  'learn',
];

export function nextPhase(current: PhaseName): PhaseName | null {
  const idx = PHASE_SEQUENCE.indexOf(current);
  return idx === -1 || idx === PHASE_SEQUENCE.length - 1
    ? null
    : PHASE_SEQUENCE[idx + 1]!;
}

// TODO(T4.2): import WorktreePool from '../runtime/worktree-pool.js' once
// Workstream AA lands packages/core/src/runtime/worktree-pool.ts.
// The interface below is a forward-compatible type stub; the runtime class will
// satisfy it when AA's PR merges.
/** Minimal interface so execute-phase can allocate/release worktrees without
 *  depending on the full WorktreePool class (which lives in Workstream AA). */
export interface WorktreePoolLike {
  allocate(opts: {
    agentId: string;
    sessionId: string;
    branchName?: string;
    sourceRef?: string;
    deleteBranchOnRelease?: boolean;
  }): Promise<{
    id: string;
    path: string;
    branch: string;
    baselineHead?: string;
    deleteBranchOnRelease?: boolean;
    sourceRef?: string;
    allocatedAt: string;
    agentId: string;
    sessionId: string;
  }>;
  release(id: string): Promise<void>;
}

export interface GateRetryContext {
  attempt: number;
  rationale: string;
  rejectedBranch?: string;
  prNumber?: number;
  prUrl?: string;
  itemIds?: string[];
  files?: string[];
  findings?: string[];
}

export interface PhaseContext {
  sprintId: string;
  sprintVersion: string;
  projectRoot: string;
  adapter: any;
  bus: {
    publish: (topic: string, payload: any) => void;
    subscribe: (topic: string, cb: (event: any) => void) => () => void;
  };
  runtime: any;
  cycleId?: string;
  /**
   * The base branch that agent worktrees are forked from.
   * Defaults to 'main' when not provided.
   */
  baseBranch?: string;
  /** Gate retry attempt number (0 = first run). */
  retryAttempt?: number;
  /** On retry, skip phases before this one (e.g. jump straight to 'execute'). */
  skipToPhase?: PhaseName;
  /**
   * Gate rejection details from the previous attempt. Execute uses this to
   * repair the rejected PR/branch instead of reinterpreting the original item
   * as fresh work.
   */
  gateRetry?: GateRetryContext;
  /**
   * T4.2 — Optional WorktreePool. When provided, the execute phase allocates a
   * fresh worktree per coder-class item and sets the agent's cwd to that path,
   * eliminating main-tree branch ping-pong. Falls back to the existing
   * single-tree behaviour when absent.
   */
  worktreePool?: WorktreePoolLike;
  /**
   * Wave 3 T5 — Optional resume checkpoint. When provided, the scheduler will
   * skip phases listed in `completedPhases` and seed the run from
   * `resumeFromPhase`. Independent of `skipToPhase` (gate-retry) — both can
   * co-exist; resumeCheckpoint takes precedence for the start phase.
   */
  resumeCheckpoint?: CycleCheckpoint;
  /**
   * Wave 3 T5 — Total budget for the cycle (used by checkpoint payload).
   * Defaults to 0 when not provided.
   */
  budgetUsd?: number;
  /**
   * Epic-decomposer (spec 2026-05-30): the operator's objective text. When
   * present, the plan phase decomposes it into wave-layered plan.json items
   * instead of producing a signal-backlog text plan. Absent on signal cycles.
   */
  objective?: string;
}

/**
 * P0.4 — KEYSTONE. When the execute phase ran an epic cycle (items carrying
 * `parentEpicId`), it accumulates every wave's child branches onto a local
 * integration branch `codex/epic-<id>` held in a dedicated worktree. This is
 * surfaced on the execute PhaseResult so the cycle-runner's release stage can
 * push that ONE branch and open ONE PR from it — instead of committing to the
 * operator's main working tree. Absent on flat (non-epic) cycles.
 */
export interface EpicIntegrationResult {
  /** The local integration branch, e.g. `codex/epic-abc12345`. */
  branch: string;
  /** Epic id the integration branch was derived from. */
  epicId: string;
  /** Absolute path to the local integration worktree that holds the branch. */
  worktreePath?: string;
  /** Child branches successfully merged into the integration branch (all waves). */
  mergedBranches: string[];
  /** True when at least one wave-merge conflicted (owning items were failed). */
  hadConflicts: boolean;
  /**
   * P0.5 — true when any epic child touched a CI-config-class file
   * (package.json, pnpm-lock.yaml, .github/workflows/**, scripts/**). The
   * per-child bar deliberately does NOT run the full verify:gates pipeline; it
   * surfaces this flag so the cycle-runner runs verify:gates once at the epic
   * level. Absent/false on epics whose children only touched ordinary source.
   */
  requiresFullGates?: boolean;
}

export interface PhaseResult {
  phase: PhaseName;
  status: 'completed' | 'failed' | 'blocked';
  durationMs: number;
  costUsd: number;
  agentRuns: unknown[];
  itemResults?: unknown[];
  error?: string;
  /** P0.4 — present only on the execute phase of an epic cycle. */
  epicIntegration?: EpicIntegrationResult;
}

export type PhaseHandler = (ctx: PhaseContext) => Promise<PhaseResult | void>;

export interface SprintRunSummary {
  completedPhases: PhaseResult[];
  totalCostUsd: number;
  totalDurationMs: number;
}

export class PhaseScheduler {
  private unsubscribers: Array<() => void> = [];
  private resolvePromise: ((result: SprintRunSummary) => void) | null = null;
  private rejectPromise: ((err: Error) => void) | null = null;
  private phaseResults = new Map<PhaseName, PhaseResult>();
  private settled = false;
  /** Wave 3 T5 — phases already done (seeded from resumeCheckpoint, then grown). */
  private completedPhases: PhaseName[] = [];

  constructor(
    private readonly ctx: PhaseContext,
    private readonly killSwitch: KillSwitch,
    private readonly logger: CycleLogger,
    private readonly handlers: Record<PhaseName, PhaseHandler>,
  ) {}

  /**
   * Run a sprint end-to-end, auto-advancing through all phases.
   * Resolves when LEARN phase completes; rejects if killed or failed.
   */
  async run(): Promise<SprintRunSummary> {
    return new Promise((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
      this.subscribe();

      // Wave 3 T5 — seed completedPhases from resume checkpoint so the
      // checkpoint payload remains coherent across resumes.
      const resume = this.ctx.resumeCheckpoint;
      if (resume) {
        this.completedPhases = [...resume.completedPhases];
      }

      // Phase ordering: explicit gate-retry hop > checkpoint resume > 'audit'.
      const startPhase: PhaseName =
        this.ctx.skipToPhase ?? resume?.resumeFromPhase ?? 'audit';
      void this.triggerPhase(startPhase);
    });
  }

  private subscribe(): void {
    const onCompleted = (event: any) => {
      if (event.sprintId !== this.ctx.sprintId) return;
      if (event.phase && event.result) {
        this.phaseResults.set(event.phase, event.result);
        this.logger.logPhaseResult(event.phase, event.result);
        // Flush accumulated cost to cycle.json after each phase so operators
        // have live spend visibility without waiting for terminal state.
        this.logger.flushCycleCost(this.sumCost());
      }

      const phaseResult = event.result as PhaseResult | undefined;
      const justRan = event.phase as PhaseName;
      if (phaseResult && phaseResult.status !== 'completed') {
        const reason =
          typeof phaseResult.error === 'string' && phaseResult.error.length > 0
            ? phaseResult.error
            : `${justRan} phase reported ${phaseResult.status}`;
        this.persistFailureCheckpoint(justRan);
        if (justRan === 'gate') {
          return this.fail(new GateRejectedError(reason));
        }
        return this.fail(new PhaseFailedError(justRan, reason));
      }

      const trip = this.killSwitch.checkBetweenPhases({
        cumulativeCostUsd: this.sumCost(),
        consecutiveFailures: this.countConsecutiveFailures(),
      });
      if (trip) {
        return this.fail(new CycleKilledError(trip));
      }

      // Maintain ordered, deduped completedPhases list.
      if (!this.completedPhases.includes(justRan)) {
        this.completedPhases.push(justRan);
      }
      const next = nextPhase(justRan);

      // Wave 3 T5 — write checkpoint AFTER every successful phase, BEFORE the
      // next handler runs. The checkpoint is written even if the next phase
      // later fails (durability contract). Best-effort: a checkpoint write
      // failure must not kill the cycle.
      this.persistCheckpoint(next ?? justRan);

      if (!next) return this.complete();
      void this.triggerPhase(next);
    };

    const onFailed = (event: any) => {
      if (event.sprintId !== this.ctx.sprintId) return;
      this.logger.logPhaseFailure(event.phase, event.error);
      this.persistFailureCheckpoint(event.phase as PhaseName);
      // Preserve GateRejectedError so the cycle runner's retry loop can catch it
      if (event.originalError instanceof GateRejectedError) {
        this.fail(event.originalError);
      } else {
        this.fail(new PhaseFailedError(event.phase, event.error));
      }
    };

    const onItemStarted = (event: any) => {
      if (event.sprintId !== this.ctx.sprintId) return;
      this.logger.appendEvent({
        type: 'cycle_event',
        category: 'item.started',
        payload: event,
        at: new Date().toISOString(),
      });
    };

    const onItemCompleted = (event: any) => {
      if (event.sprintId !== this.ctx.sprintId) return;
      this.logger.appendEvent({
        type: 'cycle_event',
        category: 'item.completed',
        payload: event,
        at: new Date().toISOString(),
      });
    };

    // Mid-execute-phase cost flush: the execute phase publishes execute.snapshot
    // after every item completes (with costUsd = execute's running total). By
    // subscribing here we can flush the cycle-level cumulative cost to cycle.json
    // between items so operators see live spend during the long execute stage
    // instead of waiting until all items finish and sprint.phase.completed fires.
    //
    // this.sumCost() at the time of each snapshot gives audit+plan+assign costs
    // (phases already completed); event.costUsd gives execute's running spend.
    // Together they form the correct cycle-level cumulative total.
    const onExecuteSnapshot = (event: any) => {
      if (event.sprintId !== this.ctx.sprintId) return;
      if (typeof event.costUsd === 'number') {
        this.logger.flushCycleCost(this.sumCost() + event.costUsd);
      }
    };

    this.unsubscribers.push(
      this.ctx.bus.subscribe('sprint.phase.completed', onCompleted),
      this.ctx.bus.subscribe('sprint.phase.failed', onFailed),
      this.ctx.bus.subscribe('sprint.phase.item.started', onItemStarted),
      this.ctx.bus.subscribe('sprint.phase.item.completed', onItemCompleted),
      this.ctx.bus.subscribe('execute.snapshot', onExecuteSnapshot),
    );
  }

  private async triggerPhase(phase: PhaseName): Promise<void> {
    // Wave 3 T5 — skip phases already completed (resume safety). Respect
    // PHASE_SEQUENCE ordering: jump forward to the next not-yet-done phase.
    if (this.completedPhases.includes(phase)) {
      const next = nextPhase(phase);
      if (!next) return this.complete();
      return this.triggerPhase(next);
    }
    this.logger.logPhaseStart(phase);
    try {
      const handler = this.handlers[phase];
      if (!handler) {
        throw new Error(`No handler for phase ${phase}`);
      }
      await handler(this.ctx);
      // Handlers publish their own completion events
    } catch (err) {
      this.ctx.bus.publish('sprint.phase.failed', {
        sprintId: this.ctx.sprintId,
        phase,
        cycleId: this.ctx.cycleId,
        error: err instanceof Error ? err.message : String(err),
        originalError: err,
        failedAt: new Date().toISOString(),
      });
    }
  }

  private complete(): void {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    const phases = Array.from(this.phaseResults.values());
    const summary: SprintRunSummary = {
      completedPhases: phases,
      totalCostUsd: this.sumCost(),
      totalDurationMs: phases.reduce((a, r) => a + r.durationMs, 0),
    };
    this.resolvePromise?.(summary);
  }

  private fail(err: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    this.rejectPromise?.(err);
  }

  private cleanup(): void {
    this.unsubscribers.forEach((u) => u());
    this.unsubscribers = [];
  }

  /**
   * Wave 3 T5 — Persist the cycle checkpoint after a successful phase. The
   * `resumeFromPhase` is the next phase to run (or the just-completed phase
   * if we're at the terminal). Best-effort: any failure is logged and
   * swallowed so a checkpoint write cannot crash the cycle.
   */
  private persistCheckpoint(nextPhaseName: PhaseName): void {
    this.persistCheckpointWithPhases(nextPhaseName, [...this.completedPhases]);
  }

  private persistFailureCheckpoint(failedPhase: PhaseName): void {
    const resumeFromPhase = failedPhase === 'gate' ? 'execute' : failedPhase;
    const resumeIdx = PHASE_SEQUENCE.indexOf(resumeFromPhase);
    const completedPhases = this.completedPhases.filter(
      (phase) => PHASE_SEQUENCE.indexOf(phase) < resumeIdx,
    );
    this.persistCheckpointWithPhases(resumeFromPhase, completedPhases);
  }

  private persistCheckpointWithPhases(
    nextPhaseName: PhaseName,
    completedPhases: PhaseName[],
  ): void {
    const cycleId = this.ctx.cycleId;
    if (!cycleId) return; // no id, nowhere to write
    try {
      const cycleDir = join(this.ctx.projectRoot, '.agentforge', 'cycles', cycleId);
      const spent = this.sumCost();
      const ckpt: CycleCheckpoint = {
        v: 1,
        cycleId,
        capturedAt: new Date().toISOString(),
        resumeFromPhase: nextPhaseName,
        completedPhases,
        budgetUsd: this.ctx.budgetUsd ?? 0,
        spentUsd: spent,
      };
      writeCheckpoint(cycleDir, ckpt);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[phase-scheduler] checkpoint write failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private sumCost(): number {
    let total = 0;
    for (const r of this.phaseResults.values()) total += r.costUsd;
    return total;
  }

  private countConsecutiveFailures(): number {
    let count = 0;
    for (const r of Array.from(this.phaseResults.values()).reverse()) {
      if (r.status === 'failed') count++;
      else break;
    }
    return count;
  }
}
