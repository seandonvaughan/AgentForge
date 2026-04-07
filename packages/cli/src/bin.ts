#!/usr/bin/env node
import { Command } from 'commander';
import { join } from 'node:path';
import { migrateV4ToV5 } from './commands/migrate.js';
import { printBuildInfo } from './commands/build-info.js';
import { registerAutonomousCommand } from './commands/autonomous.js';

const program = new Command();
program
  .name('agentforge')
  .description('AgentForge v5 — Autonomous Agent Platform')
  .version('5.0.0');

program
  .command('init')
  .description('Initialize a new AgentForge workspace')
  .action(() => {
    console.log('AgentForge v5 init — workspace creation coming in v5.0 P0-3');
  });

program
  .command('start')
  .description('Start the AgentForge server')
  .option('-p, --port <port>', 'Port to listen on', '4750')
  .option('--host <host>', 'Host to bind to', '127.0.0.1')
  .action((opts: { port: string; host: string }) => {
    console.log(`Starting AgentForge v5 server on ${opts.host}:${opts.port}...`);
    console.log('Run: node packages/server/dist/index.js');
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
  .description('Show v5 monorepo build info')
  .option('--project-root <path>', 'Project root', process.cwd())
  .action(async (opts: { projectRoot: string }) => {
    await printBuildInfo(opts.projectRoot);
  });

registerAutonomousCommand(program);

program.parse();
