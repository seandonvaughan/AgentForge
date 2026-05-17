import { readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locate the AgentForge monorepo root from the CLI binary's location.
 * This is distinct from the external *project* root passed via --project-root
 * so that `agentforge info` always reports the correct AgentForge version even
 * when run against an external project.
 *
 * Layout: packages/cli/dist/commands/build-info.js → walk up 4 levels to monorepo root.
 */
function getAgentForgeRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return resolve(join(dirname(thisFile), '..', '..', '..', '..'));
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function printBuildInfo(_projectRoot?: string): Promise<void> {
  const agentForgeRoot = getAgentForgeRoot();
  const pkgs = ['shared', 'core', 'db', 'server', 'dashboard', 'embeddings', 'plugins-sdk', 'cli'];
  console.log('\nAgentForge Build Info');
  console.log('═'.repeat(40));
  for (const pkg of pkgs) {
    try {
      const pkgJson = JSON.parse(
        await readFile(join(agentForgeRoot, 'packages', pkg, 'package.json'), 'utf-8'),
      ) as { version: string };
      console.log(`  @agentforge/${pkg.padEnd(14)} ${pkgJson.version}`);
    } catch {
      console.log(`  @agentforge/${pkg.padEnd(14)} (not found)`);
    }
  }
  console.log('');
}
