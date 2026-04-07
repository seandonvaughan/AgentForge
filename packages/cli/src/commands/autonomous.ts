// packages/cli/src/commands/autonomous.ts
//
// `agentforge autonomous:cycle` — wires the CycleRunner to real adapters
// and runs a full autonomous development cycle.
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
// NOTE on adapter stubs: Task 23 (this file) ships with minimal stubs
// that return empty arrays/objects. Full integration with WorkspaceAdapter
// and the AgentRuntime is landing in Task 24. The empty backlog will
// cause ProposalToBacklog.build() to return [] and CycleRunner to throw
// "No backlog items to work on" — that surfaces as exit 1 and is exactly
// the behavior we want for the smoke test.
//
// See docs/superpowers/plans/2026-04-06-autonomous-loop-part2.md Task 23
// and packages/core/src/autonomous/cycle-runner.ts.

import type { Command } from 'commander';

export function registerAutonomousCommand(program: Command): void {
  program
    .command('autonomous:cycle')
    .description('Run one autonomous development cycle (PLAN → REVIEW → PR)')
    .option('--dry-run', 'Do not actually open the PR; still runs all other stages', false)
    .option('--project-root <path>', 'Project root', process.cwd())
    .action(async (opts: { dryRun: boolean; projectRoot: string }) => {
      const cwd = opts.projectRoot;
      try {
        // Lazy-import the autonomous module. This avoids loading the
        // Anthropic SDK, better-sqlite3, and the rest of the runtime stack
        // at CLI startup — the `--help` path must stay cheap.
        const {
          loadCycleConfig,
          CycleRunner,
          CycleStage,
          RealTestRunner,
          GitOps,
          PROpener,
          RuntimeAdapter,
        } = await import('@agentforge/core');

        const config = loadCycleConfig(cwd);

        // ---- Proposal adapter (Task 24 will wire to WorkspaceAdapter) ----
        // Minimal stub: returns empty arrays so the backlog is empty. The
        // CycleRunner will throw "No backlog items" and we'll exit 1 — that
        // is the expected smoke-test behavior until Task 24 lands the real
        // signal sources.
        const proposalAdapter = {
          getRecentFailedSessions: async (_days: number) => [],
          getCostAnomalies: async (_days: number) => [],
          getFailedTaskOutcomes: async (_days: number) => [],
          getFlakingTests: async (_days: number) => [],
        };

        // ---- Scoring adapter (Task 24 will wire to WorkspaceAdapter) ----
        const scoringAdapter = {
          getSprintHistory: async (_limit: number) => [],
          getCostMedians: async () => ({}),
          getTeamState: async () => ({ utilization: {} }),
        };

        // ---- Real scoring runtime via RuntimeAdapter (v6.4.1) ----
        // RuntimeAdapter bridges the AgentRuntime class-per-agent interface
        // to the RuntimeForScoring service interface ScoringPipeline expects.
        // It lazily loads agent YAML from .agentforge/agents/{id}.yaml and
        // caches AgentRuntime instances per agentId. AgentRuntime itself
        // shells out to `claude -p` so this uses the logged-in Max/Pro plan
        // session, not ANTHROPIC_API_KEY.
        const runtime = new RuntimeAdapter({ cwd });

        // ---- Phase handlers (Task 24 will wire real 9-phase implementations) ----
        // For Task 23 the handlers simply publish the `sprint.phase.completed`
        // event so the PhaseScheduler can advance through the sequence. This
        // mirrors the unit-test mock shape and means the command is runnable
        // end-to-end once the backlog is non-empty.
        const makeStubPhaseHandler = (phase: string) =>
          async (ctx: {
            sprintId: string;
            cycleId?: string;
            bus: { publish: (topic: string, payload: unknown) => void };
          }) => {
            ctx.bus.publish('sprint.phase.completed', {
              sprintId: ctx.sprintId,
              phase,
              cycleId: ctx.cycleId,
              result: {
                phase,
                status: 'completed',
                durationMs: 0,
                costUsd: 0,
                agentRuns: [],
              },
              completedAt: new Date().toISOString(),
            });
          };

        const phaseHandlers = {
          audit: makeStubPhaseHandler('audit'),
          plan: makeStubPhaseHandler('plan'),
          assign: makeStubPhaseHandler('assign'),
          execute: makeStubPhaseHandler('execute'),
          test: makeStubPhaseHandler('test'),
          review: makeStubPhaseHandler('review'),
          gate: makeStubPhaseHandler('gate'),
          release: makeStubPhaseHandler('release'),
          learn: makeStubPhaseHandler('learn'),
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
        const runner = new CycleRunner({
          cwd,
          config,
          runtime,
          proposalAdapter: proposalAdapter as unknown as import('@agentforge/core').ProposalAdapter,
          scoringAdapter: scoringAdapter as unknown as import('@agentforge/core').AdapterForScoring,
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
      } catch (err) {
        const e = err as Error;
        console.error(`[autonomous:cycle] error: ${e.message}`);
        if (e.stack) console.error(e.stack);
        process.exit(1);
      }
    });
}
