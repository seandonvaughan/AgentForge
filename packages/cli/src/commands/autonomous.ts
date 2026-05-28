// packages/cli/src/commands/autonomous.ts
//
// Canonical package CLI for autonomous cycle operations:
//   - run
//   - preview
//   - list
//   - show
//   - assess-pr
//   - streak
//   - approve
//
// `autonomous:cycle` remains as a compatibility alias for `cycle run`.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Command } from 'commander';
import {
  loadCycleConfig,
  CycleRunner,
  CycleStage,
  createAutonomousTelemetryAdapters,
  RealTestRunner,
  GitOps,
  PROpener,
  RuntimeAdapter,
  RuntimeJobSupervisor,
  WorkspaceManager,
  CycleLogger,
  MessageBusV2,
  WorktreePool,
  runExecutePhase,
  runAuditPhase,
  runPlanPhase,
  runAssignPhase,
  runGatePhase,
  runLearnPhase,
  runTestPhase,
  runReviewPhase,
  runReleasePhase,
  ProposalToBacklog,
  ScoringPipeline,
  getWorkspace,
  getDefaultWorkspace,
  readCheckpoint,
} from '@agentforge/core';
import type { MessageTopic, MessageEnvelopeV2, CycleResult, PhaseName, PhaseHandler, PhaseContext, CycleConfig, CycleLogger as CycleLoggerType } from '@agentforge/core';

interface WorkspaceAwareOptions {
  projectRoot: string;
  workspace?: string;
}

interface CycleRunOptions extends WorkspaceAwareOptions {
  dryRun: boolean;
  /** Commander sets this to false when --no-worktrees is passed. */
  worktrees: boolean;
  /** Commander sets this to false when --no-quality-bias is passed. */
  qualityBias: boolean;
  /** Resume a previously-checkpointed cycle by id. */
  resume?: string;
  /** Optional display name for a new cycle. */
  cycleName?: string;
  fastMode?: boolean;
  modelCap?: string;
  effortCap?: string;
  maxAgents?: string;
  fallback?: boolean;
}

interface CyclePreviewOptions extends WorkspaceAwareOptions {
  budgetUsd?: string;
  maxItems?: string;
  fastMode?: boolean;
  modelCap?: string;
  effortCap?: string;
  maxAgents?: string;
  fallback?: boolean;
}

interface CycleListOptions extends WorkspaceAwareOptions {
  limit: string;
  stage?: string;
  json?: boolean;
}

interface CycleShowOptions extends WorkspaceAwareOptions {
  json?: boolean;
}

interface CycleAssessPrOptions extends WorkspaceAwareOptions {
  json?: boolean;
}

interface CycleApproveOptions extends WorkspaceAwareOptions {
  all?: boolean;
  approved?: string[];
  rejected?: string[];
  decidedBy?: string;
}

interface LoopGuardStatusOptions extends WorkspaceAwareOptions {
  json?: boolean;
}

interface LoopGuardResetOptions extends WorkspaceAwareOptions {
  json?: boolean;
}

interface CycleStreakStatusOptions extends WorkspaceAwareOptions {
  json?: boolean;
}

interface CycleStreakRecordOptions extends WorkspaceAwareOptions {
  pr?: string;
  result?: string;
  reason?: string;
  json?: boolean;
}

interface CycleSummary {
  cycleId: string;
  sprintVersion: string | null;
  stage: string;
  startedAt: string;
  completedAt: string | null;
  costUsd: number;
  budgetUsd: number;
  testsPassed: number;
  testsTotal: number;
  prUrl: string | null;
  hasApprovalPending: boolean;
  approvalDecision: string | null;
}

interface AgentPrLedgerEntry {
  prNumber?: number | null;
  prUrl?: string | null;
  branch?: string;
  status?: string;
  openedAt?: string;
}

interface ApprovalItem {
  itemId: string;
  title?: string;
}

interface PendingApproval {
  cycleId: string;
  withinBudget?: {
    totalCostUsd?: number;
    items?: ApprovalItem[];
  };
  overflow?: {
    additionalCostUsd?: number;
    items?: ApprovalItem[];
  };
  agentSummary?: string;
  sprintVersion?: string;
}

interface RuntimeRoutingDecision {
  itemId: string;
  decision: 'routed' | 'default';
  runtimeMode: string | null;
  preferredProvider: string | null;
}

interface RuntimeRoutingSummary {
  totalItems: number;
  routedItems: number;
  defaultItems: number;
  decisions: RuntimeRoutingDecision[];
}

interface CycleStreakEntry {
  cycleId: string;
  prNumber: number;
  result: 'success' | 'failure';
  reason: string;
  recordedAt: string;
  mergeEvidence?: {
    prUrl?: string;
    status?: string;
    mergedAt?: string;
    openedAt?: string;
  };
}

interface CycleStreakLedger {
  version: 1;
  entries: CycleStreakEntry[];
}

interface MergeReadinessCheck {
  id:
    | 'cycle-completed'
    | 'pr-linked'
    | 'approval-state'
    | 'cycle-error'
    | 'gate-approved'
    | 'review-findings'
    | 'execute-failures'
    | 'tests';
  status: 'pass' | 'fail';
  detail: string;
}

interface PrMergeAssessment {
  cycleId: string;
  mergeReady: boolean;
  verdict: 'ready' | 'blocked';
  prUrl: string | null;
  checks: MergeReadinessCheck[];
  blockingReasons: string[];
  metrics: {
    gateVerdict: 'APPROVE' | 'REJECT' | null;
    criticalFindings: number;
    majorFindings: number;
    failedItems: number;
    testsPassed: number;
    testsTotal: number;
    newFailures: number;
  };
}

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
const CYCLE_STAGE_FILTER_RE = /^[a-z][a-z0-9_-]*$/;
type ModelCap = 'opus' | 'sonnet' | 'haiku';
type EffortCap = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

interface CycleLaunchControls {
  fastMode: boolean;
  modelCap?: ModelCap;
  effortCap?: EffortCap;
  maxAgents?: number;
  fallbackEnabled?: boolean;
}

export function registerCycleCommand(program: Command): void {
  const cycle = program
    .command('cycle')
    .description('Run and inspect autonomous development cycles');

  registerCycleRunCommand(
    cycle,
    'run',
    'Run one autonomous development cycle (PLAN -> REVIEW -> PR)',
  );

  cycle
    .command('preview')
    .description('Preview PLAN-stage backlog and budget before running a cycle')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--workspace <id>', 'Run against a registered workspace from ~/.agentforge/workspaces.json')
    .option('--budget-usd <usd>', 'Override per-cycle budget for preview only')
    .option('--max-items <count>', 'Override max sprint items for preview only')
    .option('--fast-mode', 'Use the fast parallel launch preset (defaults effort cap to high unless --effort-cap is set)')
    .option('--model-cap <tier>', 'Cap Codex model tier: opus, sonnet, or haiku')
    .option('--effort-cap <effort>', 'Cap Codex effort: low, medium, high, xhigh, or max')
    .option('--max-agents <count>', 'Override maximum execute-phase parallel agents')
    .option('--fallback', 'Enable runtime fallback for this preview')
    .option('--no-fallback', 'Disable runtime fallback for this preview')
    .action(runCyclePreviewAction);

  cycle
    .command('list')
    .description('List autonomous cycles from .agentforge/cycles')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--workspace <id>', 'Run against a registered workspace from ~/.agentforge/workspaces.json')
    .option('--limit <count>', 'Maximum rows to show', '20')
    .option('--stage <stage>', 'Filter by cycle stage')
    .option('--json', 'Print machine-readable JSON')
    .action(runCycleListAction);

  cycle
    .command('show <cycleId>')
    .description('Show one autonomous cycle in detail')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--workspace <id>', 'Run against a registered workspace from ~/.agentforge/workspaces.json')
    .option('--json', 'Print machine-readable JSON')
    .action(runCycleShowAction);

  cycle
    .command('assess-pr <cycleId>')
    .description('Assess post-cycle PR merge readiness from deterministic cycle artifacts')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--workspace <id>', 'Run against a registered workspace from ~/.agentforge/workspaces.json')
    .option('--json', 'Print machine-readable JSON')
    .action(runCycleAssessPrAction);

  cycle
    .command('approve <cycleId>')
    .description('Write approval-decision.json for a waiting cycle')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--workspace <id>', 'Run against a registered workspace from ~/.agentforge/workspaces.json')
    .option('--all', 'Approve every within-budget item and reject every overflow item')
    .option('--approved <itemIds...>', 'Explicit item IDs to approve')
    .option('--rejected <itemIds...>', 'Explicit item IDs to reject')
    .option('--decided-by <name>', 'Decision author label', 'cli')
    .action(runCycleApproveAction);

  const loopGuard = cycle
    .command('loop-guard')
    .description('Inspect or reset the autonomous loop guard state');

  loopGuard
    .command('status')
    .description('Show loop guard status from .agentforge/loop-state.json')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--workspace <id>', 'Run against a registered workspace from ~/.agentforge/workspaces.json')
    .option('--json', 'Print machine-readable JSON')
    .action(runLoopGuardStatusAction);

  loopGuard
    .command('reset')
    .description('Reset loop guard state to defaults')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--workspace <id>', 'Run against a registered workspace from ~/.agentforge/workspaces.json')
    .option('--json', 'Print machine-readable JSON')
    .action(runLoopGuardResetAction);

  const streak = cycle
    .command('streak')
    .description('Record and inspect cross-cycle success streak evidence');

  streak
    .command('status')
    .description('Show cycle streak ledger status from .agentforge/cycles/streak-ledger.json')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--workspace <id>', 'Run against a registered workspace from ~/.agentforge/workspaces.json')
    .option('--json', 'Print machine-readable JSON')
    .action(runCycleStreakStatusAction);

  streak
    .command('record <cycleId>')
    .description('Record one cycle streak ledger entry (idempotent upsert by cycleId)')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--workspace <id>', 'Run against a registered workspace from ~/.agentforge/workspaces.json')
    .option('--pr <number>', 'PR number for this cycle evidence')
    .option('--result <result>', 'Cycle outcome: success or failure')
    .option('--reason <text>', 'Operator note describing this outcome')
    .option('--json', 'Print machine-readable JSON')
    .action(runCycleStreakRecordAction);
}

export function registerAutonomousCommand(program: Command): void {
  registerCycleRunCommand(
    program,
    'autonomous:cycle',
    'Compatibility alias for cycle run',
  );
}

function registerCycleRunCommand(parent: Command, commandName: string, description: string): void {
  parent
    .command(commandName)
    .description(description)
    .option('--dry-run', 'Do not actually open the PR; still runs all other stages', false)
    .option('--no-worktrees', 'Disable isolated git worktrees; fall back to single-tree execution (env: AUTONOMOUS_DISABLE_WORKTREES=1)')
    .option('--no-quality-bias', 'Disable quality-biased assignment pre-hook (env: AGENTFORGE_NO_QUALITY_BIAS=1)')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--workspace <id>', 'Run against a registered workspace from ~/.agentforge/workspaces.json')
    .option('--resume <cycleId>', 'Resume a previously-checkpointed cycle by id')
    .option('--cycle-name <name>', 'Optional display name for this cycle')
    .option('--fast-mode', 'Use the fast parallel launch preset (defaults effort cap to high unless --effort-cap is set)')
    .option('--model-cap <tier>', 'Cap Codex model tier: opus, sonnet, or haiku')
    .option('--effort-cap <effort>', 'Cap Codex effort: low, medium, high, xhigh, or max')
    .option('--max-agents <count>', 'Override maximum execute-phase parallel agents')
    .option('--fallback', 'Enable runtime fallback for this cycle')
    .option('--no-fallback', 'Disable runtime fallback for this cycle')
    .action(runCycleAction);
}

/** Allowed format for --resume cycleId argument. */
const RESUME_CYCLE_ID_RE = /^[a-zA-Z0-9-]{8,64}$/;

async function runCycleAction(opts: CycleRunOptions): Promise<void> {
  // --no-quality-bias flag: set env so phase handlers pick it up automatically.
  // Commander maps --no-quality-bias → opts.qualityBias = false.
  if (opts.qualityBias === false) {
    process.env['AGENTFORGE_NO_QUALITY_BIAS'] = '1';
    console.log('[cycle] quality-bias pre-hook disabled');
  }

  // Mutual exclusion guard: --resume implies an existing cycle, --cycle-name implies a new one.
  if (opts.resume !== undefined && opts.cycleName !== undefined) {
    console.error('Error: --resume and --cycle-name are mutually exclusive.');
    process.exitCode = 1;
    return;
  }

  // Validate --resume before resolving anything else.
  let resumeCheckpoint: ReturnType<typeof readCheckpoint> | null = null;
  if (opts.resume !== undefined) {
    const rawId = opts.resume;
    // Match-then-use: validate format first, then use the matched value so the
    // static analyzer can trace a sanitized string through the file-system path.
    const matched = RESUME_CYCLE_ID_RE.exec(rawId);
    if (!matched) {
      console.error(`Error: invalid cycle id "${rawId}". Expected ^[a-zA-Z0-9-]{8,64}$.`);
      process.exitCode = 1;
      return;
    }
    const safeId = matched[0];
    const resolvedCwd = await resolveWorkspaceProjectRoot(opts);
    const cycleDir = join(resolvedCwd, '.agentforge', 'cycles', safeId);
    resumeCheckpoint = readCheckpoint(cycleDir);
    if (resumeCheckpoint === null) {
      console.error(`Cycle ${safeId} has no checkpoint`);
      process.exitCode = 1;
      return;
    }
    console.log(`[cycle] resuming cycleId=${safeId} fromPhase=${resumeCheckpoint.resumeFromPhase}`);
  }

  const cwd = await resolveWorkspaceProjectRoot(opts);

  try {
    const config = loadCycleConfig(cwd);
    const launchControls = resolveCycleLaunchControls(opts);
    if (launchControls === null) {
      process.exitCode = 1;
      return;
    }

    // Launch-time overrides threaded through env by the server's POST handler
    // (and by anyone driving the CLI directly). Mirrors the previewCycle
    // pattern in packages/core/src/autonomous/preview-cycle.ts so the preview
    // and run paths honour the same knobs.
    const budgetOverride = parseEnvPositiveNumber(process.env['AUTONOMOUS_BUDGET_USD']);
    if (budgetOverride !== null) {
      config.budget.perCycleUsd = budgetOverride;
      console.log(`[cycle] budget override: $${budgetOverride}`);
    }
    const maxItemsOverride = parseEnvPositiveInteger(process.env['AUTONOMOUS_MAX_ITEMS']);
    if (maxItemsOverride !== null) {
      config.limits.maxItemsPerSprint = maxItemsOverride;
      console.log(`[cycle] maxItems override: ${maxItemsOverride}`);
    }
    applyCycleLaunchControls(config, launchControls, '[cycle]');
    const branchPrefixOverride = process.env['AUTONOMOUS_BRANCH_PREFIX']?.trim();
    if (branchPrefixOverride) {
      config.git.branchPrefix = branchPrefixOverride;
      console.log(`[cycle] branchPrefix override: ${branchPrefixOverride}`);
    }
    const baseBranchOverride = process.env['AUTONOMOUS_BASE_BRANCH']?.trim();
    if (baseBranchOverride) {
      config.git.baseBranch = baseBranchOverride;
      console.log(`[cycle] baseBranch override: ${baseBranchOverride}`);
    }
    if (process.env['AUTONOMOUS_DRY_RUN'] === 'true' || process.env['AUTONOMOUS_DRY_RUN'] === '1') {
      opts.dryRun = true;
      console.log('[cycle] dry-run override: PR will not be opened');
    }
    // Runtime fallback defaults to enabled for compatibility unless this
    // launch explicitly disabled it through CLI flags or server env.
    const enableFallback = launchControls.fallbackEnabled ?? true;

    const telemetry = createAutonomousTelemetryAdapters(cwd);

    // T1: Construct WorktreePool so each agent in the execute phase gets an
    // isolated git worktree, preventing branch ping-pong in the main tree.
    // Skip when --no-worktrees flag is set or AUTONOMOUS_DISABLE_WORKTREES=1.
    // Commander maps --no-worktrees → opts.worktrees = false.
    const disableWorktreesFlag = opts.worktrees === false;
    const disableWorktreesEnv = process.env['AUTONOMOUS_DISABLE_WORKTREES'] === '1';
    const worktreesSupportedForMode = config.prMode === 'multi';
    const worktreesDisabled = disableWorktreesFlag || disableWorktreesEnv || !worktreesSupportedForMode;

    let worktreePool: WorktreePool | undefined;
    let disableWorktrees = worktreesDisabled;

    if (!worktreesDisabled) {
      try {
        worktreePool = new WorktreePool({
          projectRoot: cwd,
          baseBranch: config.git.baseBranch,
          branchPrefix: config.git.branchPrefix,
          rootDir: process.env['AUTONOMOUS_WORKTREE_ROOT_DIR']?.trim() ||
            buildCycleWorktreeRootDir(cwd),
        });
      } catch (poolErr) {
        const poolMsg = poolErr instanceof Error ? poolErr.message : String(poolErr);
        const suffix = config.prMode === 'multi'
          ? 'multi-PR mode requires isolated worktrees'
          : 'falling back to single-tree execution';
        process.stderr.write(
          `[autonomous:cycle] worktree-pool unavailable: ${poolMsg} — ${suffix}\n`,
        );
        worktreePool = undefined;
        disableWorktrees = true;
      }
    }

    if (config.prMode === 'multi' && disableWorktrees) {
      throw new Error(
        'prMode=multi requires isolated worktrees. Remove --no-worktrees/AUTONOMOUS_DISABLE_WORKTREES or use prMode=single.',
      );
    }

    // Build a RuntimeJobSupervisor backed by the real workspace DB so every
    // agent run during the execute phase creates a durable runtime_job row
    // and runtime_events. Without this the tables stay empty across restarts.
    // Non-fatal: if the workspace DB can't be opened the cycle continues
    // without persistence (identical to previous behaviour).
    let workspaceManager: WorkspaceManager | null = null;
    let supervisor: RuntimeJobSupervisor | undefined;
    try {
      workspaceManager = new WorkspaceManager({ dataDir: join(cwd, '.agentforge', 'v5') });
      const { adapter: workspaceAdapter } = await workspaceManager.getOrCreateDefaultWorkspace();
      supervisor = new RuntimeJobSupervisor({ adapter: workspaceAdapter });
    } catch {
      // Best-effort — if the workspace DB is unavailable, skip persistence.
      workspaceManager?.close();
      workspaceManager = null;
    }

    try {
      const runtime = new RuntimeAdapter({
        cwd,
        ...(config.modelCap ? { modelCap: config.modelCap } : {}),
        ...(config.effortCap ? { effortCap: config.effortCap } : {}),
        enableFallback,
        ...(supervisor ? { supervisor } : {}),
      });
      const phaseHandlers = {
        audit: (ctx: PhaseContext) => runAuditPhase(ctx),
        plan: (ctx: PhaseContext) => runPlanPhase(ctx),
        assign: (ctx: PhaseContext) => runAssignPhase(ctx),
        execute: (ctx: PhaseContext) => runExecutePhase(ctx, {
          maxParallelism: config.limits.maxExecutePhaseParallelism,
          requireWorktrees: !disableWorktrees,
        }),
        test: (ctx: PhaseContext) => runTestPhase(ctx),
        review: (ctx: PhaseContext) => runReviewPhase(ctx),
        gate: (ctx: PhaseContext) => runGatePhase(ctx),
        release: (ctx: PhaseContext) => runReleasePhase(ctx),
        learn: (ctx: PhaseContext) => runLearnPhase(ctx),
      };

      // Create a real cycle logger using the cycleId resolution logic from CycleRunner.
      // Priority order:
      //   1. resumeCheckpoint.cycleId — reuse the existing cycle directory
      //   2. AUTONOMOUS_CYCLE_ID env — server pre-allocates the id
      //   3. fresh UUID — direct CLI use with no coordination
      const envId = process.env['AUTONOMOUS_CYCLE_ID'];
      const cycleId = resumeCheckpoint
        ? resumeCheckpoint.cycleId
        : (envId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(envId)
          ? envId
          : randomUUID());
      const logger = new CycleLogger(cwd, cycleId);

      const testRunner = new RealTestRunner(cwd, config.testing, null);
      const gitOps = new GitOps(cwd, config.git, logger);
      const prOpener = new PROpener(cwd);

      // Create a real event bus using MessageBusV2 from packages/core,
      // adapting its envelope-based interface to the simple (topic, payload) interface.
      // Cast internal cycle topics to MessageTopic to satisfy the stricter type.
      const messageBusV2 = new MessageBusV2();
      const bus = {
        publish: (topic: string, payload: unknown) => {
          messageBusV2.publish({
            from: 'system',
            to: 'broadcast',
            topic: topic as MessageTopic,
            category: 'system',
            payload,
          });
        },
        subscribe: (topic: string, cb: (event: unknown) => void) => {
          return messageBusV2.subscribe(topic as MessageTopic, (envelope: MessageEnvelopeV2) => {
            cb(envelope.payload);
          });
        },
      };

      const runner = new CycleRunner({
        cwd,
        config,
        cycleId,
        runtime,
        proposalAdapter: telemetry.proposalAdapter,
        scoringAdapter: telemetry.scoringAdapter,
        phaseHandlers: phaseHandlers as unknown as Record<PhaseName, PhaseHandler>,
        testRunner,
        gitOps,
        prOpener,
        bus,
        messageBus: messageBusV2,
        ...(worktreePool !== undefined ? { worktreePool } : {}),
        ...(disableWorktrees ? { disableWorktrees: true } : {}),
        ...(opts.dryRun ? { dryRun: { prOpener: true } } : {}),
        ...(resumeCheckpoint !== null ? { resumeCheckpoint } : {}),
      });

      const logDir = `.agentforge/cycles/${cycleId}`;
      console.log(`[cycle] cycleId=${cycleId}`);
      console.log(`[cycle] logDir=${logDir}`);
      if (opts.dryRun) console.log('[cycle] dry-run mode: PR will not be opened');

      const result = await runner.start();
      printCycleRunResult(result, logDir, CycleStage);
    } finally {
      workspaceManager?.close();
      telemetry.close();
    }
  } catch (err) {
    const e = err as Error;
    // Cross-cycle loop guard (safeguard #1): a clean HALT, not a crash. Exit 3
    // so an external repeat-invoker can distinguish "stop spinning" from a
    // genuine cycle error (exit 1) and stop the chain.
    if (e.name === 'LoopHaltedError') {
      console.error(`\n[cycle] HALTED by loop guard: ${e.message}`);
      console.error(
        '[cycle] No cycle was started — this prevents unproductive spinning. ' +
          'Investigate the most recent cycle, then delete or reset ' +
          '.agentforge/loop-state.json to resume.',
      );
      process.exitCode = 3;
      return;
    }
    console.error(`[cycle] error: ${e.message}`);
    if (e.stack) console.error(e.stack);
    process.exitCode = 1;
  }
}

async function runCyclePreviewAction(opts: CyclePreviewOptions): Promise<void> {
  const projectRoot = await resolveWorkspaceProjectRoot(opts);
  const budgetUsd = parseOptionalPositiveNumber(opts.budgetUsd, '--budget-usd');
  const maxItems = parseOptionalInteger(opts.maxItems, '--max-items');
  const launchControls = resolveCycleLaunchControls(opts);
  if (budgetUsd === null || maxItems === null || launchControls === null) {
    process.exitCode = 1;
    return;
  }

  try {
    const preview = await runCyclePreview({
      projectRoot,
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
      ...(maxItems !== undefined ? { maxItems } : {}),
      launchControls,
    });

    console.log(`Candidates:   ${preview.candidateCount}`);
    console.log(`Within budget:${preview.withinBudget}`);
    console.log(`Needs approval:${preview.requiresApproval}`);
    console.log(`Total est:    $${preview.totalEstimatedCostUsd.toFixed(4)}`);
    console.log(`Overflow:     $${preview.budgetOverflowUsd.toFixed(4)}`);
    if (preview.fallback) {
      console.log(`Fallback:     ${preview.fallback}`);
    }
    console.log(`Summary:      ${preview.summary}`);

    if (preview.warnings.length > 0) {
      console.log('');
      console.log('Warnings:');
      for (const warning of preview.warnings) {
        console.log(`  - ${warning}`);
      }
    }

    if (preview.rankedItems.length > 0) {
      console.log('');
      console.log('Ranked items:');
      for (const item of preview.rankedItems) {
        console.log(
          `  ${item.rank}. ${item.title}  [${item.withinBudget ? 'within budget' : 'needs approval'}]`,
        );
        console.log(
          `     score=${item.score.toFixed(2)}  confidence=${item.confidence.toFixed(2)}  est=$${item.estimatedCostUsd.toFixed(2)}  assignee=${item.suggestedAssignee}`,
        );
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function runCyclePreview(options: {
  projectRoot: string;
  budgetUsd?: number;
  maxItems?: number;
  launchControls: CycleLaunchControls;
}) {
  const startedAt = Date.now();
  const config = loadCycleConfig(options.projectRoot);
  if (typeof options.budgetUsd === 'number') {
    config.budget.perCycleUsd = options.budgetUsd;
  }
  if (typeof options.maxItems === 'number') {
    config.limits.maxItemsPerSprint = options.maxItems;
  }
  applyCycleLaunchControls(config, options.launchControls, '[cycle preview]');

  const telemetry = createAutonomousTelemetryAdapters(options.projectRoot);
  try {
    const backlog = await new ProposalToBacklog(
      telemetry.proposalAdapter,
      options.projectRoot,
      config,
    ).build();

    if (backlog.length === 0) {
      return {
        candidateCount: 0,
        rankedItems: [],
        totalEstimatedCostUsd: 0,
        budgetOverflowUsd: 0,
        withinBudget: 0,
        requiresApproval: 0,
        summary: 'No backlog items found — nothing to score.',
        warnings: ['Empty backlog: no proposals or TODO(autonomous) markers detected.'],
        durationMs: Date.now() - startedAt,
        scoringCostUsd: 0,
        fallback: null,
      };
    }

    const runtime = new RuntimeAdapter({
      cwd: options.projectRoot,
      ...(config.modelCap ? { modelCap: config.modelCap } : {}),
      ...(config.effortCap ? { effortCap: config.effortCap } : {}),
      enableFallback: options.launchControls.fallbackEnabled ?? true,
    });
    const pipeline = new ScoringPipeline(
      runtime,
      telemetry.scoringAdapter,
      config,
      createPreviewCycleLogger(),
      options.projectRoot,
    );
    const scored = await pipeline.scoreWithFallback(backlog);
    const rankedItems = [...scored.withinBudget, ...scored.requiresApproval];

    return {
      candidateCount: backlog.length,
      rankedItems,
      totalEstimatedCostUsd: Number(scored.totalEstimatedCostUsd ?? 0),
      budgetOverflowUsd: Number(scored.budgetOverflowUsd ?? 0),
      withinBudget: scored.withinBudget.length,
      requiresApproval: scored.requiresApproval.length,
      summary: String(scored.summary ?? ''),
      warnings: Array.isArray(scored.warnings) ? scored.warnings : [],
      durationMs: Date.now() - startedAt,
      scoringCostUsd: 0,
      fallback: scored.fallback ?? null,
    };
  } finally {
    telemetry.close();
  }
}

async function runCycleListAction(opts: CycleListOptions): Promise<void> {
  const projectRoot = await resolveWorkspaceProjectRoot(opts);
  const limit = parseLimit(opts.limit, 20);
  if (limit === null) {
    process.exitCode = 1;
    return;
  }
  const stageFilter = parseCycleListStageFilter(opts.stage);
  if (stageFilter === null) {
    process.exitCode = 1;
    return;
  }

  const cycles = listCycles(projectRoot)
    .filter((cycle) => stageFilter === undefined || cycle.stage === stageFilter)
    .slice(0, limit);
  if (cycles.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({
        projectRoot,
        limit,
        ...(stageFilter !== undefined ? { stage: stageFilter } : {}),
        cycles: [],
      }, null, 2));
      return;
    }
    console.log(stageFilter === undefined
      ? '(no cycles recorded)'
      : `(no cycles matched --stage ${stageFilter})`);
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify({
      projectRoot,
      limit,
      ...(stageFilter !== undefined ? { stage: stageFilter } : {}),
      cycles,
    }, null, 2));
    return;
  }

  for (const cycle of cycles) {
    console.log(`${cycle.cycleId}  ${cycle.stage}`);
    console.log(`  started=${cycle.startedAt}${cycle.completedAt ? `  completed=${cycle.completedAt}` : ''}`);
    console.log(`  sprint=${cycle.sprintVersion ?? '(none)'}  cost=$${cycle.costUsd.toFixed(4)} / $${cycle.budgetUsd.toFixed(2)}`);
    console.log(`  tests=${cycle.testsPassed}/${cycle.testsTotal}  pr=${cycle.prUrl ?? '(none)'}`);
    if (cycle.hasApprovalPending) {
      console.log('  approval=pending');
    } else if (cycle.approvalDecision) {
      console.log(`  approval=${cycle.approvalDecision}`);
    }
    console.log('');
  }
}

function parseCycleListStageFilter(rawStage: string | undefined): string | null | undefined {
  if (rawStage === undefined) {
    return undefined;
  }
  const stage = rawStage.trim().toLowerCase();
  if (stage.length === 0) {
    console.error('Invalid value for --stage: expected non-empty stage name');
    return null;
  }
  if (!CYCLE_STAGE_FILTER_RE.test(stage)) {
    console.error(`Invalid value for --stage: ${rawStage}. Expected a stage token like completed, failed, verify, or custom-stage.`);
    return null;
  }
  return stage;
}

async function runCycleShowAction(cycleId: string, opts: CycleShowOptions): Promise<void> {
  const projectRoot = await resolveWorkspaceProjectRoot(opts);
  if (!SAFE_ID.test(cycleId)) {
    console.error(`Invalid cycle id: ${cycleId}`);
    process.exitCode = 1;
    return;
  }

  const cycleDir = join(projectRoot, '.agentforge', 'cycles', cycleId);
  if (!existsSync(cycleDir)) {
    console.error(`Cycle not found: ${cycleId}`);
    process.exitCode = 1;
    return;
  }

  const summary = summarizeCycle(cycleDir, cycleId);
  if (!summary) {
    console.error(`Cycle not found: ${cycleId}`);
    process.exitCode = 1;
    return;
  }

  const cycleJson = readJsonIfExists(join(cycleDir, 'cycle.json')) as Record<string, unknown> | null;
  const pendingApproval = readJsonIfExists(join(cycleDir, 'approval-pending.json')) as PendingApproval | null;
  const decision = readJsonIfExists(join(cycleDir, 'approval-decision.json')) as Record<string, unknown> | null;
  const scoring = readJsonIfExists(join(cycleDir, 'scoring.json')) as Record<string, unknown> | null;
  const eventsCount = countJsonlLines(join(cycleDir, 'events.jsonl'));
  const agentPr = latestCycleAgentPr(cycleDir);
  const runtimeRouting = readRuntimeRoutingSummary(cycleDir);

  if (opts.json) {
    console.log(JSON.stringify({
      projectRoot,
      cycleId: summary.cycleId,
      cycleDir,
      summary,
      pr: {
        url: summary.prUrl,
        agentPr: agentPr
          ? {
              prNumber: typeof agentPr.prNumber === 'number' ? agentPr.prNumber : null,
              prUrl: agentPr.prUrl ?? null,
              branch: agentPr.branch ?? null,
              status: agentPr.status ?? null,
              openedAt: agentPr.openedAt ?? null,
            }
          : null,
      },
      eventsCount,
      error: cycleJson && typeof cycleJson.error === 'string' ? cycleJson.error : null,
      scoring,
      runtimeRouting,
      pendingApproval,
      decision,
    }, null, 2));
    return;
  }

  console.log(`Cycle:        ${summary.cycleId}`);
  console.log(`Stage:        ${summary.stage}`);
  console.log(`Started:      ${summary.startedAt}`);
  if (summary.completedAt) {
    console.log(`Completed:    ${summary.completedAt}`);
  }
  console.log(`Sprint:       ${summary.sprintVersion ?? '(none)'}`);
  console.log(`Cost:         $${summary.costUsd.toFixed(4)} / $${summary.budgetUsd.toFixed(2)}`);
  console.log(`Tests:        ${summary.testsPassed}/${summary.testsTotal}`);
  console.log(`PR:           ${summary.prUrl ?? '(none)'}`);
  console.log(`Events:       ${eventsCount}`);

  if (summary.hasApprovalPending) {
    console.log('Approval:     pending');
  } else if (summary.approvalDecision) {
    console.log(`Approval:     ${summary.approvalDecision}`);
  }

  if (cycleJson && typeof cycleJson.error === 'string') {
    console.log(`Error:        ${cycleJson.error}`);
  }

  if (scoring) {
    const totalEstimatedCostUsd = typeof scoring.totalEstimatedCostUsd === 'number'
      ? scoring.totalEstimatedCostUsd
      : null;
    const summaryText = typeof scoring.summary === 'string' ? scoring.summary : null;
    if (totalEstimatedCostUsd !== null || summaryText) {
      console.log('');
      console.log('Scoring:');
      if (totalEstimatedCostUsd !== null) {
        console.log(`  estTotal=$${totalEstimatedCostUsd.toFixed(4)}`);
      }
      if (summaryText) {
        console.log(`  ${summaryText}`);
      }
    }
  }

  if (pendingApproval) {
    const withinBudgetItems = pendingApproval.withinBudget?.items ?? [];
    const overflowItems = pendingApproval.overflow?.items ?? [];
    console.log('');
    console.log('Pending approval:');
    console.log(`  withinBudget=${withinBudgetItems.length}  overflow=${overflowItems.length}`);
    if (pendingApproval.agentSummary) {
      console.log(`  ${pendingApproval.agentSummary}`);
    }
  }

  if (decision) {
    console.log('');
    console.log('Decision:');
    console.log(`  ${JSON.stringify(decision)}`);
  }
}

async function runCycleAssessPrAction(cycleId: string, opts: CycleAssessPrOptions): Promise<void> {
  const projectRoot = await resolveWorkspaceProjectRoot(opts);
  if (!SAFE_ID.test(cycleId)) {
    console.error(`Invalid cycle id: ${cycleId}`);
    process.exitCode = 1;
    return;
  }

  const cycleDir = join(projectRoot, '.agentforge', 'cycles', cycleId);
  if (!existsSync(cycleDir)) {
    console.error(`Cycle not found: ${cycleId}`);
    process.exitCode = 1;
    return;
  }

  const summary = summarizeCycle(cycleDir, cycleId);
  if (!summary) {
    console.error(`Cycle not found: ${cycleId}`);
    process.exitCode = 1;
    return;
  }

  const assessment = assessCyclePrMergeReadiness(cycleDir, summary);

  if (opts.json) {
    console.log(JSON.stringify({
      projectRoot,
      cycleId: summary.cycleId,
      cycleDir,
      assessment,
    }, null, 2));
    return;
  }

  console.log(`Cycle:        ${assessment.cycleId}`);
  console.log(`PR:           ${assessment.prUrl ?? '(none)'}`);
  console.log(`Merge ready:  ${assessment.mergeReady ? 'yes' : 'no'}`);
  console.log(`Verdict:      ${assessment.verdict}`);
  console.log('');
  console.log('Checks:');
  for (const check of assessment.checks) {
    console.log(`  ${check.status.toUpperCase()} ${check.id}: ${check.detail}`);
  }
  if (assessment.blockingReasons.length > 0) {
    console.log('');
    console.log('Blocking reasons:');
    for (const reason of assessment.blockingReasons) {
      console.log(`  - ${reason}`);
    }
  }
}

async function runCycleApproveAction(cycleId: string, opts: CycleApproveOptions): Promise<void> {
  const projectRoot = await resolveWorkspaceProjectRoot(opts);
  if (!SAFE_ID.test(cycleId)) {
    console.error(`Invalid cycle id: ${cycleId}`);
    process.exitCode = 1;
    return;
  }

  const cycleDir = join(projectRoot, '.agentforge', 'cycles', cycleId);
  const pendingFile = join(cycleDir, 'approval-pending.json');
  const decisionFile = join(cycleDir, 'approval-decision.json');

  if (!existsSync(pendingFile)) {
    console.error('No pending approval');
    process.exitCode = 1;
    return;
  }

  if (existsSync(decisionFile)) {
    console.error('Already decided');
    process.exitCode = 1;
    return;
  }

  let approvedItemIds: string[] = [];
  let rejectedItemIds: string[] = [];

  if (opts.all) {
    const pending = readJsonIfExists(pendingFile) as PendingApproval | null;
    approvedItemIds = (pending?.withinBudget?.items ?? []).map((item) => item.itemId);
    rejectedItemIds = (pending?.overflow?.items ?? []).map((item) => item.itemId);
  } else {
    approvedItemIds = opts.approved ?? [];
    rejectedItemIds = opts.rejected ?? [];
  }

  if (approvedItemIds.length === 0 && rejectedItemIds.length === 0) {
    console.error('No items provided. Use --all or pass --approved/--rejected.');
    process.exitCode = 1;
    return;
  }

  const decision = {
    cycleId,
    decision: approvedItemIds.length > 0 ? 'approved' : 'rejected',
    approvedItemIds,
    rejectedItemIds,
    decidedBy: opts.decidedBy ?? 'cli',
    decidedAt: new Date().toISOString(),
  };

  writeFileSync(decisionFile, JSON.stringify(decision, null, 2));
  console.log(`Wrote ${decisionFile}`);
  console.log(`Decision:     ${decision.decision}`);
  console.log(`Approved:     ${approvedItemIds.length}`);
  console.log(`Rejected:     ${rejectedItemIds.length}`);
}

async function runLoopGuardStatusAction(opts: LoopGuardStatusOptions): Promise<void> {
  const projectRoot = await resolveWorkspaceProjectRoot(opts);
  const statePath = join(projectRoot, '.agentforge', 'loop-state.json');
  const parsed = readLoopGuardStateForStatus(statePath);
  const state = parsed.state ?? localDefaultLoopGuardState();

  if (opts.json) {
    console.log(JSON.stringify({
      projectRoot,
      path: statePath,
      stateFileStatus: parsed.fileStatus,
      fileStatus: parsed.fileStatus,
      halted: Boolean(state.haltedReason),
      haltedReason: state.haltedReason ?? null,
      reason: state.haltedReason ?? null,
      failures: state.consecutiveFailedCycles,
      lastCycleId: state.lastCycleId,
      lastOutcome: state.lastOutcome,
      lastUpdatedAt: state.lastUpdatedAt,
      updatedAt: state.lastUpdatedAt,
    }, null, 2));
    return;
  }

  console.log('[loop-guard] status');
  console.log(`Path:         ${statePath}`);
  console.log(`State file:   ${parsed.fileStatus}`);
  console.log(`Halted:       ${state.haltedReason ? 'yes' : 'no'}`);
  if (state.haltedReason) {
    console.log(`Reason:       ${state.haltedReason}`);
  }
  console.log(`Failures:     ${state.consecutiveFailedCycles}`);
  console.log(`Last cycle:   ${state.lastCycleId ?? '(none)'}`);
  console.log(`Last outcome: ${state.lastOutcome ?? '(none)'}`);
  console.log(`Updated:      ${state.lastUpdatedAt}`);
}

async function runLoopGuardResetAction(opts: LoopGuardResetOptions): Promise<void> {
  const projectRoot = await resolveWorkspaceProjectRoot(opts);
  const statePath = join(projectRoot, '.agentforge', 'loop-state.json');
  const next = localDefaultLoopGuardState();
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(next, null, 2));

  if (opts.json) {
    console.log(JSON.stringify({
      projectRoot,
      path: statePath,
      state: next,
      reset: true,
    }, null, 2));
    return;
  }

  console.log('[loop-guard] reset');
  console.log(`Path:         ${statePath}`);
  console.log('State:        reset to defaults');
}

async function runCycleStreakStatusAction(opts: CycleStreakStatusOptions): Promise<void> {
  const projectRoot = await resolveWorkspaceProjectRoot(opts);
  const ledgerPath = join(projectRoot, '.agentforge', 'cycles', 'streak-ledger.json');
  const ledger = readCycleStreakLedger(ledgerPath);
  const entries = sortCycleStreakEntriesNewestFirst(ledger.entries);
  const consecutiveSuccesses = countConsecutiveSuccessesFromNewest(entries);
  const latestEntry = entries[0] ?? null;

  if (opts.json) {
    console.log(JSON.stringify({
      projectRoot,
      path: ledgerPath,
      totalEntries: entries.length,
      consecutiveSuccesses,
      latestEntry,
      entries,
    }, null, 2));
    return;
  }

  console.log('[cycle streak] status');
  console.log(`Path:         ${ledgerPath}`);
  console.log(`Entries:      ${entries.length}`);
  console.log(`Consecutive:  ${consecutiveSuccesses}`);
  if (!latestEntry) {
    console.log('Latest:       (none)');
    return;
  }

  console.log(`Latest:       ${latestEntry.cycleId}  pr=${latestEntry.prNumber}  result=${latestEntry.result}`);
  console.log(`Reason:       ${latestEntry.reason}`);
  console.log(`Recorded:     ${latestEntry.recordedAt}`);
}

async function runCycleStreakRecordAction(cycleId: string, opts: CycleStreakRecordOptions): Promise<void> {
  const projectRoot = await resolveWorkspaceProjectRoot(opts);
  if (!SAFE_ID.test(cycleId)) {
    console.error(`Invalid cycle id: ${cycleId}`);
    process.exitCode = 1;
    return;
  }

  const prNumber = parseRequiredPositiveInteger(opts.pr, '--pr');
  if (prNumber === null) {
    process.exitCode = 1;
    return;
  }

  const result = normalizeStreakResult(opts.result);
  if (result === null) {
    console.error(`Invalid --result value: ${opts.result ?? '(missing)'}. Expected success or failure.`);
    process.exitCode = 1;
    return;
  }

  const reason = normalizeRequiredText(opts.reason);
  if (reason === null) {
    console.error('Missing --reason value. Provide a non-empty reason.');
    process.exitCode = 1;
    return;
  }

  const ledgerPath = join(projectRoot, '.agentforge', 'cycles', 'streak-ledger.json');
  const now = new Date().toISOString();
  const mergeEvidence = readCycleStreakMergeEvidence(projectRoot, cycleId, prNumber);
  const nextEntry: CycleStreakEntry = {
    cycleId,
    prNumber,
    result,
    reason,
    recordedAt: now,
    ...(mergeEvidence ? { mergeEvidence } : {}),
  };

  const ledger = readCycleStreakLedger(ledgerPath);
  const index = ledger.entries.findIndex((entry) => entry.cycleId === cycleId);
  const action = index >= 0 ? 'updated' : 'recorded';
  if (index >= 0) {
    ledger.entries[index] = nextEntry;
  } else {
    ledger.entries.push(nextEntry);
  }

  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, `${JSON.stringify({ version: 1, entries: ledger.entries }, null, 2)}\n`, 'utf8');

  const sortedEntries = sortCycleStreakEntriesNewestFirst(ledger.entries);
  const consecutiveSuccesses = countConsecutiveSuccessesFromNewest(sortedEntries);
  if (opts.json) {
    console.log(JSON.stringify({
      projectRoot,
      path: ledgerPath,
      action,
      consecutiveSuccesses,
      entry: nextEntry,
    }, null, 2));
    return;
  }

  console.log(`[cycle streak] ${action}: ${cycleId}`);
  console.log(`Path:         ${ledgerPath}`);
  console.log(`PR:           ${prNumber}`);
  console.log(`Result:       ${result}`);
  console.log(`Reason:       ${reason}`);
  console.log(`Consecutive:  ${consecutiveSuccesses}`);
}

async function resolveWorkspaceProjectRoot(options: WorkspaceAwareOptions): Promise<string> {
  let cwd = options.projectRoot;
  try {
    if (options.workspace) {
      const ws = getWorkspace(options.workspace);
      if (!ws) {
        throw new Error(`unknown workspace: ${options.workspace}`);
      }
      cwd = ws.path;
      console.log(`[cycle] workspace=${ws.id} (${ws.path})`);
      return cwd;
    }

    const def = getDefaultWorkspace();
    if (def && options.projectRoot === process.cwd()) {
      cwd = def.path;
      console.log(`[cycle] workspace=${def.id} (default, ${def.path})`);
    }
  } catch (error) {
    if (options.workspace) {
      throw error;
    }
  }

  return resolve(cwd);
}

function buildCycleWorktreeRootDir(projectRoot: string): string {
  const resolvedRoot = resolve(projectRoot);
  const repoName = basename(resolvedRoot)
    .replace(/[^a-zA-Z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'workspace';
  const rootHash = createHash('sha256')
    .update(process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot)
    .digest('hex')
    .slice(0, 12);
  return join('..', '.agentforge-worktrees', `${repoName}-${rootHash}`);
}

function printCycleRunResult(
  result: CycleResult,
  logDir: string,
  cycleStage: typeof CycleStage,
): void {
  switch (result.stage) {
    case cycleStage.COMPLETED: {
      console.log('');
      console.log('[cycle] COMPLETED');
      const prUrl = result.pr.url ?? latestCycleAgentPr(logDir)?.prUrl ?? null;
      console.log(`  sprint:       v${result.sprintVersion}`);
      console.log(`  pr:           ${prUrl ?? '(none)'}`);
      console.log(
        `  cost:         $${result.cost.totalUsd.toFixed(4)} / $${result.cost.budgetUsd}`,
      );
      console.log(
        `  tests:        ${result.tests.passed}/${result.tests.total} passed (${(result.tests.passRate * 100).toFixed(1)}%)`,
      );
      console.log(`  logDir:       ${logDir}`);
      return;
    }
    case cycleStage.KILLED: {
      const trip = result.killSwitch;
      console.error('');
      console.error('[cycle] KILLED');
      console.error(`  reason:       ${trip?.reason ?? 'unknown'}`);
      console.error(`  detail:       ${trip?.detail ?? '(no detail)'}`);
      console.error(`  stageAtTrip:  ${trip?.stageAtTrip ?? 'unknown'}`);
      console.error(`  logDir:       ${logDir}`);
      process.exitCode = 2;
      return;
    }
    default: {
      console.error('');
      console.error(`[cycle] terminal stage: ${result.stage}`);
      console.error(`  logDir:       ${logDir}`);
      process.exitCode = 1;
    }
  }
}

function listCycles(projectRoot: string): CycleSummary[] {
  const cyclesDir = join(projectRoot, '.agentforge', 'cycles');
  if (!existsSync(cyclesDir)) {
    return [];
  }

  return readdirSync(cyclesDir)
    .filter((entry) => SAFE_ID.test(entry))
    .map((entry) => summarizeCycle(join(cyclesDir, entry), entry))
    .filter((value): value is CycleSummary => value !== null)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

function summarizeCycle(cycleDir: string, cycleId: string): CycleSummary | null {
  if (!existsSync(cycleDir)) {
    return null;
  }

  const cycleJson = readJsonIfExists(join(cycleDir, 'cycle.json')) as Record<string, unknown> | null;
  const pendingFile = join(cycleDir, 'approval-pending.json');
  const decisionFile = join(cycleDir, 'approval-decision.json');
  const hasApprovalPending = existsSync(pendingFile) && !existsSync(decisionFile);
  const approvalDecision = existsSync(decisionFile)
    ? ((readJsonIfExists(decisionFile) as { decision?: string } | null)?.decision ?? null)
    : null;

  const activeStage = inferActiveStage(cycleDir);
  if (cycleJson && !isHeartbeatOnlyCyclePayload(cycleJson)) {
    const cost = (cycleJson.cost ?? {}) as Record<string, unknown>;
    const tests = (cycleJson.tests ?? {}) as Record<string, unknown>;
    const pr = (cycleJson.pr ?? {}) as Record<string, unknown>;
    const agentPr = latestCycleAgentPr(cycleDir);
    const stage = typeof cycleJson.stage === 'string'
      ? cycleJson.stage
      : inferFallbackStage(cycleJson, activeStage);
    return {
      cycleId: (cycleJson.cycleId as string) ?? cycleId,
      sprintVersion: (cycleJson.sprintVersion as string) ?? null,
      stage,
      startedAt:
        (cycleJson.startedAt as string) ??
        safeStatDate(cycleDir) ??
        new Date(0).toISOString(),
      completedAt: (cycleJson.completedAt as string) ?? null,
      costUsd: Number(cost.totalUsd ?? 0),
      budgetUsd: Number(cost.budgetUsd ?? 200),
      testsPassed: Number(tests.passed ?? 0),
      testsTotal: Number(tests.total ?? 0),
      prUrl: typeof pr.url === 'string' && pr.url.length > 0
        ? pr.url
        : agentPr?.prUrl ?? null,
      hasApprovalPending,
      approvalDecision,
    };
  }

  return {
    cycleId: (cycleJson?.cycleId as string | undefined) ?? cycleId,
    sprintVersion: null,
    stage: activeStage ?? 'plan',
    startedAt: safeStatDate(cycleDir) ?? new Date(0).toISOString(),
    completedAt: null,
    costUsd: 0,
    budgetUsd: 200,
    testsPassed: 0,
    testsTotal: 0,
    prUrl: null,
    hasApprovalPending,
    approvalDecision,
  };
}

function latestCycleAgentPr(cycleDir: string): AgentPrLedgerEntry | null {
  const ledger = readJsonIfExists(join(cycleDir, 'agent-prs.json'));
  if (!Array.isArray(ledger)) return null;

  const entries = ledger
    .filter((entry): entry is AgentPrLedgerEntry => entry !== null && typeof entry === 'object')
    .filter((entry) => typeof entry.prUrl === 'string' && entry.prUrl.length > 0)
    .sort((left, right) => {
      const leftTime = typeof left.openedAt === 'string' ? left.openedAt : '';
      const rightTime = typeof right.openedAt === 'string' ? right.openedAt : '';
      return rightTime.localeCompare(leftTime);
    });

  return entries[0] ?? null;
}

function isHeartbeatOnlyCyclePayload(cycleJson: Record<string, unknown>): boolean {
  return Object.keys(cycleJson).every((key) => key === 'cycleId' || key === 'lastHeartbeatAt');
}

function inferFallbackStage(cycleJson: Record<string, unknown>, activeStage: string | null): string {
  if (hasTerminalCycleShape(cycleJson)) {
    return 'completed';
  }
  return activeStage ?? 'running';
}

function hasTerminalCycleShape(cycleJson: Record<string, unknown>): boolean {
  return (
    typeof cycleJson.completedAt === 'string' ||
    typeof cycleJson.durationMs === 'number' ||
    typeof cycleJson.tests === 'object' ||
    typeof cycleJson.git === 'object' ||
    typeof cycleJson.pr === 'object' ||
    typeof cycleJson.error === 'string' ||
    typeof cycleJson.gateVerdict === 'string'
  );
}

function inferActiveStage(cycleDir: string): string | null {
  const eventsPath = join(cycleDir, 'events.jsonl');
  if (!existsSync(eventsPath)) {
    return null;
  }

  let stage: string | null = null;
  try {
    for (const line of readFileSync(eventsPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      const type = typeof event.type === 'string' ? event.type : '';
      const phase = typeof event.phase === 'string' ? event.phase : null;
      if ((type === 'phase.start' || type === 'phase.result' || type === 'phase.failure') && phase) {
        stage = phase;
      } else if (type === 'cycle.complete' && typeof event.stage === 'string') {
        stage = event.stage;
      }
    }
  } catch {
    return stage;
  }

  return stage;
}

function safeStatDate(path: string): string | null {
  try {
    return statSync(path).birthtime.toISOString();
  } catch {
    return null;
  }
}

function readJsonIfExists(path: string): unknown | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function countJsonlLines(path: string): number {
  if (!existsSync(path)) {
    return 0;
  }

  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

function readRuntimeRoutingSummary(cycleDir: string): RuntimeRoutingSummary | null {
  const execute = readJsonIfExists(join(cycleDir, 'phases', 'execute.json')) as {
    itemResults?: Array<Record<string, unknown>>;
    agentRuns?: Array<Record<string, unknown>>;
  } | null;
  if (!execute) return null;

  const itemResults = Array.isArray(execute.itemResults) ? execute.itemResults : [];
  const agentRuns = Array.isArray(execute.agentRuns) ? execute.agentRuns : [];
  const runs = itemResults.length > 0 ? itemResults : agentRuns;
  if (runs.length === 0) return null;

  const decisionsByItemId = new Map<string, RuntimeRoutingDecision>();
  for (const run of runs) {
    const itemId = typeof run.itemId === 'string' ? run.itemId : null;
    if (!itemId || decisionsByItemId.has(itemId)) continue;

    const runtimeMode = typeof run.runtimeMode === 'string' && run.runtimeMode.length > 0
      ? run.runtimeMode
      : null;
    const preferredProvider = typeof run.preferredProvider === 'string' && run.preferredProvider.length > 0
      ? run.preferredProvider
      : null;
    decisionsByItemId.set(itemId, {
      itemId,
      decision: runtimeMode !== null || preferredProvider !== null ? 'routed' : 'default',
      runtimeMode,
      preferredProvider,
    });
  }

  const decisions = [...decisionsByItemId.values()];
  if (decisions.length === 0) return null;

  const routedItems = decisions.filter((entry) => entry.decision === 'routed').length;
  return {
    totalItems: decisions.length,
    routedItems,
    defaultItems: decisions.length - routedItems,
    decisions,
  };
}

function assessCyclePrMergeReadiness(cycleDir: string, summary: CycleSummary): PrMergeAssessment {
  const cycleJson = readJsonIfExists(join(cycleDir, 'cycle.json')) as Record<string, unknown> | null;
  const gateJson = readJsonIfExists(join(cycleDir, 'phases', 'gate.json')) as Record<string, unknown> | null;
  const reviewJson = readJsonIfExists(join(cycleDir, 'phases', 'review.json')) as Record<string, unknown> | null;
  const executeJson = readJsonIfExists(join(cycleDir, 'phases', 'execute.json')) as Record<string, unknown> | null;
  const gateVerdict = readGateVerdict(cycleJson, gateJson);
  const reviewFindingCounts = readReviewFindingCounts(reviewJson);
  const failedItems = countFailedExecuteItems(executeJson);
  const cycleError = cycleJson && typeof cycleJson.error === 'string' && cycleJson.error.trim().length > 0
    ? cycleJson.error.trim()
    : null;
  const tests = cycleJson && typeof cycleJson.tests === 'object' && cycleJson.tests !== null
    ? cycleJson.tests as Record<string, unknown>
    : null;
  const newFailures = tests && Array.isArray(tests.newFailures) ? tests.newFailures.length : 0;

  const checks: MergeReadinessCheck[] = [
    {
      id: 'cycle-completed',
      status: summary.stage === 'completed' ? 'pass' : 'fail',
      detail: summary.stage === 'completed'
        ? 'cycle stage is completed'
        : `cycle stage is ${summary.stage}`,
    },
    {
      id: 'pr-linked',
      status: summary.prUrl ? 'pass' : 'fail',
      detail: summary.prUrl ? 'cycle has an associated PR URL' : 'cycle has no associated PR URL',
    },
    {
      id: 'approval-state',
      status: summary.hasApprovalPending || summary.approvalDecision === 'rejected' ? 'fail' : 'pass',
      detail: summary.hasApprovalPending
        ? 'approval decision is still pending'
        : summary.approvalDecision === 'rejected'
          ? 'approval decision is rejected'
          : summary.approvalDecision
            ? `approval decision is ${summary.approvalDecision}`
            : 'no blocking approval decision detected',
    },
    {
      id: 'cycle-error',
      status: cycleError ? 'fail' : 'pass',
      detail: cycleError ? `cycle error recorded: ${cycleError}` : 'no cycle-level error recorded',
    },
    {
      id: 'gate-approved',
      status: gateVerdict === 'APPROVE' ? 'pass' : 'fail',
      detail: gateVerdict === 'APPROVE'
        ? 'gate verdict is APPROVE'
        : gateVerdict === 'REJECT'
          ? 'gate verdict is REJECT'
          : 'gate verdict is missing',
    },
    {
      id: 'review-findings',
      status: reviewFindingCounts.critical === 0 && reviewFindingCounts.major === 0 ? 'pass' : 'fail',
      detail: `review findings CRITICAL=${reviewFindingCounts.critical} MAJOR=${reviewFindingCounts.major}`,
    },
    {
      id: 'execute-failures',
      status: failedItems === 0 ? 'pass' : 'fail',
      detail: failedItems === 0 ? 'no failed execute items detected' : `failed execute items=${failedItems}`,
    },
    {
      id: 'tests',
      status: summary.testsTotal > 0 && summary.testsPassed === summary.testsTotal && newFailures === 0 ? 'pass' : 'fail',
      detail: `tests passed=${summary.testsPassed}/${summary.testsTotal} newFailures=${newFailures}`,
    },
  ];

  const blockingReasons = checks
    .filter((check) => check.status === 'fail')
    .map((check) => `${check.id}: ${check.detail}`);
  const mergeReady = blockingReasons.length === 0;

  return {
    cycleId: summary.cycleId,
    mergeReady,
    verdict: mergeReady ? 'ready' : 'blocked',
    prUrl: summary.prUrl,
    checks,
    blockingReasons,
    metrics: {
      gateVerdict,
      criticalFindings: reviewFindingCounts.critical,
      majorFindings: reviewFindingCounts.major,
      failedItems,
      testsPassed: summary.testsPassed,
      testsTotal: summary.testsTotal,
      newFailures,
    },
  };
}

function readGateVerdict(
  cycleJson: Record<string, unknown> | null,
  gateJson: Record<string, unknown> | null,
): 'APPROVE' | 'REJECT' | null {
  const fromCycle = cycleJson?.gateVerdict;
  if (fromCycle === 'APPROVE' || fromCycle === 'REJECT') {
    return fromCycle;
  }
  const fromGate = gateJson?.verdict;
  if (fromGate === 'APPROVE' || fromGate === 'REJECT') {
    return fromGate;
  }
  return null;
}

function readReviewFindingCounts(reviewJson: Record<string, unknown> | null): { critical: number; major: number } {
  const structuredSeverities = readStructuredReviewSeverities(reviewJson);
  const severities = structuredSeverities.length > 0
    ? structuredSeverities
    : readReviewSeveritiesFromResponses(reviewJson);
  return {
    critical: severities.filter((severity) => severity === 'CRITICAL').length,
    major: severities.filter((severity) => severity === 'MAJOR').length,
  };
}

function readStructuredReviewSeverities(reviewJson: Record<string, unknown> | null): Array<'CRITICAL' | 'MAJOR'> {
  if (!reviewJson) return [];

  const severities: Array<'CRITICAL' | 'MAJOR'> = [];
  const addFromFindings = (findings: unknown): void => {
    if (!Array.isArray(findings)) return;
    for (const finding of findings) {
      if (!finding || typeof finding !== 'object') continue;
      const severity = (finding as { severity?: unknown }).severity;
      if (severity === 'CRITICAL' || severity === 'MAJOR') {
        severities.push(severity);
      }
    }
  };

  addFromFindings(reviewJson.findings);
  const agentRuns = Array.isArray(reviewJson.agentRuns) ? reviewJson.agentRuns : [];
  for (const run of agentRuns) {
    if (!run || typeof run !== 'object') continue;
    addFromFindings((run as { findings?: unknown }).findings);
  }
  return severities;
}

function readReviewSeveritiesFromResponses(reviewJson: Record<string, unknown> | null): Array<'CRITICAL' | 'MAJOR'> {
  if (!reviewJson || !Array.isArray(reviewJson.agentRuns)) return [];

  const severities: Array<'CRITICAL' | 'MAJOR'> = [];
  for (const run of reviewJson.agentRuns) {
    if (!run || typeof run !== 'object') continue;
    const response = (run as { response?: unknown }).response;
    if (typeof response !== 'string') continue;
    for (const line of response.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = /^[-*>\s]*\[?(CRITICAL|MAJOR)\]?\s*:/i.exec(trimmed);
      if (match?.[1] === 'CRITICAL' || match?.[1] === 'MAJOR') {
        severities.push(match[1]);
      }
    }
  }
  return severities;
}

function countFailedExecuteItems(executeJson: Record<string, unknown> | null): number {
  if (!executeJson) return 0;

  const itemResults = Array.isArray(executeJson.itemResults) ? executeJson.itemResults : [];
  const agentRuns = Array.isArray(executeJson.agentRuns) ? executeJson.agentRuns : [];
  const runs = itemResults.length > 0 ? itemResults : agentRuns;
  if (runs.length === 0) return 0;

  const seenItemIds = new Set<string>();
  let failed = 0;
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    if (!run || typeof run !== 'object') continue;
    const itemId = typeof (run as { itemId?: unknown }).itemId === 'string'
      ? (run as { itemId: string }).itemId
      : null;
    const dedupeKey = itemId && itemId.length > 0 ? itemId : `index:${index}`;
    if (seenItemIds.has(dedupeKey)) continue;
    seenItemIds.add(dedupeKey);
    if ((run as { status?: unknown }).status === 'failed') {
      failed += 1;
    }
  }
  return failed;
}

function isIsoDateString(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function readLoopGuardStateForStatus(path: string): {
  fileStatus: 'valid' | 'missing' | 'corrupt';
  state: ReturnType<typeof localDefaultLoopGuardState> | null;
} {
  if (!existsSync(path)) {
    return { fileStatus: 'missing', state: null };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ReturnType<typeof localDefaultLoopGuardState>>;
    const consecutiveFailedCycles = parsed.consecutiveFailedCycles;
    const lastCycleId = parsed.lastCycleId;
    const lastOutcome = parsed.lastOutcome;
    const lastUpdatedAt = parsed.lastUpdatedAt;
    const haltedReason = parsed.haltedReason;
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.v === 1 &&
      Number.isInteger(consecutiveFailedCycles) &&
      consecutiveFailedCycles !== undefined &&
      consecutiveFailedCycles >= 0 &&
      (lastCycleId === null || typeof lastCycleId === 'string') &&
      (lastOutcome === null || lastOutcome === 'completed' || lastOutcome === 'failed') &&
      typeof lastUpdatedAt === 'string' &&
      isIsoDateString(lastUpdatedAt) &&
      (haltedReason === undefined || typeof haltedReason === 'string')
    ) {
      return {
        fileStatus: 'valid',
        state: {
          v: 1,
          consecutiveFailedCycles,
          lastCycleId,
          lastOutcome,
          lastUpdatedAt,
          ...(haltedReason !== undefined ? { haltedReason } : {}),
        },
      };
    }
  } catch {
    // fall through
  }
  return { fileStatus: 'corrupt', state: null };
}

function localDefaultLoopGuardState(): {
  v: 1;
  consecutiveFailedCycles: number;
  lastCycleId: string | null;
  lastOutcome: 'completed' | 'failed' | null;
  lastUpdatedAt: string;
  haltedReason?: string;
} {
  return {
    v: 1,
    consecutiveFailedCycles: 0,
    lastCycleId: null,
    lastOutcome: null,
    lastUpdatedAt: new Date(0).toISOString(),
  };
}

function parseOptionalPositiveNumber(raw: string | undefined, label: string): number | undefined | null {
  if (raw === undefined) return undefined;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`Invalid ${label} value: ${raw}`);
    return null;
  }
  return parsed;
}

function parseOptionalInteger(raw: string | undefined, label: string): number | undefined | null {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`Invalid ${label} value: ${raw}`);
    return null;
  }
  return parsed;
}

function resolveCycleLaunchControls(opts: {
  fastMode?: boolean;
  modelCap?: string;
  effortCap?: string;
  maxAgents?: string;
  fallback?: boolean;
}): CycleLaunchControls | null {
  const modelCapRaw = opts.modelCap ?? process.env['AUTONOMOUS_MODEL_CAP'];
  const modelCap = parseModelCap(modelCapRaw);
  if (modelCap === null) {
    console.error(`Invalid --model-cap value: ${modelCapRaw}. Expected opus, sonnet, or haiku.`);
    return null;
  }

  const fastMode = opts.fastMode === true;
  const effortCapRaw = opts.effortCap ?? process.env['AUTONOMOUS_EFFORT_CAP'];
  const effortCap = effortCapRaw === undefined && fastMode
    ? 'high'
    : parseEffortCap(effortCapRaw);
  if (effortCap === null) {
    console.error(`Invalid --effort-cap value: ${effortCapRaw}. Expected low, medium, high, xhigh, or max.`);
    return null;
  }

  const maxAgentsRaw = opts.maxAgents ?? process.env['AUTONOMOUS_MAX_AGENTS'];
  const maxAgents = parseOptionalPositiveIntegerStrict(maxAgentsRaw, '--max-agents');
  if (maxAgents === null) {
    return null;
  }

  const fallbackEnabled = opts.fallback !== undefined
    ? opts.fallback
    : parseEnvFallbackEnabled(process.env['AUTONOMOUS_FALLBACK_ENABLED']);

  return {
    fastMode,
    ...(modelCap ? { modelCap } : {}),
    ...(effortCap ? { effortCap } : {}),
    ...(maxAgents !== undefined ? { maxAgents } : {}),
    ...(fallbackEnabled !== undefined ? { fallbackEnabled } : {}),
  };
}

function applyCycleLaunchControls(
  config: CycleConfig,
  controls: CycleLaunchControls,
  logPrefix: string,
): void {
  if (controls.fastMode) {
    console.log(`${logPrefix} fast-mode enabled`);
  }
  if (controls.modelCap) {
    config.modelCap = controls.modelCap;
    console.log(`${logPrefix} modelCap override: ${controls.modelCap}`);
  }
  if (controls.effortCap) {
    config.effortCap = controls.effortCap;
    console.log(`${logPrefix} effortCap override: ${controls.effortCap}`);
  }
  if (controls.maxAgents !== undefined) {
    config.limits.maxExecutePhaseParallelism = controls.maxAgents;
    console.log(`${logPrefix} maxAgents override: ${controls.maxAgents}`);
  }
  if (controls.fallbackEnabled !== undefined) {
    config.fallbackEnabled = controls.fallbackEnabled;
    console.log(`${logPrefix} fallback ${controls.fallbackEnabled ? 'enabled' : 'disabled'}`);
  }
}

function parseModelCap(raw: string | undefined): ModelCap | undefined | null {
  if (raw === undefined || raw === '') return undefined;
  return raw === 'opus' || raw === 'sonnet' || raw === 'haiku' ? raw : null;
}

function parseEffortCap(raw: string | undefined): EffortCap | undefined | null {
  if (raw === undefined || raw === '') return undefined;
  return raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'xhigh' || raw === 'max' ? raw : null;
}

function parseOptionalPositiveIntegerStrict(raw: string | undefined, label: string): number | undefined | null {
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`Invalid ${label} value: ${raw}`);
    return null;
  }
  return parsed;
}

function parseEnvFallbackEnabled(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === '') return undefined;
  const normalized = raw.toLowerCase();
  if (normalized === 'false' || normalized === '0') return false;
  if (normalized === 'true' || normalized === '1') return true;
  return undefined;
}

function createPreviewCycleLogger(): CycleLoggerType {
  return {
    logScoring: (_result: unknown, _grounding: unknown) => {},
    logScoringFallback: (_strike: number, _reason: string) => {},
    logKillSwitch: (_trip: unknown) => {},
    logCycleResult: (_result: unknown) => {},
    logGitEvent: (_event: unknown) => {},
    logTestRun: (_result: unknown) => {},
    logPREvent: (_event: unknown) => {},
  } as CycleLoggerType;
}

function parseEnvPositiveNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseEnvPositiveInteger(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseLimit(raw: string, fallback: number): number | null {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`Invalid limit value: ${raw}`);
    return null;
  }
  return parsed ?? fallback;
}

function parseRequiredPositiveInteger(raw: string | undefined, label: string): number | null {
  if (raw === undefined || raw.trim().length === 0) {
    console.error(`Missing ${label} value.`);
    return null;
  }
  const value = raw.trim();
  if (!/^[1-9]\d*$/.test(value)) {
    console.error(`Invalid ${label} value: ${raw}`);
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    console.error(`Invalid ${label} value: ${raw}`);
    return null;
  }
  return parsed;
}

function normalizeRequiredText(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

function normalizeStreakResult(raw: string | undefined): 'success' | 'failure' | null {
  if (raw !== 'success' && raw !== 'failure') return null;
  return raw;
}

function readCycleStreakLedger(path: string): CycleStreakLedger {
  if (!existsSync(path)) return { version: 1, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const rawEntries = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { entries?: unknown } | null)?.entries)
        ? (parsed as { entries: unknown[] }).entries
        : [];
    const entries = rawEntries
      .map(normalizeCycleStreakEntry)
      .filter((entry): entry is CycleStreakEntry => entry !== null);
    return { version: 1, entries };
  } catch {
    return { version: 1, entries: [] };
  }
}

function normalizeCycleStreakEntry(value: unknown): CycleStreakEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const cycleId = typeof obj['cycleId'] === 'string' ? obj['cycleId'].trim() : '';
  if (!cycleId || !SAFE_ID.test(cycleId)) return null;

  const prNumber = typeof obj['prNumber'] === 'number' && Number.isInteger(obj['prNumber']) && obj['prNumber'] > 0
    ? obj['prNumber']
    : null;
  if (prNumber === null) return null;

  const result = obj['result'] === 'success' || obj['result'] === 'failure'
    ? obj['result']
    : null;
  if (result === null) return null;

  const reason = typeof obj['reason'] === 'string' && obj['reason'].trim().length > 0
    ? obj['reason'].trim()
    : null;
  if (reason === null) return null;

  const normalized: CycleStreakEntry = {
    cycleId,
    prNumber,
    result,
    reason,
    recordedAt: normalizeStreakRecordedAt(obj['recordedAt']),
  };

  if (obj['mergeEvidence'] && typeof obj['mergeEvidence'] === 'object' && !Array.isArray(obj['mergeEvidence'])) {
    const evidence = obj['mergeEvidence'] as Record<string, unknown>;
    const normalizedEvidence = {
      ...(typeof evidence['prUrl'] === 'string' && evidence['prUrl'].length > 0 ? { prUrl: evidence['prUrl'] } : {}),
      ...(typeof evidence['status'] === 'string' && evidence['status'].length > 0 ? { status: evidence['status'] } : {}),
      ...(typeof evidence['mergedAt'] === 'string' && evidence['mergedAt'].length > 0 ? { mergedAt: evidence['mergedAt'] } : {}),
      ...(typeof evidence['openedAt'] === 'string' && evidence['openedAt'].length > 0 ? { openedAt: evidence['openedAt'] } : {}),
    };
    if (Object.keys(normalizedEvidence).length > 0) {
      normalized.mergeEvidence = normalizedEvidence;
    }
  }

  return normalized;
}

function normalizeStreakRecordedAt(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      const timestamp = Date.parse(trimmed);
      if (Number.isFinite(timestamp)) {
        return new Date(timestamp).toISOString();
      }
    }
  }
  return new Date(0).toISOString();
}

function sortCycleStreakEntriesNewestFirst(entries: CycleStreakEntry[]): CycleStreakEntry[] {
  return [...entries].sort((left, right) => {
    const byDate = right.recordedAt.localeCompare(left.recordedAt);
    if (byDate !== 0) return byDate;
    return right.cycleId.localeCompare(left.cycleId);
  });
}

function countConsecutiveSuccessesFromNewest(entries: CycleStreakEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.result !== 'success') {
      break;
    }
    count += 1;
  }
  return count;
}

function readCycleStreakMergeEvidence(
  projectRoot: string,
  cycleId: string,
  prNumber: number,
): CycleStreakEntry['mergeEvidence'] | null {
  const cycleDir = join(projectRoot, '.agentforge', 'cycles', cycleId);
  const cycleJson = readJsonIfExists(join(cycleDir, 'cycle.json')) as Record<string, unknown> | null;
  const cyclePr = cycleJson && typeof cycleJson.pr === 'object' && cycleJson.pr !== null
    ? cycleJson.pr as Record<string, unknown>
    : null;

  const cyclePrNumber = typeof cyclePr?.number === 'number' ? cyclePr.number : null;
  if (cyclePr && cyclePrNumber === prNumber) {
    const evidence = {
      ...(typeof cyclePr.url === 'string' && cyclePr.url.length > 0 ? { prUrl: cyclePr.url } : {}),
      ...(typeof cyclePr.status === 'string' && cyclePr.status.length > 0 ? { status: cyclePr.status } : {}),
      ...(typeof cyclePr.mergedAt === 'string' && cyclePr.mergedAt.length > 0 ? { mergedAt: cyclePr.mergedAt } : {}),
      ...(typeof cyclePr.openedAt === 'string' && cyclePr.openedAt.length > 0 ? { openedAt: cyclePr.openedAt } : {}),
    };
    if (Object.keys(evidence).length > 0) return evidence;
  }

  const agentPr = latestCycleAgentPr(cycleDir);
  if (agentPr && agentPr.prNumber === prNumber) {
    const evidence = {
      ...(typeof agentPr.prUrl === 'string' && agentPr.prUrl.length > 0 ? { prUrl: agentPr.prUrl } : {}),
      ...(typeof agentPr.status === 'string' &&
        agentPr.status.length > 0 &&
        agentPr.status !== 'open'
        ? { status: agentPr.status }
        : {}),
      ...(typeof agentPr.openedAt === 'string' && agentPr.openedAt.length > 0 ? { openedAt: agentPr.openedAt } : {}),
    };
    if (Object.keys(evidence).length > 0) return evidence;
  }

  return null;
}


