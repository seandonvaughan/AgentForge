/**
 * Code Comment Miner for AgentForge (Haiku-tier).
 *
 * Recursively walks a project directory and extracts structured comment
 * annotations from source files: TODO/FIXME/HACK markers, architecture
 * decision records (Decision:, Rationale:), and general NOTE comments.
 *
 * Uses only Node.js built-in modules (fs, path).
 */

import { readdir, readFile } from "node:fs/promises";
import { join, extname, relative } from "node:path";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** A structured comment annotation extracted from a source file. */
export interface CommentNote {
  /** The comment text (stripped of the comment marker and keyword prefix). */
  text: string;
  /** File path relative to the project root. */
  file: string;
  /** 1-based line number of the comment. */
  line: number;
  /** Comment category: "TODO", "FIXME", "HACK", "NOTE", "DECISION", "RATIONALE". */
  type: string;
}

/** Categorised results returned by mineComments. */
export interface CommentMineResult {
  /** Action-required markers: TODO, FIXME, HACK. */
  todos: CommentNote[];
  /** Architecture decision records: Decision:, Rationale:. */
  decisions: CommentNote[];
  /** Informational annotations: NOTE. */
  notes: CommentNote[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directories to skip during recursive traversal. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".agentforge",
  "coverage",
  "__pycache__",
  ".next",
  ".nuxt",
]);

/**
 * File extensions whose content should be scanned for comments.
 * Covers the primary source-file types from the plan (TS, Python,
 * Go, Rust, Java) as well as common extras.
 */
const SCANNABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".swift",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".sh",
  ".bash",
  ".zsh",
  ".scala",
  ".dart",
  ".ex",
  ".exs",
  ".erl",
  ".hs",
  ".lua",
  ".vue",
  ".svelte",
]);

// ---------------------------------------------------------------------------
// Comment-extraction patterns
// ---------------------------------------------------------------------------

/**
 * Each rule describes:
 *   - pattern: regex that matches a comment line (capture group 1 = trailing text)
 *   - category: which bucket ("todos" | "decisions" | "notes")
 *   - type: the canonical type string stored on CommentNote
 */
interface CommentRule {
  pattern: RegExp;
  category: keyof CommentMineResult;
  type: string;
}

const COMMENT_RULES: CommentRule[] = [
  // --- Action-required markers ---
  {
    pattern: /(?:\/\/|#|\/\*)\s*TODO(?:\([^)]*\))?:?\s*(.+)/i,
    category: "todos",
    type: "TODO",
  },
  {
    pattern: /(?:\/\/|#|\/\*)\s*FIXME(?:\([^)]*\))?:?\s*(.+)/i,
    category: "todos",
    type: "FIXME",
  },
  {
    pattern: /(?:\/\/|#|\/\*)\s*HACK(?:\([^)]*\))?:?\s*(.+)/i,
    category: "todos",
    type: "HACK",
  },
  // --- Architecture decision records ---
  {
    pattern: /(?:\/\/|#|\/\*)\s*Decision:\s*(.+)/i,
    category: "decisions",
    type: "DECISION",
  },
  {
    pattern: /(?:\/\/|#|\/\*)\s*Rationale:\s*(.+)/i,
    category: "decisions",
    type: "RATIONALE",
  },
  // --- Informational notes ---
  {
    pattern: /(?:\/\/|#|\/\*)\s*NOTE(?:\([^)]*\))?:?\s*(.+)/i,
    category: "notes",
    type: "NOTE",
  },
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Recursively collect all file paths under dir, skipping SKIP_DIRS. */
async function walkDirectory(dir: string): Promise<string[]> {
  const results: string[] = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      const nested = await walkDirectory(fullPath);
      results.push(...nested);
    } else if (entry.isFile()) {
      if (SCANNABLE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

/** Extract all CommentNotes from the lines of a single file. */
function extractComments(lines: string[], relativePath: string): CommentNote[] {
  const found: CommentNote[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }

    for (const rule of COMMENT_RULES) {
      const match = rule.pattern.exec(line);
      const text = match?.[1];
      if (text) {
        found.push({
          text: text.trim(),
          file: relativePath,
          line: i + 1,
          type: rule.type,
        });
        // A single line can only match one rule — stop checking this line.
        break;
      }
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Recursively scan a project directory and extract structured comment
 * annotations from source files.
 *
 * @param projectRoot  Absolute path to the project root.
 * @returns  CommentMineResult containing todos, decisions, and notes arrays.
 */
export async function mineComments(projectRoot: string): Promise<CommentMineResult> {
  const result: CommentMineResult = {
    todos: [],
    decisions: [],
    notes: [],
  };

  const filePaths = await walkDirectory(projectRoot);

  await Promise.all(
    filePaths.map(async (filePath) => {
      let content: string;
      try {
        content = await readFile(filePath, "utf-8");
      } catch {
        return;
      }

      const lines = content.split("\n");
      const relativePath = relative(projectRoot, filePath);
      const comments = extractComments(lines, relativePath);

      for (const comment of comments) {
        result[comment.type === "DECISION" || comment.type === "RATIONALE"
          ? "decisions"
          : comment.type === "NOTE"
            ? "notes"
            : "todos"].push(comment);
      }
    })
  );

  return result;
}
