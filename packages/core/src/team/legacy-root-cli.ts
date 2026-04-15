import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface LegacyRootCliOptions {
  cwd?: string;
}

function getRepositoryRoot(): string {
  return fileURLToPath(new URL('../../../../', import.meta.url));
}

function getLegacyRootCliPath(): string {
  return join(getRepositoryRoot(), 'dist', 'cli', 'index.js');
}

export async function runLegacyRootCli(
  args: string[],
  options: LegacyRootCliOptions = {},
): Promise<number> {
  const cliPath = getLegacyRootCliPath();

  try {
    await access(cliPath, constants.F_OK);
  } catch {
    throw new Error(
      `Legacy root CLI is not built at ${cliPath}. Run \`corepack pnpm build\` first.`,
    );
  }

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd ?? process.cwd(),
      stdio: 'inherit',
      env: {
        ...process.env,
        AGENTFORGE_BRIDGED: '1',
      },
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 0);
    });
  });
}
