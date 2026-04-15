// packages/cli/src/commands/autonomous.ts
//
// `agentforge autonomous:cycle` / `agentforge cycle run` — runs a full
// autonomous development cycle backed by canonical workspace telemetry.
//
// Exit codes:
//   0 — cycle reached COMPLETED (PR opened)
//   1 — unexpected error, or cycle ended in FAILED/other terminal stage
//   2 — kill switch trip (cycle ended in KILLED)
//
// NOTE on lazy imports: the autonomous module and AgentRuntime touch the
// Anthropic SDK and filesystem at module-load time. We lazy-import inside
// the action handler so the command can be registered even when the
// ANTHROPIC_API_KEY or downstream modules are unavailable. This keeps
// `agentforge --help` cheap and safe in all environments.
//
import type { Command } from 'commander';

interface CycleRunOptions {
  dryRun: boolean;
  projectRoot: string;
  workspace?: string;
}

export function registerCycleCommand(program: Command): void {
  const cycle = program
    .command('cycle')
    .description('Run and inspect autonomous development cycles');

  registerCycleRunCommand(cycle, 'run', 'Run one autonomous development cycle (PLAN -> REVIEW -> PR)');
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
  // v6.6.0 — workspace resolution order:
  //   1. --workspace <id> (explicit)
  //   2. registry default (if any workspaces registered)
  //   3. --project-root / process.cwd() (existing behavior)
  let cwd = opts.projectRoot;
  try {
    const { getWorkspace, getDefaultWorkspace } = await import('@agentforge/core');
    if (opts.workspace) {
      const ws = getWorkspace(opts.workspace);
      if (!ws) {
        console.error(`[autonomous:cycle] unknown workspace: ${opts.workspace}`);
        process.exit(1);
      }
      cwd = ws.path;
      console.log(`[autonomous:cycle] workspace=${ws.id} (${ws.path})`);
    } else {
      const def = getDefaultWorkspace();
      if (def && opts.projectRoot === process.cwd()) {
        // Only auto-use the default when the user did NOT pass an
        // explicit --project-root override.
        cwd = def.path;
        console.log(`[autonomous:cycle] workspace=${def.id} (default, ${def.path})`);
      }
    }
  } catch {
    // Registry unreadable — fall through to existing behavior.
  }
  try {
    // Lazy-import the autonomous module. This avoids loading the
    // Anthropic SDK, better-sqlite3, and the rest of the runtime stack
    // at CLI startup — the `--help` path must stay cheap.
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

    // ---- Real scoring runtime via RuntimeAdapter (v6.4.1) ----
    // RuntimeAdapter bridges the AgentRuntime class-per-agent interface
    // to the RuntimeForScoring service interface ScoringPipeline expects.
    // It lazily loads agent YAML from .agentforge/agents/{id}.yaml and
    // caches AgentRuntime instances per agentId. AgentRuntime itself
    // shells out to `claude -p` so this uses the logged-in Max/Pro plan
    // session, not ANTHROPIC_API_KEY.
    const runtime = new RuntimeAdapter({ cwd });

    const phaseHandlers = {
      // v6.5.2-A: real strategic phase handlers — researcher/cto/ceo/
      // data-analyst dispatches via RuntimeAdapter with read-only tools
      // (Read/Bash/Glob/Grep). They analyze and report; they don't
      // modify code (that's execute's job).
      audit: (ctx: any) => runAuditPhase(ctx),
      plan: (ctx: any) => runPlanPhase(ctx),
      assign: (ctx: any) => runAssignPhase(ctx),
      // v6.5.1: real execute phase — dispatches each sprint item to its
      // assignee agent via RuntimeAdapter (claude -p with Read/Write/Edit/
      // Bash/Glob/Grep tools enabled). The git stage picks up working-tree
      // changes after the phase completes.
      // v6.7.4: honor config.limits.maxExecutePhaseParallelism — without
      // this, runExecutePhase fell back to its internal default of 3,
      // which was the root cause of cycles running only 1-2 agents in
      // parallel even with maxConcurrentAgents: 20 in settings.yaml.
      execute: (ctx: any) => runExecutePhase(ctx, {
        maxParallelism: config.limits.maxExecutePhaseParallelism,
      }),
      // v6.5.2: real verification phases — test/review dispatch read-only
      // analysis agents (backend-qa, code-reviewer); release is a metadata
      // marker phase (no agent call).
      test: (ctx: any) => runTestPhase(ctx),
      review: (ctx: any) => runReviewPhase(ctx),
      gate: (ctx: any) => runGatePhase(ctx),
      release: (ctx: any) => runReleasePhase(ctx),
      learn: (ctx: any) => runLearnPhase(ctx),
    };

    // ---- Real exec adapters ----
    // CycleLogger is constructed inside CycleRunner; GitOps/TestRunner
    // need a logger too but the cycle logger isn't exposed. Passing
    // `null as any` is a temporary shim — Task 24 restructures this.
    const nullLogger = {
      logGitEvent: (_e: unknown) => {},
      logTestRun: (_r: unknown) => {},
      logPREvent: (_e: unknown) => {},
      logScoring: (_s: unknown, _g: unknown) => {},
      logScoringFallback: (_strike: number, _reason: string) => {},
      logKillSwitch: (_t: unknown) => {},
      logCycleResult: (_r: unknown) => {},
    } as unknown as import('@agentforge/core').CycleLogger;

    const testRunner = new RealTestRunner(cwd, config.testing, null);
    const gitOps = new GitOps(cwd, config.git, nullLogger);
    const prOpener = new PROpener(cwd);

    // ---- In-process event bus ----
    // Matches the shape CycleRunner/PhaseScheduler expect: topic-keyed
    // publish/subscribe returning an unsubscribe fn. The MessageBusV2
    // in core is heavier (envelope-based) so we use this lean version
    // which matches the cycle-runner.test.ts fixture exactly.
    const bus = (() => {
      const subs: Record<string, Array<(e: unknown) => void>> = {};
      return {
        publish: (topic: string, payload: unknown) => {
          const list = subs[topic] ?? [];
          for (const cb of list) cb(payload);
        },
        subscribe: (topic: string, cb: (e: unknown) => void) => {
          if (!subs[topic]) subs[topic] = [];
          subs[topic]!.push(cb);
          return () => {
            subs[topic] = (subs[topic] ?? []).filter((c) => c !== cb);
          };
        },
      };
    })();

    // ---- Construct and run ----
    try {
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
      console.log(`[autonomous:cycle] cycleId=${cycleId}`);
      console.log(`[autonomous:cycle] logDir=${logDir}`);
      if (opts.dryRun) console.log('[autonomous:cycle] dry-run mode: PR will not be opened');

      const result = await runner.start();

      switch (result.stage) {
        case CycleStage.COMPLETED: {
          console.log('');
          console.log('[autonomous:cycle] COMPLETED');
          console.log(`  sprint:       v${result.sprintVersion}`);
          console.log(`  pr:           ${result.pr.url ?? '(none)'}`);
          console.log(
            `  cost:         $${result.cost.totalUsd.toFixed(4)} / $${result.cost.budgetUsd}`,
          );
          console.log(
            `  tests:        ${result.tests.passed}/${result.tests.total} passed (${(result.tests.passRate * 100).toFixed(1)}%)`,
          );
          console.log(`  logDir:       ${logDir}`);
          process.exit(0);
          break;
        }
        case CycleStage.KILLED: {
          const trip = result.killSwitch;
          console.error('');
          console.error('[autonomous:cycle] KILLED');
          console.error(`  reason:       ${trip?.reason ?? 'unknown'}`);
          console.error(`  detail:       ${trip?.detail ?? '(no detail)'}`);
          console.error(`  stageAtTrip:  ${trip?.stageAtTrip ?? 'unknown'}`);
          console.error(`  logDir:       ${logDir}`);
          process.exit(2);
          break;
        }
        default: {
          console.error('');
          console.error(`[autonomous:cycle] terminal stage: ${result.stage}`);
          console.error(`  logDir:       ${logDir}`);
          process.exit(1);
        }
      }
    } finally {
      telemetry.close();
    }
  } catch (err) {
    const e = err as Error;
    console.error(`[autonomous:cycle] error: ${e.message}`);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  }
}
