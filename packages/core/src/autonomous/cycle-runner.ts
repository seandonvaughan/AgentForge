// packages/core/src/autonomous/cycle-runner.ts
//
// Top-level orchestrator for the AgentForge autonomous development cycle.
//
// Drives all six cycle stages in order:
//   STAGE 1 — PLAN    : ProposalToBacklog → ScoringPipeline → BudgetApproval
//   STAGE 2 — STAGE   : SprintGenerator
//   STAGE 3 — RUN     : PhaseScheduler (audit→plan→assign→execute→test→review→gate→release→learn)
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
  private scoringFallback: 'static' | undefined;
  private gateVerdict: 'APPROVE' | 'REJECT' | undefined = undefined;

  constructor(private readonly options: CycleRunnerOptions) {
    // Honor AUTONOMOUS_CYCLE_ID when set (server's POST /api/v5/cycles route
     // pre-allocates the id and pre-creates the dir, then spawns the CLI with
     // this env var set so the CLI writes to the same dir the API client
     // already has a pointer to). Falls back to a fresh UUID for direct CLI use.
    const envId = process.env['AUTONOMOUS_CYCLE_ID'];
    this.cycleId = envId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(envId)
      ? envId
      : randomUUID();
    this.startedAt = Date.now();
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
    let final: CycleResult;
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
    // .agentforge/sprints/v{N}.json. Version is bumped from the latest
    // existing sprint based on item tags.
    // ─────────────────────────────────────────────────────────────────
    const generator = new SprintGenerator(this.options.cwd, this.options.config);
    const plan: SprintPlan = await generator.generate(approved.approvedItems);
    this.sprintVersion = plan.version;
    // Persist the cycle→sprint link immediately so the dashboard can resolve
    // the Items tab without needing to match sprint files by timestamp.
    this.logger.logSprintAssigned(plan.version);
    this.checkKillSwitch();

    // ─────────────────────────────────────────────────────────────────
    // STAGE 3 — RUN
    // Drive the 9-phase sprint sequence (audit → … → learn) via
    // PhaseScheduler. The kill switch is checked between every phase.
    // ─────────────────────────────────────────────────────────────────
    const scheduler = new PhaseScheduler(
      {
        sprintId: plan.sprintId,
        sprintVersion: plan.version,
        projectRoot: this.options.cwd,
        adapter: this.options.scoringAdapter,
        bus: this.options.bus,
        runtime: this.options.runtime,
        cycleId: this.cycleId,
      },
      this.killSwitch,
      this.logger,
      this.options.phaseHandlers,
    );
    const runSummary: SprintRunSummary = await scheduler.run();
    this.totalCostUsd = runSummary.totalCostUsd;
    // Gate phase approval is implied by scheduler.run() completing without
    // throwing GateRejectedError — record it so cycle-outcome memory entries
    // capture the verdict for cross-cycle audit context.
    this.gateVerdict = 'APPROVE';
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
    await this.options.gitOps.verifyPreconditions();
    this.branch = await this.options.gitOps.createBranch(plan.version);

    const filesToCommit = await this.collectChangedFiles(runSummary);
    this.filesChanged = filesToCommit;

    // Only call gitOps.stage if we have files. Real GitOps refuses an empty
    // list (good safety), but mocked GitOps in unit tests is permissive. The
    // smoke test (Task 25) is responsible for end-to-end file detection.
    if (filesToCommit.length > 0) {
      await this.options.gitOps.stage(filesToCommit);
    }
    const message = this.buildCommitMessage(plan.version, scored.summary);
    this.commitSha = await this.options.gitOps.commit(message);
    await this.options.gitOps.push(this.branch);

    // ─────────────────────────────────────────────────────────────────
    // STAGE 6 — REVIEW
    // Render the PR body and open the PR. Pre-built CycleResult passed
    // to renderPrBody is intermediate (stage=REVIEW); the final returned
    // result is built below with stage=COMPLETED.
    // ─────────────────────────────────────────────────────────────────
    const intermediate = this.buildResult(CycleStage.REVIEW, {
      sprintVersion: plan.version,
      cost: {
        totalUsd: runSummary.totalCostUsd,
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

    // ─────────────────────────────────────────────────────────────────
    // COMPLETED
    // ─────────────────────────────────────────────────────────────────
    // `scoringFallback` is only added when defined to satisfy
    // `exactOptionalPropertyTypes`.
    const completedOverrides: Partial<CycleResult> = {
      sprintVersion: plan.version,
      cost: {
        totalUsd: runSummary.totalCostUsd,
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
        url: prResult.url,
        number: prResult.number,
        draft: prResult.draft,
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
  private async collectChangedFiles(_runSummary: SprintRunSummary): Promise<string[]> {
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
   * Read-only accessor for tests/operators that want to inspect the cycleId
   * before `start()` is called (e.g., to set up an external monitor).
   */
  getCycleId(): string {
    return this.cycleId;
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
