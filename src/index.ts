/**
 * AgentForge — Adaptive Agent Team Builder for Claude Code
 *
 * Main entry point for the Claude Code plugin.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface AgentForgePlugin {
  name: string;
  version: string;
}

const plugin: AgentForgePlugin = {
  name: "agentforge",
  version: readPackageVersion(),
};

console.log("AgentForge loaded");

// Export utilities
export * from './utils/index.js';

export default plugin;

function readPackageVersion(): string {
  try {
    const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
    return packageJson.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
