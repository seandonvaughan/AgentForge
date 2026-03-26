/**
 * KnowledgeIngester — v4.4 P1-4
 *
 * Auto-indexes TypeScript exports in src under the project root into a knowledge index.
 * Uses regex-based parsing (no AST). Extracts exported names and JSDoc comments.
 * Output is stored at .agentforge/knowledge/codebase-index.json.
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, relative } from "node:path";

export interface CodeSymbol {
  name: string;
  kind: "class" | "interface" | "function" | "type" | "const";
  filePath: string;
  exportedFrom: string;
  description?: string;
  line: number;
}

export interface KnowledgeIndex {
  generatedAt: string;
  projectRoot: string;
  symbols: CodeSymbol[];
}

// Matches: export (class|interface|function|type|const) Name
const EXPORT_RE = /^export\s+(class|interface|function|type|const)\s+(\w+)/;

// Matches JSDoc block closing line
const JSDOC_END_RE = /^\s*\*\/\s*$/;

// Matches JSDoc block opening line
const JSDOC_START_RE = /^\s*\/\*\*/;

// Matches a JSDoc content line starting with optional whitespace and asterisk
const JSDOC_LINE_RE = /^\s*\*\s?(.*)/;

export class KnowledgeIngester {
  constructor(private projectRoot: string) {}

  /**
   * Walk src directories under projectRoot, parse exports with optional JSDoc.
   * Returns a KnowledgeIndex with all found symbols.
   */
  async ingest(): Promise<KnowledgeIndex> {
    const srcDir = join(this.projectRoot, "src");
    const tsFiles = await collectTsFiles(srcDir);

    const symbols: CodeSymbol[] = [];
    for (const filePath of tsFiles) {
      const fileSymbols = await parseFile(filePath, this.projectRoot);
      symbols.push(...fileSymbols);
    }

    return {
      generatedAt: new Date().toISOString(),
      projectRoot: this.projectRoot,
      symbols,
    };
  }

  /**
   * Write a KnowledgeIndex to the given outputPath as JSON.
   */
  async save(index: KnowledgeIndex, outputPath: string): Promise<void> {
    const lastSlash = outputPath.lastIndexOf("/");
    const dir = lastSlash > 0 ? outputPath.substring(0, lastSlash) : undefined;
    if (dir) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(outputPath, JSON.stringify(index, null, 2), "utf-8");
  }

  /**
   * Load an existing KnowledgeIndex from disk or return null if not found.
   */
  static async load(outputPath: string): Promise<KnowledgeIndex | null> {
    try {
      const raw = await readFile(outputPath, "utf-8");
      return JSON.parse(raw) as KnowledgeIndex;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function collectTsFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectTsFiles(fullPath);
      results.push(...nested);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      results.push(fullPath);
    }
  }
  return results;
}

async function parseFile(filePath: string, projectRoot: string): Promise<CodeSymbol[]> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");
  const symbols: CodeSymbol[] = [];

  // Module path relative to project root, extension stripped
  const relPath = relative(projectRoot, filePath).replace(/\\/g, "/");
  const exportedFrom = relPath.replace(/\.ts$/, "");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = EXPORT_RE.exec(line);
    if (!match) continue;

    const kind = match[1] as CodeSymbol["kind"];
    const name = match[2];
    const description = extractJsDoc(lines, i);

    symbols.push({
      name,
      kind,
      filePath,
      exportedFrom,
      description: description || undefined,
      line: i + 1,
    });
  }

  return symbols;
}

// Matches a single-line JSDoc: /** ... */
const JSDOC_SINGLE_RE = /^\s*\/\*\*\s*(.*?)\s*\*\/\s*$/;

/**
 * Scan backwards from lineIndex to find the nearest JSDoc block.
 * Handles both single-line (/** text *\/) and multi-line blocks.
 * Returns the concatenated comment text, or empty string if none found.
 */
function extractJsDoc(lines: string[], lineIndex: number): string {
  let cursor = lineIndex - 1;

  // Skip blank lines between JSDoc and export declaration
  while (cursor >= 0 && lines[cursor].trim() === "") {
    cursor--;
  }

  if (cursor < 0) return "";

  // Handle single-line JSDoc: /** text */
  const singleMatch = JSDOC_SINGLE_RE.exec(lines[cursor]);
  if (singleMatch) {
    return singleMatch[1].trim();
  }

  // Handle multi-line JSDoc block — current line should be closing marker
  if (!JSDOC_END_RE.test(lines[cursor])) {
    return "";
  }

  // Found closing marker — walk back to find opening marker
  const endCursor = cursor;
  cursor--;
  while (cursor >= 0 && !JSDOC_START_RE.test(lines[cursor])) {
    cursor--;
  }

  if (cursor < 0) return "";

  // Extract text lines between open and close markers
  const commentLines: string[] = [];
  for (let j = cursor + 1; j < endCursor; j++) {
    const m = JSDOC_LINE_RE.exec(lines[j]);
    if (m) {
      commentLines.push(m[1]);
    }
  }

  return commentLines.join(" ").trim();
}
