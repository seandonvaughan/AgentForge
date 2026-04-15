/**
 * Integration Detector scanner for AgentForge (Haiku-tier).
 *
 * Recursively walks a project directory and scans file contents for references
 * to external integrations: Jira ticket keys, Confluence URLs, and Slack
 * webhook/workspace URLs and channel mentions.
 *
 * Returns a deduplicated list of `IntegrationRef` objects.
 *
 * Uses only Node.js built-in modules (fs, path).
 */

import { readdir, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import type { IntegrationRef } from "../types/analysis.js";

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
 * File extensions to scan.
 * Includes source code files, config files, and document files.
 */
const SCAN_EXTENSIONS = new Set([
  // Documents
  ".md",
  ".txt",
  // Source code
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
  ".cs",
  ".sh",
  // Config
  ".yaml",
  ".yml",
  ".json",
  ".toml",
  ".env",
  ".ini",
  ".conf",
  ".xml",
]);

// ---------------------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------------------

/**
 * Jira ticket key pattern: one or more uppercase letters followed by a hyphen
 * and one or more digits. Must be preceded by a non-word character (or start
 * of string) to avoid false positives inside longer identifiers.
 *
 * Examples: PROJ-123, MYPROJECT-1, BACKEND-42
 */
const JIRA_TICKET_RE = /(?<![a-z])([A-Z][A-Z0-9]+-[0-9]+)/g;

/**
 * Jira URL pattern: atlassian.net/browse/ paths.
 */
const JIRA_URL_RE = /https?:\/\/[a-zA-Z0-9.-]+\.atlassian\.net\/(?:browse|jira)[^\s"')>]*/g;

/**
 * Confluence URL patterns:
 * - atlassian.net/wiki paths
 * - confluence.* hostnames
 */
const CONFLUENCE_ATLASSIAN_RE =
  /https?:\/\/[a-zA-Z0-9.-]+\.atlassian\.net\/wiki[^\s"')>]*/g;
const CONFLUENCE_HOST_RE =
  /https?:\/\/confluence\.[a-zA-Z0-9.-]+[^\s"')>]*/g;

/**
 * Slack webhook URL pattern: hooks.slack.com/services/...
 */
const SLACK_WEBHOOK_RE = /https?:\/\/hooks\.slack\.com\/services\/[^\s"')>]*/g;

/**
 * Slack workspace URL pattern: *.slack.com (excluding hooks subdomain).
 */
const SLACK_WORKSPACE_RE = /https?:\/\/(?!hooks\.)[a-zA-Z0-9-]+\.slack\.com[^\s"')>]*/g;

/**
 * Slack channel name pattern — matched per line only on lines that also
 * contain the word "slack" (case-insensitive). The channel name must start
 * with a lowercase letter and may contain letters, digits, underscores, and
 * hyphens.
 */
const SLACK_CHANNEL_RE = /#([a-z][a-z0-9_-]+)/gi;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collects all file paths under `dir`, skipping directories
 * listed in SKIP_DIRS.
 */
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
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Extract all regex matches from `content` and return them as an array.
 * The regex is reset before use to ensure it starts from position 0.
 */
function extractMatches(content: string, re: RegExp): string[] {
  re.lastIndex = 0;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    matches.push(m[0]);
  }
  return matches;
}

/**
 * Scan a single file and collect all integration references found in it.
 */
async function scanFile(filePath: string): Promise<IntegrationRef[]> {
  const ext = extname(filePath).toLowerCase();
  if (!SCAN_EXTENSIONS.has(ext)) return [];

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const refs: IntegrationRef[] = [];

  // Jira tickets
  for (const match of extractMatches(content, JIRA_TICKET_RE)) {
    refs.push({ type: "jira", ref: match });
  }

  // Jira URLs
  for (const match of extractMatches(content, JIRA_URL_RE)) {
    refs.push({ type: "jira", ref: match });
  }

  // Confluence atlassian.net/wiki URLs
  for (const match of extractMatches(content, CONFLUENCE_ATLASSIAN_RE)) {
    refs.push({ type: "confluence", ref: `confluence:${match}` });
  }

  // Confluence confluence.* host URLs
  for (const match of extractMatches(content, CONFLUENCE_HOST_RE)) {
    refs.push({ type: "confluence", ref: `confluence:${match}` });
  }

  // Slack webhooks
  for (const match of extractMatches(content, SLACK_WEBHOOK_RE)) {
    refs.push({ type: "slack", ref: match });
  }

  // Slack workspace URLs
  for (const match of extractMatches(content, SLACK_WORKSPACE_RE)) {
    refs.push({ type: "slack", ref: match });
  }

  // Slack channel mentions: scan each line that contains "slack" for #channel
  for (const line of content.split("\n")) {
    if (/slack/i.test(line)) {
      SLACK_CHANNEL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = SLACK_CHANNEL_RE.exec(line)) !== null) {
        refs.push({ type: "slack", ref: m[0] });
      }
    }
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Walk a project directory and return a deduplicated list of all external
 * integration references found across source files, configs, and documents.
 *
 * Skips node_modules, .git, dist, and other build/tooling directories.
 * Unreadable files are silently ignored.
 */
export async function detectIntegrations(
  projectRoot: string,
): Promise<IntegrationRef[]> {
  const allPaths = await walkDirectory(projectRoot);

  const allRefs: IntegrationRef[] = [];

  const BATCH_SIZE = 50;
  for (let i = 0; i < allPaths.length; i += BATCH_SIZE) {
    const batch = allPaths.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map((p) => scanFile(p)));
    for (const fileRefs of batchResults) {
      allRefs.push(...fileRefs);
    }
  }

  // Deduplicate by (type, ref) composite key
  const seen = new Set<string>();
  const unique: IntegrationRef[] = [];
  for (const ref of allRefs) {
    const key = `${ref.type}::${ref.ref}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(ref);
    }
  }

  return unique;
}
