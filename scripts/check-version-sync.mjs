#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const failures = [];

const rootManifest = readJson("package.json");
const rootVersion = stringField(rootManifest, "version");

if (!rootVersion) {
  failures.push("package.json is missing a version field.");
} else if (!isSemverLike(rootVersion)) {
  failures.push(`package.json version is not semver-like: ${rootVersion}`);
}

const manifests = [
  { label: "package.json", path: "package.json", required: true },
  { label: ".claude-plugin/plugin.json", path: join(".claude-plugin", "plugin.json"), required: true },
  ...workspacePackageManifests(),
];

for (const manifest of manifests) {
  const absolutePath = join(repoRoot, manifest.path);
  if (!existsSync(absolutePath)) {
    if (manifest.required) {
      failures.push(`${manifest.label} is missing.`);
    }
    continue;
  }

  const data = readJson(manifest.path);
  const version = stringField(data, "version");
  if (!version) {
    failures.push(`${manifest.label} is missing a version field.`);
    continue;
  }

  if (rootVersion && version !== rootVersion) {
    failures.push(`${manifest.label} version ${version} does not match root ${rootVersion}.`);
  }
}

const refName = process.env.CHECK_VERSION_TAG ?? process.env.GITHUB_REF_NAME ?? "";
if (rootVersion && refName.startsWith("v")) {
  const expectedTag = `v${rootVersion}`;
  if (refName !== expectedTag) {
    failures.push(`release tag ${refName} does not match package version ${expectedTag}.`);
  }
}

if (failures.length > 0) {
  console.error("Version sync check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Version sync check passed for ${rootVersion}.`);

function workspacePackageManifests() {
  const packagesDir = join(repoRoot, "packages");
  if (!existsSync(packagesDir)) {
    return [];
  }

  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = join("packages", entry.name, "package.json");
      return {
        label: relative(repoRoot, join(repoRoot, path)).replaceAll("\\", "/"),
        path,
        required: true,
      };
    });
}

function readJson(path) {
  const absolutePath = join(repoRoot, path);
  try {
    return JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${path} could not be read as JSON: ${message}`);
    return {};
  }
}

function stringField(data, key) {
  return typeof data[key] === "string" ? data[key] : "";
}

function isSemverLike(version) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}
