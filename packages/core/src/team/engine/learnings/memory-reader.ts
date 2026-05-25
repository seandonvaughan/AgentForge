/**
 * Memory Reader — reads `.agentforge/memory/<type>.jsonl` line-by-line.
 *
 * Returns entries most-recent-first. Malformed lines are skipped with a
 * console.warn so they never crash the curator pipeline.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryEntry {
  id: string;
  type: string;
  value: string;
  createdAt: string;
  source?: string;
  tags?: string[];
  metadata?: unknown;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read all entries from `.agentforge/memory/<type>.jsonl`.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param type        - One of `gate-verdict`, `review-finding`, `cycle-outcome`.
 * @returns           - Parsed entries, most-recent-first. Empty array if file
 *                      is missing or unreadable.
 */
export async function readMemoryEntries(
  projectRoot: string,
  type: string,
): Promise<MemoryEntry[]> {
  const filePath = join(projectRoot, ".agentforge", "memory", `${type}.jsonl`);

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err: unknown) {
    // File not found or unreadable — not an error for the caller
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn(`[memory-reader] Could not read ${filePath}:`, err);
    }
    return [];
  }

  const entries: MemoryEntry[] = [];
  const lines = raw.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;

    try {
      const parsed = JSON.parse(line) as unknown;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        typeof (parsed as Record<string, unknown>).id === "string" &&
        typeof (parsed as Record<string, unknown>).value === "string"
      ) {
        entries.push(parsed as MemoryEntry);
      } else {
        console.warn(
          `[memory-reader] Skipping malformed entry at ${filePath}:${i + 1} — missing id or value`,
        );
      }
    } catch {
      console.warn(
        `[memory-reader] Skipping invalid JSON at ${filePath}:${i + 1}`,
      );
    }
  }

  // Sort most-recent-first by createdAt; entries with no date go last
  entries.sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });

  return entries;
}
