import { startServer } from './index.js';
import { setupGracefulShutdown } from './graceful-shutdown.js';
import { AgentDatabase } from '../db/index.js';
import { SqliteAdapter } from '../db/index.js';
import { SseManager } from './sse/index.js';
import { EventCollector } from '../event-collector/index.js';
import { V4MessageBus } from '../communication/v4-message-bus.js';
import { join } from 'node:path';

const DB_PATH = process.env.AGENTFORGE_DB ?? join(process.cwd(), '.agentforge', 'audit.db');
const PORT = parseInt(process.env.PORT ?? '4700', 10);

async function main() {
  console.warn("[compat] Root server bootstrap is legacy compatibility mode. Prefer `npm run start` or `node packages/server/dist/main.js` for the package-canonical server.");

  // Initialize DB
  const db = new AgentDatabase({ path: DB_PATH });
  const adapter = new SqliteAdapter({ db });

  // Initialize SSE
  const sseManager = new SseManager();

  // Initialize EventBus and EventCollector
  const bus = new V4MessageBus();
  const _collector = new EventCollector({ bus, adapter, sseManager });

  // Start server
  const app = await startServer({ port: PORT, adapter, sseManager });
  setupGracefulShutdown(app);

  console.log(`AgentForge v6.2 running at http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/app`);
  console.log(`API: http://localhost:${PORT}/api/v1/health`);
  console.log(`DB: ${DB_PATH}`);

  // Open browser (best-effort, no crash if it fails)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { exec } = await import('node:child_process');
  const browserUrl = `http://localhost:${PORT}/app`;
  const cmd = process.platform === 'darwin'
    ? `open "${browserUrl}"`
    : process.platform === 'win32'
    ? `start "" "${browserUrl}"`
    : `xdg-open "${browserUrl}"`;
  // eslint-disable-next-line no-empty
  exec(cmd, (err) => { if (err) console.log('(Browser auto-open failed, visit URL above)'); });
}

main().catch(err => {
  console.error('Server startup failed:', err);
  process.exit(1);
});
