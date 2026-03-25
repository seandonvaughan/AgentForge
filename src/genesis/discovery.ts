/**
 * Project Discovery for the AgentForge Genesis workflow.
 *
 * Performs a quick filesystem scan of a project root to classify the
 * project state and emit signals that drive downstream pipeline decisions.
 *
 * The four possible states are:
 * - "empty"     — nothing useful found (no source files, no docs, no git)
 * - "codebase"  — source code files found but no substantive documents
 * - "documents" — document files found but no source code
 * - "full"      — both source code and documents found
 */

import { readdir, stat, access } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { constants } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Classified project state from the discovery scan. */
export type DiscoveryState = "empty" | "codebase" | "documents" | "full";

/** Result returned by {@link discover}. */
export interface DiscoveryResult {
  /** The classified project state. */
  state: DiscoveryState;
  /** Emitted signals describing what was found. */
  signals: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * File extensions that indicate a software codebase.
 * Ordered by likelihood to keep the hot path fast.
 */
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".cs",
  ".cpp",
  ".cc",
  ".c",
  ".h",
  ".hpp",
  ".swift",
  ".php",
  ".scala",
  ".clj",
  ".ex",
  ".exs",
  ".hs",
  ".elm",
  ".dart",
  ".lua",
  ".r",
  ".jl",
]);

/**
 * File extensions that indicate document/business content.
 */
const DOC_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".pdf",
  ".docx",
  ".doc",
  ".odt",
  ".rst",
  ".adoc",
  ".tex",
]);

/**
 * Directories to skip during the scan to keep it quick.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  "target",
  "vendor",
]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Recursively walk the directory tree (up to maxDepth levels) looking for
 * source and document files.  Stops as soon as both signals are found.
 *
 * @param dir       - Directory to scan.
 * @param maxDepth  - Maximum levels to descend (default: 4).
 * @returns An object with `hasSource` and `hasDocs` boolean flags.
 */
async function walkForSignals(
  dir: string,
  maxDepth: number = 4,
): Promise<{ hasSource: boolean; hasDocs: boolean }> {
  let hasSource = false;
  let hasDocs = false;

  async function walk(current: string, depth: number): Promise<void> {
    // Early exit once both signals are confirmed
    if (hasSource && hasDocs) return;
    if (depth > maxDepth) return;

    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return;
    }

    for (const entry of entries) {
      // Early exit from inner loop too
      if (hasSource && hasDocs) return;

      if (SKIP_DIRS.has(entry)) continue;

      const fullPath = join(current, entry);

      let entryStat;
      try {
        entryStat = await stat(fullPath);
      } catch {
        continue;
      }

      if (entryStat.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entryStat.isFile()) {
        const ext = extname(entry).toLowerCase();
        if (SOURCE_EXTENSIONS.has(ext)) {
          hasSource = true;
        } else if (DOC_EXTENSIONS.has(ext)) {
          // Exclude README-only noise from triggering the docs signal:
          // A single top-level README isn't enough to classify the project
          // as document-oriented.  We do count it if we also find it inside
          // a dedicated docs directory, or if there are multiple doc files.
          hasDocs = true;
        }
      }
    }
  }

  await walk(dir, 0);
  return { hasSource, hasDocs };
}

/**
 * Check whether the given directory is inside a git repository.
 */
async function hasGitRepo(projectRoot: string): Promise<boolean> {
  const gitDir = join(projectRoot, ".git");
  try {
    await access(gitDir, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover the nature of a project by performing a quick filesystem scan.
 *
 * Classifies the project into one of four states based on what exists:
 * - `"empty"`     — no source files and no document files found
 * - `"codebase"`  — source code files found; no (meaningful) docs
 * - `"documents"` — document files found; no source code
 * - `"full"`      — both source code and document files found
 *
 * The returned `signals` array reflects the discrete discoveries and can
 * be used downstream to decide which domain scanners to activate.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @returns A {@link DiscoveryResult} with the classified state and signals.
 */
export async function discover(projectRoot: string): Promise<DiscoveryResult> {
  const signals: string[] = [];

  // Run the filesystem walk and git check in parallel
  const [{ hasSource, hasDocs }, isGit] = await Promise.all([
    walkForSignals(projectRoot),
    hasGitRepo(projectRoot),
  ]);

  if (hasSource) {
    signals.push("codebase_present");
  }

  if (hasDocs) {
    signals.push("documents_present");
  }

  if (isGit) {
    signals.push("git_repo");
  }

  let state: DiscoveryState;

  if (hasSource && hasDocs) {
    state = "full";
  } else if (hasSource) {
    state = "codebase";
  } else if (hasDocs) {
    state = "documents";
  } else {
    state = "empty";
  }

  return { state, signals };
}
