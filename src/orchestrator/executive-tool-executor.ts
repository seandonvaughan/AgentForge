/**
 * ExecutiveToolExecutor — AgentForge v6.0 P1-5
 *
 * Parses structured tool invocations from an agent's text response and
 * executes them as real side-effects against the filesystem and lifecycle
 * manager.
 *
 * Supported invocation formats
 * ─────────────────────────────
 *  1. Inline keyword:  TOOL: toolName(arg1, arg2)
 *  2. JSON block:      { "tool": "toolName", "args": { ... } }
 *
 * Supported tools
 * ───────────────
 *  createSprint(version, title, items, budget?, teamSize?)
 *    → Writes .agentforge/sprints/v<version>.json
 *
 *  defineStandard(key, value, category?)
 *    → Appends / updates .agentforge/standards.yaml
 *
 *  hirePending(teamId, role, seniority, skills?, justification?)
 *    → Records a HiringRecommendation via lifecycleManager.requestHire()
 *
 *  escalate(message, priority?, targetAgent?)
 *    → Writes a structured escalation to .agentforge/escalations/<ts>.json
 *
 * Export:
 *   parseToolInvocations(response) → ToolInvocation[]
 *   executeTools(invocations, context) → Promise<ToolExecutionResult[]>
 */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentLifecycleManager } from "../lifecycle/agent-lifecycle-manager.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A parsed tool call extracted from an agent response. */
export interface ToolInvocation {
  /** Tool name, e.g. "createSprint". */
  tool: string;
  /** Arguments passed to the tool. */
  args: Record<string, unknown>;
  /** Raw source text from which this invocation was extracted. */
  rawSource: string;
}

/** Result of executing a single tool invocation. */
export interface ToolExecutionResult {
  tool: string;
  success: boolean;
  /** Human-readable description of what was done. */
  message: string;
  /** Any data produced (e.g. file path written). */
  data?: unknown;
  error?: string;
}

/** Context required by executeTools. */
export interface ExecutiveToolContext {
  /**
   * Root of the .agentforge directory.
   * Defaults to process.cwd() + "/.agentforge".
   */
  agentforgeDir?: string;

  /** Optional lifecycle manager for hiring-related tools. */
  lifecycleManager?: AgentLifecycleManager;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Matches: TOOL: toolName(anything) */
const KEYWORD_RE = /TOOL:\s*([A-Za-z][A-Za-z0-9_]*)(\([^)]*\))?/g;

/** Matches bare JSON objects with a "tool" key in the text. */
const JSON_OBJECT_RE = /\{[\s\S]*?"tool"\s*:\s*"[^"]+"[\s\S]*?\}/g;

/** Parse a simple positional argument list: (arg1, arg2, ...) */
function parsePositionalArgs(raw: string): string[] {
  // Remove surrounding parens
  const inner = raw.replace(/^\(|\)$/g, "").trim();
  if (!inner) return [];
  return inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
}

/**
 * Scan an agent's text response for tool invocations.
 *
 * Supports two syntaxes:
 *   TOOL: createSprint("6.1", "My Sprint", [...])
 *   { "tool": "createSprint", "args": { "version": "6.1" } }
 *
 * Returns a deduplicated list of ToolInvocation objects.
 */
export function parseToolInvocations(agentResponse: string): ToolInvocation[] {
  const invocations: ToolInvocation[] = [];
  const seen = new Set<string>();

  // --- Pattern 1: TOOL: keyword syntax ---
  for (const match of agentResponse.matchAll(KEYWORD_RE)) {
    const tool = match[1];
    const rawArgs = match[2] ?? "()";
    const positional = parsePositionalArgs(rawArgs);

    // Map positional args to named args by tool convention
    const args = positionalArgsToNamed(tool, positional);
    const key = `${tool}:${JSON.stringify(args)}`;
    if (!seen.has(key)) {
      seen.add(key);
      invocations.push({ tool, args, rawSource: match[0] });
    }
  }

  // --- Pattern 2: JSON object syntax ---
  for (const match of agentResponse.matchAll(JSON_OBJECT_RE)) {
    try {
      const obj = JSON.parse(match[0]) as { tool?: string; args?: Record<string, unknown> };
      if (!obj.tool) continue;
      const tool = obj.tool;
      const args = obj.args ?? {};
      const key = `${tool}:${JSON.stringify(args)}`;
      if (!seen.has(key)) {
        seen.add(key);
        invocations.push({ tool, args, rawSource: match[0] });
      }
    } catch {
      // Malformed JSON — skip
    }
  }

  return invocations;
}

/** Map positional argument arrays to named args by tool convention. */
function positionalArgsToNamed(tool: string, positional: string[]): Record<string, unknown> {
  const schemas: Record<string, string[]> = {
    createSprint:   ["version", "title", "items", "budget", "teamSize"],
    defineStandard: ["key", "value", "category"],
    hirePending:    ["teamId", "role", "seniority", "skills", "justification"],
    escalate:       ["message", "priority", "targetAgent"],
  };
  const keys = schemas[tool] ?? positional.map((_, i) => `arg${i}`);
  const result: Record<string, unknown> = {};
  keys.forEach((k, i) => {
    if (i < positional.length) result[k] = positional[i];
  });
  return result;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function toolCreateSprint(
  args: Record<string, unknown>,
  agentforgeDir: string,
): Promise<ToolExecutionResult> {
  const version = String(args["version"] ?? "next");
  const title = String(args["title"] ?? `Sprint v${version}`);
  const budget = Number(args["budget"] ?? 100);
  const teamSize = Number(args["teamSize"] ?? 5);

  // items can be a JSON string, an array, or absent
  let items: unknown[] = [];
  if (Array.isArray(args["items"])) {
    items = args["items"] as unknown[];
  } else if (typeof args["items"] === "string") {
    try {
      const parsed = JSON.parse(args["items"]);
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      // treat as a single plaintext description
      items = [{ id: "p0-1", title: String(args["items"]), priority: "P0", status: "pending" }];
    }
  }

  const sprint = {
    version,
    name: title,
    phase: "planning",
    createdAt: new Date().toISOString(),
    items,
    budget,
    teamSize,
  };

  const sprintsDir = join(agentforgeDir, "sprints");
  await mkdir(sprintsDir, { recursive: true });
  const filePath = join(sprintsDir, `v${version}.json`);
  await writeFile(filePath, JSON.stringify(sprint, null, 2), "utf-8");

  return {
    tool: "createSprint",
    success: true,
    message: `Sprint v${version} written to ${filePath}`,
    data: { filePath, version },
  };
}

async function toolDefineStandard(
  args: Record<string, unknown>,
  agentforgeDir: string,
): Promise<ToolExecutionResult> {
  const key = String(args["key"] ?? "unnamed");
  const value = String(args["value"] ?? "");
  const category = String(args["category"] ?? "general");

  const standardsPath = join(agentforgeDir, "standards.yaml");

  // Read existing content or start fresh
  let existing = "";
  if (existsSync(standardsPath)) {
    existing = await readFile(standardsPath, "utf-8");
  }

  // Append or update — simple YAML line approach
  const entry = `  ${key}: "${value.replace(/"/g, '\\"')}"`;
  const categoryHeader = `${category}:`;

  let updated: string;
  if (existing.includes(categoryHeader)) {
    // Append under existing category section
    updated = existing.replace(
      new RegExp(`(${categoryHeader}[\\s\\S]*?)(?=\\n[a-z]|$)`, "m"),
      (section) => `${section.trimEnd()}\n${entry}\n`,
    );
  } else {
    // Add new category block
    updated = `${existing.trimEnd()}\n\n${categoryHeader}\n${entry}\n`;
  }

  await mkdir(agentforgeDir, { recursive: true });
  await writeFile(standardsPath, updated, "utf-8");

  return {
    tool: "defineStandard",
    success: true,
    message: `Standard "${key}" defined under category "${category}"`,
    data: { key, value, category, filePath: standardsPath },
  };
}

async function toolHirePending(
  args: Record<string, unknown>,
  agentforgeDir: string,
  lifecycleManager?: AgentLifecycleManager,
): Promise<ToolExecutionResult> {
  const teamId = String(args["teamId"] ?? "default-team");
  const role = String(args["role"] ?? "specialist") as import("../types/lifecycle.js").AgentRole;
  const seniority = String(args["seniority"] ?? "mid") as import("../types/lifecycle.js").SeniorityLevel;
  const skills = typeof args["skills"] === "string"
    ? args["skills"].split(",").map((s) => s.trim())
    : Array.isArray(args["skills"]) ? (args["skills"] as string[]) : [];
  const justification = String(args["justification"] ?? "Requested by executive agent");

  if (lifecycleManager) {
    const recId = lifecycleManager.requestHire({
      teamId,
      requestedRole: role,
      requestedSeniority: seniority,
      requestedSkills: skills,
      justification,
      requestedBy: "executive-agent",
    });

    return {
      tool: "hirePending",
      success: true,
      message: `Hiring recommendation ${recId} created for ${seniority} ${role} on team ${teamId}`,
      data: { recommendationId: recId, teamId, role, seniority },
    };
  }

  // No lifecycle manager — persist recommendation as JSON
  const pending = {
    id: `hire-${Date.now()}`,
    teamId,
    requestedRole: role,
    requestedSeniority: seniority,
    requestedSkills: skills,
    justification,
    requestedBy: "executive-agent",
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  const hiringDir = join(agentforgeDir, "hiring");
  await mkdir(hiringDir, { recursive: true });
  const filePath = join(hiringDir, `${pending.id}.json`);
  await writeFile(filePath, JSON.stringify(pending, null, 2), "utf-8");

  return {
    tool: "hirePending",
    success: true,
    message: `Hiring recommendation written to ${filePath}`,
    data: { filePath, ...pending },
  };
}

async function toolEscalate(
  args: Record<string, unknown>,
  agentforgeDir: string,
): Promise<ToolExecutionResult> {
  const message = String(args["message"] ?? "Escalation from executive agent");
  const priority = String(args["priority"] ?? "P1");
  const targetAgent = String(args["targetAgent"] ?? "ceo");

  const escalation = {
    id: `esc-${Date.now()}`,
    message,
    priority,
    targetAgent,
    createdAt: new Date().toISOString(),
  };

  const escDir = join(agentforgeDir, "escalations");
  await mkdir(escDir, { recursive: true });
  const filePath = join(escDir, `${escalation.id}.json`);
  await writeFile(filePath, JSON.stringify(escalation, null, 2), "utf-8");

  return {
    tool: "escalate",
    success: true,
    message: `Escalation ${escalation.id} written (${priority} → ${targetAgent})`,
    data: { filePath, escalationId: escalation.id },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a list of parsed tool invocations against the provided context.
 *
 * Tools are executed sequentially. A failure in one tool does NOT abort
 * the remaining tools — each result is captured independently.
 *
 * @param invocations     Parsed tool calls (output of parseToolInvocations).
 * @param context         Execution context (agentforgeDir, lifecycleManager).
 * @returns               One result per invocation.
 */
export async function executeTools(
  invocations: ToolInvocation[],
  context: ExecutiveToolContext = {},
): Promise<ToolExecutionResult[]> {
  const agentforgeDir = context.agentforgeDir ?? join(process.cwd(), ".agentforge");
  const results: ToolExecutionResult[] = [];

  for (const invocation of invocations) {
    try {
      let result: ToolExecutionResult;

      switch (invocation.tool) {
        case "createSprint":
          result = await toolCreateSprint(invocation.args, agentforgeDir);
          break;

        case "defineStandard":
          result = await toolDefineStandard(invocation.args, agentforgeDir);
          break;

        case "hirePending":
          result = await toolHirePending(invocation.args, agentforgeDir, context.lifecycleManager);
          break;

        case "escalate":
          result = await toolEscalate(invocation.args, agentforgeDir);
          break;

        default:
          result = {
            tool: invocation.tool,
            success: false,
            message: `Unknown tool: "${invocation.tool}"`,
            error: `No implementation registered for tool "${invocation.tool}"`,
          };
      }

      results.push(result);
    } catch (err: unknown) {
      results.push({
        tool: invocation.tool,
        success: false,
        message: `Tool "${invocation.tool}" threw an error`,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
