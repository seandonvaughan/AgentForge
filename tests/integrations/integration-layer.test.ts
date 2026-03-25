// tests/integrations/integration-layer.test.ts
import { describe, it, expect, vi } from "vitest";
import { IntegrationLayer } from "../../src/integrations/integration-layer.js";
import type {
  McpConfig,
  IntegrationAction,
  JiraCreateIssueAction,
  GithubCreateIssueAction,
  ConfluenceCreatePageAction,
  SlackPostMessageAction,
} from "../../src/types/integration.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fullMcpConfig: McpConfig = {
  mcpServers: {
    atlassian: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-atlassian"],
      env: {
        ATLASSIAN_URL: "${ATLASSIAN_URL}",
        ATLASSIAN_EMAIL: "${ATLASSIAN_EMAIL}",
        ATLASSIAN_API_TOKEN: "${ATLASSIAN_API_TOKEN}",
      },
    },
    github: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PERSONAL_ACCESS_TOKEN}" },
    },
    slack: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
      env: {
        SLACK_BOT_TOKEN: "${SLACK_BOT_TOKEN}",
        SLACK_TEAM_ID: "${SLACK_TEAM_ID}",
      },
    },
  },
};

const jiraAction: JiraCreateIssueAction = {
  type: "jira:create_issue",
  project: "PROJ",
  summary: "Login regression",
  description: "SSO login fails after deploy",
  issueType: "Bug",
  priority: "High",
  triggeredBy: "qa-lead",
};

const githubAction: GithubCreateIssueAction = {
  type: "github:create_issue",
  repo: "acme/backend",
  title: "Null pointer in auth handler",
  body: "Reproduces with empty bearer token",
  labels: ["bug"],
  triggeredBy: "security-agent",
};

const confluenceAction: ConfluenceCreatePageAction = {
  type: "confluence:create_page",
  spaceKey: "ENG",
  title: "ADR-42",
  body: "Decision body",
  triggeredBy: "architect-lead",
};

const slackAction: SlackPostMessageAction = {
  type: "slack:post_message",
  channel: "#dev-handoffs",
  text: "Handoff complete.",
  triggeredBy: "qa-lead",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IntegrationLayer", () => {
  describe("constructor / availability", () => {
    it("derives available targets from mcpConfig server keys (atlassian → jira+confluence)", () => {
      const layer = new IntegrationLayer(fullMcpConfig);
      expect(layer.isAvailable("jira")).toBe(true);
      expect(layer.isAvailable("confluence")).toBe(true);
      expect(layer.isAvailable("github")).toBe(true);
      expect(layer.isAvailable("slack")).toBe(true);
    });

    it("respects explicit allowedTargets override", () => {
      const layer = new IntegrationLayer(fullMcpConfig, ["jira", "slack"]);
      expect(layer.isAvailable("jira")).toBe(true);
      expect(layer.isAvailable("slack")).toBe(true);
      expect(layer.isAvailable("github")).toBe(false);
      expect(layer.isAvailable("confluence")).toBe(false);
    });

    it("getAvailableTargets() returns only the configured targets", () => {
      const layer = new IntegrationLayer(fullMcpConfig, ["github"]);
      const targets = layer.getAvailableTargets();
      expect(targets).toHaveLength(1);
      expect(targets).toContain("github");
    });

    it("returns only filesystem target when mcpConfig has no servers", () => {
      const emptyConfig: McpConfig = { mcpServers: {} };
      const layer = new IntegrationLayer(emptyConfig);
      const targets = layer.getAvailableTargets();
      expect(targets).toHaveLength(1);
      expect(targets).toContain("filesystem");
    });
  });

  describe("dispatch()", () => {
    it("returns a success IntegrationResult for a jira:create_issue action", async () => {
      const layer = new IntegrationLayer(fullMcpConfig);
      const result = await layer.dispatch(jiraAction);

      expect(result.success).toBe(true);
      expect(result.target).toBe("jira");
      expect(result.action).toBe("jira:create_issue");
      expect(typeof result.timestamp).toBe("string");
    });

    it("returns a success IntegrationResult for a github:create_issue action", async () => {
      const layer = new IntegrationLayer(fullMcpConfig);
      const result = await layer.dispatch(githubAction);

      expect(result.success).toBe(true);
      expect(result.target).toBe("github");
      expect(result.action).toBe("github:create_issue");
    });

    it("returns a success IntegrationResult for a confluence:create_page action", async () => {
      const layer = new IntegrationLayer(fullMcpConfig);
      const result = await layer.dispatch(confluenceAction);

      expect(result.success).toBe(true);
      expect(result.target).toBe("confluence");
      expect(result.action).toBe("confluence:create_page");
    });

    it("returns a success IntegrationResult for a slack:post_message action", async () => {
      const layer = new IntegrationLayer(fullMcpConfig);
      const result = await layer.dispatch(slackAction);

      expect(result.success).toBe(true);
      expect(result.target).toBe("slack");
      expect(result.action).toBe("slack:post_message");
    });

    it("throws when dispatching to a target not in allowedTargets", async () => {
      const layer = new IntegrationLayer(fullMcpConfig, ["slack"]);
      await expect(layer.dispatch(jiraAction)).rejects.toThrow(
        /Integration target "jira" is not available/,
      );
    });

    it("throws when dispatching to a target absent from mcpConfig", async () => {
      const configWithoutGithub: McpConfig = {
        mcpServers: {
          slack: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-slack"],
          },
        },
      };
      const layer = new IntegrationLayer(configWithoutGithub);
      await expect(layer.dispatch(githubAction)).rejects.toThrow(
        /Integration target "github" is not available/,
      );
    });

    it("result timestamp is a valid ISO 8601 string", async () => {
      const layer = new IntegrationLayer(fullMcpConfig);
      const result = await layer.dispatch(slackAction);
      expect(() => new Date(result.timestamp)).not.toThrow();
      expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
    });
  });
});
