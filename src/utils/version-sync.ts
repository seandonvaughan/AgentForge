/**
 * VersionSync — P2-4: Version Sync Guard
 *
 * Reads package.json and .claude-plugin/plugin.json, then compares
 * their version fields. The two versions must match per project convention
 * (sprint number in package.json == version in plugin.json).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default project root: up from src/utils/ to repo root. */
const DEFAULT_PROJECT_ROOT = join(__dirname, "../../");

export interface VersionSyncResult {
  packageVersion: string;
  pluginVersion: string;
  match: boolean;
}

/**
 * Read package.json and .claude-plugin/plugin.json from the project root
 * and compare their version strings.
 *
 * @param projectRoot - Optional override for the project root directory.
 * @param readFile    - Optional injectable file reader for testing.
 */
export function checkVersionSync(
  projectRoot?: string,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf-8"),
): VersionSyncResult {
  const root = projectRoot ?? DEFAULT_PROJECT_ROOT;

  const packageJson = readJsonFile(join(root, "package.json"), readFile);
  const pluginJson  = readJsonFile(join(root, ".claude-plugin", "plugin.json"), readFile);

  const packageVersion = String(packageJson["version"] ?? "");
  const pluginVersion  = String(pluginJson["version"]  ?? "");

  return {
    packageVersion,
    pluginVersion,
    match: packageVersion === pluginVersion,
  };
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

function readJsonFile(
  filePath: string,
  readFile: (p: string) => string,
): Record<string, unknown> {
  const raw = readFile(filePath);
  return JSON.parse(raw) as Record<string, unknown>;
}
