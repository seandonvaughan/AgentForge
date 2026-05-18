// packages/core/src/autonomous/phase-scheduler.ts
// Event-driven phase auto-advance for autonomous development cycles.
// Subscribes to sprint.phase.completed/failed on the EventBus and triggers
// the next phase in sequence. Kill switch checked between every phase.
// See docs/superpowers/specs/2026-04-06-autonomous-loop-design.md §7.3
import type { KillSwitch } from './kill-switch.js';
import type { CycleLogger } from './cycle-logger.js';
import { CycleKilledError, PhaseFailedError } from './types.js';
import { GateRejectedError } from './phase-handlers/gate-phase.js';

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
  allocate(opts: { agentId: string; sessionId: string }): Promise<{
    id: string;
    path: string;
    branch: string;
    allocatedAt: string;
    agentId: string;
    sessionId: string;
  }>;
  release(id: string): Promise<void>;
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
   * T4.2 — Optional WorktreePool. When provided, the execute phase allocates a
   * fresh worktree per coder-class item and sets the agent's cwd to that path,
   * eliminating main-tree branch ping-pong. Falls back to the existing
   * single-tree behaviour when absent.
   */
  worktreePool?: WorktreePoolLike;
}

export interface PhaseResult {
  phase: PhaseName;
  status: 'completed' | 'failed' | 'blocked';
  durationMs: number;
  costUsd: number;
  agentRuns: unknown[];
  itemResults?: unknown[];
  error?: string;
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
      const startPhase = this.ctx.skipToPhase ?? 'audit';
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

      const trip = this.killSwitch.checkBetweenPhases({
        cumulativeCostUsd: this.sumCost(),
        consecutiveFailures: this.countConsecutiveFailures(),
      });
      if (trip) {
        return this.fail(new CycleKilledError(trip));
      }

      const next = nextPhase(event.phase as PhaseName);
      if (!next) return this.complete();
      void this.triggerPhase(next);
    };

    const onFailed = (event: any) => {
      if (event.sprintId !== this.ctx.sprintId) return;
      this.logger.logPhaseFailure(event.phase, event.error);
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
