// tests/integrations/mcp-config-generator.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateMcpConfig, writeMcpConfig } from "../../src/integrations/mcp-config-generator.js";
import type { IntegrationRef } from "../../src/types/analysis.js";
import type { McpConfig } from "../../src/types/integration.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const jiraRef: IntegrationRef = { type: "jira", ref: "PROJ-123" };
const confluenceRef: IntegrationRef = {
  type: "confluence",
  ref: "confluence:https://example.atlassian.net/wiki/spaces/ENG/pages/1",
};
const githubRef: IntegrationRef = { type: "github", ref: "https://github.com/acme/backend" };
const slackRef: IntegrationRef = { type: "slack", ref: "https://hooks.slack.com/services/T/B/x" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateMcpConfig", () => {
  it("returns empty mcpServers when integration list is empty", () => {
    const config = generateMcpConfig([]);
    expect(config.mcpServers).toEqual({});
  });

  it("maps a jira ref to an atlassian MCP server entry", () => {
    const config = generateMcpConfig([jiraRef]);
    expect(config.mcpServers["atlassian"]).toBeDefined();
    expect(config.mcpServers["atlassian"].args).toContain(
      "@modelcontextprotocol/server-atlassian",
    );
  });

  it("maps a confluence ref to an atlassian MCP server entry", () => {
    const config = generateMcpConfig([confluenceRef]);
    expect(config.mcpServers["atlassian"]).toBeDefined();
  });

  it("deduplicates jira + confluence to a single atlassian entry", () => {
    const config = generateMcpConfig([jiraRef, confluenceRef]);
    const keys = Object.keys(config.mcpServers);
    expect(keys.filter((k) => k === "atlassian")).toHaveLength(1);
    expect(keys).not.toContain("jira");
    expect(keys).not.toContain("confluence");
  });

  it("maps a github ref to a github MCP server entry", () => {
    const config = generateMcpConfig([githubRef]);
    expect(config.mcpServers["github"]).toBeDefined();
    expect(config.mcpServers["github"].args).toContain(
      "@modelcontextprotocol/server-github",
    );
  });

  it("maps a slack ref to a slack MCP server entry", () => {
    const config = generateMcpConfig([slackRef]);
    expect(config.mcpServers["slack"]).toBeDefined();
    expect(config.mcpServers["slack"].args).toContain(
      "@modelcontextprotocol/server-slack",
    );
  });

  it("generates all four servers for all four integration types", () => {
    const config = generateMcpConfig([jiraRef, confluenceRef, githubRef, slackRef]);
    // jira + confluence → single atlassian entry, plus github and slack
    const keys = Object.keys(config.mcpServers).sort();
    expect(keys).toContain("atlassian");
    expect(keys).toContain("github");
    expect(keys).toContain("slack");
    // exactly 3 server entries (jira+confluence collapsed to atlassian)
    expect(keys).toHaveLength(3);
  });

  it("silently ignores unknown integration types", () => {
    const unknownRef: IntegrationRef = { type: "asana", ref: "project-xyz" };
    const config = generateMcpConfig([unknownRef]);
    expect(config.mcpServers).toEqual({});
  });
});

describe("writeMcpConfig", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentforge-mcp-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes .mcp/config.json to the project root", async () => {
    const config = generateMcpConfig([jiraRef, slackRef]);
    await writeMcpConfig(tempDir, config);

    const raw = await readFile(join(tempDir, ".mcp", "config.json"), "utf-8");
    const parsed: McpConfig = JSON.parse(raw);

    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers["atlassian"]).toBeDefined();
    expect(parsed.mcpServers["slack"]).toBeDefined();
  });

  it("creates the .mcp directory if it does not exist", async () => {
    const config: McpConfig = { mcpServers: {} };
    // No mkdir beforehand — writeMcpConfig must handle creation.
    await expect(writeMcpConfig(tempDir, config)).resolves.toBeUndefined();

    const raw = await readFile(join(tempDir, ".mcp", "config.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.mcpServers).toEqual({});
  });

  it("written JSON is valid and round-trips cleanly", async () => {
    const config = generateMcpConfig([githubRef]);
    await writeMcpConfig(tempDir, config);

    const raw = await readFile(join(tempDir, ".mcp", "config.json"), "utf-8");
    const parsed: McpConfig = JSON.parse(raw);

    expect(parsed.mcpServers["github"].command).toBe("npx");
    expect(Array.isArray(parsed.mcpServers["github"].args)).toBe(true);
  });
});
