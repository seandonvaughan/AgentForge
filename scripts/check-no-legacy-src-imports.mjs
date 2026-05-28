#!/usr/bin/env node
/**
 * check-no-legacy-src-imports.mjs
 *
 * CI guard: ensure consumers are not importing concrete implementations
 * directly from the legacy src/ tree at the repo root.
 *
 * Exit codes:
 *   0 — no violations found
 *   1 — one or more files contain a deep src/ import (violation)
 *
 * Usage:
 *   node scripts/check-no-legacy-src-imports.mjs
 *   node scripts/check-no-legacy-src-imports.mjs --scan-dir <dir>
 *
 * --scan-dir <dir>   Scan only this directory for import violations (for tests).
 *                    When omitted the full repo (minus src/, tests/, node_modules/)
 *                    is scanned.
 *
 * The script also counts remaining REAL (non-shim) src/ modules and prints the
 * result.  A "shim" is any .ts file under src/ whose non-comment body contains
 * only `export ... from '@agentforge/...'` statements.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = normalize(fileURLToPath(new URL('..', import.meta.url)));

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

let extraScanDir = null;

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--scan-dir') {
    extraScanDir = resolve(process.argv[i + 1] ?? '');
    i++;
  }
}

// ---------------------------------------------------------------------------
// Helper: walk a directory for source files
// ---------------------------------------------------------------------------

/**
 * Recursively collect all files under `dir` matching `predicate`.
 * Skips any directory whose name appears in the `skipDirs` set.
 *
 * @param {string} dir
 * @param {(name: string, fullPath: string) => boolean} predicate
 * @param {Set<string>} skipDirs
 * @returns {string[]}
 */
function walkDir(dir, predicate, skipDirs) {
  /** @type {string[]} */
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      results.push(...walkDir(join(dir, entry.name), predicate, skipDirs));
    } else if (entry.isFile() && predicate(entry.name, join(dir, entry.name))) {
      results.push(join(dir, entry.name));
    }
  }
  return results;
}

// Directories to skip when walking (applies at every depth level).
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.svelte-kit',
  '.git',
  'coverage',
  'playwright-report',
  'test-results',
  'artifacts',
  '__fixtures__',
]);

// ---------------------------------------------------------------------------
// Helper: classify a src/ module as shim vs concrete
// ---------------------------------------------------------------------------

/**
 * A file is a shim when every non-comment, non-blank line in its body is a
 * re-export statement that points exclusively at an @agentforge/* package.
 *
 * Detection is done with string operations (startsWith / includes), not regex,
 * to comply with the CodeQL ReDoS policy.
 *
 * @param {string} content
 * @returns {boolean}
 */
function isShimContent(content) {
  // Strip block comments (/* ... */)
  let stripped = '';
  let inBlock = false;
  let i = 0;
  while (i < content.length) {
    if (!inBlock && content[i] === '/' && content[i + 1] === '*') {
      inBlock = true;
      i += 2;
      continue;
    }
    if (inBlock && content[i] === '*' && content[i + 1] === '/') {
      inBlock = false;
      i += 2;
      continue;
    }
    if (!inBlock) {
      stripped += content[i];
    }
    i++;
  }

  // Strip line comments (// ...)
  const lines = stripped.split('\n').map((line) => {
    const idx = line.indexOf('//');
    return idx === -1 ? line : line.slice(0, idx);
  });

  const meaningful = lines.map((l) => l.trim()).filter((l) => l.length > 0);

  if (meaningful.length === 0) {
    return true; // empty file → shim
  }

  return meaningful.every(
    (line) =>
      (line.startsWith('export') && line.includes("'@agentforge/")) ||
      (line.startsWith('export') && line.includes('"@agentforge/'))
  );
}

// ---------------------------------------------------------------------------
// Step 1: Count remaining real (non-shim) src/ modules
// ---------------------------------------------------------------------------

const srcDir = join(repoRoot, 'src');

const allSrcModules = walkDir(
  srcDir,
  (name) => {
    if (!name.endsWith('.ts')) return false;
    if (name.endsWith('.test.ts')) return false;
    if (name.endsWith('.spec.ts')) return false;
    if (name.endsWith('.d.ts')) return false;
    return true;
  },
  SKIP_DIRS
);

let realSrcCount = 0;
for (const f of allSrcModules) {
  let content = '';
  try {
    content = readFileSync(f, 'utf8');
  } catch {
    realSrcCount++;
    continue;
  }
  if (!isShimContent(content)) {
    realSrcCount++;
  }
}

console.log(`Remaining real (non-shim) src/ modules: ${realSrcCount}`);

// ---------------------------------------------------------------------------
// Step 2: Scan for deep src/ import violations
// ---------------------------------------------------------------------------

/**
 * Returns true when the import specifier is a deep path into the repo root's
 * legacy src/ tree (a concrete implementation import, not an @agentforge/*
 * package specifier).
 *
 * A violation looks like one of:
 *   - '../src/utils/foo.js'          (one level up then into src/)
 *   - '../../src/utils/foo.js'       (two levels up then into src/)
 *   - '../../../src/something.js'    (etc.)
 *
 * We identify this by checking that the specifier contains '/src/' preceded
 * only by '../' path segments (i.e. the path is navigating UP from some
 * sub-directory and then DOWN into src/).
 *
 * We do NOT flag:
 *   - '@agentforge/*'                (package imports)
 *   - '../../../../src/routes/...'   (SvelteKit internal route references
 *                                     within packages/dashboard — these are
 *                                     detected by checking the containing
 *                                     package, but the simplest guard is: the
 *                                     specifier must start with '../' or './'
 *                                     AND the path segment after the dot-dot
 *                                     chain must be exactly 'src')
 *
 * String operations only — no regex — per the CodeQL ReDoS policy.
 *
 * @param {string} specifier   The raw import path as it appears in source.
 * @param {string} fromFile    Absolute path of the file containing this import.
 * @returns {boolean}
 */
function isDeepSrcImport(specifier, fromFile) {
  // Skip non-relative / package specifiers quickly.
  if (!specifier.startsWith('.')) return false;

  // Normalize to forward slashes for uniform processing.
  const normalized = specifier.split('\\').join('/');

  // The specifier must navigate UP (contain '../') and then reference src/
  // at some level.  We check that '/src/' appears in the specifier.
  if (!normalized.includes('/src/') && !normalized.endsWith('/src')) {
    return false;
  }

  // Strip the leading './'..'/' segments and see what the first real
  // directory name is after the dot-dot chain.
  let rest = normalized;
  while (rest.startsWith('../') || rest.startsWith('./')) {
    rest = rest.startsWith('../') ? rest.slice(3) : rest.slice(2);
  }

  // The first path segment after the traversal must be 'src'.
  const firstSegment = rest.startsWith('src/') ? 'src' : rest.split('/')[0];
  if (firstSegment !== 'src') {
    return false;
  }

  // Resolve the specifier against the file's directory to confirm the
  // resolved path actually falls under the repo root's src/ directory.
  // This avoids flagging intra-package src/ folders.
  const fileDir = join(fromFile, '..');
  const resolvedParts = join(fileDir, normalized).split(join(repoRoot, 'src'));
  if (resolvedParts.length < 2) {
    return false;
  }

  // resolvedParts[0] should be everything before repoRoot/src — if the
  // resolved path starts with repoRoot/src it is a legacy src/ import.
  return resolvedParts[0] === '' || resolvedParts[0] === repoRoot.slice(0, -1);
}

/**
 * Extract all import/export specifiers from a source file's text.
 * Works with static import/export statements only.
 *
 * Strategy: scan line by line for the keyword `from` followed by a quoted
 * string.  Also catches `import(...)` dynamic imports.
 * Uses String.includes / indexOf — no regex.
 *
 * @param {string} content
 * @returns {string[]}
 */
function extractSpecifiers(content) {
  const specifiers = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();

    // `from 'specifier'` or `from "specifier"`
    if (line.includes(' from ')) {
      const fromIdx = line.indexOf(' from ');
      const afterFrom = line.slice(fromIdx + 6).trim();
      const quote = afterFrom[0];
      if (quote === "'" || quote === '"') {
        const end = afterFrom.indexOf(quote, 1);
        if (end !== -1) {
          specifiers.push(afterFrom.slice(1, end));
        }
      }
    }

    // Dynamic import: import('specifier') or import("specifier")
    if (line.includes("import('") || line.includes('import("')) {
      for (const prefix of ["import('", 'import("']) {
        let pos = line.indexOf(prefix);
        while (pos !== -1) {
          const quotePos = pos + prefix.length - 1;
          const quote = line[quotePos];
          const end = line.indexOf(quote, quotePos + 1);
          if (end !== -1) {
            specifiers.push(line.slice(quotePos + 1, end));
          }
          pos = line.indexOf(prefix, pos + 1);
        }
      }
    }
  }
  return specifiers;
}

// Determine which directories to scan for violations.
/** @type {string[]} */
let scanDirs;

if (extraScanDir !== null) {
  // Test mode: only scan the specified directory.
  scanDirs = [extraScanDir];
} else {
  // Default: scan the full repo, excluding src/ itself and tests/.
  // The walker already skips node_modules, dist, .svelte-kit, etc. via SKIP_DIRS.
  const rootLevelExcludes = new Set(['src', 'tests', '.agentforge']);

  /** @type {string[]} */
  scanDirs = [];
  let topEntries;
  try {
    topEntries = readdirSync(repoRoot, { withFileTypes: true });
  } catch {
    topEntries = [];
  }
  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue;
    if (rootLevelExcludes.has(entry.name)) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;
    scanDirs.push(join(repoRoot, entry.name));
  }
  // Also scan root-level .ts/.mjs files directly (e.g. examples/).
  scanDirs.push(repoRoot);
}

/** @type {{ file: string; specifier: string }[]} */
const violations = [];

for (const scanTarget of scanDirs) {
  let files;
  const targetStat = statSync(scanTarget, { throwIfNoEntry: false });
  if (!targetStat) continue;

  if (targetStat.isDirectory()) {
    files = walkDir(
      scanTarget,
      (name) => {
        if (name.endsWith('.test.ts')) return false;
        if (name.endsWith('.spec.ts')) return false;
        if (name.endsWith('.d.ts')) return false;
        return (
          name.endsWith('.ts') ||
          name.endsWith('.tsx') ||
          name.endsWith('.mts') ||
          name.endsWith('.js') ||
          name.endsWith('.mjs')
        );
      },
      SKIP_DIRS
    );
  } else {
    files = [scanTarget];
  }

  for (const f of files) {
    // When scanning the repo root directory directly, only pick up root-level
    // files (not subdirectories — those are already covered by scanDirs).
    if (scanTarget === repoRoot) {
      const rel = relative(repoRoot, f);
      // Skip if the file is inside any subdirectory of the repo root.
      if (rel.includes('/') || rel.includes('\\')) continue;
    }

    let content = '';
    try {
      content = readFileSync(f, 'utf8');
    } catch {
      continue;
    }

    const specifiers = extractSpecifiers(content);
    for (const spec of specifiers) {
      if (isDeepSrcImport(spec, f)) {
        violations.push({ file: relative(repoRoot, f), specifier: spec });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Step 3: Report and exit
// ---------------------------------------------------------------------------

if (violations.length === 0) {
  console.log('check:legacy-src passed — no deep src/ import violations found.');
  process.exit(0);
} else {
  console.error(`check:legacy-src FAILED — ${violations.length} deep src/ import violation(s) found:`);
  for (const v of violations) {
    console.error(`  ${v.file}  →  ${v.specifier}`);
  }
  process.exit(1);
}
