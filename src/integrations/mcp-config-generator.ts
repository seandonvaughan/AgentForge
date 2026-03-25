/**
 * McpConfigGenerator for AgentForge Phase 2c: MCP Integration.
 *
 * Reads scanner output (IntegrationRef[]) and generates a minimal
 * .mcp/config.json that only includes MCP servers for detected integrations.
 *
 * Uses only Node.js built-in modules (fs, path).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IntegrationRef } from "../types/analysis.js";
import type { McpConfig, McpServerConfig } from "../types/integration.js";

// ---------------------------------------------------------------------------
// Known MCP server definitions
// ---------------------------------------------------------------------------

/**
 * Maps integration types to their MCP server configuration.
 * jira and confluence share the atlassian server — deduplication is handled
 * in generateMcpConfig().
 */
const MCP_SERVER_DEFINITIONS: Record<
  string,
  { key: string; config: McpServerConfig }
> = {
  jira: {
    key: "atlassian",
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-atlassian"],
      env: {
        ATLASSIAN_URL: "${ATLASSIAN_URL}",
        ATLASSIAN_EMAIL: "${ATLASSIAN_EMAIL}",
        ATLASSIAN_API_TOKEN: "${ATLASSIAN_API_TOKEN}",
      },
    },
  },
  confluence: {
    key: "atlassian",
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-atlassian"],
      env: {
        ATLASSIAN_URL: "${ATLASSIAN_URL}",
        ATLASSIAN_EMAIL: "${ATLASSIAN_EMAIL}",
        ATLASSIAN_API_TOKEN: "${ATLASSIAN_API_TOKEN}",
      },
    },
  },
  github: {
    key: "github",
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PERSONAL_ACCESS_TOKEN}",
      },
    },
  },
  slack: {
    key: "slack",
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
      env: {
        SLACK_BOT_TOKEN: "${SLACK_BOT_TOKEN}",
        SLACK_TEAM_ID: "${SLACK_TEAM_ID}",
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates an McpConfig from a list of detected IntegrationRef objects.
 *
 * Deduplicates jira + confluence into a single "atlassian" server entry.
 * Integration types with no known MCP server mapping are silently ignored.
 *
 * @param integrations - Output from detectIntegrations() (IntegrationRef[]).
 * @returns McpConfig ready to be serialised to .mcp/config.json.
 */
export function generateMcpConfig(integrations: IntegrationRef[]): McpConfig {
  const detectedTypes = new Set(integrations.map((ref) => ref.type));
  const servers: Record<string, McpServerConfig> = {};

  for (const type of detectedTypes) {
    const definition = MCP_SERVER_DEFINITIONS[type];
    if (!definition) continue;

    // jira and confluence share the same key → only written once
    if (!servers[definition.key]) {
      servers[definition.key] = definition.config;
    }
  }

  return { mcpServers: servers };
}

/**
 * Writes an McpConfig to <projectRoot>/.mcp/config.json.
 *
 * Creates the .mcp directory if it does not already exist.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param config - The McpConfig to write.
 */
export async function writeMcpConfig(
  projectRoot: string,
  config: McpConfig,
): Promise<void> {
  const mcpDir = join(projectRoot, ".mcp");
  await mkdir(mcpDir, { recursive: true });
  const configPath = join(mcpDir, "config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
}
