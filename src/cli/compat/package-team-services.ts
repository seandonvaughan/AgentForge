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
    const { forgeTeamWithLegacyEngine } = await import('@agentforge/core');
    return forgeTeamWithLegacyEngine(process.cwd(), options);
  });
}

export async function genesisTeamCompatibility(
  options: PackageGenesisOptions = {},
): Promise<void> {
  await runCompatibilityAction(async () => {
    const { genesisTeamWithLegacyEngine } = await import('@agentforge/core');
    return genesisTeamWithLegacyEngine(process.cwd(), options);
  });
}

export async function rebuildTeamCompatibility(
  options: PackageRebuildOptions = {},
): Promise<void> {
  await runCompatibilityAction(async () => {
    const { rebuildTeamWithLegacyEngine } = await import('@agentforge/core');
    return rebuildTeamWithLegacyEngine(process.cwd(), options);
  });
}

export async function applyReforgeCompatibility(
  proposalId: string,
  options: PackageReforgeApplyOptions = {},
): Promise<void> {
  await runCompatibilityAction(async () => {
    const { applyLegacyReforgeProposal } = await import('@agentforge/core');
    return applyLegacyReforgeProposal(process.cwd(), proposalId, options);
  });
}

export async function listReforgeCompatibility(): Promise<void> {
  await runCompatibilityAction(async () => {
    const { listLegacyReforgeState } = await import('@agentforge/core');
    return listLegacyReforgeState(process.cwd());
  });
}

export async function rollbackReforgeCompatibility(agentName: string): Promise<void> {
  await runCompatibilityAction(async () => {
    const { rollbackLegacyReforgeOverride } = await import('@agentforge/core');
    return rollbackLegacyReforgeOverride(process.cwd(), agentName);
  });
}

export async function statusReforgeCompatibility(): Promise<void> {
  await runCompatibilityAction(async () => {
    const { showLegacyReforgeStatus } = await import('@agentforge/core');
    return showLegacyReforgeStatus(process.cwd());
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
