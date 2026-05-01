#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const changelogPath = join(repoRoot, "CHANGELOG.md");
const rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const version = rootManifest.version;
const failures = [];

if (!existsSync(changelogPath)) {
  failures.push("CHANGELOG.md is missing.");
} else {
  const changelog = readFileSync(changelogPath, "utf8");
  const normalized = changelog.replace(/^\uFEFF/, "");

  if (!normalized.startsWith("# Changelog")) {
    failures.push("CHANGELOG.md must start with '# Changelog'.");
  }

  const unreleasedIndex = normalized.search(/^## \[Unreleased\]/m);
  if (unreleasedIndex === -1) {
    failures.push("CHANGELOG.md is missing a '## [Unreleased]' section.");
  }

  const versionHeading = new RegExp(`^## \\[${escapeRegex(version)}\\]\\s+-\\s+\\d{4}-\\d{2}-\\d{2}\\s*$`, "m");
  const match = normalized.match(versionHeading);
  if (!match || match.index === undefined) {
    failures.push(`CHANGELOG.md is missing a dated section for version ${version}.`);
  } else {
    if (unreleasedIndex !== -1 && match.index < unreleasedIndex) {
      failures.push(`CHANGELOG.md version ${version} appears before [Unreleased].`);
    }

    const bodyStart = match.index + match[0].length;
    const nextHeading = normalized.slice(bodyStart).search(/^## \[/m);
    const body = nextHeading === -1
      ? normalized.slice(bodyStart)
      : normalized.slice(bodyStart, bodyStart + nextHeading);

    if (!body.trim()) {
      failures.push(`CHANGELOG.md section for version ${version} is empty.`);
    }
  }
}

if (failures.length > 0) {
  console.error("Changelog check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Changelog check passed for ${version}.`);

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
