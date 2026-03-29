/**
 * Tests for src/utils/version-sync.ts — P2-4: Version Sync Guard
 */

import { describe, it, expect } from "vitest";
import { checkVersionSync } from "../../src/utils/version-sync.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a fake readFile function that serves JSON for package.json and
 * plugin.json paths.
 */
function makeReader(packageVersion: string, pluginVersion: string) {
  return (filePath: string): string => {
    if (filePath.endsWith("package.json") && !filePath.includes("plugin")) {
      return JSON.stringify({ name: "agentforge", version: packageVersion });
    }
    if (filePath.endsWith("plugin.json")) {
      return JSON.stringify({ name: "agentforge", version: pluginVersion });
    }
    throw new Error(`Unexpected readFile call: ${filePath}`);
  };
}

/** makeReader variant where a field is missing from one of the JSON blobs. */
function makeReaderMissingField(missingFrom: "package" | "plugin") {
  return (filePath: string): string => {
    if (filePath.endsWith("package.json") && !filePath.includes("plugin")) {
      return missingFrom === "package"
        ? JSON.stringify({ name: "agentforge" })
        : JSON.stringify({ name: "agentforge", version: "5.9.0" });
    }
    if (filePath.endsWith("plugin.json")) {
      return missingFrom === "plugin"
        ? JSON.stringify({ name: "agentforge" })
        : JSON.stringify({ name: "agentforge", version: "5.9.0" });
    }
    throw new Error(`Unexpected readFile call: ${filePath}`);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkVersionSync", () => {
  it("returns match: true when both versions are identical", () => {
    const result = checkVersionSync("/fake/root", makeReader("6.2.0", "6.2.0"));
    expect(result.packageVersion).toBe("6.2.0");
    expect(result.pluginVersion).toBe("6.2.0");
    expect(result.match).toBe(true);
  });

  it("returns match: false when versions differ", () => {
    const result = checkVersionSync("/fake/root", makeReader("6.2.0", "6.1.0"));
    expect(result.packageVersion).toBe("6.2.0");
    expect(result.pluginVersion).toBe("6.1.0");
    expect(result.match).toBe(false);
  });

  it("returns match: false when plugin version is missing", () => {
    const result = checkVersionSync("/fake/root", makeReaderMissingField("plugin"));
    expect(result.pluginVersion).toBe("");
    expect(result.match).toBe(false);
  });

  it("returns match: false when package version is missing", () => {
    const result = checkVersionSync("/fake/root", makeReaderMissingField("package"));
    expect(result.packageVersion).toBe("");
    expect(result.match).toBe(false);
  });

  it("handles pre-release version strings correctly", () => {
    const result = checkVersionSync("/fake/root", makeReader("6.0.0-rc.1", "6.0.0-rc.1"));
    expect(result.match).toBe(true);
  });

  it("treats versions as strings (no numeric coercion)", () => {
    // "6.2" and "6.2.0" are different strings
    const result = checkVersionSync("/fake/root", makeReader("6.2", "6.2.0"));
    expect(result.match).toBe(false);
  });

  it("reads real project files when no overrides are provided", () => {
    // Integration-style test that hits the real files on disk.
    const result = checkVersionSync();
    expect(typeof result.packageVersion).toBe("string");
    expect(typeof result.pluginVersion).toBe("string");
    expect(typeof result.match).toBe("boolean");
    // Current state: both are 6.2.0
    expect(result.match).toBe(true);
  });
});
