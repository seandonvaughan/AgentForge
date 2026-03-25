// tests/types/integration-types.test.ts
import { describe, it, expect } from "vitest";
import type {
  IntegrationTarget,
  IntegrationAction,
  JiraCreateIssueAction,
  GithubCreateIssueAction,
  ConfluenceCreatePageAction,
  SlackPostMessageAction,
  IntegrationResult,
  McpServerConfig,
  McpConfig,
} from "../../src/types/integration.js";

describe("integration types", () => {
  it("IntegrationTarget accepts all four supported values", () => {
    const targets: IntegrationTarget[] = ["jira", "github", "confluence", "slack"];
    expect(targets).toHaveLength(4);
    expect(targets).toContain("jira");
    expect(targets).toContain("github");
    expect(targets).toContain("confluence");
    expect(targets).toContain("slack");
  });

  it("each IntegrationAction subtype has the correct discriminant and triggeredBy", () => {
    const jiraAction: JiraCreateIssueAction = {
      type: "jira:create_issue",
      project: "PROJ",
      summary: "Bug in login flow",
      description: "Users cannot log in with SSO",
      issueType: "Bug",
      triggeredBy: "qa-lead",
    };

    const githubAction: GithubCreateIssueAction = {
      type: "github:create_issue",
      repo: "acme/backend",
      title: "Null pointer in auth handler",
      body: "Reproduces with empty bearer token",
      labels: ["bug", "security"],
      triggeredBy: "security-agent",
    };

    const confluenceAction: ConfluenceCreatePageAction = {
      type: "confluence:create_page",
      spaceKey: "ENG",
      title: "ADR-42: Switch to MCP",
      body: "## Decision\n\nAdopt MCP for external tool dispatch.",
      parentId: "987654",
      triggeredBy: "architect-lead",
    };

    const slackAction: SlackPostMessageAction = {
      type: "slack:post_message",
      channel: "#dev-handoffs",
      text: "Handoff from qa-lead to deploy-agent complete.",
      triggeredBy: "qa-lead",
    };

    // Discriminants
    expect(jiraAction.type).toBe("jira:create_issue");
    expect(githubAction.type).toBe("github:create_issue");
    expect(confluenceAction.type).toBe("confluence:create_page");
    expect(slackAction.type).toBe("slack:post_message");

    // triggeredBy on every action
    expect(jiraAction.triggeredBy).toBe("qa-lead");
    expect(githubAction.triggeredBy).toBe("security-agent");
    expect(confluenceAction.triggeredBy).toBe("architect-lead");
    expect(slackAction.triggeredBy).toBe("qa-lead");

    // The union type accepts all four
    const actions: IntegrationAction[] = [
      jiraAction,
      githubAction,
      confluenceAction,
      slackAction,
    ];
    expect(actions).toHaveLength(4);
  });

  it("IntegrationResult and McpConfig have the expected shapes", () => {
    const result: IntegrationResult = {
      success: true,
      target: "jira",
      action: "jira:create_issue",
      response: { id: "PROJ-99" },
      timestamp: new Date().toISOString(),
    };

    expect(result.success).toBe(true);
    expect(result.target).toBe("jira");
    expect(result.action).toBe("jira:create_issue");
    expect(typeof result.timestamp).toBe("string");

    const serverConfig: McpServerConfig = {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-atlassian"],
      env: { ATLASSIAN_URL: "https://acme.atlassian.net" },
    };

    const mcpConfig: McpConfig = {
      mcpServers: { atlassian: serverConfig },
    };

    expect(mcpConfig.mcpServers["atlassian"]).toBeDefined();
    expect(mcpConfig.mcpServers["atlassian"].command).toBe("npx");
    expect(mcpConfig.mcpServers["atlassian"].args).toContain(
      "@modelcontextprotocol/server-atlassian",
    );
  });
});
