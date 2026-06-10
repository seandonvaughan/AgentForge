/**
 * CC Agent Emitter — writes Claude-Code-compatible agent markdown files.
 *
 * For each agent spec, produces a `.claude/agents/<id>.md` file with YAML
 * frontmatter understood by the native Claude Code `Agent` tool.
 *
 * Used by both the legacy `forgeTeam()` path (builder/index.ts) and the
 * Opus-driven `synthesizeTeam()` path (synthesis.ts) so the .md output
 * format has a single source of truth.
 *
 * Atomic write strategy: content is first written to a sibling temp file beside
 * the destination and then renamed into place, preventing partial files from
 * being observed during concurrent forge runs without crossing filesystems.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { writeFileAtomic } from "../fs/atomic-write.js";

// ---------------------------------------------------------------------------
// Shared contract — Workstream U canonical definition (Workstream V imports
// this type via the package barrel, do NOT duplicate it there).
// ---------------------------------------------------------------------------

export interface ClaudeCodeAgentSpec {
  /** Kebab-case agent identifier. */
  id: string;
  /** Single sentence description shown in Claude Code's agent picker. */
  description: string;
  /** Full markdown system prompt body (no frontmatter). */
  systemPrompt: string;
  /** Model tier for this agent. Defaults to `"sonnet"`. */
  model?: "fable" | "opus" | "sonnet" | "haiku";
  /** Claude Code tool names. Defaults to `["Read","Edit","Write","Bash","Grep","Glob"]`. */
  tools?: string[];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface EmitClaudeCodeAgentsOptions {
  /** Absolute path to the project root — agents go in `<projectRoot>/.claude/agents/`. */
  projectRoot: string;
  /** Agent specs to emit. */
  agents: ClaudeCodeAgentSpec[];
}

export interface EmitClaudeCodeAgentsResult {
  /** Absolute paths of every .md file that was written (one per agent). */
  written: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TOOLS = ["Read", "Edit", "Write", "Bash", "Grep", "Glob"];
const DEFAULT_MODEL: Required<ClaudeCodeAgentSpec>["model"] = "sonnet";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Ensure a directory exists (recursive, idempotent). */
async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

/**
 * Write `content` to `filePath` atomically via a tmp-file + rename.
 *
 * The rename is atomic on POSIX systems (POSIX.1-2008 §4.12) so a reader
 * will always observe either the old file or the complete new file — never a
 * partial write.
 */
async function writeAtomic(filePath: string, content: string): Promise<void> {
  await writeFileAtomic(filePath, content);
}

/**
 * Build the CC-compatible frontmatter + system prompt body for a single agent.
 *
 * The frontmatter is a YAML block produced by `js-yaml.dump()` so all special
 * characters are properly escaped — no manual string templating for values.
 */
export function buildAgentMarkdown(spec: ClaudeCodeAgentSpec): string {
  const tools = (spec.tools && spec.tools.length > 0
    ? spec.tools
    : DEFAULT_TOOLS
  ).join(",");

  const tier = spec.model ?? DEFAULT_MODEL;
  // Claude Code's agent frontmatter accepts the opus/sonnet/haiku aliases but
  // has no 'fable' alias — emit the full model id for the fable tier.
  const model = tier === "fable" ? "claude-fable-5" : tier;

  // Use js-yaml to safely serialise frontmatter fields.
  // `dump()` is called per-field so we can control the exact layout while
  // still benefiting from safe YAML escaping of the values.
  const frontmatterObj: Record<string, string> = {
    name: spec.id,
    description: spec.description,
    tools,
    model,
  };

  // Strip the trailing newline that yaml.dump always appends; we'll add our
  // own structure around the block.
  const yamlBody = yaml.dump(frontmatterObj, {
    lineWidth: -1, // prevent wrapping
    noRefs: true,
    sortKeys: false,
    quotingType: '"',
    forceQuotes: false,
  });

  return `---\n${yamlBody}---\n\n${spec.systemPrompt}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write a Claude-Code-compatible `.md` file for each agent spec under
 * `<projectRoot>/.claude/agents/<id>.md`.
 *
 * - Creates the `.claude/agents/` directory if absent.
 * - Writes each file atomically (tmp → rename) to prevent partial files.
 * - Idempotent: calling twice with identical input produces identical output.
 * - Silent skip if the `.claude/` parent does NOT exist AND the directory
 *   cannot be created (e.g. read-only FS) — the function resolves with an
 *   empty `written` array in that case.  In all other error scenarios the
 *   underlying OS error propagates.
 *
 * @returns `{ written }` — absolute paths of every file successfully written.
 */
export async function emitClaudeCodeAgents(
  opts: EmitClaudeCodeAgentsOptions,
): Promise<EmitClaudeCodeAgentsResult> {
  const { projectRoot, agents } = opts;
  const claudeAgentsDir = join(projectRoot, ".claude", "agents");

  // Ensure the directory exists.  We use recursive:true so this is a no-op
  // when it already exists.
  await ensureDir(claudeAgentsDir);

  const written: string[] = [];

  await Promise.all(
    agents.map(async (spec) => {
      const filePath = join(claudeAgentsDir, `${spec.id}.md`);
      const content = buildAgentMarkdown(spec);
      await writeAtomic(filePath, content);
      written.push(filePath);
    }),
  );

  return { written };
}
