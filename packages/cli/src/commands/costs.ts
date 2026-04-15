import type { Command } from 'commander';

export function registerCostsCommand(program: Command): void {
  const costs = program
    .command('costs')
    .description('Inspect package-runtime cost and usage data');

  registerCostReportCommand(
    costs.command('report').description('Show package-runtime cost totals and breakdowns'),
    { compatibilityAlias: false },
  );

  registerCostReportCommand(
    program.command('cost-report').description('Compatibility alias for costs report'),
    { compatibilityAlias: true },
  );
}

function registerCostReportCommand(
  command: Command,
  options: { compatibilityAlias: boolean },
): void {
  command
    .option('--project-root <path>', 'Project root', process.cwd())
    .action(async (commandOptions: { projectRoot: string }) => {
      if (options.compatibilityAlias) {
        console.warn('[compat] `cost-report` is a compatibility alias. Prefer `costs report`.');
      }

      try {
        const { generateCostReport } = await import('@agentforge/core');
        const report = await generateCostReport(commandOptions.projectRoot);

        if (report.source === 'empty') {
          console.log('No package-runtime sessions recorded yet.');
          console.log('');
          console.log('Pricing reference:');
          for (const [model, pricing] of Object.entries(report.pricingReference)) {
            console.log(`  ${model}: input $${pricing.input.toFixed(2)} / 1M, output $${pricing.output.toFixed(2)} / 1M`);
          }
          return;
        }

        console.log('AgentForge Cost Report');
        console.log(`Source:       ${report.source}`);
        console.log(`Sessions:     ${report.sessionsRecorded}`);
        console.log(`Agent runs:   ${report.totalAgentRuns}`);
        console.log(`Total spend:  $${report.totalSpentUsd.toFixed(4)}`);

        if (report.perAgent.length > 0) {
          console.log('');
          console.log('Per-agent:');
          for (const agent of report.perAgent) {
            console.log(`  ${agent.label}: $${agent.totalUsd.toFixed(4)} across ${agent.runs} run(s)`);
          }
        }

        if (report.perModel.length > 0) {
          console.log('');
          console.log('Per-model:');
          for (const model of report.perModel) {
            console.log(`  ${model.label}: $${model.totalUsd.toFixed(4)} across ${model.runs} run(s)`);
          }
        }

        if (report.lastSession) {
          console.log('');
          console.log('Last session:');
          console.log(`  ${report.lastSession.sessionId}`);
          console.log(`  status=${report.lastSession.status}  cost=$${report.lastSession.costUsd.toFixed(4)}`);
          console.log(`  started=${report.lastSession.startedAt}`);
          if (report.lastSession.completedAt) {
            console.log(`  completed=${report.lastSession.completedAt}`);
          }
          if (report.lastSession.providerKind || report.lastSession.runtimeModeResolved) {
            console.log(`  runtime=${report.lastSession.runtimeModeResolved ?? 'auto'} via ${report.lastSession.providerKind ?? 'unknown transport'}`);
          }
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
