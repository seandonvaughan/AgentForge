import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function printBuildInfo(projectRoot: string): Promise<void> {
  const pkgs = ['shared', 'core', 'db', 'server', 'dashboard', 'embeddings', 'plugins-sdk', 'cli'];
  console.log('\nAgentForge v5 Build Info');
  console.log('═'.repeat(40));
  for (const pkg of pkgs) {
    try {
      const pkgJson = JSON.parse(
        await readFile(join(projectRoot, 'packages', pkg, 'package.json'), 'utf-8'),
      ) as { version: string };
      console.log(`  @agentforge/${pkg.padEnd(14)} ${pkgJson.version}`);
    } catch {
      console.log(`  @agentforge/${pkg.padEnd(14)} (not found)`);
    }
  }
  console.log('');
}
