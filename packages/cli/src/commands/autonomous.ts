// packages/cli/src/commands/autonomous.ts
//
// Canonical package CLI for autonomous cycle operations:
//   - run
//   - preview
//   - list
//   - show
//   - approve
//
// `autonomous:cycle` remains as a compatibility alias for `cycle run`.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';

interface WorkspaceAwareOptions {
  projectRoot: string;
  workspace?: string;
}

interface CycleRunOptions extends WorkspaceAwareOptions {
  dryRun: boolean;
}

interface CyclePreviewOptions extends WorkspaceAwareOptions {
  budgetUsd?: string;
  maxItems?: string;
}

interface CycleListOptions extends WorkspaceAwareOptions {
  limit: string;
}

interface CycleShowOptions extends WorkspaceAwareOptions {}

interface CycleApproveOptions extends WorkspaceAwareOptions {
  all?: boolean;
  approved?: string[];
  rejected?: string[];
  decidedBy?: string;
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

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

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
    .action(runCyclePreviewAction);

  cycle
    .command('list')
    .description('List autonomous cycles from .agentforge/cycles')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--workspace <id>', 'Run against a registered workspace from ~/.agentforge/workspaces.json')
    .option('--limit <count>', 'Maximum rows to show', '20')
    .action(runCycleListAction);

  cycle
    .command('show <cycleId>')
    .description('Show one autonomous cycle in detail')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--workspace <id>', 'Run against a registered workspace from ~/.agentforge/workspaces.json')
    .action(runCycleShowAction);

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
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--workspace <id>', 'Run against a registered workspace from ~/.agentforge/workspaces.json')
    .action(runCycleAction);
}

async function runCycleAction(opts: CycleRunOptions): Promise<void> {
  const cwd = await resolveWorkspaceProjectRoot(opts);

  try {
    const {
      loadCycleConfig,
      CycleRunner,
      CycleStage,
      createAutonomousTelemetryAdapters,
      RealTestRunner,
      GitOps,
      PROpener,
      RuntimeAdapter,
      runExecutePhase,
      runAuditPhase,
      runPlanPhase,
      runAssignPhase,
      runGatePhase,
      runLearnPhase,
      runTestPhase,
      runReviewPhase,
      runReleasePhase,
    } = await import('@agentforge/core');

    const config = loadCycleConfig(cwd);
    const telemetry = createAutonomousTelemetryAdapters(cwd);

    try {
      const runtime = new RuntimeAdapter({ cwd });
      const phaseHandlers = {
        audit: (ctx: any) => runAuditPhase(ctx),
        plan: (ctx: any) => runPlanPhase(ctx),
        assign: (ctx: any) => runAssignPhase(ctx),
        execute: (ctx: any) => runExecutePhase(ctx, {
          maxParallelism: config.limits.maxExecutePhaseParallelism,
        }),
        test: (ctx: any) => runTestPhase(ctx),
        review: (ctx: any) => runReviewPhase(ctx),
        gate: (ctx: any) => runGatePhase(ctx),
        release: (ctx: any) => runReleasePhase(ctx),
        learn: (ctx: any) => runLearnPhase(ctx),
      };

      const nullLogger = createNoopCycleLogger();
      const testRunner = new RealTestRunner(cwd, config.testing, null);
      const gitOps = new GitOps(cwd, config.git, nullLogger);
      const prOpener = new PROpener(cwd);
      const bus = createInProcessBus();

      const runner = new CycleRunner({
        cwd,
        config,
        runtime,
        proposalAdapter: telemetry.proposalAdapter,
        scoringAdapter: telemetry.scoringAdapter,
        phaseHandlers: phaseHandlers as unknown as Record<
          import('@agentforge/core').PhaseName,
          import('@agentforge/core').PhaseHandler
        >,
        testRunner,
        gitOps,
        prOpener,
        bus,
        ...(opts.dryRun ? { dryRun: { prOpener: true } } : {}),
      });

      const cycleId = runner.getCycleId();
      const logDir = `.agentforge/cycles/${cycleId}`;
      console.log(`[cycle] cycleId=${cycleId}`);
      console.log(`[cycle] logDir=${logDir}`);
      if (opts.dryRun) console.log('[cycle] dry-run mode: PR will not be opened');

      const result = await runner.start();
      printCycleRunResult(result, logDir, CycleStage);
    } finally {
      telemetry.close();
    }
  } catch (err) {
    const e = err as Error;
    console.error(`[cycle] error: ${e.message}`);
    if (e.stack) console.error(e.stack);
    process.exitCode = 1;
  }
}

async function runCyclePreviewAction(opts: CyclePreviewOptions): Promise<void> {
  const projectRoot = await resolveWorkspaceProjectRoot(opts);
  const budgetUsd = parseOptionalPositiveNumber(opts.budgetUsd, '--budget-usd');
  const maxItems = parseOptionalInteger(opts.maxItems, '--max-items');
  if (budgetUsd === null || maxItems === null) {
    process.exitCode = 1;
    return;
  }

  try {
    const { previewCycle } = await import('@agentforge/core');
    const preview = await previewCycle({
      projectRoot,
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
      ...(maxItems !== undefined ? { maxItems } : {}),
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

async function runCycleListAction(opts: CycleListOptions): Promise<void> {
  const projectRoot = await resolveWorkspaceProjectRoot(opts);
  const limit = parseLimit(opts.limit, 20);
  if (limit === null) {
    process.exitCode = 1;
    return;
  }

  const cycles = listCycles(projectRoot).slice(0, limit);
  if (cycles.length === 0) {
    console.log('(no cycles recorded)');
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

async function resolveWorkspaceProjectRoot(options: WorkspaceAwareOptions): Promise<string> {
  let cwd = options.projectRoot;
  try {
    const { getWorkspace, getDefaultWorkspace } = await import('@agentforge/core');
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

  return cwd;
}

function printCycleRunResult(
  result: import('@agentforge/core').CycleResult,
  logDir: string,
  cycleStage: typeof import('@agentforge/core').CycleStage,
): void {
  switch (result.stage) {
    case cycleStage.COMPLETED: {
      console.log('');
      console.log('[cycle] COMPLETED');
      console.log(`  sprint:       v${result.sprintVersion}`);
      console.log(`  pr:           ${result.pr.url ?? '(none)'}`);
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

  if (cycleJson) {
    const cost = (cycleJson.cost ?? {}) as Record<string, unknown>;
    const tests = (cycleJson.tests ?? {}) as Record<string, unknown>;
    const pr = (cycleJson.pr ?? {}) as Record<string, unknown>;
    return {
      cycleId: (cycleJson.cycleId as string) ?? cycleId,
      sprintVersion: (cycleJson.sprintVersion as string) ?? null,
      stage: (cycleJson.stage as string) ?? 'completed',
      startedAt:
        (cycleJson.startedAt as string) ??
        safeStatDate(cycleDir) ??
        new Date(0).toISOString(),
      completedAt: (cycleJson.completedAt as string) ?? null,
      costUsd: Number(cost.totalUsd ?? 0),
      budgetUsd: Number(cost.budgetUsd ?? 200),
      testsPassed: Number(tests.passed ?? 0),
      testsTotal: Number(tests.total ?? 0),
      prUrl: (pr.url as string) ?? null,
      hasApprovalPending,
      approvalDecision,
    };
  }

  return {
    cycleId,
    sprintVersion: null,
    stage: 'running',
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

function parseLimit(raw: string, fallback: number): number | null {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`Invalid limit value: ${raw}`);
    return null;
  }
  return parsed ?? fallback;
}

function createNoopCycleLogger(): import('@agentforge/core').CycleLogger {
  return {
    logGitEvent: (_event: unknown) => {},
    logTestRun: (_result: unknown) => {},
    logPREvent: (_event: unknown) => {},
    logScoring: (_result: unknown, _grounding: unknown) => {},
    logScoringFallback: (_strike: number, _reason: string) => {},
    logKillSwitch: (_trip: unknown) => {},
    logCycleResult: (_result: unknown) => {},
  } as import('@agentforge/core').CycleLogger;
}

function createInProcessBus() {
  const subs: Record<string, Array<(event: unknown) => void>> = {};
  return {
    publish: (topic: string, payload: unknown) => {
      const list = subs[topic] ?? [];
      for (const cb of list) cb(payload);
    },
    subscribe: (topic: string, cb: (event: unknown) => void) => {
      if (!subs[topic]) subs[topic] = [];
      subs[topic]!.push(cb);
      return () => {
        subs[topic] = (subs[topic] ?? []).filter((current) => current !== cb);
      };
    },
  };
}
