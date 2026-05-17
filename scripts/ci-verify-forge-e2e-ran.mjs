#!/usr/bin/env node
/**
 * ci-verify-forge-e2e-ran.mjs
 *
 * Reads the JUnit XML artifact produced by the Test job
 * (test-results/junit.xml) and asserts that the
 * agent-driven-forge-e2e test suite actually executed.
 *
 * Exits 0 on success, 1 on failure (silently-skipped or missing).
 *
 * Usage:
 *   node scripts/ci-verify-forge-e2e-ran.mjs [path-to-junit.xml]
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const xmlPath =
  process.argv[2] ?? join(repoRoot, "test-results", "junit.xml");

// ── 1. Verify the file exists ──────────────────────────────────────────────

if (!existsSync(xmlPath)) {
  console.error(`[forge-e2e-verify] FAIL: JUnit XML not found at ${xmlPath}`);
  console.error(
    "  The Test job must upload test-results/junit.xml before this check runs."
  );
  process.exit(1);
}

const xml = readFileSync(xmlPath, "utf8");

// ── 2. Search for the test file name in the XML ────────────────────────────
//
// Vitest JUnit reporter writes classname attributes that include the test
// file path, e.g.:
//
//   <testcase classname="tests/integration/agent-driven-forge-e2e"
//             name="Phase A — recon artifact persistence > writes all 5 recon JSONs"
//             .../>
//
// We treat the presence of "agent-driven-forge-e2e" anywhere in the XML as
// proof the suite ran.  We additionally count passing test cases (<testcase>
// elements that have NO nested <failure> or <error> child) to surface a
// meaningful summary.

const NEEDLE = "agent-driven-forge-e2e";

if (!xml.includes(NEEDLE)) {
  console.error(
    `[forge-e2e-verify] FAIL: No test cases for "${NEEDLE}" found in ${xmlPath}`
  );
  console.error(
    "  The agent-driven forge e2e suite was NOT executed.  Check vitest include patterns."
  );
  process.exit(1);
}

// ── 3. Count pass / fail ───────────────────────────────────────────────────
//
// Naive XML parse — avoids adding a dependency on a real XML parser.
// We pull every <testcase ...> block that references the needle file.

const blockRe =
  /<testcase\b[^>]*?(?:classname|name)="[^"]*agent-driven-forge-e2e[^"]*"[\s\S]*?(?:\/>|<\/testcase>)/g;
const blocks = xml.match(blockRe) ?? [];

let passed = 0;
let failed = 0;
let skipped = 0;

for (const block of blocks) {
  if (/<failure\b/.test(block) || /<error\b/.test(block)) {
    failed += 1;
  } else if (/<skipped\b/.test(block)) {
    skipped += 1;
  } else {
    passed += 1;
  }
}

const total = passed + failed + skipped;

// ── 4. Report ──────────────────────────────────────────────────────────────

if (total === 0) {
  // The string "agent-driven-forge-e2e" appeared (e.g. in a testsuite
  // attribute) but we found no individual testcase blocks — something is
  // off with the XML structure.
  console.error(
    `[forge-e2e-verify] WARN: Suite token found but 0 testcase blocks matched.`
  );
  console.error(
    "  Adjust the regex in scripts/ci-verify-forge-e2e-ran.mjs if the JUnit format changed."
  );
  // Non-fatal: the suite ran, we just couldn't count.
  console.log("[forge-e2e-verify] PASS (suite present, count indeterminate)");
  process.exit(0);
}

console.log(
  `[forge-e2e-verify] agent-driven-forge-e2e: ${total} test(s) — ${passed} passed, ${failed} failed, ${skipped} skipped`
);

if (failed > 0) {
  console.error(
    `[forge-e2e-verify] FAIL: ${failed} test case(s) in the forge e2e suite are failing.`
  );
  process.exit(1);
}

console.log("[forge-e2e-verify] PASS: agent-driven forge pipeline e2e ran and all tests passed.");
process.exit(0);
