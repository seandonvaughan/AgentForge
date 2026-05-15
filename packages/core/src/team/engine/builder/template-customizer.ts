/**
 * Template Customizer — injects project-specific context into agent templates.
 *
 * Takes a generic {@link AgentTemplate} and a {@link FullScanResult}, then
 * returns a new template with placeholders replaced, file patterns updated,
 * and context paths populated based on what actually exists in the project.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentTemplate } from "../types/agent.js";
import type { FullScanResult } from "../scanner/index.js";
import {
  loadMemoryEntries,
  curateLearnings,
  formatLearningsBlock,
} from "./memory-curator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a human-readable stack description from scan results. */
function buildStackDescription(scan: FullScanResult): string {
  const parts: string[] = [];

  // Languages (sorted by file count, descending)
  const langEntries = Object.entries(scan.files.languages).sort(
    (a, b) => b[1] - a[1],
  );
  if (langEntries.length > 0) {
    const top = langEntries.slice(0, 5).map(([lang]) => lang);
    parts.push(top.join(", "));
  }

  // Frameworks
  if (scan.files.frameworks_detected.length > 0) {
    parts.push(scan.files.frameworks_detected.join(", "));
  }

  // Package manager
  if (scan.dependencies.package_manager !== "unknown") {
    parts.push(`Package manager: ${scan.dependencies.package_manager}`);
  }

  // CI
  if (scan.ci.ci_provider !== "none") {
    parts.push(`CI: ${scan.ci.ci_provider}`);
  }

  return parts.join(" | ") || "Unknown stack";
}

/** Derive coding conventions from what the scan found. */
function buildConventionsDescription(scan: FullScanResult): string {
  const conventions: string[] = [];

  // Linters / formatters
  if (scan.dependencies.linters.length > 0) {
    conventions.push(`Linters: ${scan.dependencies.linters.join(", ")}`);
  }

  // Test frameworks
  if (scan.dependencies.test_frameworks.length > 0) {
    conventions.push(
      `Testing: ${scan.dependencies.test_frameworks.join(", ")}`,
    );
  }

  // Build tools
  if (scan.dependencies.build_tools.length > 0) {
    conventions.push(
      `Build: ${scan.dependencies.build_tools.join(", ")}`,
    );
  }

  // Common patterns detected across files
  const patternCounts = new Map<string, number>();
  for (const file of scan.files.files) {
    for (const p of file.patterns) {
      patternCounts.set(p, (patternCounts.get(p) ?? 0) + 1);
    }
  }
  const topPatterns = [...patternCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => name);
  if (topPatterns.length > 0) {
    conventions.push(`Common patterns: ${topPatterns.join(", ")}`);
  }

  return conventions.join(" | ") || "No specific conventions detected";
}

/**
 * Compute file extension glob patterns (e.g. `"**\/*.ts"`) for every
 * language actually found in the scan.
 */
function buildFilePatterns(scan: FullScanResult): string[] {
  const extMap: Record<string, string> = {
    TypeScript: "**/*.ts",
    JavaScript: "**/*.js",
    Python: "**/*.py",
    Rust: "**/*.rs",
    Go: "**/*.go",
    Java: "**/*.java",
    Kotlin: "**/*.kt",
    Ruby: "**/*.rb",
    PHP: "**/*.php",
    "C#": "**/*.cs",
    "C++": "**/*.cpp",
    C: "**/*.c",
    Swift: "**/*.swift",
    Dart: "**/*.dart",
    Vue: "**/*.vue",
    Svelte: "**/*.svelte",
    Elixir: "**/*.ex",
    Haskell: "**/*.hs",
    Scala: "**/*.scala",
    Lua: "**/*.lua",
    Shell: "**/*.sh",
    SQL: "**/*.sql",
    GraphQL: "**/*.graphql",
    Protobuf: "**/*.proto",
    Terraform: "**/*.tf",
    YAML: "**/*.yaml",
    JSON: "**/*.json",
    HTML: "**/*.html",
    CSS: "**/*.css",
    SCSS: "**/*.scss",
  };

  const patterns: string[] = [];
  for (const lang of Object.keys(scan.files.languages)) {
    const pattern = extMap[lang];
    if (pattern) {
      patterns.push(pattern);
    }
  }

  // Also add TSX/JSX if TypeScript/JavaScript detected
  if (scan.files.languages["TypeScript"]) {
    patterns.push("**/*.tsx");
  }
  if (scan.files.languages["JavaScript"]) {
    patterns.push("**/*.jsx", "**/*.mjs", "**/*.cjs");
  }

  return [...new Set(patterns)];
}

/** Identify project-specific context files that likely exist. */
function buildProjectSpecificPaths(scan: FullScanResult): string[] {
  const paths: string[] = [];

  // Look for common project root files
  const rootFiles = [
    "README.md",
    "CONTRIBUTING.md",
    "CHANGELOG.md",
    "LICENSE",
    ".env.example",
    ".editorconfig",
  ];

  const allFilePaths = new Set(scan.files.files.map((f) => f.file_path));

  for (const file of rootFiles) {
    if (allFilePaths.has(file)) {
      paths.push(file);
    }
  }

  // Config files based on detected package manager / frameworks
  const configFiles = [
    "package.json",
    "tsconfig.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "Makefile",
    "docker-compose.yml",
    "docker-compose.yaml",
    ".prettierrc",
    ".eslintrc.json",
    ".eslintrc.js",
    "eslint.config.js",
    "biome.json",
  ];

  for (const file of configFiles) {
    if (allFilePaths.has(file)) {
      paths.push(file);
    }
  }

  // CI config files
  for (const ciFile of scan.ci.config_files) {
    paths.push(ciFile);
  }

  return [...new Set(paths)];
}

/** Filter auto_include entries to only those that have matching files. */
function filterAutoInclude(
  autoInclude: string[],
  scan: FullScanResult,
): string[] {
  const allFilePaths = scan.files.files.map((f) => f.file_path);

  return autoInclude.filter((pattern) => {
    // If it ends with / it's a directory pattern — check if any file starts with it
    if (pattern.endsWith("/")) {
      return allFilePaths.some((fp) => fp.startsWith(pattern));
    }
    // If it contains a glob wildcard, keep it (we can't easily verify)
    if (pattern.includes("*")) {
      return true;
    }
    // Otherwise check if the exact file exists
    return allFilePaths.some((fp) => fp === pattern || fp.endsWith(`/${pattern}`));
  });
}

/**
 * Derive a 1-3 sentence project purpose statement from README + package.json.
 *
 * Strategy: prefer the README's first non-heading paragraph (skipping badges),
 * fall back to package.json's `description` field, fall back to a generic line.
 * The result is condensed onto a single line so it splices cleanly into a
 * `{project_purpose}` placeholder.
 */
function buildProjectPurpose(projectRoot: string): string {
  // README first
  const readmePath = join(projectRoot, "README.md");
  if (existsSync(readmePath)) {
    try {
      const raw = readFileSync(readmePath, "utf8");
      const paragraphs = raw.split(/\n\s*\n/);
      for (const p of paragraphs) {
        const cleaned = p
          .replace(/^#+\s.*$/gm, "")          // headings
          .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // image badges
          .replace(/\[[^\]]*\]\([^)]*\)/g, "")  // link text
          .replace(/^>.*$/gm, "")                // blockquotes
          .replace(/<[^>]+>/g, "")               // raw HTML
          .replace(/`[^`]*`/g, "")               // inline code
          .replace(/\s+/g, " ")
          .trim();
        if (cleaned.length >= 60) {
          return cleaned.length > 400 ? cleaned.slice(0, 397) + "..." : cleaned;
        }
      }
    } catch {
      // fall through to package.json
    }
  }

  // package.json description
  const pkgPath = join(projectRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { description?: string };
      if (pkg.description && pkg.description.length > 10) return pkg.description;
    } catch {
      // fall through
    }
  }

  return "This project's purpose has not been documented yet — read CLAUDE.md, README.md, and recent commits for context before acting.";
}

/**
 * Build a "## Key Subsystems" bullet list from monorepo `packages/*` (or
 * `apps/*`) directories. Each entry is the package name + the first non-empty
 * description from its `package.json` if present.
 *
 * Returns an empty string when no subsystems are detected (single-package
 * project) so the template's `{key_subsystems}` placeholder degrades cleanly.
 */
function buildKeySubsystems(scan: FullScanResult, projectRoot: string): string {
  const candidates = [join(projectRoot, "packages"), join(projectRoot, "apps")];
  const bullets: string[] = [];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
      entries = readdirSync(dir).filter((e) => {
        try {
          return statSync(join(dir, e)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      continue;
    }
    for (const name of entries.sort()) {
      const pkgFile = join(dir, name, "package.json");
      let desc = "";
      if (existsSync(pkgFile)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as {
            description?: string;
          };
          desc = pkg.description ?? "";
        } catch {
          desc = "";
        }
      }
      bullets.push(desc ? `- **${name}** — ${desc}` : `- **${name}**`);
    }
  }
  // Mark scan parameter as intentionally unused for now — kept in signature
  // so future improvements can leverage scan.files.directories without a churn.
  void scan;
  return bullets.length === 0 ? "" : bullets.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Options accepted by {@link customizeTemplate} for project-context injection. */
export interface CustomizeOptions {
  /**
   * Absolute path to the project root. Required for memory-derived learnings
   * curation and for reading README / packages.
   */
  projectRoot?: string;
  /**
   * Override the curated lessons selection (e.g. for tests). When omitted,
   * the customizer reads `.agentforge/memory/*.jsonl` from `projectRoot` and
   * calls {@link curateLearnings}.
   */
  learnings?: string[];
}

/**
 * Customize an agent template with project-specific context derived from
 * scan results.
 *
 * Returns a **new** template object — the original is not mutated.
 *
 * Placeholders supported in the template's `system_prompt`:
 * - `{project_name}`             — project's human name
 * - `{detected_stack}`           — languages / frameworks / package manager / CI
 * - `{detected_conventions}`     — linters, test frameworks, build tools, common patterns
 * - `{project_purpose}`          — 1-3 sentence purpose from README or package.json
 * - `{key_subsystems}`           — markdown bullet list of packages/apps
 * - `{baked_learnings}`          — markdown bullet list of curated lessons from memory
 *
 * @param template    - The base agent template.
 * @param scan        - Full scan results from the project.
 * @param projectName - Human-readable project name.
 * @param options     - Optional project root + learnings override (used by tests).
 */
export function customizeTemplate(
  template: AgentTemplate,
  scan: FullScanResult,
  projectName: string,
  options: CustomizeOptions = {},
): AgentTemplate {
  const detectedStack = buildStackDescription(scan);
  const detectedConventions = buildConventionsDescription(scan);

  // Project purpose + subsystems (require a projectRoot; degrade cleanly when absent)
  const projectRoot = options.projectRoot;
  const projectPurpose = projectRoot
    ? buildProjectPurpose(projectRoot)
    : "Project purpose not derivable without a projectRoot.";
  const keySubsystems = projectRoot ? buildKeySubsystems(scan, projectRoot) : "";

  // Curate learnings from memory unless caller overrides
  let learnings: string[];
  if (options.learnings) {
    learnings = options.learnings;
  } else if (projectRoot) {
    const memEntries = loadMemoryEntries(projectRoot);
    learnings = curateLearnings(template, memEntries);
  } else {
    learnings = [];
  }
  const bakedLearnings = formatLearningsBlock(learnings);

  // Replace placeholders in the system prompt
  const system_prompt = template.system_prompt
    .replace(/\{project_name\}/g, projectName)
    .replace(/\{detected_stack\}/g, detectedStack)
    .replace(/\{detected_conventions\}/g, detectedConventions)
    .replace(/\{project_purpose\}/g, projectPurpose)
    .replace(/\{key_subsystems\}/g, keySubsystems)
    .replace(/\{baked_learnings\}/g, bakedLearnings);

  // Update file patterns based on actual languages found
  const scanPatterns = buildFilePatterns(scan);
  const file_patterns =
    scanPatterns.length > 0
      ? [...new Set([...template.triggers.file_patterns, ...scanPatterns])]
      : template.triggers.file_patterns;

  // Build project-specific context
  const project_specific = buildProjectSpecificPaths(scan);

  // Filter auto_include to files that actually exist
  const auto_include = filterAutoInclude(template.context.auto_include, scan);

  return {
    ...template,
    system_prompt,
    learnings,
    triggers: {
      ...template.triggers,
      file_patterns,
    },
    context: {
      ...template.context,
      auto_include,
      project_specific,
    },
  };
}
