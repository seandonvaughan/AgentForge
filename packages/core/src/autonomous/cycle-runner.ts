// packages/core/src/autonomous/cycle-runner.ts
//
// Top-level orchestrator for the AgentForge autonomous development cycle.
//
// Drives all six cycle stages in order:
//   STAGE 1 — PLAN    : ProposalToBacklog → ScoringPipeline → BudgetApproval
//   STAGE 2 — STAGE   : SprintGenerator
//   STAGE 3 — RUN     : PhaseScheduler (audit→plan→assign→execute→test→review→gate→release→learn)
//   STAGE 3.5 — TYPECHECK : pnpm build + tsc --noEmit (fail-fast before VERIFY)
//   STAGE 4 — VERIFY  : RealTestRunner + KillSwitch.checkPostVerify
//   STAGE 5 — COMMIT  : GitOps.verifyPreconditions/createBranch/stage/commit/push
//   STAGE 6 — REVIEW  : renderPrBody → PROpener.open
//
// Errors are caught at the top level. CycleKilledError → stage=KILLED. Any
// other error → stage=FAILED. The terminal cycle.json is ALWAYS written via
// CycleLogger.logCycleResult before returning, regardless of outcome.
//
// See docs/superpowers/specs/2026-04-06-autonomous-loop-design.md §6 and
// docs/superpowers/plans/2026-04-06-autonomous-loop-part2.md Task 21.

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// CycleCheckpoint type + readCheckpoint helper live in
// `./cycle-artifacts/cycle-checkpoint.ts` (Wave 3 T5). Re-export here so the
// public surface that T6 wired up (`import { readCheckpoint } from '@agentforge/core'`)
// keeps working without owning the canonical definitions.
export { readCheckpoint } from './cycle-artifacts/cycle-checkpoint.js';

const execFileAsync = promisify(execFile);

// v6.5.1: the TEST_POLLUTION_PATTERNS workaround from v6.4.4 has been removed.
// Tests that previously mutated the real repo's .agentforge/ now use
// os.tmpdir() workspaces (see tests/e2e/cli.test.ts), so collectChangedFiles
// can rely on git status alone — no path-based denylist needed.
import {
  CycleStage,
  CycleKilledError,
  PhaseFailedError,
} from './types.js';
import { GateRejectedError } from './phase-handlers/gate-phase.js';
import type { CycleConfig, CycleResult, KillSwitchTrip } from './types.js';
import {
  ProposalToBacklog,
  type ProposalAdapter,
} from './proposal-to-backlog.js';
import {
  ScoringPipeline,
  type AdapterForScoring,
  type RuntimeForScoring,
  type ScoringPipelineResult,
} from './scoring-pipeline.js';
import { BudgetApproval } from './budget-approval.js';
import { SprintGenerator, type SprintPlan } from './sprint-generator.js';
import {
  PhaseScheduler,
  type PhaseHandler,
  type PhaseName,
  type SprintRunSummary,
} from './phase-scheduler.js';
import { KillSwitch } from './kill-switch.js';
import { CycleLogger } from './cycle-logger.js';
import { renderPrBody } from './pr-body-renderer.js';
import type { RealTestRunner } from './exec/real-test-runner.js';
import type { GitOps } from './exec/git-ops.js';
import type { PROpener } from './exec/pr-opener.js';
import { runAutoReforge, extractInvolvedAgentIds } from './auto-reforge.js';
import type { AutoReforgeResult } from './auto-reforge.js';
import { runPreVerifyTypeCheck, type PreVerifyTypeCheckResult } from './pre-verify-typecheck.js';
import { assertUnattendedSafe } from './audit/unattended-guard.js';
import { mergeBreakdowns, type CostBreakdown } from './cost-breakdown.js';
import { exportCycleTelemetry } from '../telemetry/cycle-telemetry-export.js';
import { resolveTelemetryConfig } from '../telemetry/config.js';
// T4.6 — WorktreeGc: schedule GC at cycle start (clean stale worktrees) and
// cycle end (clean this cycle's worktrees, keep last 20 for forensics).
// TODO(T4.6-BB): once Workstream BB lands the worktreePool in CycleRunnerOptions,
// replace the inline import with a proper typed import and remove the TODO.
import { WorktreeGc } from '../runtime/worktree-gc.js';
import type { WorktreePool } from '../runtime/worktree-pool.js';
import { MergeQueue } from '../runtime/merge-queue.js';
import type { DrainAndMergeResult } from '../runtime/merge-queue.js';
import type { MessageBusV2 } from '../message-bus/message-bus.js';
import type { CycleCheckpoint } from './cycle-artifacts/cycle-checkpoint.js';

/**
 * Build a PR title that's safe for `gh pr create` and never truncated mid-word.
 *
 * Why this is a pure exported function: the autonomous loop's first
 * end-to-end successful cycle (b8755f16) crashed at the very last step
 * because the inline title-building logic produced "autonomous(v6.7.0): All
 * three items are well within the $50 cycle budg" — gh's arg parser choked
 * on the unquoted parens, and slice(0, 50) cut a word in half. Extracting
 * this lets the test suite pin both behaviors directly without spinning up
 * a CycleRunner.
 *
 * Rules:
 *   1. Strip parens (gh CLI parses unquoted (...) as option groups)
 *   2. Collapse newlines into single spaces
 *   3. Truncate at 65 chars on the nearest word boundary (ellipsis appended)
 */
export function sanitizePrTitle(version: string, summary: string): string {
  const prefix = `autonomous v${version}: `;
  const room = 65 - prefix.length;
  const oneLine = summary.replace(/[\r\n]+/g, ' ').replace(/[()]/g, '').trim();
  if (oneLine.length <= room) return prefix + oneLine;
  const cut = oneLine.slice(0, room);
  const lastSpace = cut.lastIndexOf(' ');
  return prefix + (lastSpace > 20 ? cut.slice(0, lastSpace) : cut) + '…';
}

export function shouldOpenSingleCyclePr(filesChanged: string[], commitSha: string | null): boolean {
  return filesChanged.length > 0 && commitSha !== null;
}

export function shouldRunAggregateCommit(
  prMode: CycleConfig['prMode'] | undefined,
  filesChanged: string[],
): boolean {
  return prMode !== 'multi' && filesChanged.length > 0;
}

/**
 * Extract a useful error message from a failed execFileAsync call.
 *
 * Critical fix: TypeScript (and most build tools) write compilation errors to
 * stdout, not stderr. Prior code used `??` which only falls through on null/
 * undefined — an empty stderr Buffer toString() returns `""` which is NOT
 * nullish, so the stdout fallback never fired and operators saw an empty
 * "build failed: " message. Cycle a84ea768 was killed by 2 fixable TS errors
 * that this bug hid.
 */
function extractSubprocessError(err: unknown): string {
  const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  const stderrStr = (e.stderr?.toString() ?? '').trim();
  const stdoutStr = (e.stdout?.toString() ?? '').trim();
  const text = stderrStr || stdoutStr || e.message || String(err);
  return text.slice(0, 2000);
}

/**
 * Tokenise a shell command string into argv suitable for `execFile`.
 *
 * Handles single-quoted and double-quoted tokens so command strings like
 *   `pnpm --filter "@agentforge/core" build`
 * are split into:
 *   `['pnpm', '--filter', '@agentforge/core', 'build']`
 *
 * Replaces the previous naive `cmd.split(' ')` which corrupted commands
 * containing quoted arguments with interior spaces. This function is the
 * correct counterpart to using `execFile` (which bypasses the shell and
 * requires the caller to pre-tokenize argv).
 *
 * Constraints:
 * - No backslash escape handling outside of double quotes (not needed for
 *   the pnpm/tsc invocations stored in CycleConfig.testing).
 * - No subshells, pipes, or other shell meta-characters.
 *
 * Exported so unit tests can verify tokenisation independently of CycleRunner.
 */
export function parseCommandArgs(cmd: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let i = 0;

  while (i < cmd.length) {
    const ch = cmd[i]!;

    if (ch === '"' || ch === "'") {
      // Collect all characters until the matching closing quote.
      const quote = ch;
      i++;
      while (i < cmd.length && cmd[i] !== quote) {
        current += cmd[i];
        i++;
      }
      i++; // consume closing quote
    } else if (ch === ' ' || ch === '\t') {
      // Whitespace ends the current token (consecutive whitespace is collapsed).
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      i++;
    } else {
      current += ch;
      i++;
    }
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}

export interface CycleRunnerOptions {
  cwd: string;
  config: CycleConfig;
  runtime: RuntimeForScoring;
  proposalAdapter: ProposalAdapter;
  scoringAdapter: AdapterForScoring;
  phaseHandlers: Record<PhaseName, PhaseHandler>;
  testRunner: RealTestRunner;
  gitOps: GitOps;
  prOpener: PROpener;
  bus: {
    publish: (topic: string, payload: any) => void;
    subscribe: (topic: string, cb: (event: any) => void) => () => void;
  };
  dryRun?: { prOpener?: boolean };
  /**
   * Pre-allocated cycle ID. When provided, the runner uses this value instead
   * of reading AUTONOMOUS_CYCLE_ID from env or generating a fresh UUID. Use
   * this when the caller has already created a CycleLogger (e.g. to pass to
   * GitOps) so both share the same directory.
   */
  cycleId?: string;
  /**
   * Optional pre-verify type-checker injected between STAGE 3 (RUN) and
   * STAGE 4 (VERIFY). When omitted, a built-in implementation runs
   * `config.testing.buildCommand` then `config.testing.typeCheckCommand`
   * via execFileAsync. Inject a controlled mock in unit tests to avoid
   * executing real build commands in tmpdir environments.
   *
   * The runner respects `config.quality.requireBuildSuccess` and
   * `config.quality.requireTypeCheckSuccess` — a failure only trips the
   * kill switch when the corresponding flag is true.
   */
  preVerifyTypeCheck?: (cwd: string, testing: CycleConfig['testing']) => Promise<PreVerifyTypeCheckResult>;
  /**
   * T4.2/T4.6 — Optional WorktreePool. When provided:
   *   - T4.2: execute phase allocates a fresh isolated git worktree per
   *     coder-class sprint item, preventing main-tree branch ping-pong.
   *   - T4.6: WorktreeGc runs at cycle start + end to clean up stale worktrees.
   *
   * When absent, the runner falls back to single-tree execution (legacy behavior).
   * Disable explicitly with `disableWorktrees: true` for tests/smoke runs.
   *
   * NOTE: WorktreePool is typed as 'any' until Workstream AA lands
   * packages/core/src/runtime/worktree-pool.ts — the pre-existing T4.6 import
   * already covers the class type once AA ships.
   */
  worktreePool?: WorktreePool;
  /**
   * T4.2 — When true, worktree allocation is completely disabled for this
   * cycle, even if a `worktreePool` is provided. Use for smoke runs, CI
   * environments without git worktree support, or unit tests that don't need
   * real isolation.
   */
  disableWorktrees?: boolean;
  /**
   * Full `MessageBusV2` instance required for multi-PR mode (prMode='multi').
   *
   * The `bus` field above uses a simplified `(topic, payload)` facade that is
   * sufficient for most internal event publishing, but `MergeQueue` needs the
   * full typed bus API (subscribe with typed envelopes, etc.). Provide this
   * when constructing a cycle with `prMode='multi'`.
   *
   * When absent and prMode='multi', the MergeQueue will not be started and
   * the cycle falls back to single-PR behavior with a console warning.
   */
  messageBus?: MessageBusV2;
  /**
   * Resume checkpoint (Wave 3 T5+T6). When provided:
   *   - The runner reuses `resumeCheckpoint.cycleId` instead of generating a new one.
   *   - `totalCostUsd` is seeded from `resumeCheckpoint.spentUsd`.
   *   - PhaseScheduler is told to skip phases in `completedPhases` and start at `resumeFromPhase`.
   * Supplied by the CLI when `--resume <cycleId>` is passed.
   */
  resumeCheckpoint?: CycleCheckpoint;
}

// ---------------------------------------------------------------------------
// Exported helper: collectFilesFromAgentBranches
//
// Extracted from CycleRunner so it can be unit-tested without spinning up the
// full runner (which requires a live git repo, KillSwitch, CycleLogger, etc.).
// CycleRunner.collectFilesFromAgentBranches() delegates here.
// ---------------------------------------------------------------------------

/**
 * Collect changed files from agent worktree branches recorded in
 * `.agentforge/cycles/<cycleId>/phases/execute.json`.
 *
 * For each completed agent run that recorded a `worktreeBranch`, run:
 *   git diff --name-only origin/<baseBranch>...<worktreeBranch>
 * inside `cwd` (the main repo working tree). File-discovery only — the actual
 * git add/commit/push continues to run against the main tree using the paths
 * returned here.
 *
 * - Worktrees may already have been released by the time this helper runs;
 *   use the recorded branch as source of truth instead of the checkout path.
 * - Files under `.agentforge/cycles/` are excluded.
 * - Results are de-duplicated across all branches and returned sorted.
 */
export async function collectFilesFromAgentBranches(opts: {
  cwd: string;
  cycleId: string;
  baseBranch: string;
}): Promise<string[]> {
  const { cwd, cycleId, baseBranch } = opts;
  const execPath = join(cwd, '.agentforge/cycles', cycleId, 'phases/execute.json');
  if (!existsSync(execPath)) return [];

  let execData: unknown;
  try {
    execData = JSON.parse(readFileSync(execPath, 'utf8'));
  } catch {
    return [];
  }

  const agentRuns: Array<Record<string, unknown>> =
    (execData as { agentRuns?: Array<Record<string, unknown>> }).agentRuns ?? [];

  const allFiles = new Set<string>();

  for (const run of agentRuns) {
    const branch = typeof run['worktreeBranch'] === 'string' ? run['worktreeBranch'] : undefined;

    if (!branch) continue;

    try {
      const { stdout } = await execFileAsync(
        'git',
        ['diff', '--name-only', `origin/${baseBranch}...${branch}`],
        { cwd, maxBuffer: 10 * 1024 * 1024 },
      );
      const files = stdout
        .toString()
        .split('\n')
        .map(f => f.trim())
        .filter(f => f.length > 0)
        .filter(f => !f.includes('.agentforge/cycles/'));
      for (const f of files) allFiles.add(f);
    } catch {
      // Branch may not be pushed yet or remote may not know it; skip silently.
    }
  }

  return [...allFiles].sort();
}

/**
 * The CycleRunner is constructed once per autonomous cycle and immediately
 * generates a cycleId, instantiates the per-cycle CycleLogger, and primes the
 * KillSwitch. All wiring is dependency-injected so the orchestrator is fully
 * unit-testable with mocks.
 */
export class CycleRunner {
  private readonly cycleId: string;
  private readonly logger: CycleLogger;
  private readonly killSwitch: KillSwitch;
  private readonly startedAt: number;

  // State accumulated across stages so the catch handler can include partial
  // information in the terminal CycleResult written to cycle.json.
  private sprintVersion = '';
  private branch = '';
  private commitSha: string | null = null;
  private filesChanged: string[] = [];
  private prUrl: string | null = null;
  private prNumber: number | null = null;
  private prDraft = false;
  private totalCostUsd = 0;
  private testStats: CycleResult['tests'] = {
    passed: 0,
    failed: 0,
    skipped: 0,
    total: 0,
    passRate: 0,
    newFailures: [],
  };
  private scoringFallback: 'static' | 'effort-estimator' | undefined;
  private gateVerdict: 'APPROVE' | 'REJECT' | undefined = undefined;
  private autoReforgeCanary: AutoReforgeResult['canary'] | undefined = undefined;
  /** Set in runStages() when prMode='multi'; used to drain at cycle end. */
  private mergeQueue: MergeQueue | null = null;
  /** Accumulated CostBreakdown from the execute phase (Wave 2). */
  private executionBreakdown: CostBreakdown | undefined = undefined;

  constructor(private readonly options: CycleRunnerOptions) {
    // Resolve cycleId in priority order:
    //   1. options.resumeCheckpoint.cycleId — resume path reuses the existing cycle dir
    //   2. options.cycleId — caller pre-allocated (CLI creates logger+gitOps first)
    //   3. AUTONOMOUS_CYCLE_ID env — server's POST /api/v5/cycles pre-allocates
    //      the id and pre-creates the dir, then spawns the CLI with this env var
    //      so the CLI writes to the same dir the API client already has a pointer to
    //   4. fresh UUID — direct CLI use with no coordination
    const envId = process.env['AUTONOMOUS_CYCLE_ID'];
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    // Wave 3 T5+T6 — resumeCheckpoint takes priority for cycleId so durability
    // is end-to-end. Use match-then-use on the checkpoint id.
    const CKPT_ID_RE = /^[a-zA-Z0-9-]{8,64}$/;
    const resumeId = options.resumeCheckpoint?.cycleId;
    const safeResumeId = resumeId && CKPT_ID_RE.test(resumeId) ? resumeId : undefined;
    this.cycleId = safeResumeId
      ?? ((options.cycleId && UUID_RE.test(options.cycleId))
        ? options.cycleId
        : (envId && UUID_RE.test(envId) ? envId : randomUUID()));
    this.startedAt = Date.now();
    // Seed accumulated spend from checkpoint so budget gates account for prior spend.
    if (options.resumeCheckpoint) {
      this.totalCostUsd = options.resumeCheckpoint.spentUsd;
    }
    this.logger = new CycleLogger(options.cwd, this.cycleId);
    this.killSwitch = new KillSwitch(
      options.config,
      this.cycleId,
      this.startedAt,
      options.cwd,
    );
  }

  /**
   * Run the cycle to completion. Always returns a `CycleResult`; never throws.
   * Always writes the terminal cycle.json before returning.
   */
  async start(): Promise<CycleResult> {
    // === wave5:T5 === Unattended pre-flight guard.
    // Must run before any phase starts (heartbeat, stages, etc.).
    if (process.env['AGENTFORGE_UNATTENDED'] === '1') {
      await assertUnattendedSafe(
        this.options.cwd,
        this.options.config.budget.perCycleUsd,
        this.totalCostUsd,
      );
    }
    // === end wave5:T5 ===

    let final: CycleResult;
    // Heartbeat: every 30s, stamp lastHeartbeatAt on cycle.json so dashboards
    // can detect runners that died at the OS level (SIGKILL/OOM/terminal-close)
    // where the try/catch below never gets a chance to flush a terminal stage.
    // See memory/feedback_cycle_heartbeat_required.md for the post-mortem.
    this.logger.flushHeartbeat();
    const heartbeatTimer = setInterval(() => {
      this.logger.flushHeartbeat();
    }, 30_000);
    // Don't keep the event loop alive just for the heartbeat.
    heartbeatTimer.unref?.();
    try {
      final = await this.runStages();
    } catch (err) {
      if (err instanceof CycleKilledError) {
        this.logger.logKillSwitch(err.trip);
        final = this.buildResult(CycleStage.KILLED, { killSwitch: err.trip });
      } else if (err instanceof GateRejectedError) {
        // Gate phase explicitly rejected the sprint — record the verdict so
        // the cycle-outcome memory entry surfaces it for the next audit phase.
        this.gateVerdict = 'REJECT';
        final = this.buildResult(CycleStage.FAILED, {
          error: `gate: ${err.rationale}`,
          gateVerdict: 'REJECT',
        });
      } else if (err instanceof PhaseFailedError) {
        // PhaseFailedError from the PhaseScheduler is a hard failure but is
        // distinct from a kill-switch trip. We surface it as FAILED so the
        // operator can investigate without conflating it with a safety stop.
        final = this.buildResult(CycleStage.FAILED, {
          error: `${err.phase}: ${err.reason}`,
        });
      } else {
        final = this.buildResult(CycleStage.FAILED, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Stop the heartbeat before the terminal write so the two writers don't
    // race on cycle.json (last-writer-wins on the file would otherwise wipe
    // the terminal stage with a heartbeat-only payload).
    clearInterval(heartbeatTimer);

    // ALWAYS write cycle.json — that's the contract this module guarantees to
    // every operator and downstream tool that watches .agentforge/cycles/.
    try {
      this.logger.logCycleResult(final);
    } catch {
      // Best-effort: if cycle.json cannot be written we still return the
      // result. The operator will see the missing file and know something
      // catastrophic happened to the logger itself.
    }
    return final;
  }

  /**
   * Internal driver. Runs all six stages in sequence and returns the final
   * COMPLETED result. Throws CycleKilledError or other errors which `start()`
   * translates into the appropriate terminal stage.
   */
  private async runStages(): Promise<CycleResult> {
    const effectiveWorktreePool = this.getEffectiveWorktreePool();

    if (this.options.config.prMode === 'multi') {
      if (this.options.disableWorktrees) {
        throw new Error(
          'prMode=multi requires isolated worktrees. Remove disableWorktrees or use prMode=single.',
        );
      }
      if (!effectiveWorktreePool) {
        throw new Error(
          'prMode=multi requires options.worktreePool so execute items cannot modify the parent working tree.',
        );
      }
      if (!this.options.messageBus) {
        throw new Error(
          'prMode=multi requires options.messageBus so agent branches can be pushed and opened as PRs.',
        );
      }
    } else if (effectiveWorktreePool) {
      throw new Error(
        'options.worktreePool currently requires prMode=multi. Use disableWorktrees for single-PR cycles until merge-back is implemented.',
      );
    }

    // ─────────────────────────────────────────────────────────────────
    // T6 — RESUME: if a checkpoint was provided, emit an audit entry
    // and log the resume event before anything else runs.
    // ─────────────────────────────────────────────────────────────────
    if (this.options.resumeCheckpoint) {
      const cp = this.options.resumeCheckpoint;
      this.logger.appendEvent({
        type: 'cycle.resumed',
        cycleId: this.cycleId,
        fromPhase: cp.resumeFromPhase,
        byUser: process.env['USER'] ?? 'cli',
        at: new Date().toISOString(),
      });
      // eslint-disable-next-line no-console
      console.log(
        `[autonomous:cycle] resuming cycleId=${this.cycleId} fromPhase=${cp.resumeFromPhase} spentUsd=${cp.spentUsd}`,
      );
    }

    // ─────────────────────────────────────────────────────────────────
    // T4.6 — WORKTREE GC (START): clean up stale worktrees from prior
    // cycles before we begin so disk usage doesn't accumulate unbounded.
    // Errors are swallowed — a GC failure must never block a new cycle.
    // ─────────────────────────────────────────────────────────────────
    await this.runWorktreeGc('start');

    // ─────────────────────────────────────────────────────────────────
    // MULTI-PR MODE SETUP
    // When prMode='multi', start the MergeQueue now so it subscribes to
    // agent.branch.pushed events emitted by coder-class agents during
    // STAGE 3 (RUN). The queue opens one draft PR per agent branch in
    // real-time, recording each in the cycle ledger at
    // .agentforge/cycles/<cycleId>/agent-prs.json.
    //
    // The baseBranch is the cycle's git.baseBranch (typically 'main' or the
    // autonomous cycle branch set by GitOps). We read it from config here
    // because the autonomous branch itself is not yet created (STAGE 5).
    // ─────────────────────────────────────────────────────────────────
    if (this.options.config.prMode === 'multi') {
      if (!this.options.messageBus) {
        // eslint-disable-next-line no-console
        console.warn(
          '[autonomous:cycle] multi-pr: prMode=multi requires options.messageBus to be set. ' +
          'Falling back to single-PR behavior.',
        );
      } else {
        this.mergeQueue = new MergeQueue({
          projectRoot: this.options.cwd,
          bus: this.options.messageBus,
          parentBranch: this.options.config.git.baseBranch,
          cycleId: this.cycleId,
          dryRun: this.options.dryRun?.prOpener === true,
        });
        this.mergeQueue.start();
        // eslint-disable-next-line no-console
        console.log(`[autonomous:cycle] multi-pr: MergeQueue started (base=${this.options.config.git.baseBranch})`);
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // STAGE 1 — PLAN
    // Build a backlog from project signals, score it, and gate on budget.
    // ─────────────────────────────────────────────────────────────────
    const bridge = new ProposalToBacklog(
      this.options.proposalAdapter,
      this.options.cwd,
      this.options.config,
    );
    const backlog = await bridge.build();

    if (backlog.length === 0) {
      throw new Error('No backlog items to work on — nothing to do');
    }

    const scoring = new ScoringPipeline(
      this.options.runtime,
      this.options.scoringAdapter,
      this.options.config,
      this.logger,
      this.options.cwd,
    );
    const scored: ScoringPipelineResult = await scoring.scoreWithFallback(
      backlog,
    );
    this.scoringFallback = scored.fallback;
    this.checkKillSwitch();

    // BUDGET APPROVAL GATE
    // If everything fits within budget, this short-circuits with auto-approval.
    // Otherwise it blocks on TTY prompt or approval-decision.json file.
    const approval = new BudgetApproval(
      this.options.cwd,
      this.cycleId,
      this.logger,
    );
    const approved = await approval.collect({
      withinBudget: scored.withinBudget,
      requiresApproval: scored.requiresApproval,
      budgetUsd: this.options.config.budget.perCycleUsd,
      summary: scored.summary,
    });

    // ─────────────────────────────────────────────────────────────────
    // STAGE 2 — STAGE
    // Convert the approved ranked items into a SprintPlan and write
    // cycles/{cycleId}/plan.json — single source of truth (Track D migration).
    // ─────────────────────────────────────────────────────────────────
    const generator = new SprintGenerator(this.options.cwd, this.options.config);
    const plan: SprintPlan = await generator.generate(approved.approvedItems, this.cycleId);
    this.sprintVersion = plan.version;
    // Log sprint assignment in events.jsonl so the dashboard can resolve the
    // sprint version without timestamp matching.
    this.logger.logSprintAssigned(plan.version);
    this.checkKillSwitch();

    // ─────────────────────────────────────────────────────────────────
    // STAGE 3 — RUN (with auto-retry on gate rejection)
    // Drive the 9-phase sprint sequence (audit → … → learn) via
    // PhaseScheduler. If the gate rejects, extract the findings and
    // retry from execute→test→review→gate up to maxAutoRetries times.
    // After requireApprovalAfter retries, block on human approval.
    // ─────────────────────────────────────────────────────────────────
    const retryConfig = this.options.config.retry;
    let retryAttempt = 0;
    let runSummary!: SprintRunSummary;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // T4.2: resolve the worktree pool for the phase context.
      // worktreePool is undefined when disableWorktrees is set OR when the
      // caller provided neither a pool nor we can auto-construct one (AA not
      // yet landed). The execute phase falls back to single-tree behavior when
      // worktreePool is absent.
      const phaseWorktreePool = this.getEffectiveWorktreePool();

      // T6: on first attempt, honour the resume checkpoint's phase (if any).
      // On retry attempts, always jump to 'execute' (existing retry logic).
      const skipToPhase: PhaseName | undefined = retryAttempt > 0
        ? 'execute'
        : (this.options.resumeCheckpoint?.resumeFromPhase as PhaseName | undefined);

      const scheduler = new PhaseScheduler(
        {
          sprintId: plan.sprintId,
          sprintVersion: plan.version,
          projectRoot: this.options.cwd,
          adapter: this.options.scoringAdapter,
          bus: this.options.bus,
          runtime: this.options.runtime,
          cycleId: this.cycleId,
          baseBranch: this.options.config.git.baseBranch,
          ...(retryAttempt > 0 ? { retryAttempt, skipToPhase: 'execute' as PhaseName } : {}),
          ...(retryAttempt === 0 && skipToPhase !== undefined ? { skipToPhase } : {}),
          // T4.2: pass the pool (or undefined) through so the execute phase
          // can allocate per-item worktrees when coder-class items are dispatched.
          ...(phaseWorktreePool !== undefined ? { worktreePool: phaseWorktreePool } : {}),
          // Wave 3 T5: forward checkpoint resume only on the FIRST attempt;
          // gate-retries (retryAttempt > 0) re-run from 'execute' explicitly.
          ...(retryAttempt === 0 && this.options.resumeCheckpoint
            ? { resumeCheckpoint: this.options.resumeCheckpoint }
            : {}),
          budgetUsd: this.options.config.budget.perCycleUsd,
        },
        this.killSwitch,
        this.logger,
        this.options.phaseHandlers,
      );

      try {
        runSummary = await scheduler.run();
        this.totalCostUsd += runSummary.totalCostUsd;
        // Gate approved — break out of retry loop
        this.gateVerdict = 'APPROVE';
        // Reconcile sprint file: mark all executed items as completed
        // based on execute.json (fixes stale in_progress after retries)
        this.reconcileSprintStatus(plan.version);
        // Wave 2: load the per-item/phase CostBreakdown from execute.json.
        this.loadExecutionBreakdownFromDisk();
        break;
      } catch (err) {
        if (!(err instanceof GateRejectedError)) throw err;

        // Capture the failed attempt's cost before retrying — the scheduler
        // tracked phase costs even though the gate threw. Sum them from the
        // phase files on disk since the scheduler's internal state is lost.
        this.totalCostUsd += this.sumPhaseCostsFromDisk();
        // Flush accumulated cost so operators see live spend even when the
        // gate rejects and we loop back for another attempt.
        this.logger.flushCycleCost(this.totalCostUsd);

        retryAttempt++;
        this.logger.logPhaseFailure('gate', `retry ${retryAttempt}/${retryConfig.maxAutoRetries}: ${err.rationale.slice(0, 500)}`);

        // Check if we've exhausted auto-retries
        if (retryAttempt > retryConfig.maxAutoRetries) {
          throw err; // Propagate to start() → FAILED
        }

        // Check if we need human approval to continue retrying
        if (retryAttempt > retryConfig.requireApprovalAfter) {
          const retryApproval = new BudgetApproval(
            this.options.cwd,
            this.cycleId,
            this.logger,
          );
          await retryApproval.collect({
            withinBudget: [],
            requiresApproval: [],
            budgetUsd: this.options.config.budget.perCycleUsd,
            summary: `Gate retry ${retryAttempt}: ${err.rationale.slice(0, 200)}`,
          });
        }

        // Inject gate findings into memory so the next execute pass sees them
        this.logger.logPhaseFailure('gate', `findings for retry: ${err.rationale.slice(0, 1000)}`);

        // Check budget/duration kill switch before retrying
        this.checkKillSwitch();

        // eslint-disable-next-line no-console
        console.log(`[autonomous:cycle] gate rejected (attempt ${retryAttempt}/${retryConfig.maxAutoRetries}) — retrying from execute phase`);
      }
    }

    this.checkKillSwitch();

    // ─────────────────────────────────────────────────────────────────
    // STAGE 3.25 — AUTO-REFORGE
    // After gate approval, run the learning-curator + mutator so agents
    // absorb the lessons from this cycle before it is marked COMPLETED.
    // Errors are swallowed — a reforge failure must never kill a passed
    // cycle. Honoured by config.autoReforge (default true).
    // ─────────────────────────────────────────────────────────────────
    await this.runAutoReforgeStep({
      projectedBudgetUsd: scored.totalEstimatedCostUsd,
      currentCostUsd: this.totalCostUsd,
    });
    this.checkKillSwitch();

    // ─────────────────────────────────────────────────────────────────
    // STAGE 3.3 — TELEMETRY EXPORT (T5.7)
    // Optionally export anonymized cycle telemetry after learnings are
    // applied. Honour the opt-in config; errors are swallowed.
    // ─────────────────────────────────────────────────────────────────
    await this.runTelemetryExport();

    // ─────────────────────────────────────────────────────────────────
    // STAGE 3.5 — TYPECHECK (fail-fast pre-verify)
    // Run pnpm build + tsc --noEmit before the full test suite. TypeScript
    // compilation errors introduced during execute are caught here rather
    // than surviving to the gate phase, where each rejection costs $15-30
    // in agent spend. The step no-ops when the corresponding command string
    // is empty or the quality flag is false.
    // ─────────────────────────────────────────────────────────────────
    await this.runPreVerifyTypeCheck();
    this.checkKillSwitch();

    // ─────────────────────────────────────────────────────────────────
    // STAGE 4 — VERIFY
    // Run the project's real test command, derive a TestResult, then check
    // the kill switch's post-verify gate (test floor + regression policy).
    // ─────────────────────────────────────────────────────────────────
    const testResult = await this.options.testRunner.run(this.cycleId);
    this.logger.logTestRun(testResult);
    this.testStats = {
      passed: testResult.passed,
      failed: testResult.failed,
      skipped: testResult.skipped,
      total: testResult.total,
      passRate: testResult.passRate,
      newFailures: testResult.newFailures,
    };

    const regression = {
      detected: testResult.newFailures.length > 0,
      reason:
        testResult.newFailures.length > 0
          ? `${testResult.newFailures.length} new failures: ${testResult.newFailures
              .slice(0, 3)
              .join(', ')}`
          : '',
    };
    const verifyTrip = this.killSwitch.checkPostVerify(testResult, regression);
    if (verifyTrip) {
      throw new CycleKilledError(verifyTrip);
    }

    // ─────────────────────────────────────────────────────────────────
    // STAGE 5 — COMMIT
    // Verify git/gh preconditions, create the autonomous feature branch,
    // stage the changed files, commit (with secret scan), and push.
    // ─────────────────────────────────────────────────────────────────
    const filesToCommit = await this.collectChangedFiles(runSummary);
    this.filesChanged = filesToCommit;

    if (this.options.config.prMode === 'multi') {
      this.options.bus.publish('sprint.phase.commit.step', {
        cycleId: this.cycleId,
        step: 'skipped',
        detail: 'multi-PR mode uses agent branches directly — skipping aggregate commit',
      });
    } else if (shouldRunAggregateCommit(this.options.config.prMode, filesToCommit)) {
      await this.options.gitOps.verifyPreconditions();
      this.options.bus.publish('sprint.phase.commit.step', {
        cycleId: this.cycleId,
        step: 'preconditions',
        detail: 'git/gh preconditions verified',
      });

      this.branch = await this.options.gitOps.createBranch(plan.version);
      this.options.bus.publish('sprint.phase.commit.step', {
        cycleId: this.cycleId,
        step: 'branch-created',
        detail: this.branch,
      });

      await this.options.gitOps.stage(filesToCommit);
      this.options.bus.publish('sprint.phase.commit.step', {
        cycleId: this.cycleId,
        step: 'staged',
        detail: `${filesToCommit.length} file(s) staged`,
      });

      // v15.0.0: guard commit + push behind filesToCommit.length > 0. Cycle
      // b555cca4 crashed at this exact point: all 5 items produced text-only
      // analysis (no file edits), git commit -F - exited code 1 because
      // nothing was staged. Now we treat "no work product" as a clean
      // no-op rather than a fatal error.
      const message = this.buildCommitMessage(plan.version, scored.summary);
      this.commitSha = await this.options.gitOps.commit(message);
      this.options.bus.publish('sprint.phase.commit.step', {
        cycleId: this.cycleId,
        step: 'committed',
        detail: this.commitSha ?? '',
      });

      await this.options.gitOps.push(this.branch);
      this.options.bus.publish('sprint.phase.commit.step', {
        cycleId: this.cycleId,
        step: 'pushed',
        detail: this.branch,
      });
    } else {
      this.options.bus.publish('sprint.phase.commit.step', {
        cycleId: this.cycleId,
        step: 'skipped',
        detail: 'no file changes produced by execute phase — skipping branch, commit, push, and PR',
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // STAGE 6 — REVIEW
    // Two modes:
    //
    //   single (default): render PR body, open one squash-PR for the entire
    //   autonomous branch via PROpener. This is the legacy path and remains
    //   fully intact for backward compatibility.
    //
    //   multi: skip the single squash-PR entirely. Agent PRs were already
    //   opened in real-time by MergeQueue during STAGE 3 (RUN). Drain the
    //   queue here to await any in-flight handlers, log a per-PR summary
    //   from the ledger, and optionally call drainAndMerge() when
    //   autoMergePRs=true.
    // ─────────────────────────────────────────────────────────────────
    if (this.options.config.prMode === 'multi') {
      // ── multi-PR path ──────────────────────────────────────────────
      await this.runMultiPrDrain(plan.version, scored.summary);
    } else {
      // ── single-PR path (default) ────────────────────────────────────
      if (shouldOpenSingleCyclePr(filesToCommit, this.commitSha)) {
        const intermediate = this.buildResult(CycleStage.REVIEW, {
          sprintVersion: plan.version,
          cost: {
            totalUsd: this.totalCostUsd,
            budgetUsd: this.options.config.budget.perCycleUsd,
            byAgent: {},
            byPhase: {},
          },
          tests: this.testStats,
          git: {
            branch: this.branch,
            commitSha: this.commitSha,
            filesChanged: filesToCommit,
          },
        });

        const prBody = renderPrBody({
          sprint: {
            version: plan.version,
            items: plan.items.map((i) => ({
              id: i.id,
              priority: i.priority,
              title: i.title,
              assignee: i.assignee,
            })),
          },
          result: intermediate,
          testResult,
          scoringResult: {
            rankings: [...scored.withinBudget, ...scored.requiresApproval],
            totalEstimatedCostUsd: scored.totalEstimatedCostUsd,
            budgetOverflowUsd: scored.budgetOverflowUsd,
            summary: scored.summary,
            warnings: scored.warnings,
          },
        });

        // Build the PROpener request — only include `reviewers` if we have one,
        // and only include `dryRun` if it's truthy. `exactOptionalPropertyTypes`
        // forbids `undefined` for optional fields, so use conditional spreads.
        const prRequest = {
          branch: this.branch,
          baseBranch: this.options.config.git.baseBranch,
          title: sanitizePrTitle(plan.version, scored.summary),
          body: prBody,
          draft: this.options.config.pr.draft,
          labels: this.options.config.pr.labels,
          ...(this.options.config.pr.assignReviewer
            ? { reviewers: [this.options.config.pr.assignReviewer] }
            : {}),
          ...(this.options.dryRun?.prOpener ? { dryRun: true } : {}),
        };
        const prResult = await this.options.prOpener.open(prRequest);

        this.prUrl = prResult.url;
        this.prNumber = prResult.number;
        this.prDraft = prResult.draft;

        this.logger.logPREvent({
          type: 'opened',
          url: prResult.url,
          number: prResult.number,
          title: `autonomous(v${plan.version})`,
        });
      } else {
        this.options.bus.publish('sprint.phase.review.step', {
          cycleId: this.cycleId,
          step: 'skipped',
          detail: 'no commit was produced — skipping single-PR open',
        });
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // T4.6 — WORKTREE GC (END): clean up this cycle's worktrees, keeping
    // the last 20 for forensics. Errors are swallowed — same policy as
    // the start-of-cycle GC pass.
    // ─────────────────────────────────────────────────────────────────
    await this.runWorktreeGc('end');

    // ─────────────────────────────────────────────────────────────────
    // COMPLETED
    // ─────────────────────────────────────────────────────────────────
    // `scoringFallback` is only added when defined to satisfy
    // `exactOptionalPropertyTypes`.
    const completedOverrides: Partial<CycleResult> = {
      sprintVersion: plan.version,
      cost: {
        totalUsd: this.totalCostUsd,
        budgetUsd: this.options.config.budget.perCycleUsd,
        byAgent: {},
        byPhase: {},
      },
      tests: this.testStats,
      git: {
        branch: this.branch,
        commitSha: this.commitSha,
        filesChanged: filesToCommit,
      },
      pr: {
        url: this.prUrl,
        number: this.prNumber,
        draft: this.prDraft,
      },
    };
    if (this.scoringFallback) {
      completedOverrides.scoringFallback = this.scoringFallback;
    }
    return this.buildResult(CycleStage.COMPLETED, completedOverrides);
  }

  /**
   * Between-stage kill switch check. Used at the boundaries between PLAN
   * substages and STAGE/RUN. The PhaseScheduler does its own per-phase check
   * during STAGE 3 — this only covers the gaps the scheduler doesn't see.
   */
  private checkKillSwitch(): void {
    const trip = this.killSwitch.checkBetweenPhases({
      cumulativeCostUsd: this.totalCostUsd,
      consecutiveFailures: 0,
    });
    if (trip) throw new CycleKilledError(trip);
  }

  /**
   * Dispatch the pre-verify typecheck step (STAGE 3.5). Uses the injected
   * `preVerifyTypeCheck` when provided; falls back to running the real build
   * and typecheck commands via execFileAsync. Trips the kill switch and throws
   * CycleKilledError on failure (subject to the quality flags).
   */
  private async runPreVerifyTypeCheck(): Promise<void> {
    // eslint-disable-next-line no-console
    console.log('[autonomous:cycle] stage 3.5: running pre-verify typecheck');
    const result = this.options.preVerifyTypeCheck
      ? await this.options.preVerifyTypeCheck(this.options.cwd, this.options.config.testing)
      : await runPreVerifyTypeCheck(this.options.cwd, this.options.config.testing, this.logger);

    if (!result.buildOk) {
      // eslint-disable-next-line no-console
      console.error(`[autonomous:cycle] build failed: ${(result.buildError ?? '').slice(0, 200)}`);
      this.logger.logPhaseFailure('typecheck', `build failed: ${result.buildError ?? 'unknown'}`);
    }
    const buildTrip = this.killSwitch.checkBuildResult({
      success: result.buildOk,
      ...(result.buildError !== undefined ? { error: result.buildError } : {}),
    });
    if (buildTrip) throw new CycleKilledError(buildTrip);

    if (!result.typeCheckOk) {
      // eslint-disable-next-line no-console
      console.error(`[autonomous:cycle] typecheck failed: ${(result.typeCheckError ?? '').slice(0, 200)}`);
      this.logger.logPhaseFailure('typecheck', `tsc failed: ${result.typeCheckError ?? 'unknown'}`);
    }
    const typeCheckTrip = this.killSwitch.checkTypeCheckResult({
      success: result.typeCheckOk,
      ...(result.typeCheckError !== undefined ? { error: result.typeCheckError } : {}),
    });
    if (typeCheckTrip) throw new CycleKilledError(typeCheckTrip);
  }

  /**
   * Run the auto-reforge step (STAGE 3.25). Extracts the unique agent IDs
   * that ran in this cycle from phases/execute.json, then calls
   * runAutoReforge so those agents absorb the cycle's learnings.
   *
   * Honoured by `config.autoReforge` (default true when the field is absent).
   * Any error is caught and logged — a reforge failure MUST NOT kill a cycle
   * that has already passed the gate.
   */
  private async runAutoReforgeStep(
    context?: { projectedBudgetUsd?: number; currentCostUsd?: number },
  ): Promise<void> {
    // Default true: existing configs without the field still trigger reforge.
    const shouldReforge = this.options.config.autoReforge !== false;
    if (!shouldReforge) {
      // eslint-disable-next-line no-console
      console.log('[autonomous:cycle] stage 3.25: auto-reforge skipped (autoReforge=false)');
      return;
    }

    // eslint-disable-next-line no-console
    console.log('[autonomous:cycle] stage 3.25: running auto-reforge');
    try {
      const involvedAgentIds = extractInvolvedAgentIds(this.options.cwd, this.cycleId);
      const result = await runAutoReforge({
        projectRoot: this.options.cwd,
        cycleId: this.cycleId,
        involvedAgentIds,
        ...(this.options.config.autoReforgeCanary !== undefined
          ? { canary: this.options.config.autoReforgeCanary }
          : {}),
        ...(context?.projectedBudgetUsd !== undefined
          ? { projectedBudgetUsd: context.projectedBudgetUsd }
          : {}),
        ...(context?.currentCostUsd !== undefined
          ? { currentCostUsd: context.currentCostUsd }
          : {}),
        bus: this.options.bus,
      });
      this.autoReforgeCanary = result.canary;
      if (result.skipped) {
        // eslint-disable-next-line no-console
        console.log('[autonomous:cycle] stage 3.25: auto-reforge skipped (no proposed learnings)');
      } else {
        // eslint-disable-next-line no-console
        console.log(
          `[autonomous:cycle] stage 3.25: auto-reforge complete in ${result.durationMs}ms` +
          ` (applied=${result.mutatorReport?.totalApplied ?? 0})`,
        );
        if (result.canary) {
          // eslint-disable-next-line no-console
          console.log(
            `[autonomous:cycle] stage 3.25: canary status=${result.canary.status}` +
            ` staged=${result.canary.stagedAgents.length}` +
            ` promoted=${result.canary.promotedAgents.length}` +
            ` rolledBack=${result.canary.rolledBackAgents.length}`,
          );
        }
      }
    } catch (err) {
      // Swallow — reforge errors must never fail the cycle.
      // eslint-disable-next-line no-console
      console.error(
        `[autonomous:cycle] stage 3.25: auto-reforge error (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * T5.7 — Optionally export anonymized cycle telemetry.
   * Reads telemetry config from environment / .agentforge/telemetry.yaml.
   * Errors are swallowed — telemetry failures must NEVER kill a cycle.
   */
  private async runTelemetryExport(): Promise<void> {
    try {
      const telConfig = resolveTelemetryConfig(this.options.cwd);
      if (!telConfig.enabled) return;

      // eslint-disable-next-line no-console
      console.log('[autonomous:cycle] stage 3.3: exporting cycle telemetry');
      const result = await exportCycleTelemetry({
        projectRoot: this.options.cwd,
        cycleId: this.cycleId,
        enabled: true,
        ...(telConfig.endpoint !== undefined ? { endpoint: telConfig.endpoint } : {}),
      });
      if (result.exported) {
        // eslint-disable-next-line no-console
        console.log(`[autonomous:cycle] stage 3.3: telemetry saved to ${result.localPath}`);
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[autonomous:cycle] stage 3.3: telemetry not exported — ${result.reason}`);
      }
    } catch (err) {
      // Swallow — telemetry errors must never fail the cycle.
      // eslint-disable-next-line no-console
      console.error(
        `[autonomous:cycle] stage 3.3: telemetry export error (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Collect the file paths that the cycle modified during the RUN stage.
   *
   * v6.4.1: queries `git status --porcelain` for all working-tree changes
   * (modified, added, untracked). Filters out `.agentforge/cycles/**` because
   * those are the cycle's own log files, not "work product" to be committed.
   *
   * Limitation: this approach assumes the working tree was clean at cycle
   * start. If the user has other uncommitted changes when the cycle runs,
   * those will also be captured. A future improvement is to track per-agent
   * file writes via runtime hooks so we don't depend on the git working tree.
   */
  /**
   * Sum phase costs from disk — used when the scheduler throws (gate rejection)
   * and we need to capture the failed attempt's costs before retrying.
   */
  /**
   * After the retry loop, reconcile the sprint file so all items that the
   * execute phase completed are marked 'completed' — not left as 'in_progress'
   * due to stale writes from parallel execution or retry re-reads.
   */
  private reconcileSprintStatus(_sprintVersion: string): void {
    // plan.json lives inside the cycle directory — reconcile directly there.
    const cycleDir = join(this.options.cwd, '.agentforge/cycles', this.cycleId);
    const execPath = join(cycleDir, 'phases/execute.json');
    const planPath = join(cycleDir, 'plan.json');
    if (!existsSync(execPath) || !existsSync(planPath)) return;

    try {
      const execData = JSON.parse(readFileSync(execPath, 'utf8'));
      const planData = JSON.parse(readFileSync(planPath, 'utf8'));
      const runs: Array<{ itemId: string; status: string }> = execData.agentRuns ?? [];
      const completedIds = new Set(runs.filter(r => r.status === 'completed').map(r => r.itemId));

      // plan.json is a flat SprintPlan (no sprints[] wrapper)
      for (const item of planData.items ?? []) {
        if (completedIds.has(item.id) && item.status !== 'completed') {
          item.status = 'completed';
        }
      }
      writeFileSync(planPath, JSON.stringify(planData, null, 2));
    } catch { /* non-fatal — dashboard will show stale data but cycle continues */ }
  }

  private sumPhaseCostsFromDisk(): number {
    const phasesDir = join(this.options.cwd, '.agentforge/cycles', this.cycleId, 'phases');
    let total = 0;
    for (const name of ['audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate']) {
      const f = join(phasesDir, `${name}.json`);
      if (existsSync(f)) {
        try {
          const d = JSON.parse(readFileSync(f, 'utf8'));
          total += Number(d.costUsd ?? 0);
        } catch { /* skip corrupt files */ }
      }
    }
    return total;
  }

  /**
   * Wave 2 — Read the accumulated CostBreakdown from execute.json and set
   * `this.executionBreakdown`. Called after STAGE 3 (RUN) completes so the
   * breakdown is available for `buildResult()`.
   *
   * Reads `phases/execute.json` and accumulates the per-item `breakdown`
   * objects via `mergeBreakdowns`. If the file is absent or malformed the
   * field stays undefined — never throws.
   */
  private loadExecutionBreakdownFromDisk(): void {
    const execPath = join(
      this.options.cwd, '.agentforge/cycles', this.cycleId, 'phases/execute.json',
    );
    if (!existsSync(execPath)) return;
    try {
      const data = JSON.parse(readFileSync(execPath, 'utf8'));
      // Prefer the phase-level breakdown if it was pre-computed.
      if (data.breakdown && typeof data.breakdown === 'object') {
        this.executionBreakdown = data.breakdown as CostBreakdown;
        return;
      }
      // Otherwise accumulate from per-item breakdowns.
      const runs: Array<Record<string, unknown>> = data.agentRuns ?? data.itemResults ?? [];
      let acc: CostBreakdown | undefined;
      for (const run of runs) {
        if (run.breakdown && typeof run.breakdown === 'object') {
          acc = acc === undefined
            ? (run.breakdown as CostBreakdown)
            : mergeBreakdowns(acc, run.breakdown as CostBreakdown);
        }
      }
      if (acc !== undefined) this.executionBreakdown = acc;
    } catch { /* non-fatal */ }
  }

  private async collectChangedFiles(_runSummary: SprintRunSummary): Promise<string[]> {
    // When a worktreePool is available, collect files from individual agent
    // worktree branches via git diff rather than git status on the main tree.
    if (this.options.config.prMode === 'multi' && this.getEffectiveWorktreePool()) {
      return this.collectFilesFromAgentBranches();
    }

    try {
      const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: this.options.cwd,
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout
        .toString()
        .split('\n')
        .filter(line => line.length > 0)
        // Porcelain format: "XY path" where XY is 2-char status and path is tab/space-separated
        // For renames: "R  old -> new" — we only care about the new path
        .map(line => {
          const rest = line.slice(3);
          const arrowIdx = rest.indexOf(' -> ');
          return arrowIdx >= 0 ? rest.slice(arrowIdx + 4).trim() : rest.trim();
        })
        .filter(file => file.length > 0)
        .filter(file => !file.startsWith('.agentforge/cycles/'));
    } catch {
      return [];
    }
  }

  /**
   * Collect changed files from agent worktree branches recorded in execute.json.
   * Delegates to the exported `collectFilesFromAgentBranches()` helper so it can
   * be tested in isolation without spinning up a full CycleRunner.
   */
  private async collectFilesFromAgentBranches(): Promise<string[]> {
    return collectFilesFromAgentBranches({
      cwd: this.options.cwd,
      cycleId: this.cycleId,
      baseBranch: this.options.config.git.baseBranch,
    });
  }

  /**
   * Render a deterministic commit message for the autonomous commit.
   * The Co-Authored-By trailer is required by the AgentForge git policy.
   */
  private buildCommitMessage(version: string, summary: string): string {
    return `autonomous(v${version}): ${summary}

Cycle: ${this.cycleId}

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
`;
  }

  /**
   * Build a CycleResult with sane defaults for every field, then apply the
   * caller's overrides on top. Used for both intermediate (REVIEW) and
   * terminal (COMPLETED/KILLED/FAILED) results.
   */
  private buildResult(
    stage: CycleStage,
    overrides: Partial<CycleResult> = {},
  ): CycleResult {
    const base: CycleResult = {
      cycleId: this.cycleId,
      sprintVersion: this.sprintVersion,
      stage,
      startedAt: new Date(this.startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - this.startedAt,
      cost: {
        totalUsd: this.totalCostUsd,
        budgetUsd: this.options.config.budget.perCycleUsd,
        byAgent: {},
        byPhase: {},
        // Wave 2: attach granular token/tool breakdown when available.
        ...(this.executionBreakdown !== undefined
          ? { breakdown: this.executionBreakdown }
          : {}),
      },
      tests: { ...this.testStats },
      git: {
        branch: this.branch,
        commitSha: this.commitSha,
        filesChanged: [...this.filesChanged],
      },
      pr: {
        url: this.prUrl,
        number: this.prNumber,
        draft: this.prDraft,
      },
    };
    if (this.scoringFallback) {
      base.scoringFallback = this.scoringFallback;
    }
    if (this.gateVerdict !== undefined) {
      base.gateVerdict = this.gateVerdict;
    }
    if (this.autoReforgeCanary !== undefined) {
      base.autoReforge = { canary: this.autoReforgeCanary };
    }
    const merged: CycleResult = { ...base, ...overrides };
    // v6.4.4 bug #2: propagate `error` field so FAILED cycles surface the
    // reason in cycle.json rather than forcing consumers to reconstruct it
    // from events.jsonl. `exactOptionalPropertyTypes` forbids assigning
    // `undefined`, so only attach when present.
    if (overrides.error !== undefined) {
      merged.error = overrides.error;
    }
    if (overrides.gateVerdict !== undefined) {
      merged.gateVerdict = overrides.gateVerdict;
    }
    return merged;
  }

  /**
   * STAGE 6 multi-PR path.
   *
   * - Drains in-flight MergeQueue handlers.
   * - Logs a one-line summary for each PR recorded in the ledger.
   * - If `config.autoMergePRs === true`, calls drainAndMerge({ autoMerge: true })
   *   to promote CI-green PRs to ready and squash-merge them.
   * - If `config.autoMergePRs` is false/absent (default), calls
   *   drainAndMerge({ autoMerge: false }) which only promotes drafts → ready.
   *
   * The single-PR (PROpener) step is NOT called in this path.
   * Errors from drainAndMerge are swallowed — a merge failure must never
   * kill a cycle that passed all quality gates.
   */
  private async runMultiPrDrain(_version: string, _summary: string): Promise<void> {
    if (!this.mergeQueue) return;

    // Stop accepting new events before draining.
    this.mergeQueue.stop();

    // eslint-disable-next-line no-console
    console.log('[autonomous:cycle] multi-pr: draining MergeQueue...');

    // Drain in-flight handlers and read the ledger summary.
    let drainResult: Awaited<ReturnType<MergeQueue['drain']>>;
    try {
      drainResult = await this.mergeQueue.drain();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[autonomous:cycle] multi-pr: drain error (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    // Log per-PR summary (one line each).
    for (const pr of drainResult.prs) {
      // eslint-disable-next-line no-console
      console.log(
        `[autonomous:cycle] multi-pr: PR #${pr.prNumber} agent=${pr.agentId} branch=${pr.branch}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(
      `[autonomous:cycle] multi-pr: ${drainResult.pushed} branch(es) pushed, ${drainResult.prs.length} open PR(s)`,
    );

    // Optionally call drainAndMerge.
    try {
      const autoMerge = this.options.config.autoMergePRs === true;
      const dmResult: DrainAndMergeResult = await this.mergeQueue.drainAndMerge({ autoMerge });
      // eslint-disable-next-line no-console
      console.log(
        `[autonomous:cycle] multi-pr: drainAndMerge complete — ` +
        `ready=${dmResult.ready.length} merged=${dmResult.merged.length} ` +
        `failing=${dmResult.failing.length} pending=${dmResult.pending.length}`,
      );
    } catch (err) {
      // Swallow — merge errors must never fail the cycle.
      // eslint-disable-next-line no-console
      console.error(
        `[autonomous:cycle] multi-pr: drainAndMerge error (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * T4.6 — Run WorktreeGc at cycle start and end.
   * - start: aggressive cleanup (olderThanMs=24h, keepLast=20, maxDiskMb=5000)
   * - end:   keepLast=20 so forensics are preserved, no age filter override
   *
   * Any error is caught and logged — GC failures must never kill a cycle.
   */
  private async runWorktreeGc(when: 'start' | 'end'): Promise<void> {
    const pool = this.getEffectiveWorktreePool();
    if (!pool) return;
    try {
      const gc = new WorktreeGc({
        pool,
        projectRoot: this.options.cwd,
        keepLast: 20,
        ...(when === 'start' ? { olderThanMs: 24 * 60 * 60 * 1000 } : {}),
        maxDiskMb: 5000,
      });
      const result = await gc.run();
      if (result.removed.length > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[autonomous:cycle] worktree-gc (${when}): removed ${result.removed.length} worktrees` +
          ` (~${result.diskFreedMb.toFixed(1)} MB freed)`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[autonomous:cycle] worktree-gc (${when}) error (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Read-only accessor for tests/operators that want to inspect the cycleId
   * before `start()` is called (e.g., to set up an external monitor).
   */
  getCycleId(): string {
    return this.cycleId;
  }

  private getEffectiveWorktreePool(): WorktreePool | undefined {
    return this.options.disableWorktrees ? undefined : this.options.worktreePool;
  }

  /**
   * Read-only accessor for the kill switch trip state. Useful for external
   * dashboards/healthchecks that want to surface the kill reason without
   * waiting for `start()` to return.
   */
  getKillSwitchTrip(): KillSwitchTrip | null {
    return this.killSwitch.getTrip();
  }
}
