#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateV4ToV5 } from './commands/migrate.js';
import { printBuildInfo } from './commands/build-info.js';
import { registerAutonomousCommand, registerCycleCommand } from './commands/autonomous.js';
import { registerCostsCommand } from './commands/costs.js';
import { registerRunCommand } from './commands/run.js';
import { registerTeamCommand, registerTeamSessionsCommand } from './commands/team.js';
import { registerWorkspacesCommand } from './commands/workspaces.js';

const CLI_VERSION = readPackageVersion();
const program = new Command();
program
  .name('agentforge')
  .description('AgentForge package-canonical CLI (run/cost/cycle/workspaces are package-native; team generation/reforge run through package team services)')
  .version(CLI_VERSION);

program
  .command('init')
  .description('Initialize a new AgentForge workspace (placeholder)')
  .action(() => {
    console.log('AgentForge init — workspace creation remains in active development.');
  });

program
  .command('start')
  .description('Start the canonical package server')
  .option('-p, --port <port>', 'Port to listen on', '4750')
  .option('--host <host>', 'Host to bind to', '127.0.0.1')
  .option('--project-root <path>', 'Project root', process.cwd())
  .option('--data-dir <path>', 'Workspace data directory')
  .action(async (opts: {
    port: string;
    host: string;
    projectRoot: string;
    dataDir?: string;
  }) => {
    const port = Number.parseInt(opts.port, 10);
    if (!Number.isFinite(port) || port <= 0) {
      console.error(`Invalid port: ${opts.port}`);
      process.exitCode = 1;
      return;
    }

    try {
      const { startPackageServer } = await import('@agentforge/server');
      await startPackageServer({
        port,
        host: opts.host,
        projectRoot: opts.projectRoot,
        ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command('migrate')
  .description('Migrate v4 data to v5 SQLite format')
  .option('--project-root <path>', 'Project root', process.cwd())
  .option('--output <path>', 'Target SQLite database path', '.agentforge/v5/registry.db')
  .action(async (opts: { projectRoot: string; output: string }) => {
    const projectRoot = opts.projectRoot;
    const targetPath = join(projectRoot, opts.output);
    console.log(`Migrating v4 \u2192 v5: ${projectRoot} \u2192 ${targetPath}`);
    const report = await migrateV4ToV5(projectRoot, targetPath);
    console.log(`\nMigration complete:`);
    console.log(`  Agents migrated:   ${report.agentsMigrated}`);
    console.log(`  Sessions migrated: ${report.sessionsMigrated}`);
    console.log(`  Costs migrated:    ${report.costsMigrated}`);
    if (report.warnings.length > 0) {
      console.log(`\nWarnings:`);
      report.warnings.forEach(w => console.log(`  ! ${w}`));
    }
    if (report.errors.length > 0) {
      console.log(`\nErrors:`);
      report.errors.forEach(e => console.log(`  x ${e}`));
    }
    console.log(`\nStarted:   ${report.startedAt}`);
    console.log(`Completed: ${report.completedAt ?? 'unknown'}`);
  });

program
  .command('info')
  .description('Show package build info')
  .option('--project-root <path>', 'Project root', process.cwd())
  .action(async (opts: { projectRoot: string }) => {
    await printBuildInfo(opts.projectRoot);
  });

registerAutonomousCommand(program);
registerCycleCommand(program);
registerRunCommand(program);
registerCostsCommand(program);
registerTeamCommand(program);
registerTeamSessionsCommand(program);
registerWorkspacesCommand(program);

program.parse();

function readPackageVersion(): string {
  try {
    const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
    return packageJson.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
