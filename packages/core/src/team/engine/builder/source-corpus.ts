/**
 * Source-corpus picker — selects representative files from a project for
 * the agent-driven forge's synthesis phase.
 *
 * Strategy:
 *   1. Walk `packages/` (or top-level if no packages dir), one subsystem at a time
 *   2. For each subsystem, pick a small set of "load-bearing" files: package.json,
 *      tsconfig.json, the public-surface entrypoint (src/index.ts or similar),
 *      and a few large source files (sorted by LOC, descending)
 *   3. Include README.md and CLAUDE.md at the project root if present
 *   4. Truncate each file's content to a per-file char cap so no single file
 *      monopolizes the budget
 *   5. Stop adding files once the running total approaches `maxChars` (default 160k
 *      ≈ 40k tokens — leaves headroom under the typical 50k-token budget for the
 *      synthesis prompt)
 *
 * Returns ordered (most-load-bearing first) so downstream consumers can
 * truncate from the tail safely.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, basename } from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SourceCorpusFile {
  /** Path relative to projectRoot, forward-slash form. */
  path: string;
  /** File content, possibly truncated. */
  content: string;
  /** True when the file was truncated to fit the per-file cap. */
  truncated: boolean;
}

export interface SourceCorpusOptions {
  /** Absolute path to the project root. */
  projectRoot: string;
  /** Hard cap on total chars across all files (default 160_000 ≈ 40k tokens). */
  maxChars?: number;
  /** Per-file char cap (default 12_000 ≈ 3k tokens). */
  maxFileChars?: number;
}

export interface SourceCorpusResult {
  files: SourceCorpusFile[];
  /** Total chars across all included files. */
  totalChars: number;
  /** Subsystems sampled (informational). */
  subsystemsSampled: string[];
  /** Files considered but skipped due to budget. */
  skipped: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  ".svelte-kit",
  ".claire",
  ".worktrees",
  ".turbo",
  "agents-pre-v22-forge",   // forge audit snapshot — skip
]);

/** Directory-name patterns to skip (matched as suffix on any path segment). */
const SKIP_NAME_PATTERNS = [
  /-export$/,        // dashboard-v1-export, ui-v2-export, etc.
  /\.backup$/,
  /\.snapshot$/,
];

const SOURCE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".svelte",
  ".vue",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".cs",
]);

const LOAD_BEARING_NAMES = new Set([
  "package.json",
  "tsconfig.json",
  "index.ts",
  "index.tsx",
  "main.ts",
  "server.ts",
  "+layout.svelte",
  "+page.svelte",
  "+server.ts",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
]);

interface FileCandidate {
  path: string;
  size: number;
  loadBearing: boolean;
  subsystem: string;
}

async function* walkFiles(
  dir: string,
  projectRoot: string,
): AsyncGenerator<{ abs: string; rel: string; size: number }> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    if (SKIP_NAME_PATTERNS.some((p) => p.test(e.name))) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkFiles(abs, projectRoot);
    } else if (e.isFile()) {
      try {
        const s = await stat(abs);
        const rel = relative(projectRoot, abs).split("\\").join("/");
        yield { abs, rel, size: s.size };
      } catch {
        // unreadable — skip
      }
    }
  }
}

function deriveSubsystem(rel: string): string {
  const parts = rel.split("/");
  if (parts.length === 1) return "root";   // top-level files: package.json, tsconfig.json
  if (parts[0] === "packages" && parts.length >= 2) return `packages/${parts[1]}`;
  if (parts[0] === "apps" && parts.length >= 2) return `apps/${parts[1]}`;
  if (parts[0] === "src") return "src";
  if (parts[0] === "tests" || parts[0] === "test") return "tests";
  if (parts[0] === "scripts") return "scripts";
  if (parts[0] === "docs") return "docs";
  return parts[0] ?? "root";
}

/** Priority weight for a subsystem (lower = picked first). */
function subsystemPriority(subsystem: string): number {
  if (subsystem === "root") return 0;
  if (subsystem.startsWith("packages/")) return 1;
  if (subsystem.startsWith("apps/")) return 2;
  if (subsystem === "src") return 3;
  if (subsystem === "scripts") return 4;
  if (subsystem === "tests") return 5;
  if (subsystem === "docs") return 6;
  return 9;
}

function isSourceFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return SOURCE_EXTS.has(name.slice(dot).toLowerCase());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a representative source corpus for the agent-driven forge.
 *
 * Picks load-bearing files (package.json, tsconfig.json, entrypoints) +
 * the largest source files per subsystem, until the total char budget is
 * exhausted. Each file is truncated to a per-file cap so no single file
 * dominates the corpus.
 */
export async function buildSourceCorpus(
  opts: SourceCorpusOptions,
): Promise<SourceCorpusResult> {
  const { projectRoot } = opts;
  const maxChars = opts.maxChars ?? 160_000;
  const maxFileChars = opts.maxFileChars ?? 12_000;

  // ── Collect all candidate files ──
  const candidates: FileCandidate[] = [];
  for await (const f of walkFiles(projectRoot, projectRoot)) {
    const name = basename(f.rel);
    const loadBearing = LOAD_BEARING_NAMES.has(name);
    if (!loadBearing && !isSourceFile(name)) continue;
    candidates.push({
      path: f.rel,
      size: f.size,
      loadBearing,
      subsystem: deriveSubsystem(f.rel),
    });
  }

  // ── Rank: load-bearing first; then by subsystem priority (packages/* before
  //         random top-level dirs); within a subsystem prefer larger files ──
  candidates.sort((a, b) => {
    if (a.loadBearing !== b.loadBearing) return a.loadBearing ? -1 : 1;
    const pa = subsystemPriority(a.subsystem);
    const pb = subsystemPriority(b.subsystem);
    if (pa !== pb) return pa - pb;
    if (a.subsystem !== b.subsystem) return a.subsystem.localeCompare(b.subsystem);
    return b.size - a.size;
  });

  // ── Greedy pick under budget, capped to N files per subsystem ──
  const PER_SUBSYSTEM_CAP = 4;
  const perSubsystemCount = new Map<string, number>();
  const subsystemsSampled = new Set<string>();
  const files: SourceCorpusFile[] = [];
  let totalChars = 0;
  let skipped = 0;

  for (const c of candidates) {
    const used = perSubsystemCount.get(c.subsystem) ?? 0;
    if (used >= PER_SUBSYSTEM_CAP) {
      skipped++;
      continue;
    }
    if (totalChars >= maxChars) {
      skipped++;
      continue;
    }
    let content: string;
    try {
      content = await readFile(join(projectRoot, c.path), "utf8");
    } catch {
      skipped++;
      continue;
    }
    let truncated = false;
    if (content.length > maxFileChars) {
      content =
        content.slice(0, maxFileChars) +
        `\n\n... [truncated ${content.length - maxFileChars} chars]`;
      truncated = true;
    }
    if (totalChars + content.length > maxChars) {
      skipped++;
      continue;
    }
    files.push({ path: c.path, content, truncated });
    totalChars += content.length;
    perSubsystemCount.set(c.subsystem, used + 1);
    subsystemsSampled.add(c.subsystem);
  }

  return {
    files,
    totalChars,
    subsystemsSampled: [...subsystemsSampled].sort(),
    skipped,
  };
}
