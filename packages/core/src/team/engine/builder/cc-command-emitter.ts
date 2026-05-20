/**
 * CC Command Emitter — writes Claude-Code-compatible slash-command stub files.
 *
 * For each team agent, produces a `.claude/commands/team-<id>.md` file so
 * power users can hot-key any forged role in any CC session by typing
 * `/team-<id> <task>`.
 *
 * Used by both the legacy `forgeTeam()` path (builder/index.ts) and the
 * Opus-driven `forgeTeamAgentDriven()` orchestrator (agent-driven-forge.ts).
 *
 * Atomic write strategy: content is first written to a sibling temp file beside
 * the destination and then renamed into place, preventing partial files from
 * being observed during concurrent forge runs without crossing filesystems.
 *
 * Skip behaviour: if the `.claude/` directory does NOT exist at the project root,
 * the function resolves immediately with `{ written: [] }` — no directory is
 * created.  This lets projects that have not opted in to Claude Code remain
 * untouched.
 */

import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../fs/atomic-write.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TeamCommandSpec {
  /** Kebab-case agent identifier — used in the command file name and body. */
  id: string;
  /** One-sentence description shown in Claude Code's command picker. */
  description: string;
}

export interface EmitClaudeCodeTeamCommandsOptions {
  /** Absolute path to the project root — commands go in `<projectRoot>/.claude/commands/`. */
  projectRoot: string;
  /** Agent specs to emit commands for. */
  agents: TeamCommandSpec[];
}

export interface EmitClaudeCodeTeamCommandsResult {
  /** Absolute paths of every .md file that was written (one per agent). */
  written: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Return true if the given path exists (any kind). */
async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

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
 * Build the CC slash-command markdown for a single team agent.
 *
 * The frontmatter uses only plain strings, so no js-yaml round-trip is needed
 * for safety — the values are interpolated as single-line strings with no
 * special characters.  The description field is the only user-supplied string;
 * it is placed in the frontmatter verbatim (CC parses it as a plain YAML
 * scalar).
 *
 * If the description ever needs quoting (e.g. contains `:` or `#`), the
 * caller is expected to pass it already sanitised, or the frontmatter will
 * be re-generated via js-yaml in a future hardening pass.
 */
export function buildCommandMarkdown(spec: TeamCommandSpec): string {
  const { id, description } = spec;

  // Frontmatter — two static fields that CC reads for the command picker.
  const frontmatter = [
    `---`,
    `description: Invoke the ${id} agent with a task. Wraps /agentforge:invoke for hot-key access.`,
    `argument-hint: <task description>`,
    `---`,
  ].join("\n");

  // Command body — instructions the calling Claude instance follows.
  const body = [
    `# Team: ${id}`,
    ``,
    description,
    ``,
    `## What to do`,
    ``,
    `Invoke the \`${id}\` agent via the Agent tool (or \`/agentforge:invoke ${id}\` if outside a CC session) on the user's task: \`$ARGUMENTS\`.`,
    ``,
    `The agent is loaded from \`.claude/agents/${id}.md\` (forged by AgentForge).`,
  ].join("\n");

  return `${frontmatter}\n\n${body}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write a Claude-Code-compatible slash-command `.md` file for each team agent
 * under `<projectRoot>/.claude/commands/team-<id>.md`.
 *
 * - **Skips silently** if `<projectRoot>/.claude/` does NOT exist (opt-out).
 * - Creates the `.claude/commands/` sub-directory if absent.
 * - Writes each file atomically (tmp → rename) to prevent partial files.
 * - Idempotent: calling twice with identical input produces identical output.
 *
 * @returns `{ written }` — absolute paths of every file successfully written.
 */
export async function emitClaudeCodeTeamCommands(
  opts: EmitClaudeCodeTeamCommandsOptions,
): Promise<EmitClaudeCodeTeamCommandsResult> {
  const { projectRoot, agents } = opts;
  const claudeDir = join(projectRoot, ".claude");

  // Skip silently if the .claude/ directory doesn't exist — the project has
  // not opted in to Claude Code.
  if (!(await pathExists(claudeDir))) {
    return { written: [] };
  }

  const commandsDir = join(claudeDir, "commands");
  await ensureDir(commandsDir);

  const written: string[] = [];

  await Promise.all(
    agents.map(async (spec) => {
      const filePath = join(commandsDir, `team-${spec.id}.md`);
      const content = buildCommandMarkdown(spec);
      await writeAtomic(filePath, content);
      written.push(filePath);
    }),
  );

  return { written };
}
