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
  // Initialize DB
  const db = new AgentDatabase({ path: DB_PATH });
  const adapter = new SqliteAdapter({ db });

  // Initialize SSE
  const sseManager = new SseManager();

  // Initialize EventBus and EventCollector
  const bus = new V4MessageBus();
  const collector = new EventCollector({ bus, adapter, sseManager });

  // Start server
  const app = await startServer({ port: PORT, adapter, sseManager });
  setupGracefulShutdown(app);

  console.log(`AgentForge v4.7 running at http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/app`);
  console.log(`API: http://localhost:${PORT}/api/v1/health`);
  console.log(`DB: ${DB_PATH}`);
}

main().catch(err => {
  console.error('Server startup failed:', err);
  process.exit(1);
});
