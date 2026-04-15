import type { Command } from 'commander';

interface TeamShowOptions {
  projectRoot: string;
  verbose?: boolean;
}

interface TeamForgeOptions {
  projectRoot: string;
  dryRun?: boolean;
  verbose?: boolean;
  domains?: string;
}

interface TeamGenesisOptions {
  projectRoot: string;
  interview?: boolean;
  domains?: string;
  yes?: boolean;
}

interface TeamRebuildOptions {
  projectRoot: string;
  autoApply?: boolean;
  upgrade?: boolean;
}

interface ReforgeApplyOptions {
  projectRoot: string;
  yes?: boolean;
}

interface TeamSessionsOptions {
  projectRoot: string;
}

export function registerTeamCommand(program: Command): void {
  const team = program
    .command('team')
    .description('Inspect and update AgentForge teams through package-core services')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--verbose', 'Show detailed agent info')
    .action(teamShowAction);

  team
    .command('forge')
    .description('Analyze project and generate optimized agent team')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--dry-run', 'Show what would be generated without writing files')
    .option('--verbose', 'Show detailed analysis output')
    .option('--domains <domains>', 'Comma-separated list of domains to activate')
    .action(teamForgeAction);

  team
    .command('genesis')
    .description('Start from an idea and build an optimized agent team')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--interview', 'Force interview mode even if project files exist')
    .option('--domains <domains>', 'Comma-separated list of domains to activate')
    .option('--yes', 'Skip approval gate')
    .action(teamGenesisAction);

  team
    .command('rebuild')
    .description('Re-scan project and update agent team')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--auto-apply', 'Apply changes without review')
    .option('--upgrade', 'Migrate v1 team to v2 format without full rebuild')
    .action(teamRebuildAction);

  const reforge = team
    .command('reforge')
    .description('Manage team reforge proposals and runtime overrides');

  reforge
    .command('apply <proposalId>')
    .description('Review and apply a structural reforge proposal')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--yes', 'Apply without confirmation prompt')
    .action(teamReforgeApplyAction);

  reforge
    .command('list')
    .description('List pending proposals and active overrides')
    .option('--project-root <path>', 'Project root', process.cwd())
    .action(teamReforgeListAction);

  reforge
    .command('rollback <agent>')
    .description('Rollback an agent override to its previous version')
    .option('--project-root <path>', 'Project root', process.cwd())
    .action(teamReforgeRollbackAction);

  reforge
    .command('status')
    .description('Show reforge override status for all agents')
    .option('--project-root <path>', 'Project root', process.cwd())
    .action(teamReforgeStatusAction);

  program
    .command('forge')
    .description('Compatibility alias for team forge')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--dry-run', 'Show what would be generated without writing files')
    .option('--verbose', 'Show detailed analysis output')
    .option('--domains <domains>', 'Comma-separated list of domains to activate')
    .action(async (options: TeamForgeOptions, command: Command) => {
      console.warn('[compat] `forge` top-level form is a compatibility alias. Prefer `team forge`.');
      await teamForgeAction(options, command);
    });

  program
    .command('genesis')
    .description('Compatibility alias for team genesis')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--interview', 'Force interview mode even if project files exist')
    .option('--domains <domains>', 'Comma-separated list of domains to activate')
    .option('--yes', 'Skip approval gate')
    .action(async (options: TeamGenesisOptions, command: Command) => {
      console.warn('[compat] `genesis` top-level form is a compatibility alias. Prefer `team genesis`.');
      await teamGenesisAction(options, command);
    });

  program
    .command('rebuild')
    .description('Compatibility alias for team rebuild')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--auto-apply', 'Apply changes without review')
    .option('--upgrade', 'Migrate v1 team to v2 format without full rebuild')
    .action(async (options: TeamRebuildOptions, command: Command) => {
      console.warn('[compat] `rebuild` top-level form is a compatibility alias. Prefer `team rebuild`.');
      await teamRebuildAction(options, command);
    });

  const reforgeAlias = program
    .command('reforge')
    .description('Compatibility alias for team reforge');

  reforgeAlias
    .command('apply <proposalId>')
    .description('Compatibility alias for team reforge apply')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--yes', 'Apply without confirmation prompt')
    .action(async (proposalId: string, options: ReforgeApplyOptions, command: Command) => {
      console.warn('[compat] `reforge apply` top-level form is a compatibility alias. Prefer `team reforge apply`.');
      await teamReforgeApplyAction(proposalId, options, command);
    });

  reforgeAlias
    .command('list')
    .description('Compatibility alias for team reforge list')
    .option('--project-root <path>', 'Project root', process.cwd())
    .action(async (options: TeamSessionsOptions, command: Command) => {
      console.warn('[compat] `reforge list` top-level form is a compatibility alias. Prefer `team reforge list`.');
      await teamReforgeListAction(options, command);
    });

  reforgeAlias
    .command('rollback <agent>')
    .description('Compatibility alias for team reforge rollback')
    .option('--project-root <path>', 'Project root', process.cwd())
    .action(async (agent: string, options: TeamSessionsOptions, command: Command) => {
      console.warn('[compat] `reforge rollback` top-level form is a compatibility alias. Prefer `team reforge rollback`.');
      await teamReforgeRollbackAction(agent, options, command);
    });

  reforgeAlias
    .command('status')
    .description('Compatibility alias for team reforge status')
    .option('--project-root <path>', 'Project root', process.cwd())
    .action(async (options: TeamSessionsOptions, command: Command) => {
      console.warn('[compat] `reforge status` top-level form is a compatibility alias. Prefer `team reforge status`.');
      await teamReforgeStatusAction(options, command);
    });
}

export function registerTeamSessionsCommand(program: Command): void {
  const teamSessions = program
    .command('team-sessions')
    .description('Manage hibernated team sessions');

  teamSessions
    .command('list')
    .description('List all hibernated sessions')
    .option('--project-root <path>', 'Project root', process.cwd())
    .action(teamSessionsListAction);

  teamSessions
    .command('delete <sessionId>')
    .description('Delete a hibernated session by ID')
    .option('--project-root <path>', 'Project root', process.cwd())
    .action(teamSessionsDeleteAction);

  const sessionsAlias = program
    .command('sessions')
    .description('Compatibility alias for team-sessions');

  sessionsAlias
    .command('list')
    .description('Compatibility alias for team-sessions list')
    .option('--project-root <path>', 'Project root', process.cwd())
    .action(async (options: TeamSessionsOptions, command: Command) => {
      console.warn('[compat] `sessions list` is a compatibility alias. Prefer `team-sessions list`.');
      await teamSessionsListAction(options, command);
    });

  sessionsAlias
    .command('delete <sessionId>')
    .description('Compatibility alias for team-sessions delete')
    .option('--project-root <path>', 'Project root', process.cwd())
    .action(async (sessionId: string, options: TeamSessionsOptions, command: Command) => {
      console.warn('[compat] `sessions delete` is a compatibility alias. Prefer `team-sessions delete`.');
      await teamSessionsDeleteAction(sessionId, options, command);
    });
}

async function teamShowAction(options: TeamShowOptions, command: Command): Promise<void> {
  try {
    const { showGeneratedTeam } = await import('@agentforge/core');
    const exitCode = await showGeneratedTeam(
      resolveProjectRoot(options.projectRoot, command),
      typeof options.verbose === 'boolean' ? { verbose: options.verbose } : {},
    );
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function teamForgeAction(options: TeamForgeOptions, command: Command): Promise<void> {
  try {
    const { forgeTeamService } = await import('@agentforge/core');
    const exitCode = await forgeTeamService(
      resolveProjectRoot(options.projectRoot, command),
      {
        ...(options.dryRun ? { dryRun: true } : {}),
        ...(options.verbose ? { verbose: true } : {}),
        ...(typeof options.domains === 'string' && options.domains.length > 0
          ? { domains: options.domains }
          : {}),
      },
    );
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function teamGenesisAction(
  options: TeamGenesisOptions,
  command: Command,
): Promise<void> {
  try {
    const { genesisTeamService } = await import('@agentforge/core');
    const exitCode = await genesisTeamService(
      resolveProjectRoot(options.projectRoot, command),
      {
        ...(options.interview ? { interview: true } : {}),
        ...(options.yes ? { yes: true } : {}),
        ...(typeof options.domains === 'string' && options.domains.length > 0
          ? { domains: options.domains }
          : {}),
      },
    );
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function teamRebuildAction(
  options: TeamRebuildOptions,
  command: Command,
): Promise<void> {
  try {
    const { rebuildTeamService } = await import('@agentforge/core');
    const exitCode = await rebuildTeamService(
      resolveProjectRoot(options.projectRoot, command),
      {
        ...(options.autoApply ? { autoApply: true } : {}),
        ...(options.upgrade ? { upgrade: true } : {}),
      },
    );
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function teamReforgeApplyAction(
  proposalId: string,
  options: ReforgeApplyOptions,
  command: Command,
): Promise<void> {
  try {
    const { applyReforgeProposalService } = await import('@agentforge/core');
    const exitCode = await applyReforgeProposalService(
      resolveProjectRoot(options.projectRoot, command),
      proposalId,
      options.yes ? { yes: true } : {},
    );
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function teamReforgeListAction(
  options: TeamSessionsOptions,
  command: Command,
): Promise<void> {
  try {
    const { listReforgeStateService } = await import('@agentforge/core');
    const exitCode = await listReforgeStateService(resolveProjectRoot(options.projectRoot, command));
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function teamReforgeRollbackAction(
  agent: string,
  options: TeamSessionsOptions,
  command: Command,
): Promise<void> {
  try {
    const { rollbackReforgeOverrideService } = await import('@agentforge/core');
    const exitCode = await rollbackReforgeOverrideService(
      resolveProjectRoot(options.projectRoot, command),
      agent,
    );
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function teamReforgeStatusAction(
  options: TeamSessionsOptions,
  command: Command,
): Promise<void> {
  try {
    const { showReforgeStatusService } = await import('@agentforge/core');
    const exitCode = await showReforgeStatusService(resolveProjectRoot(options.projectRoot, command));
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function teamSessionsListAction(
  options: TeamSessionsOptions,
  command: Command,
): Promise<void> {
  try {
    const { listTeamSessions } = await import('@agentforge/core');
    const exitCode = await listTeamSessions(resolveProjectRoot(options.projectRoot, command));
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function teamSessionsDeleteAction(
  sessionId: string,
  options: TeamSessionsOptions,
  command: Command,
): Promise<void> {
  try {
    const { deleteTeamSession } = await import('@agentforge/core');
    const exitCode = await deleteTeamSession(
      resolveProjectRoot(options.projectRoot, command),
      sessionId,
    );
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function resolveProjectRoot(fallback: string | undefined, command?: Command): string {
  const explicitFromArgv = readProjectRootFromArgv();
  if (explicitFromArgv) {
    return explicitFromArgv;
  }

  const localOptions = command?.optsWithGlobals?.() as { projectRoot?: unknown } | undefined;
  if (typeof localOptions?.projectRoot === 'string' && localOptions.projectRoot.length > 0) {
    return localOptions.projectRoot;
  }

  const parentOptions = command?.parent?.opts?.() as { projectRoot?: unknown } | undefined;
  if (typeof parentOptions?.projectRoot === 'string' && parentOptions.projectRoot.length > 0) {
    return parentOptions.projectRoot;
  }

  if (typeof fallback === 'string' && fallback.length > 0) {
    return fallback;
  }

  return process.cwd();
}

function readProjectRootFromArgv(): string | undefined {
  for (let index = process.argv.length - 1; index >= 0; index -= 1) {
    const current = process.argv[index];
    if (current === '--project-root') {
      const next = process.argv[index + 1];
      return typeof next === 'string' && next.length > 0 ? next : undefined;
    }

    if (current?.startsWith('--project-root=')) {
      const [, value] = current.split('=', 2);
      return value && value.length > 0 ? value : undefined;
    }
  }

  return undefined;
}
