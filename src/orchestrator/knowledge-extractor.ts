/**
 * KnowledgeExtractor — P1-1: Team Knowledge Accumulation
 *
 * Scans agent responses for structured knowledge patterns and extracts
 * KnowledgeEntry objects for persistence via CareerStore.addKnowledge().
 */

import { randomUUID } from "node:crypto";
import type { KnowledgeEntry, KnowledgeCategory } from "../types/lifecycle.js";

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

/**
 * Maps a keyword prefix (case-insensitive) to a KnowledgeCategory.
 * Lines starting with these prefixes are extracted as structured knowledge.
 */
const PREFIX_MAP: Array<{ prefix: string; category: KnowledgeCategory }> = [
  { prefix: "convention:", category: "convention" },
  { prefix: "pattern:",    category: "pattern"    },
  { prefix: "decision:",   category: "decision"   },
  { prefix: "pitfall:",    category: "pitfall"    },
  { prefix: "note:",       category: "domain_fact" },
];

/**
 * Markdown header levels that trigger knowledge extraction from the
 * immediately following paragraph. Only H2/H3 are harvested.
 */
const HEADER_REGEX = /^#{2,3}\s+(.+)$/;

/**
 * Keywords that hint a markdown section contains actionable knowledge.
 * Checked case-insensitively against the heading text.
 */
const KNOWLEDGE_HEADER_HINTS = [
  "convention", "pattern", "decision", "pitfall", "note",
  "approach", "strategy", "lesson", "recommendation", "insight",
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan `agentResponse` for knowledge patterns and return structured
 * KnowledgeEntry objects ready for CareerStore.addKnowledge().
 *
 * @param agentId    - ID of the agent whose response is being scanned.
 * @param agentResponse - Full text of the agent's output.
 * @param teamId     - Team to which extracted knowledge is attributed.
 */
export function extractKnowledge(
  agentId: string,
  agentResponse: string,
  teamId: string,
): KnowledgeEntry[] {
  const entries: KnowledgeEntry[] = [];
  const lines = agentResponse.split("\n");
  const now = new Date().toISOString();

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    // 1. Prefix-keyed lines
    const prefixMatch = matchPrefix(line);
    if (prefixMatch) {
      const content = prefixMatch.content.trim();
      if (content.length > 0) {
        entries.push(makeEntry({
          teamId,
          category: prefixMatch.category,
          content,
          source: agentId,
          now,
        }));
      }
      i++;
      continue;
    }

    // 2. Markdown header followed by a paragraph
    const headerMatch = HEADER_REGEX.exec(line);
    if (headerMatch) {
      const heading = headerMatch[1];
      if (isKnowledgeHeading(heading)) {
        const paragraphLines: string[] = [];
        let j = i + 1;
        // Collect non-empty lines until blank line or next header
        while (j < lines.length) {
          const nextLine = lines[j].trim();
          if (nextLine === "" || /^#+/.test(nextLine)) break;
          paragraphLines.push(nextLine);
          j++;
        }
        const paragraphText = paragraphLines.join(" ").trim();
        if (paragraphText.length > 0) {
          entries.push(makeEntry({
            teamId,
            category: inferCategoryFromHeading(heading),
            content: `${heading}: ${paragraphText}`,
            source: agentId,
            now,
          }));
          i = j;
          continue;
        }
      }
    }

    i++;
  }

  return deduplicate(entries);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface MakeEntryParams {
  teamId: string;
  category: KnowledgeCategory;
  content: string;
  source: string;
  now: string;
}

function makeEntry({ teamId, category, content, source, now }: MakeEntryParams): KnowledgeEntry {
  return {
    id: randomUUID(),
    teamId,
    category,
    content,
    source,
    confidence: 0.8,
    references: [],
    createdAt: now,
    lastValidated: now,
  };
}

interface PrefixMatchResult {
  category: KnowledgeCategory;
  content: string;
}

function matchPrefix(line: string): PrefixMatchResult | null {
  const lower = line.toLowerCase();
  for (const { prefix, category } of PREFIX_MAP) {
    if (lower.startsWith(prefix)) {
      return {
        category,
        content: line.slice(prefix.length).trim(),
      };
    }
  }
  return null;
}

function isKnowledgeHeading(heading: string): boolean {
  const lower = heading.toLowerCase();
  return KNOWLEDGE_HEADER_HINTS.some((hint) => lower.includes(hint));
}

function inferCategoryFromHeading(heading: string): KnowledgeCategory {
  const lower = heading.toLowerCase();
  if (lower.includes("convention")) return "convention";
  if (lower.includes("pattern"))    return "pattern";
  if (lower.includes("decision"))   return "decision";
  if (lower.includes("pitfall"))    return "pitfall";
  return "domain_fact";
}

/** Remove entries whose trimmed content is identical. */
function deduplicate(entries: KnowledgeEntry[]): KnowledgeEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const key = `${e.category}::${e.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
