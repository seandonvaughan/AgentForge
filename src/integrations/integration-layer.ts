/**
 * IntegrationLayer for AgentForge Phase 2c: MCP Integration.
 *
 * Routes typed IntegrationActions to MCP tool calls.
 *
 * NOTE: dispatch() is a STUB for non-filesystem targets. Actual MCP tool calling requires the
 * Claude Code runtime. Filesystem operations use native Node.js file I/O.
 */

import { promises as fs } from "node:fs";

import type {
  IntegrationAction,
  IntegrationResult,
  IntegrationTarget,
  McpConfig,
} from "../types/integration.js";

// ---------------------------------------------------------------------------
// IntegrationLayer
// ---------------------------------------------------------------------------

/**
 * Routes typed IntegrationActions to MCP tool calls.
 *
 * Instantiated once per session with an McpConfig (derived from the
 * project's .mcp/config.json) and an optional allow-list of targets.
 * When allowedTargets is omitted, all targets present in mcpConfig are
 * considered available.
 */
export class IntegrationLayer {
  private readonly availableTargets: Set<IntegrationTarget>;

  constructor(
    private readonly mcpConfig: McpConfig,
    allowedTargets?: IntegrationTarget[],
  ) {
    if (allowedTargets !== undefined) {
      this.availableTargets = new Set(allowedTargets);
    } else {
      // Derive available targets from the server keys in mcpConfig.
      // The atlassian server covers both jira and confluence.
      // Filesystem is always available as it doesn't require MCP configuration.
      const targets = new Set<IntegrationTarget>();
      targets.add("filesystem"); // Always available
      for (const key of Object.keys(mcpConfig.mcpServers)) {
        const lower = key.toLowerCase();
        if (lower === "jira" || lower.includes("jira")) targets.add("jira");
        if (lower === "github" || lower.includes("github")) targets.add("github");
        if (lower === "atlassian" || lower.includes("atlassian")) {
          targets.add("jira");
          targets.add("confluence");
        }
        if (lower === "confluence" || lower.includes("confluence")) targets.add("confluence");
        if (lower === "slack" || lower.includes("slack")) targets.add("slack");
      }
      this.availableTargets = targets;
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Dispatch a typed IntegrationAction to the appropriate MCP server.
   *
   * For filesystem actions: performs real file operations.
   * For other targets: logs the action and returns a success result (STUB).
   * Real MCP tool calling for non-filesystem targets is handled by the Claude Code runtime in Phase 3.
   *
   * @throws Error if the action's target integration is not available.
   */
  async dispatch(action: IntegrationAction): Promise<IntegrationResult> {
    const target = action.type.split(":")[0] as IntegrationTarget;

    if (!this.availableTargets.has(target)) {
      const available = Array.from(this.availableTargets).join(", ") || "none";
      throw new Error(
        `Integration target "${target}" is not available. ` +
          `Available targets: ${available}`,
      );
    }

    // Real filesystem dispatch
    if (target === "filesystem") {
      try {
        const filePath = (action as typeof action & { path: string }).path;

        if (action.type === "filesystem:write_file") {
          const content = (action as typeof action & { content: string }).content;
          if (!filePath || content === undefined) {
            return {
              success: false,
              target,
              action: action.type,
              error: "filesystem:write_file requires path and content",
              timestamp: new Date().toISOString(),
            };
          }
          await fs.writeFile(filePath, content, "utf8");
          return {
            success: true,
            target,
            action: action.type,
            response: { path: filePath, bytesWritten: content.length },
            timestamp: new Date().toISOString(),
          };
        }

        if (action.type === "filesystem:read_file") {
          if (!filePath) {
            return {
              success: false,
              target,
              action: action.type,
              error: "filesystem:read_file requires path",
              timestamp: new Date().toISOString(),
            };
          }
          const fileContent = await fs.readFile(filePath, "utf8");
          return {
            success: true,
            target,
            action: action.type,
            response: { path: filePath, content: fileContent },
            timestamp: new Date().toISOString(),
          };
        }

        return {
          success: false,
          target,
          action: action.type,
          error: "Unknown filesystem action",
          timestamp: new Date().toISOString(),
        };
      } catch (error) {
        return {
          success: false,
          target,
          action: action.type,
          error: `Filesystem operation failed: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: new Date().toISOString(),
        };
      }
    }

    // STUB: In real runtime, this would resolve the MCP tool name and args,
    // then invoke the Claude Code MCP dispatch mechanism.
    const toolName = this.resolveToolName(action);
    console.log(
      `[IntegrationLayer] STUB dispatch → tool="${toolName}" triggeredBy="${action.triggeredBy}"`,
    );

    return {
      success: true,
      target,
      action: action.type,
      response: { stub: true, toolName },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Returns true if the given target is available in this layer's config.
   */
  isAvailable(target: IntegrationTarget): boolean {
    return this.availableTargets.has(target);
  }

  /**
   * Returns all available integration targets.
   */
  getAvailableTargets(): IntegrationTarget[] {
    return Array.from(this.availableTargets);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Maps an IntegrationAction type to the corresponding MCP tool name. */
  private resolveToolName(action: IntegrationAction): string {
    switch (action.type) {
      case "jira:create_issue":
        return "jira_create_issue";
      case "github:create_issue":
        return "create_issue";
      case "confluence:create_page":
        return "confluence_create_page";
      case "slack:post_message":
        return "slack_post_message";
      case "filesystem:write_file":
        return "filesystem_write_file";
      case "filesystem:read_file":
        return "filesystem_read_file";
      default: {
        // Exhaustiveness check — TypeScript will error if a case is missing.
        const _exhaustive: never = action;
        throw new Error(`Unhandled action type: ${(_exhaustive as IntegrationAction).type}`);
      }
    }
  }
}
