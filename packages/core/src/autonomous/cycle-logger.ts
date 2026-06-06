// packages/core/src/autonomous/cycle-logger.ts
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CycleResult, TestResult, ScoringResult, KillSwitchTrip } from './types.js';
import { writeMemoryEntry } from '../memory/types.js';
import { validateCycleJson, validateScoringJson } from './cycle-artifacts/index.js';
import { computeCycleStaleness, aggregatePhaseErrorSummary } from './cycle-health.js';

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

export interface CycleStatusUpdate {
  stage?: string;
  status?: string;
  currentStep?: string;
  detail?: string;
  extra?: Record<string, unknown>;
}

type ProviderUsageMap = Record<string, { items: number; costUsd: number }>;
type PhaseErrorSummary = Record<string, { failed: number; retried: number }>;

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
    const phasePath = join(this.cycleDir, 'phases', `${phase}.json`);
    // P0.1 — MERGE into a handler-written phase artifact instead of
    // overwriting it. Phase handlers (e.g. runAuditPhase) write rich keys
    // (findings, memoriesInjected, …) to phases/<phase>.json before the
    // PhaseScheduler logs the bare PhaseResult summary here; an unconditional
    // overwrite destroyed those keys before downstream consumers (plan-phase
    // reads audit.json findings) ever saw them. Handler-written keys survive;
    // the logger's own summary fields (status/durationMs/costUsd/…) are
    // refreshed on top. If the file is missing, unparseable, or either side
    // is not a plain JSON object, fall back to today's summary-only write.
    // The merge path must never throw.
    let payload: unknown = result;
    if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
      try {
        if (existsSync(phasePath)) {
          const existing: unknown = JSON.parse(readFileSync(phasePath, 'utf8'));
          if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
            payload = { ...(existing as Record<string, unknown>), ...(result as Record<string, unknown>) };
          }
        }
      } catch {
        // Unreadable/corrupt existing artifact — fall back to summary-only write.
      }
    }
    this.writeJson(phasePath, payload);
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
      const existingTotalUsd =
        typeof existingCost['totalUsd'] === 'number' && Number.isFinite(existingCost['totalUsd'])
          ? existingCost['totalUsd']
          : undefined;
      const nextTotalUsd =
        existingTotalUsd === undefined ? totalUsd : Math.max(existingTotalUsd, totalUsd);
      const providerUsage =
        this.readExecuteProviderUsage()
        ?? this.normalizeProviderUsage(base['providerUsage']);
      const lastHeartbeatAt = this.normalizeHeartbeatAt(base['lastHeartbeatAt']);
      const phaseErrorSummary =
        this.readPhaseErrorSummary()
        ?? this.normalizePhaseErrorSummary(base['phaseErrorSummary'])
        ?? {};
      const staleness = computeCycleStaleness(lastHeartbeatAt, Date.now());
      this.writeJson(cyclePath, {
        ...base,
        cycleId: this.cycleId,
        stage,
        cost: { ...existingCost, totalUsd: nextTotalUsd },
        staleness,
        phaseErrorSummary,
        ...(providerUsage !== undefined ? { providerUsage } : {}),
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
      // Heartbeat must NEVER invent a `stage` value. flushCycleCost() writes
      // `stage: "run"` after the first real phase result; logCycleResult()
      // writes a terminal stage. If we default to "run" here, the dashboard
      // sees fake progress before STAGE 1 (PLAN/scoring) even completes —
      // top rail shows PLAN ✓ STAGE ✓ RUN active when nothing has happened.
      // Only forward stage if it's already on disk.
      const merged: Record<string, unknown> = {
        ...base,
        cycleId: this.cycleId,
        lastHeartbeatAt: new Date().toISOString(),
      };
      const lastHeartbeatAt = this.normalizeHeartbeatAt(merged['lastHeartbeatAt']);
      merged['staleness'] = computeCycleStaleness(lastHeartbeatAt, Date.now());
      merged['phaseErrorSummary'] =
        this.readPhaseErrorSummary()
        ?? this.normalizePhaseErrorSummary(base['phaseErrorSummary'])
        ?? {};
      if (!('stage' in base)) {
        delete merged['stage'];
      }
      this.writeJson(cyclePath, merged);
    } catch { /* non-fatal */ }
  }

  /**
   * Merge a live cycle status update into cycle.json. This is intentionally
   * non-fatal and preserves terminal stages, so observability writes cannot
   * change the outcome of a cycle that has already completed or failed.
   */
  flushCycleStatus(update: CycleStatusUpdate): void {
    const cyclePath = join(this.cycleDir, 'cycle.json');
    try {
      let base: Record<string, unknown> = {};
      if (existsSync(cyclePath)) {
        try {
          base = JSON.parse(readFileSync(cyclePath, 'utf8')) as Record<string, unknown>;
        } catch { /* keep empty base on parse error */ }
      }

      const terminalStages = new Set(['completed', 'failed', 'killed']);
      const baseStage = typeof base['stage'] === 'string' ? base['stage'] : undefined;
      const requestedStage = update.stage ?? baseStage;
      const stage =
        baseStage !== undefined && terminalStages.has(baseStage) && requestedStage !== baseStage
          ? baseStage
          : requestedStage;
      const now = new Date().toISOString();
      const merged: Record<string, unknown> = {
        ...base,
        ...(update.extra ?? {}),
        cycleId: this.cycleId,
        lastHeartbeatAt: now,
        updatedAt: now,
      };
      const lastHeartbeatAt = this.normalizeHeartbeatAt(merged['lastHeartbeatAt']);
      merged['staleness'] = computeCycleStaleness(lastHeartbeatAt, Date.now());
      merged['phaseErrorSummary'] =
        this.readPhaseErrorSummary()
        ?? this.normalizePhaseErrorSummary(base['phaseErrorSummary'])
        ?? {};

      if (stage !== undefined) merged['stage'] = stage;
      if (update.status !== undefined) merged['status'] = update.status;
      if (update.currentStep !== undefined) merged['currentStep'] = update.currentStep;
      if (update.detail !== undefined) merged['detail'] = update.detail;

      this.writeJson(cyclePath, merged);
    } catch { /* non-fatal */ }
  }

  logCycleResult(result: CycleResult): void {
    const currentProviderUsage =
      this.readProviderUsageFromCycleFile()
      ?? this.normalizeProviderUsage((result as CycleResult & { providerUsage?: unknown }).providerUsage);
    const lastHeartbeatAt = this.readLastHeartbeatAtFromCycleFile();
    const phaseErrorSummary =
      this.readPhaseErrorSummary()
      ?? this.readPhaseErrorSummaryFromCycleFile()
      ?? {};
    const cyclePayload: CycleResult & {
      providerUsage?: ProviderUsageMap;
      staleness: ReturnType<typeof computeCycleStaleness>;
      phaseErrorSummary: PhaseErrorSummary;
    } = {
      ...result,
      ...(currentProviderUsage !== undefined ? { providerUsage: currentProviderUsage } : {}),
      staleness: computeCycleStaleness(lastHeartbeatAt, Date.now()),
      phaseErrorSummary,
    };
    // Opt-in schema validation — warns on drift, never throws.
    validateCycleJson(cyclePayload);
    this.writeJson(join(this.cycleDir, 'cycle.json'), cyclePayload);
    this.appendEvent({ type: 'cycle.complete', stage: cyclePayload.stage, at: new Date().toISOString() });
    writeMemoryEntry(this.cwd, {
      type: 'cycle-outcome',
      value: JSON.stringify({
        cycleId: cyclePayload.cycleId,
        sprintVersion: cyclePayload.sprintVersion,
        stage: cyclePayload.stage,
        costUsd: cyclePayload.cost.totalUsd,
        testsPassed: cyclePayload.tests.passed,
        gateVerdict: cyclePayload.gateVerdict ?? null,
        prUrl: cyclePayload.pr.url,
      }),
      source: cyclePayload.cycleId,
      tags: ['cycle', cyclePayload.stage],
    });
  }

  /**
   * Write a structured typecheck-failure artifact to cycles/<id>/typecheck-failure.json.
   *
   * Extracts the first error's file path and line number from tsc output using
   * a match-then-use pattern (capture once, use the captured value) for CodeQL
   * js/path-injection compliance.
   *
   * Shape: { stdout, stderr, files, firstError: { file, line, message }, capturedAt }
   */
  logTypecheckFailure({ stdout, stderr, files }: { stdout: string; stderr: string; files: string[] }): void {
    // Pattern: `src/foo.ts(12,3): error TS2304: Cannot find name 'x'.`
    // Capture once via exec() then use only the captured variables — never re-index
    // the raw input string (CodeQL js/path-injection compliance).
    const errorPattern = /^([^(\n]+)\((\d+),\d+\): error TS\d+: (.+)$/m;
    const m = errorPattern.exec(stdout) ?? errorPattern.exec(stderr);
    const firstError = m
      ? { file: m[1]!.trim(), line: parseInt(m[2]!, 10), message: m[3]!.trim() }
      : null;

    this.writeJson(join(this.cycleDir, 'typecheck-failure.json'), {
      stdout,
      stderr,
      files,
      firstError,
      capturedAt: new Date().toISOString(),
    });
    this.appendEvent({ type: 'typecheck.failure', firstErrorFile: firstError?.file ?? null, at: new Date().toISOString() });
  }

  private writeJson(path: string, data: unknown): void {
    writeFileSync(path, JSON.stringify(data, null, 2));
  }

  appendEvent(event: Record<string, unknown>): void {
    appendFileSync(this.eventsPath, JSON.stringify(event) + '\n');
  }

  private readExecuteProviderUsage(): ProviderUsageMap | undefined {
    try {
      const executePhasePath = join(this.cycleDir, 'phases', 'execute.json');
      if (!existsSync(executePhasePath)) return undefined;
      const raw = JSON.parse(readFileSync(executePhasePath, 'utf8')) as Record<string, unknown>;
      return this.normalizeProviderUsage(raw['providerUsage']);
    } catch {
      return undefined;
    }
  }

  private readProviderUsageFromCycleFile(): ProviderUsageMap | undefined {
    try {
      const cyclePath = join(this.cycleDir, 'cycle.json');
      if (!existsSync(cyclePath)) return undefined;
      const raw = JSON.parse(readFileSync(cyclePath, 'utf8')) as Record<string, unknown>;
      return this.normalizeProviderUsage(raw['providerUsage']);
    } catch {
      return undefined;
    }
  }

  private readLastHeartbeatAtFromCycleFile(): string | undefined {
    try {
      const cyclePath = join(this.cycleDir, 'cycle.json');
      if (!existsSync(cyclePath)) return undefined;
      const raw = JSON.parse(readFileSync(cyclePath, 'utf8')) as Record<string, unknown>;
      return this.normalizeHeartbeatAt(raw['lastHeartbeatAt']);
    } catch {
      return undefined;
    }
  }

  private readPhaseErrorSummary(): PhaseErrorSummary | undefined {
    try {
      const phaseDir = join(this.cycleDir, 'phases');
      if (!existsSync(phaseDir)) return undefined;
      const phaseArtifacts: Array<{
        phase?: string;
        agentRuns?: Array<{ status?: string; attempts?: number }>;
      }> = [];
      for (const entry of readdirSync(phaseDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        try {
          const phasePath = join(phaseDir, entry.name);
          const raw = JSON.parse(readFileSync(phasePath, 'utf8')) as Record<string, unknown>;
          const agentRunsRaw = raw['agentRuns'];
          const agentRuns = Array.isArray(agentRunsRaw)
            ? agentRunsRaw.map((run): { status?: string; attempts?: number } => {
                if (!run || typeof run !== 'object') return {};
                const record = run as Record<string, unknown>;
                const normalizedRun: { status?: string; attempts?: number } = {};
                if (typeof record['status'] === 'string') normalizedRun.status = record['status'];
                if (typeof record['attempts'] === 'number') normalizedRun.attempts = record['attempts'];
                return normalizedRun;
              })
            : undefined;
          const phaseArtifact: { phase?: string; agentRuns?: Array<{ status?: string; attempts?: number }> } = {};
          if (typeof raw['phase'] === 'string') phaseArtifact.phase = raw['phase'];
          if (agentRuns !== undefined) phaseArtifact.agentRuns = agentRuns;
          phaseArtifacts.push(phaseArtifact);
        } catch {
          // Ignore unreadable phase artifacts — observability write must not fail.
        }
      }
      return aggregatePhaseErrorSummary(phaseArtifacts);
    } catch {
      return undefined;
    }
  }

  private readPhaseErrorSummaryFromCycleFile(): PhaseErrorSummary | undefined {
    try {
      const cyclePath = join(this.cycleDir, 'cycle.json');
      if (!existsSync(cyclePath)) return undefined;
      const raw = JSON.parse(readFileSync(cyclePath, 'utf8')) as Record<string, unknown>;
      return this.normalizePhaseErrorSummary(raw['phaseErrorSummary']);
    } catch {
      return undefined;
    }
  }

  private normalizeProviderUsage(value: unknown): ProviderUsageMap | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return {};

    const normalized: ProviderUsageMap = {};
    for (const [providerId, metrics] of entries) {
      if (!metrics || typeof metrics !== 'object') continue;
      const record = metrics as Record<string, unknown>;
      const items = record['items'];
      const costUsd = record['costUsd'];
      if (typeof items !== 'number' || !Number.isFinite(items)) continue;
      if (typeof costUsd !== 'number' || !Number.isFinite(costUsd)) continue;
      normalized[providerId] = {
        items: Math.max(0, Math.trunc(items)),
        costUsd,
      };
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private normalizePhaseErrorSummary(value: unknown): PhaseErrorSummary | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return {};

    const normalized: PhaseErrorSummary = {};
    for (const [phase, metrics] of entries) {
      if (!phase || typeof metrics !== 'object' || metrics === null) continue;
      const record = metrics as Record<string, unknown>;
      const failed = record['failed'];
      const retried = record['retried'];
      if (typeof failed !== 'number' || !Number.isFinite(failed)) continue;
      if (typeof retried !== 'number' || !Number.isFinite(retried)) continue;
      normalized[phase] = {
        failed: Math.max(0, Math.trunc(failed)),
        retried: Math.max(0, Math.trunc(retried)),
      };
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private normalizeHeartbeatAt(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }
}
