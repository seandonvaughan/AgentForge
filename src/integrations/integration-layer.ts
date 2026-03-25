/**
 * IntegrationLayer for AgentForge Phase 2c: MCP Integration.
 *
 * Routes typed IntegrationActions to MCP tool calls.
 *
 * NOTE: dispatch() is a STUB. Actual MCP tool calling requires the
 * Claude Code runtime. The important thing is the typed interface and
 * routing logic — real dispatch is a runtime concern for Phase 3.
 */

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
      const targets = new Set<IntegrationTarget>();
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
   * Currently a STUB: logs the action and returns a success result.
   * Real MCP tool calling is handled by the Claude Code runtime in Phase 3.
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
      default: {
        // Exhaustiveness check — TypeScript will error if a case is missing.
        const _exhaustive: never = action;
        throw new Error(`Unhandled action type: ${(_exhaustive as IntegrationAction).type}`);
      }
    }
  }
}
