import { Command } from 'commander';
import { buildCodexReadinessReport } from '@agentforge/core';

interface ReadinessOptions {
  projectRoot: string;
  json?: boolean;
  skipLogin?: boolean;
  skipDoctor?: boolean;
}

export function registerCodexCommand(program: Command): void {
  const codex = program
    .command('codex')
    .description('Inspect AgentForge Codex runtime readiness');

  codex
    .command('readiness')
    .description('Verify generated agents resolve to Codex model and effort profiles')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--json', 'Print machine-readable JSON')
    .option('--skip-login', 'Skip codex login status check')
    .option('--skip-doctor', 'Skip codex doctor check')
    .action((options: ReadinessOptions) => {
      const report = buildCodexReadinessReport({
        projectRoot: options.projectRoot,
        checkLogin: options.skipLogin ? false : true,
        checkDoctor: options.skipDoctor ? false : true,
      });

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`Project:           ${report.projectRoot}`);
        console.log(`Codex CLI:         ${report.codexCliAvailable ? 'available' : 'missing'}`);
        console.log(`MCP server:        ${report.mcpServerAvailable ? 'built' : 'missing'}`);
        console.log(`Codex login:       ${formatLogin(report)}`);
        console.log(`Agents checked:    ${report.agents.length}`);
        console.log('');
        console.log('Model profile:');
        for (const agent of report.agents) {
          console.log(
            `  ${agent.agentId.padEnd(28)} ${agent.tier.padEnd(6)} -> ${agent.codexModel} / ${agent.codexEffort}`,
          );
        }
        if (report.warnings.length > 0) {
          console.log('');
          console.log('Warnings:');
          for (const warning of report.warnings) {
            console.log(`  - ${warning}`);
          }
        }
        console.log('');
        console.log(`Ready:             ${report.ready ? 'yes' : 'no'}`);
      }

      if (!report.ready) {
        process.exitCode = 1;
      }
    });
}

function formatLogin(report: { codexLoginChecked: boolean; codexLoginOk: boolean | null }): string {
  if (!report.codexLoginChecked) return 'skipped';
  return report.codexLoginOk ? 'ok' : 'failed';
}
