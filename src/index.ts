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

export default plugin;
