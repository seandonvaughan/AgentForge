/**
 * Integration type definitions for AgentForge Phase 2c: MCP Integration.
 *
 * Defines typed actions that map to MCP tool calls, integration results,
 * and MCP server configuration structures.
 */

// ---------------------------------------------------------------------------
// Target integrations
// ---------------------------------------------------------------------------

/** The external tools AgentForge natively supports via MCP. */
export type IntegrationTarget = "jira" | "github" | "confluence" | "slack";

// ---------------------------------------------------------------------------
// Typed action interfaces
// ---------------------------------------------------------------------------

/** Action to create a Jira issue. */
export interface JiraCreateIssueAction {
  type: "jira:create_issue";
  /** Jira project key (e.g. "PROJ"). */
  project: string;
  summary: string;
  description: string;
  issueType: string;
  priority?: string;
  assignee?: string;
  /** Agent name that triggered this action, for audit trail. */
  triggeredBy: string;
}

/** Action to create a GitHub issue. */
export interface GithubCreateIssueAction {
  type: "github:create_issue";
  /** Repository in "owner/repo" format. */
  repo: string;
  title: string;
  body: string;
  labels?: string[];
  /** Agent name that triggered this action, for audit trail. */
  triggeredBy: string;
}

/** Action to create a Confluence page. */
export interface ConfluenceCreatePageAction {
  type: "confluence:create_page";
  spaceKey: string;
  title: string;
  /** Page body in Confluence Storage Format or Markdown. */
  body: string;
  parentId?: string;
  /** Agent name that triggered this action, for audit trail. */
  triggeredBy: string;
}

/** Action to post a Slack message. */
export interface SlackPostMessageAction {
  type: "slack:post_message";
  /** Channel name (e.g. "#dev-handoffs") or channel ID. */
  channel: string;
  text: string;
  /** Optional structured blocks for rich formatting. */
  blocks?: unknown[];
  /** Agent name that triggered this action, for audit trail. */
  triggeredBy: string;
}

/** Discriminated union of all supported integration actions. */
export type IntegrationAction =
  | JiraCreateIssueAction
  | GithubCreateIssueAction
  | ConfluenceCreatePageAction
  | SlackPostMessageAction;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Result from dispatching an IntegrationAction via IntegrationLayer. */
export interface IntegrationResult {
  success: boolean;
  /** The integration target that was dispatched to. */
  target: IntegrationTarget;
  /** The action type that was dispatched (e.g. "jira:create_issue"). */
  action: string;
  /** Raw response from the MCP server, if available. */
  response?: unknown;
  /** Error message if the dispatch failed. */
  error?: string;
  /** ISO 8601 timestamp of when the dispatch completed. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// MCP configuration structures
// ---------------------------------------------------------------------------

/** Configuration for a single MCP server entry. */
export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Shape of a project-local .mcp/config.json file. */
export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}
