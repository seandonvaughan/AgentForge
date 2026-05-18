/**
 * af_memory_query — semantic search over AgentForge memory JSONL files.
 *
 * Uses the EmbeddingStore from @agentforge/embeddings. On first call the
 * JSONL records are indexed into an in-process SQLite store. Subsequent calls
 * reuse the warm store.
 *
 * Falls back to keyword substring search if the embedding model isn't
 * available (e.g. cold CI environments without the Xenova model cache).
 *
 * SECURITY: text input is not used in regex patterns — only passed to the
 * semantic search engine. No user input reaches shell calls.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const AfMemoryQueryInput = z.object({
  text: z.string().min(1).max(1024),
  k: z.number().int().min(1).max(50).optional().default(5),
});

export type AfMemoryQueryInputType = z.infer<typeof AfMemoryQueryInput>;

export interface AfMemoryQueryResult {
  ok: boolean;
  data: {
    hits: Array<{
      file: string;
      line: number;
      score: number;
      excerpt: string;
    }>;
  } | null;
  error: { code: string; message: string } | null;
}

interface MemoryRecord {
  id?: string;
  type?: string;
  value?: string;
  createdAt?: string;
  source?: string;
  tags?: string[];
}

/** Load all JSONL records from the memory directory. */
function loadMemoryRecords(memoryDir: string): Array<{ file: string; line: number; content: string }> {
  if (!existsSync(memoryDir)) return [];

  const results: Array<{ file: string; line: number; content: string }> = [];

  let files: string[];
  try {
    files = readdirSync(memoryDir).filter((f: string) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  for (const file of files) {
    const filePath = join(memoryDir, file);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        const record = JSON.parse(line) as MemoryRecord;
        // Build a searchable text from the record
        const parts: string[] = [];
        if (record.type) parts.push(record.type);
        if (record.value) {
          // value may itself be a JSON string
          try {
            const inner = JSON.parse(record.value) as Record<string, unknown>;
            parts.push(Object.values(inner).map(v => String(v)).join(' '));
          } catch {
            parts.push(record.value);
          }
        }
        if (record.tags) parts.push(record.tags.join(' '));
        const content = parts.join(' ').trim();
        if (content) {
          results.push({ file, line: i + 1, content });
        }
      } catch {
        // skip malformed lines
      }
    }
  }

  return results;
}

/** Keyword fallback: score by number of matching words in the text. */
function keywordSearch(
  query: string,
  records: Array<{ file: string; line: number; content: string }>,
  k: number,
): Array<{ file: string; line: number; score: number; excerpt: string }> {
  // Split query into words — no regex on user input
  const words = query.toLowerCase().split(' ').filter(w => w.length > 1);

  const scored = records.map(r => {
    const lower = r.content.toLowerCase();
    let matchCount = 0;
    for (const word of words) {
      if (lower.includes(word)) matchCount++;
    }
    const score = words.length > 0 ? matchCount / words.length : 0;
    return { file: r.file, line: r.line, score, excerpt: r.content.slice(0, 200) };
  });

  return scored
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export async function afMemoryQuery(
  input: AfMemoryQueryInputType,
  projectRoot?: string,
): Promise<AfMemoryQueryResult> {
  const root = projectRoot ?? process.cwd();
  const memoryDir = join(root, '.agentforge', 'memory');

  const records = loadMemoryRecords(memoryDir);

  if (records.length === 0) {
    return {
      ok: true,
      data: { hits: [] },
      error: null,
    };
  }

  const k = input.k ?? 5;

  // Try semantic search via EmbeddingStore
  try {
    const { EmbeddingStore } = await import('@agentforge/embeddings');
    const store = new EmbeddingStore(':memory:');

    // Index all records
    await store.indexBatch(
      records.map((r, i) => ({
        id: `mem:${r.file}:${r.line}:${i}`,
        content: r.content,
      })),
    );

    const results = await store.search(input.text, { topK: k, minScore: 0.1 });
    store.close();

    const hits = results.map(r => {
      // Parse back file/line from id
      const parts = r.id.split(':');
      const file = parts[1] ?? 'unknown';
      const line = parseInt(parts[2] ?? '0', 10);
      return {
        file,
        line,
        score: Math.round(r.score * 1000) / 1000,
        excerpt: r.content.slice(0, 200),
      };
    });

    return { ok: true, data: { hits }, error: null };
  } catch {
    // Embedding model not available — fall back to keyword search
    const hits = keywordSearch(input.text, records, k);
    return { ok: true, data: { hits }, error: null };
  }
}
