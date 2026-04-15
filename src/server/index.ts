import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export { createServer, startServer } from './server.js';
export type { ServerOptions } from './server.js';
export { setupGracefulShutdown } from './graceful-shutdown.js';

export const ROOT_SERVER_DEPRECATION_MESSAGE =
  '[compat] Root server bootstrap is deprecated and now forwards to the package-canonical server.';

export function resolvePackageCanonicalServerEntrypoint(): string {
  const serverDir = dirname(fileURLToPath(import.meta.url));
  return resolve(serverDir, '../../packages/server/dist/main.js');
}

export async function launchPackageCanonicalServer(): Promise<void> {
  console.warn(ROOT_SERVER_DEPRECATION_MESSAGE);

  if (process.env.AGENTFORGE_DB && !process.env.DATA_DIR) {
    console.warn(
      '[compat] AGENTFORGE_DB is a legacy root-server setting. The package server uses DATA_DIR and defaults to .agentforge/v5.',
    );
  }

  const entrypoint = resolvePackageCanonicalServerEntrypoint();
  if (!existsSync(entrypoint)) {
    throw new Error(
      `Package server entrypoint not found at ${entrypoint}. Build the package server before using the root compatibility bootstrap.`,
    );
  }

  await import(pathToFileURL(entrypoint).href);
}
