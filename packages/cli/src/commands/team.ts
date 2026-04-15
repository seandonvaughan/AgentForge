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

interface TeamCommandOptionBag {
  projectRoot?: string;
  verbose?: boolean;
  dryRun?: boolean;
  domains?: string;
  interview?: boolean;
  yes?: boolean;
  autoApply?: boolean;
  upgrade?: boolean;
}

export function registerTeamCommand(program: Command): void {
  const team = program
    .command('team')
    .description('Generate, inspect, and update AgentForge teams through the legacy compatibility bridge')
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
    .description('Manage team reforge proposals and runtime overrides through the compatibility bridge');

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

  registerCompatibilityAlias(
    program.command('forge').description('Compatibility alias for team forge'),
    ['forge'],
    { compatibilityAlias: true, optionBuilder: buildTeamForgeArgs, preferredCommand: 'team forge' },
  );
  registerCompatibilityAlias(
    program.command('genesis').description('Compatibility alias for team genesis'),
    ['genesis'],
    { compatibilityAlias: true, optionBuilder: buildTeamGenesisArgs, preferredCommand: 'team genesis' },
  );
  registerCompatibilityAlias(
    program.command('rebuild').description('Compatibility alias for team rebuild'),
    ['rebuild'],
    { compatibilityAlias: true, optionBuilder: buildTeamRebuildArgs, preferredCommand: 'team rebuild' },
  );

  const reforgeAlias = program
    .command('reforge')
    .description('Compatibility alias for team reforge');

  registerCompatibilityAlias(
    reforgeAlias.command('apply <proposalId>').description('Compatibility alias for team reforge apply'),
    ['reforge', 'apply'],
    {
      compatibilityAlias: true,
      optionBuilder: buildTeamReforgeApplyArgs,
      positionalArgs: ['proposalId'],
      preferredCommand: 'team reforge apply',
    },
  );
  registerCompatibilityAlias(
    reforgeAlias.command('list').description('Compatibility alias for team reforge list'),
    ['reforge', 'list'],
    { compatibilityAlias: true, optionBuilder: buildProjectRootArgs, preferredCommand: 'team reforge list' },
  );
  registerCompatibilityAlias(
    reforgeAlias.command('rollback <agent>').description('Compatibility alias for team reforge rollback'),
    ['reforge', 'rollback'],
    {
      compatibilityAlias: true,
      optionBuilder: buildProjectRootArgs,
      positionalArgs: ['agent'],
      preferredCommand: 'team reforge rollback',
    },
  );
  registerCompatibilityAlias(
    reforgeAlias.command('status').description('Compatibility alias for team reforge status'),
    ['reforge', 'status'],
    { compatibilityAlias: true, optionBuilder: buildProjectRootArgs, preferredCommand: 'team reforge status' },
  );
}

export function registerTeamSessionsCommand(program: Command): void {
  const teamSessions = program
    .command('team-sessions')
    .description('Manage hibernated team sessions through the legacy compatibility bridge');

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

  registerCompatibilityAlias(
    sessionsAlias.command('list').description('Compatibility alias for team-sessions list'),
    ['sessions', 'list'],
    { compatibilityAlias: true, optionBuilder: buildProjectRootArgs, preferredCommand: 'team-sessions list' },
  );

  registerCompatibilityAlias(
    sessionsAlias.command('delete <sessionId>').description('Compatibility alias for team-sessions delete'),
    ['sessions', 'delete'],
    {
      compatibilityAlias: true,
      optionBuilder: buildProjectRootArgs,
      positionalArgs: ['sessionId'],
      preferredCommand: 'team-sessions delete',
    },
  );
}

async function teamShowAction(options: TeamShowOptions, command: Command): Promise<void> {
  await runCompatibilityCommand(
    ['team', ...buildTeamShowArgs(options)],
    resolveProjectRoot(options.projectRoot, command),
  );
}

async function teamForgeAction(options: TeamForgeOptions, command: Command): Promise<void> {
  await runCompatibilityCommand(
    ['forge', ...buildTeamForgeArgs(options)],
    resolveProjectRoot(options.projectRoot, command),
  );
}

async function teamGenesisAction(
  options: TeamGenesisOptions,
  command: Command,
): Promise<void> {
  await runCompatibilityCommand(
    ['genesis', ...buildTeamGenesisArgs(options)],
    resolveProjectRoot(options.projectRoot, command),
  );
}

async function teamRebuildAction(
  options: TeamRebuildOptions,
  command: Command,
): Promise<void> {
  await runCompatibilityCommand(
    ['rebuild', ...buildTeamRebuildArgs(options)],
    resolveProjectRoot(options.projectRoot, command),
  );
}

async function teamReforgeApplyAction(
  proposalId: string,
  options: ReforgeApplyOptions,
  command: Command,
): Promise<void> {
  await runCompatibilityCommand(
    ['reforge', 'apply', proposalId, ...buildTeamReforgeApplyArgs(options)],
    resolveProjectRoot(options.projectRoot, command),
  );
}

async function teamReforgeListAction(
  options: TeamSessionsOptions,
  command: Command,
): Promise<void> {
  await runCompatibilityCommand(
    ['reforge', 'list'],
    resolveProjectRoot(options.projectRoot, command),
  );
}

async function teamReforgeRollbackAction(
  agent: string,
  options: TeamSessionsOptions,
  command: Command,
): Promise<void> {
  await runCompatibilityCommand(
    ['reforge', 'rollback', agent],
    resolveProjectRoot(options.projectRoot, command),
  );
}

async function teamReforgeStatusAction(
  options: TeamSessionsOptions,
  command: Command,
): Promise<void> {
  await runCompatibilityCommand(
    ['reforge', 'status'],
    resolveProjectRoot(options.projectRoot, command),
  );
}

async function teamSessionsListAction(
  options: TeamSessionsOptions,
  command: Command,
): Promise<void> {
  await runCompatibilityCommand(
    ['sessions', 'list'],
    resolveProjectRoot(options.projectRoot, command),
  );
}

async function teamSessionsDeleteAction(
  sessionId: string,
  options: TeamSessionsOptions,
  command: Command,
): Promise<void> {
  await runCompatibilityCommand(
    ['sessions', 'delete', sessionId],
    resolveProjectRoot(options.projectRoot, command),
  );
}

function registerCompatibilityAlias(
  command: Command,
  baseArgs: string[],
  options: {
    compatibilityAlias: boolean;
    optionBuilder: (commandOptions: TeamCommandOptionBag) => string[];
    positionalArgs?: string[];
    preferredCommand: string;
  },
): void {
  command
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--verbose', 'Show detailed agent info')
    .option('--dry-run', 'Show what would be generated without writing files')
    .option('--domains <domains>', 'Comma-separated list of domains to activate')
    .option('--interview', 'Force interview mode even if project files exist')
    .option('--yes', 'Skip approval gate / confirmation prompt')
    .option('--auto-apply', 'Apply changes without review')
    .option('--upgrade', 'Migrate a team without a full rebuild')
    .action(async (...actionArgs: unknown[]) => {
      const commandOptions = actionArgs[actionArgs.length - 1] as Record<string, unknown>;
      const command = actionArgs[actionArgs.length - 1] as Command;
      const projectRoot = resolveProjectRoot(
        typeof commandOptions.projectRoot === 'string' ? commandOptions.projectRoot : undefined,
        command,
      );
      const positionals = (options.positionalArgs ?? [])
        .map((name, index) => actionArgs[index])
        .filter((value): value is string => typeof value === 'string');

      if (options.compatibilityAlias) {
        console.warn(`[compat] \`${baseArgs.join(' ')}\` top-level form is a compatibility alias. Prefer \`${options.preferredCommand}\`.`);
      }

      const args = [...baseArgs, ...positionals, ...options.optionBuilder(commandOptions)];
      await runCompatibilityCommand(args, projectRoot);
    });
}

function buildTeamShowArgs(options: TeamCommandOptionBag): string[] {
  return typeof options.verbose === 'boolean' && options.verbose ? ['--verbose'] : [];
}

function buildTeamForgeArgs(options: TeamCommandOptionBag): string[] {
  return [
    ...(typeof options.dryRun === 'boolean' && options.dryRun ? ['--dry-run'] : []),
    ...(typeof options.verbose === 'boolean' && options.verbose ? ['--verbose'] : []),
    ...(typeof options.domains === 'string' && options.domains ? ['--domains', options.domains] : []),
  ];
}

function buildTeamGenesisArgs(options: TeamCommandOptionBag): string[] {
  return [
    ...(typeof options.interview === 'boolean' && options.interview ? ['--interview'] : []),
    ...(typeof options.domains === 'string' && options.domains ? ['--domains', options.domains] : []),
    ...(typeof options.yes === 'boolean' && options.yes ? ['--yes'] : []),
  ];
}

function buildTeamRebuildArgs(options: TeamCommandOptionBag): string[] {
  return [
    ...(typeof options.autoApply === 'boolean' && options.autoApply ? ['--auto-apply'] : []),
    ...(typeof options.upgrade === 'boolean' && options.upgrade ? ['--upgrade'] : []),
  ];
}

function buildTeamReforgeApplyArgs(options: TeamCommandOptionBag): string[] {
  return typeof options.yes === 'boolean' && options.yes ? ['--yes'] : [];
}

function buildProjectRootArgs(_options: TeamCommandOptionBag): string[] {
  return [];
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

async function runCompatibilityCommand(args: string[], projectRoot: string): Promise<void> {
  try {
    const { runLegacyRootCli } = await import('@agentforge/core');
    const exitCode = await runLegacyRootCli(args, { cwd: projectRoot });
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
