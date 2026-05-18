// packages/core/src/autonomous/cycle-logger.ts
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CycleResult, TestResult, ScoringResult, KillSwitchTrip } from './types.js';
import { writeMemoryEntry } from '../memory/types.js';
import { validateCycleJson, validateScoringJson } from './cycle-artifacts/index.js';

export interface GitEvent {
  type: 'branch-created' | 'staged' | 'committed' | 'pushed' | 'rolled-back' | 'unreachable-skipped';
  branch?: string;
  sha?: string;
  fromSha?: string;
  files?: string[];
  message?: string;
}

export interface PREvent {
  type: 'opened' | 'failed';
  url?: string;
  number?: number;
  title?: string;
  error?: string;
}

export class CycleLogger {
  private readonly cycleDir: string;
  private readonly eventsPath: string;

  constructor(
    private readonly cwd: string,
    private readonly cycleId: string,
  ) {
    this.cycleDir = join(cwd, '.agentforge/cycles', cycleId);
    this.eventsPath = join(this.cycleDir, 'events.jsonl');
    mkdirSync(this.cycleDir, { recursive: true });
    mkdirSync(join(this.cycleDir, 'phases'), { recursive: true });
  }

  logPhaseStart(phase: string): void {
    this.appendEvent({ type: 'phase.start', phase, at: new Date().toISOString() });
  }

  /**
   * Record the sprint version for this cycle. Emitted immediately after the
   * SprintGenerator returns so the dashboard cycle detail page can resolve
   * cycle→sprint without timestamp-proximity matching. Also writes a small
   * sprint-link.json file in the cycle dir as a fast lookup key.
   */
  logSprintAssigned(sprintVersion: string): void {
    this.appendEvent({ type: 'sprint.assigned', sprintVersion, at: new Date().toISOString() });
    try {
      this.writeJson(join(this.cycleDir, 'sprint-link.json'), { sprintVersion, assignedAt: new Date().toISOString() });
    } catch { /* non-fatal */ }
  }

  logPhaseResult(phase: string, result: unknown): void {
    this.writeJson(join(this.cycleDir, 'phases', `${phase}.json`), result);
    this.appendEvent({ type: 'phase.result', phase, at: new Date().toISOString() });
  }

  logPhaseFailure(phase: string, error: string): void {
    this.writeJson(join(this.cycleDir, 'phases', `${phase}.json`), { phase, error, status: 'failed' });
    this.appendEvent({ type: 'phase.failure', phase, error, at: new Date().toISOString() });
  }

  logTestRun(result: TestResult): void {
    this.writeJson(join(this.cycleDir, 'tests.json'), result);
    this.appendEvent({ type: 'tests.complete', passed: result.passed, failed: result.failed, at: new Date().toISOString() });
  }

  logScoring(result: ScoringResult, grounding: unknown): void {
    const scoringPayload = { result, grounding, at: new Date().toISOString() };
    // Opt-in schema validation — warns on drift, never throws.
    validateScoringJson(scoringPayload);
    this.writeJson(join(this.cycleDir, 'scoring.json'), scoringPayload);
    this.appendEvent({ type: 'scoring.complete', totalCostUsd: result.totalEstimatedCostUsd, at: new Date().toISOString() });
  }

  logScoringFallback(strike: number, error: string): void {
    this.appendEvent({ type: 'scoring.fallback', strike, error, at: new Date().toISOString() });
  }

  logApprovalPending(data: unknown): void {
    this.writeJson(join(this.cycleDir, 'approval-pending.json'), data);
    this.appendEvent({ type: 'approval.pending', at: new Date().toISOString() });
  }

  logApprovalDecision(data: unknown): void {
    this.writeJson(join(this.cycleDir, 'approval-decision.json'), data);
    this.appendEvent({ type: 'approval.decision', at: new Date().toISOString() });
  }

  logGitEvent(event: GitEvent): void {
    const path = join(this.cycleDir, 'git.json');
    const existing = existsSync(path)
      ? JSON.parse(readFileSync(path, 'utf8'))
      : { events: [] };
    existing.events.push({ ...event, at: new Date().toISOString() });
    this.writeJson(path, existing);
    // v6.7.4: spread event FIRST, then override type to include the git.
    // prefix. The previous `{ type: 'git.' + event.type, ...event, ... }`
    // order had the spread clobber the typed event.type, producing a
    // duplicate-key warning and a dropped prefix.
    this.appendEvent({ ...event, type: 'git.' + event.type, at: new Date().toISOString() });
  }

  logPREvent(event: PREvent): void {
    this.writeJson(join(this.cycleDir, 'pr.json'), { ...event, at: new Date().toISOString() });
    this.appendEvent({ ...event, type: 'pr.' + event.type, at: new Date().toISOString() });
  }

  logKillSwitch(trip: KillSwitchTrip): void {
    this.appendEvent({ type: 'kill-switch.trip', ...trip, at: new Date().toISOString() });
  }

  /**
   * Write an intermediate cost snapshot to cycle.json so operators have
   * live cost visibility during the RUN stage instead of waiting for the
   * terminal cycle.json written by logCycleResult().
   *
   * Called after each phase result is written by the PhaseScheduler. Any I/O
   * error is silently swallowed — this is purely observability data and must
   * never stop the cycle.
   */
  flushCycleCost(totalUsd: number): void {
    const cyclePath = join(this.cycleDir, 'cycle.json');
    try {
      let base: Record<string, unknown> = {};
      if (existsSync(cyclePath)) {
        try {
          base = JSON.parse(readFileSync(cyclePath, 'utf8')) as Record<string, unknown>;
        } catch { /* keep empty base on parse error */ }
      }
      // Preserve any terminal stage already written by logCycleResult().
      // Only default to 'run' when no stage has been set yet.
      const stage = base['stage'] ?? 'run';
      const existingCost = (base['cost'] ?? {}) as Record<string, unknown>;
      this.writeJson(cyclePath, {
        ...base,
        cycleId: this.cycleId,
        stage,
        cost: { ...existingCost, totalUsd },
      });
    } catch { /* non-fatal: observability write failure must not stop the cycle */ }
  }

  /**
   * Write `lastHeartbeatAt` to cycle.json without touching cost or stage. Lets
   * consumers detect a cycle that died at the OS level (SIGKILL, OOM, parent
   * terminal close) where Node's try/catch in cycle-runner.start() never runs.
   * Without a heartbeat, cycle.json sits at `stage: "run"` forever and the
   * dashboard reports an in-flight cycle that hasn't ticked in hours.
   * See memory/project_cycle_db9c145f_post_mortem.md.
   */
  flushHeartbeat(): void {
    const cyclePath = join(this.cycleDir, 'cycle.json');
    try {
      let base: Record<string, unknown> = {};
      if (existsSync(cyclePath)) {
        try {
          base = JSON.parse(readFileSync(cyclePath, 'utf8')) as Record<string, unknown>;
        } catch { /* keep empty base on parse error */ }
      }
      const stage = base['stage'] ?? 'run';
      this.writeJson(cyclePath, {
        ...base,
        cycleId: this.cycleId,
        stage,
        lastHeartbeatAt: new Date().toISOString(),
      });
    } catch { /* non-fatal */ }
  }

  logCycleResult(result: CycleResult): void {
    // Opt-in schema validation — warns on drift, never throws.
    validateCycleJson(result);
    this.writeJson(join(this.cycleDir, 'cycle.json'), result);
    this.appendEvent({ type: 'cycle.complete', stage: result.stage, at: new Date().toISOString() });
    writeMemoryEntry(this.cwd, {
      type: 'cycle-outcome',
      value: JSON.stringify({
        cycleId: result.cycleId,
        sprintVersion: result.sprintVersion,
        stage: result.stage,
        costUsd: result.cost.totalUsd,
        testsPassed: result.tests.passed,
        gateVerdict: result.gateVerdict ?? null,
        prUrl: result.pr.url,
      }),
      source: result.cycleId,
      tags: ['cycle', result.stage],
    });
  }

  private writeJson(path: string, data: unknown): void {
    writeFileSync(path, JSON.stringify(data, null, 2));
  }

  appendEvent(event: Record<string, unknown>): void {
    appendFileSync(this.eventsPath, JSON.stringify(event) + '\n');
  }
}
