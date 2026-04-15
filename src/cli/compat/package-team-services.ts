interface PackageForgeOptions {
  dryRun?: boolean;
  verbose?: boolean;
  domains?: string;
}

interface PackageGenesisOptions {
  interview?: boolean;
  domains?: string;
  yes?: boolean;
}

interface PackageRebuildOptions {
  autoApply?: boolean;
  upgrade?: boolean;
}

interface PackageReforgeApplyOptions {
  yes?: boolean;
}

async function runCompatibilityAction(
  action: () => Promise<number>,
): Promise<void> {
  try {
    const exitCode = await action();
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function showTeamCompatibility(options: {
  verbose?: boolean;
} = {}): Promise<void> {
  await runCompatibilityAction(async () => {
    const { showGeneratedTeam } = await import('@agentforge/core');
    return showGeneratedTeam(
      process.cwd(),
      typeof options.verbose === 'boolean' ? { verbose: options.verbose } : {},
    );
  });
}

export async function forgeTeamCompatibility(
  options: PackageForgeOptions = {},
): Promise<void> {
  await runCompatibilityAction(async () => {
    const { forgeTeamService } = await import('@agentforge/core');
    return forgeTeamService(process.cwd(), options);
  });
}

export async function genesisTeamCompatibility(
  options: PackageGenesisOptions = {},
): Promise<void> {
  await runCompatibilityAction(async () => {
    const { genesisTeamService } = await import('@agentforge/core');
    return genesisTeamService(process.cwd(), options);
  });
}

export async function rebuildTeamCompatibility(
  options: PackageRebuildOptions = {},
): Promise<void> {
  await runCompatibilityAction(async () => {
    const { rebuildTeamService } = await import('@agentforge/core');
    return rebuildTeamService(process.cwd(), options);
  });
}

export async function applyReforgeCompatibility(
  proposalId: string,
  options: PackageReforgeApplyOptions = {},
): Promise<void> {
  await runCompatibilityAction(async () => {
    const { applyReforgeProposalService } = await import('@agentforge/core');
    return applyReforgeProposalService(process.cwd(), proposalId, options);
  });
}

export async function listReforgeCompatibility(): Promise<void> {
  await runCompatibilityAction(async () => {
    const { listReforgeStateService } = await import('@agentforge/core');
    return listReforgeStateService(process.cwd());
  });
}

export async function rollbackReforgeCompatibility(agentName: string): Promise<void> {
  await runCompatibilityAction(async () => {
    const { rollbackReforgeOverrideService } = await import('@agentforge/core');
    return rollbackReforgeOverrideService(process.cwd(), agentName);
  });
}

export async function statusReforgeCompatibility(): Promise<void> {
  await runCompatibilityAction(async () => {
    const { showReforgeStatusService } = await import('@agentforge/core');
    return showReforgeStatusService(process.cwd());
  });
}

export async function listTeamSessionsCompatibility(): Promise<void> {
  await runCompatibilityAction(async () => {
    const { listTeamSessions } = await import('@agentforge/core');
    return listTeamSessions(process.cwd());
  });
}

export async function deleteTeamSessionCompatibility(sessionId: string): Promise<void> {
  await runCompatibilityAction(async () => {
    const { deleteTeamSession } = await import('@agentforge/core');
    return deleteTeamSession(process.cwd(), sessionId);
  });
}
