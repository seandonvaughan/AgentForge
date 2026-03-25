---
id: a7c2e9d1-3f84-4b56-8e0a-f9c1d2b7e4a3
agent: external-tools-researcher
category: feature
priority: high
timestamp: "2026-03-25T03:00:00.000Z"
---

# Native MCP-Backed Integration with Jira, GitHub, Confluence, and Slack

## Problem

AgentForge v2 can *detect* references to external tools — `src/scanner/integration-detector.ts` finds Jira ticket keys, Confluence URLs, and Slack webhooks in source files — but detection is purely passive. An agent cannot *act* on those integrations: it cannot create a Jira ticket when it finds a test failure, post a Slack message when it completes a handoff, or read a Confluence page to inform its analysis. The `Handoff`, `TeamEvent`, `DelegationRequest`, and `AgentMessage` types all carry only in-process data; there is no mechanism to materialize any of that as work items, notifications, or documents in external systems.

This gap means users must manually bridge AgentForge outputs to their actual workflow tooling, which negates a large portion of the value of agent automation.

## Research

### MCP (Model Context Protocol) as the integration backbone

MCP is Anthropic's open standard (released November 2024) for giving language model agents structured, tool-call-style access to external systems. Claude Code already ships with MCP support — it can invoke any MCP server registered in the user's `claude_desktop_config.json` or a project-local `.mcp/config.json`. This means AgentForge agents running inside Claude Code can already call MCP servers without any additional client-side plumbing.

Key facts about MCP architecture:
- MCP servers expose **tools** (callable operations), **resources** (readable data), and **prompts** (reusable templates) via a JSON-RPC 2.0 transport (stdio or HTTP/SSE).
- A project-local `.mcp/config.json` (or `.claude/mcp.json`) file registers servers for that project's Claude Code session.
- Tool calls are structured: `{ name: string, arguments: Record<string, unknown> }` with typed return values.

### Existing MCP servers for each target tool

**Jira / Confluence (Atlassian):**
- `@modelcontextprotocol/server-atlassian` (official Anthropic-maintained): exposes `jira_get_issue`, `jira_create_issue`, `jira_update_issue`, `jira_add_comment`, `confluence_get_page`, `confluence_create_page`, `confluence_search`. Requires `ATLASSIAN_URL`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN` env vars.
- The live environment running this research already has the Atlassian MCP server active (visible in available tools as `mcp__claude_ai_Atlassian__*`).

**GitHub:**
- `@modelcontextprotocol/server-github` (official): exposes `create_issue`, `create_pull_request`, `get_file_contents`, `push_files`, `search_repositories`, `list_commits`. Requires `GITHUB_PERSONAL_ACCESS_TOKEN`.
- `gh` CLI MCP wrapper (community): thin wrapper around the `gh` CLI for teams already using it.

**Slack:**
- `@modelcontextprotocol/server-slack` (official): exposes `post_message`, `list_channels`, `get_thread_replies`, `add_reaction`, `create_channel`. Requires `SLACK_BOT_TOKEN`, `SLACK_TEAM_ID`.

**All four tools have production-quality, officially maintained MCP servers.** No custom MCP server development is needed for the core integration — AgentForge only needs to generate and manage the MCP configuration files and map agent actions to the correct MCP tool calls.

### How tool mapping should work

The key insight is that AgentForge agent *actions* should map to MCP *tool calls* through a typed dispatch layer, not through free-form natural language. Examples:

| Agent action (AgentForge concept) | MCP tool call |
|---|---|
| QA lead finds test failures in a sprint | `jira_create_issue` with `issuetype=Bug`, `summary`, `description`, `labels` |
| Architect records a decision | `confluence_create_page` in the team's decision log space |
| Handoff completes between lead agents | `slack_post_message` to `#dev-handoffs` with handoff summary |
| PM agent creates sprint tasks | `jira_create_issue` × N with `issuetype=Story`, `epic` linkage |
| Code review agent approves PR | `github_create_review` with `event=APPROVE` |
| Security agent flags a vulnerability | `jira_create_issue` with `issuetype=Bug`, `priority=High`, `labels=security` |

### Should AgentForge ship its own MCP server configs, or generate per-project?

Both — with different purposes:

1. **Bundled default configs** (checked into `AgentForge/mcp-presets/`): Pre-written MCP server configurations for each supported tool. Users activate a preset with `agentforge mcp enable jira`. The preset wires up the correct env vars and server package.

2. **Per-project generated overlay** (written to `.mcp/config.json` at `agentforge init`): The CLI scanner detects which integrations the project already references (using the existing `detectIntegrations` from `src/scanner/integration-detector.ts`), then generates a minimal `.mcp/config.json` that only includes servers for detected tools. This avoids loading unused MCP servers on every invocation.

## Findings

### Trade-offs

**MCP as backbone vs. custom HTTP clients:**
- MCP: zero additional client code, works inside Claude Code's existing sandbox, typed tool schemas, Anthropic-maintained servers. Downside: requires MCP server processes running alongside the session; env var management.
- Custom HTTP clients: full control, no process overhead. Downside: auth management, rate limiting, pagination, error normalization — hundreds of lines of code per tool that the community has already written for MCP servers.

**Verdict: MCP wins for the initial four tools.** Custom clients should only be considered for tools with no MCP server.

**Per-project config generation vs. static presets:**
The `detectIntegrations` scanner already knows which tools a project uses. Generating a minimal `.mcp/config.json` from detected integrations means agents automatically get the right tools without manual configuration. This is a 10-line addition to the existing scanner pipeline.

**Action mapping granularity:**
Fine-grained mappings (one agent action → one MCP call) are simpler to implement and test. Coarse-grained mappings (agent role → set of allowed tool calls) are easier to author in templates. v3 should support both: a role-level `allowed_integrations` field plus per-action override.

## Recommendation

Introduce an `IntegrationLayer` class in `src/integrations/` that:

1. Reads the project's `.mcp/config.json` to know which MCP servers are available.
2. Exposes a typed `dispatch(action: IntegrationAction): Promise<IntegrationResult>` method that maps AgentForge action types to MCP tool calls.
3. Is instantiated once per session by the orchestrator and injected into agent execution contexts.
4. Records all dispatched actions to the `ContextManager`'s decision log so they appear in every agent's assembled context.

Add an `allowed_integrations` field to `AgentTemplate` (in `src/types/agent.ts`) so each agent template declares which external tools it may touch. The orchestrator enforces this at dispatch time.

Add an `agentforge mcp` CLI subcommand that generates or updates `.mcp/config.json` based on `detectIntegrations` output.

## Implementation Sketch

```typescript
// src/types/integration.ts — NEW FILE

/** The external tools AgentForge natively supports via MCP. */
export type IntegrationTarget = "jira" | "github" | "confluence" | "slack";

/** A typed action that maps to one or more MCP tool calls. */
export type IntegrationAction =
  | JiraCreateIssueAction
  | JiraUpdateIssueAction
  | GithubCreateIssueAction
  | GithubCreatePRCommentAction
  | ConfluenceCreatePageAction
  | ConfluenceUpdatePageAction
  | SlackPostMessageAction;

export interface JiraCreateIssueAction {
  type: "jira:create_issue";
  projectKey: string;
  summary: string;
  description: string;
  issueType: "Bug" | "Story" | "Task" | "Epic";
  priority?: "Highest" | "High" | "Medium" | "Low" | "Lowest";
  labels?: string[];
  /** Agent that triggered this action, for audit trail. */
  triggeredBy: string;
}

export interface JiraUpdateIssueAction {
  type: "jira:update_issue";
  issueKey: string;
  fields: Record<string, unknown>;
  comment?: string;
  triggeredBy: string;
}

export interface GithubCreateIssueAction {
  type: "github:create_issue";
  repo: string;            // "owner/repo" format
  title: string;
  body: string;
  labels?: string[];
  assignees?: string[];
  triggeredBy: string;
}

export interface GithubCreatePRCommentAction {
  type: "github:create_pr_comment";
  repo: string;
  pullNumber: number;
  body: string;
  triggeredBy: string;
}

export interface ConfluenceCreatePageAction {
  type: "confluence:create_page";
  spaceKey: string;
  title: string;
  body: string;             // Confluence Storage Format or Markdown
  parentPageId?: string;
  triggeredBy: string;
}

export interface ConfluenceUpdatePageAction {
  type: "confluence:update_page";
  pageId: string;
  title: string;
  body: string;
  triggeredBy: string;
}

export interface SlackPostMessageAction {
  type: "slack:post_message";
  channel: string;          // "#channel-name" or channel ID
  text: string;
  /** Optional structured blocks for rich formatting. */
  blocks?: unknown[];
  triggeredBy: string;
}

/** Result from dispatching an IntegrationAction. */
export interface IntegrationResult {
  action: IntegrationAction;
  success: boolean;
  /** URL to the created/updated resource, if available. */
  resourceUrl?: string;
  /** External system's ID for the created/updated resource. */
  resourceId?: string;
  error?: string;
  durationMs: number;
}

/** Per-agent integration permissions declared in AgentTemplate. */
export interface AgentIntegrationConfig {
  /** Which external tools this agent may dispatch actions to. */
  allowed: IntegrationTarget[];
  /**
   * Allowed action types within each tool.
   * Omit to allow all action types for a permitted tool.
   */
  allowedActions?: Partial<Record<IntegrationTarget, string[]>>;
}
```

```typescript
// src/integrations/integration-layer.ts — NEW FILE

import type { IntegrationAction, IntegrationResult, AgentIntegrationConfig } from "../types/integration.js";
import type { ContextManager } from "../orchestrator/context-manager.js";

/**
 * Routes typed IntegrationActions to MCP tool calls.
 *
 * In Claude Code sessions, MCP tool calls are handled by the runtime;
 * the IntegrationLayer normalizes AgentForge action types into the
 * correct MCP tool name and argument shape, then delegates execution
 * to the Claude Code MCP dispatch mechanism (injected via mcpDispatch).
 */
export class IntegrationLayer {
  constructor(
    private readonly mcpDispatch: (toolName: string, args: Record<string, unknown>) => Promise<unknown>,
    private readonly contextManager: ContextManager,
    private readonly enabledTargets: Set<string>,
  ) {}

  /**
   * Dispatches a typed action to the appropriate MCP server.
   * Records the result in the ContextManager decision log.
   * Throws if the action's target integration is not enabled.
   */
  async dispatch(
    action: IntegrationAction,
    agentConfig: AgentIntegrationConfig,
  ): Promise<IntegrationResult> {
    const target = action.type.split(":")[0] as string;

    if (!agentConfig.allowed.includes(target as any)) {
      throw new Error(
        `Agent "${action.triggeredBy}" is not permitted to dispatch to "${target}". ` +
        `Allowed integrations: ${agentConfig.allowed.join(", ")}`,
      );
    }

    if (!this.enabledTargets.has(target)) {
      throw new Error(`Integration target "${target}" is not enabled in .mcp/config.json`);
    }

    const start = Date.now();
    try {
      const { toolName, args } = this.toMcpCall(action);
      const mcpResult = await this.mcpDispatch(toolName, args);
      const result: IntegrationResult = {
        action,
        success: true,
        resourceUrl: this.extractUrl(mcpResult),
        resourceId: this.extractId(mcpResult),
        durationMs: Date.now() - start,
      };

      // Record in decision log so all agents see it
      this.contextManager.saveDecision(
        action.triggeredBy,
        `Dispatched ${action.type}`,
        result.resourceUrl
          ? `Created/updated resource at ${result.resourceUrl}`
          : "Integration action completed",
      );

      return result;
    } catch (err) {
      return {
        action,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  /** Maps an IntegrationAction to an MCP tool name and argument shape. */
  private toMcpCall(action: IntegrationAction): { toolName: string; args: Record<string, unknown> } {
    switch (action.type) {
      case "jira:create_issue":
        return {
          toolName: "jira_create_issue",
          args: {
            project: { key: action.projectKey },
            summary: action.summary,
            description: action.description,
            issuetype: { name: action.issueType },
            priority: action.priority ? { name: action.priority } : undefined,
            labels: action.labels,
          },
        };
      case "jira:update_issue":
        return {
          toolName: "jira_update_issue",
          args: { issueIdOrKey: action.issueKey, fields: action.fields, comment: action.comment },
        };
      case "github:create_issue":
        return {
          toolName: "create_issue",
          args: { owner: action.repo.split("/")[0], repo: action.repo.split("/")[1], title: action.title, body: action.body, labels: action.labels, assignees: action.assignees },
        };
      case "confluence:create_page":
        return {
          toolName: "confluence_create_page",
          args: { spaceKey: action.spaceKey, title: action.title, body: action.body, parentId: action.parentPageId },
        };
      case "confluence:update_page":
        return {
          toolName: "confluence_update_page",
          args: { pageId: action.pageId, title: action.title, body: action.body },
        };
      case "slack:post_message":
        return {
          toolName: "slack_post_message",
          args: { channel: action.channel, text: action.text, blocks: action.blocks },
        };
      default:
        throw new Error(`Unhandled action type: ${(action as any).type}`);
    }
  }

  private extractUrl(result: unknown): string | undefined {
    if (result && typeof result === "object") {
      const r = result as Record<string, unknown>;
      return (r["self"] ?? r["url"] ?? r["html_url"] ?? r["permalink"]) as string | undefined;
    }
    return undefined;
  }

  private extractId(result: unknown): string | undefined {
    if (result && typeof result === "object") {
      const r = result as Record<string, unknown>;
      return String(r["id"] ?? r["key"] ?? r["ts"] ?? "");
    }
    return undefined;
  }
}
```

```typescript
// src/types/agent.ts — additions to AgentTemplate interface

import type { AgentIntegrationConfig } from "./integration.js";

// Add to AgentTemplate:
/**
 * External tool integration permissions for this agent.
 * Omit to disallow all external integrations.
 */
integrations?: AgentIntegrationConfig;
```

```typescript
// src/scanner/mcp-config-generator.ts — NEW FILE

import type { IntegrationRef } from "../types/analysis.js";

/** MCP server config entry for .mcp/config.json */
interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

const MCP_SERVER_MAP: Record<string, McpServerEntry> = {
  jira: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-atlassian"],
    env: {
      ATLASSIAN_URL: "${ATLASSIAN_URL}",
      ATLASSIAN_EMAIL: "${ATLASSIAN_EMAIL}",
      ATLASSIAN_API_TOKEN: "${ATLASSIAN_API_TOKEN}",
    },
  },
  confluence: {
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
};

/**
 * Generates a .mcp/config.json based on detected integrations.
 * Deduplicates jira/confluence → single atlassian server entry.
 *
 * Integrates with the existing detectIntegrations() scanner in
 * src/scanner/integration-detector.ts.
 */
export function generateMcpConfig(detectedRefs: IntegrationRef[]): Record<string, McpServerEntry> {
  const detectedTypes = new Set(detectedRefs.map((r) => r.type));
  const servers: Record<string, McpServerEntry> = {};

  for (const type of detectedTypes) {
    const entry = MCP_SERVER_MAP[type];
    if (!entry) continue;

    // jira and confluence share one atlassian server
    const serverKey = type === "confluence" ? "atlassian" : type === "jira" ? "atlassian" : type;
    if (!servers[serverKey]) {
      servers[serverKey] = entry;
    }
  }

  return servers;
}
```

## Impact

This closes the gap between AgentForge's internal coordination and the external systems where engineering work actually lives. Concrete effects:

- **QA lead agents** can file Jira bugs the moment they identify test failures, not after a human reads the session transcript.
- **Architecture agents** can publish decision records directly to the team's Confluence space, creating a permanent, searchable audit trail beyond the in-memory `ContextManager.decisions` array (which is lost when the session ends).
- **PM agents** can create and link Jira stories from a planning session, turning AgentForge output into actionable sprint work immediately.
- **Handoff events** (from `HandoffManager`) can trigger Slack notifications, giving the team real-time visibility into agent pipeline progress without polling logs.
- The existing `integration-detector.ts` scanner becomes the foundation for zero-config MCP setup: projects that already reference Jira or Slack automatically get the right MCP servers wired up at `agentforge init` time.
- All integration dispatches are recorded in `ContextManager.saveDecision`, so subsequent agents in the pipeline see what external actions have already been taken, preventing duplicate ticket creation or double-posting.
