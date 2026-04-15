// @ts-nocheck
/**
 * File Scanner module for AgentForge (Haiku-tier).
 *
 * Recursively walks a project directory, analyzes source files for language,
 * imports, exports, framework indicators, and common patterns, then returns
 * aggregated scan results.
 *
 * Uses only Node.js built-in modules (fs, path).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname, basename, relative } from "node:path";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Analysis results for a single source file. */
export interface FileAnalysis {
  /** Path to the file relative to the project root. */
  file_path: string;
  /** Detected programming language. */
  language: string;
  /** Lines of code in the file. */
  loc: number;
  /** Import / require statements found in the file. */
  imports: string[];
  /** Export statements found in the file. */
  exports: string[];
  /** Framework-related indicators detected in the file. */
  framework_indicators: string[];
  /** Common coding patterns detected in the file (e.g. async/await). */
  patterns: string[];
}

/** Aggregated results of scanning an entire project directory. */
export interface FileScanResult {
  /** Per-file analysis entries. */
  files: FileAnalysis[];
  /** Map of language name to the number of files written in that language. */
  languages: Record<string, number>;
  /** Unique set of frameworks detected across all files. */
  frameworks_detected: string[];
  /** Total number of source files scanned. */
  total_files: number;
  /** Total lines of code across all scanned files. */
  total_loc: number;
  /** Top-level directories found in the project root. */
  directory_structure: string[];
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

/** Map of file extension (without dot) to language name. */
const EXTENSION_MAP: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  rs: "Rust",
  go: "Go",
  java: "Java",
  kt: "Kotlin",
  rb: "Ruby",
  php: "PHP",
  css: "CSS",
  scss: "SCSS",
  less: "LESS",
  html: "HTML",
  htm: "HTML",
  sql: "SQL",
  yaml: "YAML",
  yml: "YAML",
  json: "JSON",
  xml: "XML",
  swift: "Swift",
  c: "C",
  cpp: "C++",
  h: "C",
  hpp: "C++",
  cs: "C#",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  lua: "Lua",
  r: "R",
  scala: "Scala",
  dart: "Dart",
  vue: "Vue",
  svelte: "Svelte",
  toml: "TOML",
  md: "Markdown",
  graphql: "GraphQL",
  gql: "GraphQL",
  proto: "Protobuf",
  tf: "Terraform",
  zig: "Zig",
  ex: "Elixir",
  exs: "Elixir",
  erl: "Erlang",
  hs: "Haskell",
};

// ---------------------------------------------------------------------------
// Framework detection rules
// ---------------------------------------------------------------------------

interface FrameworkRule {
  name: string;
  /** Patterns to match against import/require strings. */
  import_patterns: RegExp[];
  /** File-name patterns that strongly indicate the framework. */
  file_patterns: RegExp[];
}

const FRAMEWORK_RULES: FrameworkRule[] = [
  {
    name: "React",
    import_patterns: [/\breact\b/, /\breact-dom\b/],
    file_patterns: [/\.tsx$/, /\.jsx$/],
  },
  {
    name: "Next.js",
    import_patterns: [/\bnext\b/, /\bnext\/\w+/],
    file_patterns: [/next\.config\.\w+$/, /middleware\.ts$/],
  },
  {
    name: "Vue",
    import_patterns: [/\bvue\b/],
    file_patterns: [/\.vue$/, /vue\.config\.\w+$/],
  },
  {
    name: "Nuxt",
    import_patterns: [/\bnuxt\b/, /\b#imports\b/],
    file_patterns: [/nuxt\.config\.\w+$/],
  },
  {
    name: "Svelte",
    import_patterns: [/\bsvelte\b/],
    file_patterns: [/\.svelte$/, /svelte\.config\.\w+$/],
  },
  {
    name: "Angular",
    import_patterns: [/\b@angular\/\w+/],
    file_patterns: [/angular\.json$/],
  },
  {
    name: "Express",
    import_patterns: [/\bexpress\b/],
    file_patterns: [],
  },
  {
    name: "Fastify",
    import_patterns: [/\bfastify\b/],
    file_patterns: [],
  },
  {
    name: "NestJS",
    import_patterns: [/\b@nestjs\/\w+/],
    file_patterns: [/nest-cli\.json$/],
  },
  {
    name: "FastAPI",
    import_patterns: [/\bfastapi\b/],
    file_patterns: [],
  },
  {
    name: "Django",
    import_patterns: [/\bdjango\b/],
    file_patterns: [/manage\.py$/, /settings\.py$/],
  },
  {
    name: "Flask",
    import_patterns: [/\bflask\b/],
    file_patterns: [],
  },
  {
    name: "Spring",
    import_patterns: [/\borg\.springframework\b/],
    file_patterns: [/application\.properties$/, /application\.ya?ml$/],
  },
  {
    name: "Rails",
    import_patterns: [/\brails\b/, /\baction_controller\b/],
    file_patterns: [/Gemfile$/, /config\/routes\.rb$/],
  },
  {
    name: "Tailwind CSS",
    import_patterns: [/\btailwindcss\b/],
    file_patterns: [/tailwind\.config\.\w+$/],
  },
  {
    name: "Prisma",
    import_patterns: [/\b@prisma\/client\b/],
    file_patterns: [/schema\.prisma$/],
  },
  {
    name: "GraphQL",
    import_patterns: [/\bgraphql\b/, /\b@apollo\/\w+/, /\burql\b/],
    file_patterns: [/\.graphql$/, /\.gql$/],
  },
  {
    name: "Redux",
    import_patterns: [/\bredux\b/, /\b@reduxjs\/toolkit\b/],
    file_patterns: [],
  },
  {
    name: "Electron",
    import_patterns: [/\belectron\b/],
    file_patterns: [],
  },
  {
    name: "Actix",
    import_patterns: [/\bactix[_-]web\b/],
    file_patterns: [],
  },
  {
    name: "Gin",
    import_patterns: [/\bgin-gonic\/gin\b/],
    file_patterns: [],
  },
  {
    name: "Fiber",
    import_patterns: [/\bgofiber\/fiber\b/],
    file_patterns: [],
  },
];

// ---------------------------------------------------------------------------
// Pattern detection
// ---------------------------------------------------------------------------

/** Regex-based pattern detectors applied to file contents. */
const PATTERN_DETECTORS: { name: string; pattern: RegExp }[] = [
  { name: "async/await", pattern: /\basync\s+\w+|await\s+/ },
  { name: "decorators", pattern: /^\s*@\w+/m },
  { name: "generics", pattern: /<\w+(?:\s*,\s*\w+)*>/ },
  { name: "arrow functions", pattern: /=>\s*[{(]/ },
  { name: "destructuring", pattern: /(?:const|let|var)\s*[{[]/ },
  { name: "spread operator", pattern: /\.\.\.[\w([]/ },
  { name: "optional chaining", pattern: /\?\.\w+/ },
  { name: "nullish coalescing", pattern: /\?\?/ },
  { name: "template literals", pattern: /`[^`]*\$\{/ },
  { name: "classes", pattern: /\bclass\s+\w+/ },
  { name: "interfaces", pattern: /\binterface\s+\w+/ },
  { name: "enums", pattern: /\benum\s+\w+/ },
  { name: "type aliases", pattern: /\btype\s+\w+\s*=/ },
  { name: "generators", pattern: /\bfunction\s*\*/ },
  { name: "promises", pattern: /new\s+Promise\b/ },
  { name: "error handling", pattern: /\btry\s*\{/ },
  { name: "list comprehension", pattern: /\[\s*\w+\s+for\s+\w+\s+in\b/ },
  { name: "pattern matching", pattern: /\bmatch\s+\w+\s*[:{]/ },
  { name: "closures", pattern: /\bmove\s*\||\|\w+\|/ },
  { name: "goroutines", pattern: /\bgo\s+func\b|\bgo\s+\w+\(/ },
  { name: "channels", pattern: /\bchan\s+\w+|\<-\s*chan\b/ },
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
    // Unreadable directory — silently skip.
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

/** Detect the language of a file based on its extension. */
function detectLanguage(filePath: string): string | null {
  const ext = extname(filePath).replace(/^\./, "").toLowerCase();
  return EXTENSION_MAP[ext] ?? null;
}

/** Extract import/require statements from file contents. */
function extractImports(content: string, language: string): string[] {
  const imports: string[] = [];

  if (
    language === "TypeScript" ||
    language === "JavaScript" ||
    language === "Vue" ||
    language === "Svelte"
  ) {
    // ES imports: import ... from "module"
    const esImportRe = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = esImportRe.exec(content)) !== null) {
      imports.push(m[1]);
    }

    // Side-effect imports: import "module"
    const sideEffectRe = /import\s+['"]([^'"]+)['"]/g;
    while ((m = sideEffectRe.exec(content)) !== null) {
      imports.push(m[1]);
    }

    // require() calls
    const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = requireRe.exec(content)) !== null) {
      imports.push(m[1]);
    }
  } else if (language === "Python") {
    // import module / from module import ...
    const pyImportRe = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w., ]+))/gm;
    let m: RegExpExecArray | null;
    while ((m = pyImportRe.exec(content)) !== null) {
      imports.push(m[1] ?? m[2]);
    }
  } else if (language === "Go") {
    const goImportRe = /import\s+(?:\(\s*([\s\S]*?)\s*\)|"([^"]+)")/g;
    let m: RegExpExecArray | null;
    while ((m = goImportRe.exec(content)) !== null) {
      if (m[2]) {
        imports.push(m[2]);
      } else if (m[1]) {
        const lineRe = /"([^"]+)"/g;
        let lm: RegExpExecArray | null;
        while ((lm = lineRe.exec(m[1])) !== null) {
          imports.push(lm[1]);
        }
      }
    }
  } else if (language === "Rust") {
    const rustUseRe = /^\s*use\s+([\w:]+)/gm;
    let m: RegExpExecArray | null;
    while ((m = rustUseRe.exec(content)) !== null) {
      imports.push(m[1]);
    }
  } else if (language === "Java" || language === "Kotlin") {
    const javaImportRe = /^\s*import\s+([\w.]+)/gm;
    let m: RegExpExecArray | null;
    while ((m = javaImportRe.exec(content)) !== null) {
      imports.push(m[1]);
    }
  } else if (language === "Ruby") {
    const rubyReqRe = /^\s*require\s+['"]([^'"]+)['"]/gm;
    let m: RegExpExecArray | null;
    while ((m = rubyReqRe.exec(content)) !== null) {
      imports.push(m[1]);
    }
  } else if (language === "PHP") {
    const phpUseRe = /^\s*use\s+([\w\\]+)/gm;
    let m: RegExpExecArray | null;
    while ((m = phpUseRe.exec(content)) !== null) {
      imports.push(m[1]);
    }
  }

  return [...new Set(imports)];
}

/** Extract export statements from file contents. */
function extractExports(content: string, language: string): string[] {
  const exports: string[] = [];

  if (
    language === "TypeScript" ||
    language === "JavaScript" ||
    language === "Vue" ||
    language === "Svelte"
  ) {
    // Named exports: export const/let/var/function/class/interface/type/enum name
    const namedExportRe =
      /export\s+(?:default\s+)?(?:const|let|var|function\*?|class|interface|type|enum|abstract\s+class)\s+(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = namedExportRe.exec(content)) !== null) {
      exports.push(m[1]);
    }

    // export default (without a named declaration following it)
    if (/export\s+default\b/.test(content) && !exports.some((e) => e === "default")) {
      exports.push("default");
    }
  } else if (language === "Python") {
    // __all__ list
    const allRe = /__all__\s*=\s*\[([^\]]+)\]/;
    const allMatch = allRe.exec(content);
    if (allMatch) {
      const items = allMatch[1].match(/['"](\w+)['"]/g);
      if (items) {
        for (const item of items) {
          exports.push(item.replace(/['"]/g, ""));
        }
      }
    }

    // Top-level def / class
    const defRe = /^(?:def|class)\s+(\w+)/gm;
    let m: RegExpExecArray | null;
    while ((m = defRe.exec(content)) !== null) {
      if (!m[1].startsWith("_")) {
        exports.push(m[1]);
      }
    }
  } else if (language === "Go") {
    // Exported identifiers start with an uppercase letter
    const goExportRe = /^(?:func|type|var|const)\s+([A-Z]\w*)/gm;
    let m: RegExpExecArray | null;
    while ((m = goExportRe.exec(content)) !== null) {
      exports.push(m[1]);
    }
  } else if (language === "Rust") {
    const rustPubRe = /^\s*pub\s+(?:fn|struct|enum|trait|type|const|static|mod)\s+(\w+)/gm;
    let m: RegExpExecArray | null;
    while ((m = rustPubRe.exec(content)) !== null) {
      exports.push(m[1]);
    }
  }

  return [...new Set(exports)];
}

/** Detect framework indicators in file contents based on import strings. */
function detectFrameworkIndicators(
  content: string,
  imports: string[],
  filePath: string,
): string[] {
  const indicators: string[] = [];

  for (const rule of FRAMEWORK_RULES) {
    // Check import patterns
    const importMatch = rule.import_patterns.some((re) =>
      imports.some((imp) => re.test(imp)),
    );

    // Check file name patterns
    const fileMatch = rule.file_patterns.some((re) => re.test(filePath));

    // Check content for inline references (e.g. JSX, template syntax)
    const contentMatch = rule.import_patterns.some((re) => re.test(content));

    if (importMatch || fileMatch || contentMatch) {
      indicators.push(rule.name);
    }
  }

  return [...new Set(indicators)];
}

/** Detect common coding patterns in file contents. */
function detectPatterns(content: string): string[] {
  const found: string[] = [];

  for (const { name, pattern } of PATTERN_DETECTORS) {
    if (pattern.test(content)) {
      found.push(name);
    }
  }

  return found;
}

/** Analyze a single file and return a FileAnalysis. */
async function analyzeFile(
  filePath: string,
  projectRoot: string,
): Promise<FileAnalysis | null> {
  const language = detectLanguage(filePath);
  if (!language) return null;

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    // Unreadable file — skip.
    return null;
  }

  const lines = content.split("\n");
  const loc = lines.length;
  const imports = extractImports(content, language);
  const exports = extractExports(content, language);
  const relativePath = relative(projectRoot, filePath);
  const frameworkIndicators = detectFrameworkIndicators(content, imports, relativePath);
  const patterns = detectPatterns(content);

  return {
    file_path: relativePath,
    language,
    loc,
    imports,
    exports,
    framework_indicators: frameworkIndicators,
    patterns,
  };
}

/** Collect top-level directory names in the project root. */
async function getTopLevelDirs(projectRoot: string): Promise<string[]> {
  const dirs: string[] = [];

  try {
    const entries = await readdir(projectRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
        dirs.push(entry.name);
      }
    }
  } catch {
    // If we cannot read the root, return empty.
  }

  return dirs.sort();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze all file analyses to determine which frameworks are in use,
 * based on import patterns and file naming conventions.
 */
export function detectFrameworks(files: FileAnalysis[]): string[] {
  const frameworkCounts = new Map<string, number>();

  for (const file of files) {
    for (const indicator of file.framework_indicators) {
      frameworkCounts.set(indicator, (frameworkCounts.get(indicator) ?? 0) + 1);
    }
  }

  // Also check file naming conventions across the whole set
  for (const rule of FRAMEWORK_RULES) {
    if (frameworkCounts.has(rule.name)) continue;

    const fileMatch = files.some((f) =>
      rule.file_patterns.some((re) => re.test(f.file_path)),
    );
    if (fileMatch) {
      frameworkCounts.set(rule.name, 1);
    }
  }

  // Sort by frequency (most common first)
  return [...frameworkCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
}

/**
 * Recursively scan a project directory and return aggregated analysis.
 *
 * Skips non-source files (files whose extension is not in EXTENSION_MAP)
 * and directories listed in SKIP_DIRS. Unreadable files are silently
 * skipped.
 */
export async function scanFiles(projectRoot: string): Promise<FileScanResult> {
  const allPaths = await walkDirectory(projectRoot);
  const topLevelDirs = await getTopLevelDirs(projectRoot);

  const files: FileAnalysis[] = [];
  const languages: Record<string, number> = {};
  let totalLoc = 0;

  // Analyze files in parallel batches to keep memory reasonable
  const BATCH_SIZE = 50;
  for (let i = 0; i < allPaths.length; i += BATCH_SIZE) {
    const batch = allPaths.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((filePath) => analyzeFile(filePath, projectRoot)),
    );

    for (const analysis of results) {
      if (!analysis) continue;

      files.push(analysis);
      languages[analysis.language] = (languages[analysis.language] ?? 0) + 1;
      totalLoc += analysis.loc;
    }
  }

  const frameworksDetected = detectFrameworks(files);

  return {
    files,
    languages,
    frameworks_detected: frameworksDetected,
    total_files: files.length,
    total_loc: totalLoc,
    directory_structure: topLevelDirs,
  };
}
