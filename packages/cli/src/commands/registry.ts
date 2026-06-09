/**
 * Shared command registry for the AgentForge CLI.
 *
 * `registerAllCommands` is the SINGLE source of truth for every command that
 * the `agentforge` binary exposes.  Both `createCliProgram()` in bin.ts and
 * the cli-surface-parity test consume this function so the two surfaces cannot
 * silently diverge.
 *
 * Add new commands here (and only here) — never register commands directly on
 * the program inside bin.ts.
 */
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { migrateV4ToV5 } from './migrate.js';
import { printBuildInfo } from './build-info.js';
import { registerAutonomousCommand, registerCycleCommand } from './autonomous.js';
import { registerCostsCommand } from './costs.js';
import { registerRunCommand } from './run.js';
import { registerTeamCommand, registerTeamSessionsCommand } from './team.js';
import { registerWorkspacesCommand } from './workspaces.js';
import { registerDemoCommand } from './demo.js';
import { registerReplayCommand } from './replay.js';
import { registerSkillsCoverageCommand } from './skills-coverage.js';
import { registerSkillsCommand } from './skills.js';
import { registerCodexCommand } from './codex.js';
import { registerResearchCommand } from './research.js';
import { registerBacklogCommand } from './backlog.js';
import { registerLearningsCommand } from './learnings.js';
import { registerClaudeCommand } from './claude-setup.js';

interface InitializeWorkspaceImport {
  initializeWorkspace(options: {
    projectRoot?: string;
    dataDir?: string;
    workspaceName?: string;
    ownerId?: string;
  }): {
    projectRoot: string;
    dataDir: string;
    workspaceDbPath: string;
    workspace: { name: string; id: string };
    createdWorkspace: boolean;
  };
}

/**
 * Register every AgentForge CLI command on `program`.
 *
 * This function is called by `createCliProgram()` and is the canonical list of
 * commands for both the binary and any surface (e.g., Codex plugin) that
 * delegates to the binary.
 */
export function registerAllCommands(program: Command): void {
  program
    .command('init')
    .description('Initialize an AgentForge workspace')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--data-dir <path>', 'Workspace data directory')
    .option('--workspace-name <name>', 'Workspace name', 'default')
    .option('--owner <id>', 'Workspace owner id', 'system')
    .action(async (opts: {
      projectRoot: string;
      dataDir?: string;
      workspaceName: string;
      owner: string;
    }) => {
      try {
        const { initializeWorkspace } = await import('@agentforge/core') as unknown as InitializeWorkspaceImport;
        const result = initializeWorkspace({
          projectRoot: resolve(opts.projectRoot),
          ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
          workspaceName: opts.workspaceName,
          ownerId: opts.owner,
        });

        console.log('AgentForge workspace initialized');
        console.log(`  Project:      ${result.projectRoot}`);
        console.log(`  Data dir:     ${result.dataDir}`);
        console.log(`  Workspace:    ${result.workspace.name} (${result.workspace.id})`);
        console.log(`  Workspace DB: ${result.workspaceDbPath}`);
        console.log(`  Created:      ${result.createdWorkspace ? 'yes' : 'no'}`);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
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
      console.log(`Migrating v4 → v5: ${projectRoot} → ${targetPath}`);
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
  registerDemoCommand(program);
  registerReplayCommand(program);
  registerSkillsCoverageCommand(program);
  registerSkillsCommand(program);
  registerCodexCommand(program);
  registerResearchCommand(program);
  registerBacklogCommand(program);
  registerLearningsCommand(program);
  registerClaudeCommand(program);
}
