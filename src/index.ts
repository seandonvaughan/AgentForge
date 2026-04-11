/**
 * AgentForge — Adaptive Agent Team Builder for Claude Code
 *
 * Main entry point for the Claude Code plugin.
 */

export interface AgentForgePlugin {
  name: string;
  version: string;
}

const plugin: AgentForgePlugin = {
  name: "agentforge",
  version: "0.1.0",
};

console.log("AgentForge loaded");

// Export utilities
export * from './utils/index.js';

export default plugin;
