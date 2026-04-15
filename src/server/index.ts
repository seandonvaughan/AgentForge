import { startPackageServer } from '@agentforge/server';

export { createServer, startServer } from './server.js';
export type { ServerOptions } from './server.js';
export { setupGracefulShutdown } from './graceful-shutdown.js';

export const ROOT_SERVER_DEPRECATION_MESSAGE =
  '[compat] Root server bootstrap is deprecated and now forwards to the package-canonical server.';

export async function launchPackageCanonicalServer(): Promise<void> {
  console.warn(ROOT_SERVER_DEPRECATION_MESSAGE);

  if (process.env.AGENTFORGE_DB && !process.env.DATA_DIR) {
    console.warn(
      '[compat] AGENTFORGE_DB is a legacy root-server setting. The package server uses DATA_DIR and defaults to .agentforge/v5.',
    );
  }

  await startPackageServer();
}
