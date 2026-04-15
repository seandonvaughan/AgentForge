/**
 * Document Analyzer scanner for AgentForge (Sonnet-tier).
 *
 * Recursively walks a project directory, identifies document files (.md, .txt),
 * classifies them by type using filename and content heuristics, and extracts
 * a short summary (first 500 characters).
 *
 * Uses only Node.js built-in modules (fs, path).
 */

import { readdir, readFile } from "node:fs/promises";
import { join, extname, basename, relative } from "node:path";
import type { DocumentAnalysis } from "../types/analysis.js";

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

/** File extensions treated as text-based documents. */
const DOCUMENT_EXTENSIONS = new Set([".md", ".txt"]);

/** Maximum number of characters to include in the summary. */
const SUMMARY_MAX_CHARS = 500;

// ---------------------------------------------------------------------------
// Classification rules
// ---------------------------------------------------------------------------

/**
 * A classification rule that maps a document type to filename patterns and
 * content keyword patterns. Rules are evaluated in order; the first match wins.
 */
interface ClassificationRule {
  /** Document type label returned in `DocumentAnalysis.type`. */
  type: string;
  /** Patterns tested against the lowercased base filename (without extension). */
  filenamePatterns: RegExp[];
  /** Patterns tested against the lowercased document content. */
  contentPatterns: RegExp[];
}

const CLASSIFICATION_RULES: ClassificationRule[] = [
  {
    type: "readme",
    filenamePatterns: [/^readme$/i, /^read[-_]?me$/i],
    contentPatterns: [],
  },
  {
    type: "business-plan",
    filenamePatterns: [/business[-_]?plan/i, /biz[-_]?plan/i],
    contentPatterns: [
      /business\s+plan/i,
      /executive\s+summary/i,
      /market\s+opportunity/i,
      /revenue\s+model/i,
      /financial\s+projections/i,
    ],
  },
  {
    type: "prd",
    filenamePatterns: [
      /\bprd\b/i,
      /product[-_]?requirements?/i,
      /requirements[-_]?doc/i,
    ],
    contentPatterns: [
      /product\s+requirements?\s+document/i,
      /\bprd\b/i,
      /acceptance\s+criteria/i,
      /user\s+stor(?:y|ies)/i,
    ],
  },
  {
    type: "contract",
    filenamePatterns: [/contract/i, /agreement/i, /terms[-_]?of[-_]?service/i, /\btos\b/i, /nda/i],
    contentPatterns: [
      /\bcontract\b/i,
      /\bagreement\b/i,
      /party\s+[ab]\b/i,
      /whereas\b/i,
      /indemnif/i,
      /liability/i,
      /termination\s+clause/i,
    ],
  },
  {
    type: "policy",
    filenamePatterns: [/policy/i, /policies/i, /privacy/i, /compliance/i, /code[-_]?of[-_]?conduct/i],
    contentPatterns: [
      /\bpolicy\b/i,
      /\bpolicies\b/i,
      /privacy\s+policy/i,
      /data\s+protection/i,
      /gdpr/i,
      /we\s+collect\s+.*data/i,
      /code\s+of\s+conduct/i,
    ],
  },
  {
    type: "handbook",
    filenamePatterns: [/handbook/i, /onboarding/i, /employee[-_]?guide/i, /staff[-_]?guide/i],
    contentPatterns: [
      /\bhandbook\b/i,
      /employee\s+handbook/i,
      /welcome\s+to\s+the\s+company/i,
      /our\s+values/i,
      /onboarding/i,
    ],
  },
  {
    type: "research-paper",
    filenamePatterns: [/research[-_]?paper/i, /white[-_]?paper/i, /whitepaper/i, /study/i],
    contentPatterns: [
      /\babstract\b/i,
      /\bmethodology\b/i,
      /\bhypothesis\b/i,
      /\bconclusion\b/i,
      /et\s+al\b/i,
      /this\s+paper\s+presents/i,
      /references\s*\n/i,
    ],
  },
  {
    type: "marketing-plan",
    filenamePatterns: [/marketing[-_]?plan/i, /marketing[-_]?strategy/i, /go[-_]?to[-_]?market/i, /gtm/i],
    contentPatterns: [
      /marketing\s+plan/i,
      /marketing\s+strategy/i,
      /target\s+audience/i,
      /brand\s+awareness/i,
      /campaign\s+strategy/i,
      /messaging\s+framework/i,
      /go[-_]to[-_]market/i,
    ],
  },
];

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
 * Classify a document based on its filename and content.
 *
 * Returns the first matching type label, or "unknown" if no rule matches.
 */
function classifyDocument(filePath: string, content: string): string {
  const name = basename(filePath, extname(filePath)).toLowerCase();
  const lowerContent = content.toLowerCase();

  for (const rule of CLASSIFICATION_RULES) {
    const filenameMatch = rule.filenamePatterns.some((re) => re.test(name));
    if (filenameMatch) return rule.type;

    const contentMatch = rule.contentPatterns.some((re) => re.test(lowerContent));
    if (contentMatch) return rule.type;
  }

  return "unknown";
}

/**
 * Analyze a single document file and return a `DocumentAnalysis` entry,
 * or `null` if the file is not a recognized document type or cannot be read.
 */
async function analyzeFile(
  filePath: string,
  projectRoot: string,
): Promise<DocumentAnalysis | null> {
  const ext = extname(filePath).toLowerCase();
  if (!DOCUMENT_EXTENSIONS.has(ext)) return null;

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  const type = classifyDocument(filePath, content);
  const summary = content.slice(0, SUMMARY_MAX_CHARS);
  const path = relative(projectRoot, filePath);

  return { type, path, summary };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Walk a project directory and return a structured analysis for every
 * document file (.md, .txt) found.
 *
 * Skips node_modules, .git, dist, and other build/tooling directories.
 * Unreadable files are silently ignored.
 */
export async function analyzeDocuments(
  projectRoot: string,
): Promise<DocumentAnalysis[]> {
  const allPaths = await walkDirectory(projectRoot);

  const results: DocumentAnalysis[] = [];

  const BATCH_SIZE = 50;
  for (let i = 0; i < allPaths.length; i += BATCH_SIZE) {
    const batch = allPaths.slice(i, i + BATCH_SIZE);
    const analyses = await Promise.all(
      batch.map((filePath) => analyzeFile(filePath, projectRoot)),
    );

    for (const analysis of analyses) {
      if (analysis) results.push(analysis);
    }
  }

  return results;
}
