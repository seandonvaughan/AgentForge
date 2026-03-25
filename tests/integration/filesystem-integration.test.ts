/**
 * Integration tests for the filesystem integration dispatch target.
 *
 * Tests cover real file I/O operations via the IntegrationLayer:
 * - Writing files with filesystem:write_file
 * - Reading files with filesystem:read_file
 * - Error handling for non-existent files
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IntegrationLayer } from "../../src/integrations/integration-layer.js";
import type { McpConfig } from "../../src/types/integration.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a unique temp directory prefixed for easy identification. */
async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentforge-filesystem-"));
}

// ---------------------------------------------------------------------------
// Shared cleanup
// ---------------------------------------------------------------------------

const dirsToClean: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirsToClean.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Filesystem Integration", () => {
  it("filesystem:write_file writes content and returns success", async () => {
    const tmpDir = await makeTmpDir();
    dirsToClean.push(tmpDir);

    const filePath = join(tmpDir, "test-file.txt");
    const testContent = "Hello, filesystem integration!";

    // Create a minimal MCP config (filesystem doesn't require any servers)
    const mcpConfig: McpConfig = {
      mcpServers: {},
    };

    const layer = new IntegrationLayer(mcpConfig);

    const result = await layer.dispatch({
      type: "filesystem:write_file",
      path: filePath,
      content: testContent,
      triggeredBy: "test-agent",
    });

    expect(result.success).toBe(true);
    expect(result.target).toBe("filesystem");
    expect(result.action).toBe("filesystem:write_file");
    expect(result.response).toEqual({
      path: filePath,
      bytesWritten: testContent.length,
    });
    expect(result.error).toBeUndefined();
    expect(result.timestamp).toBeTruthy();
  });

  it("filesystem:read_file reads written content and returns it", async () => {
    const tmpDir = await makeTmpDir();
    dirsToClean.push(tmpDir);

    const filePath = join(tmpDir, "test-read.txt");
    const testContent = "Content to be read back";

    // Pre-write the file
    await writeFile(filePath, testContent, "utf8");

    const mcpConfig: McpConfig = {
      mcpServers: {},
    };

    const layer = new IntegrationLayer(mcpConfig);

    const result = await layer.dispatch({
      type: "filesystem:read_file",
      path: filePath,
      triggeredBy: "test-agent",
    });

    expect(result.success).toBe(true);
    expect(result.target).toBe("filesystem");
    expect(result.action).toBe("filesystem:read_file");
    expect(result.response).toEqual({
      path: filePath,
      content: testContent,
    });
    expect(result.error).toBeUndefined();
    expect(result.timestamp).toBeTruthy();
  });

  it("filesystem:read_file on non-existent path returns failure", async () => {
    const tmpDir = await makeTmpDir();
    dirsToClean.push(tmpDir);

    const nonExistentPath = join(tmpDir, "does-not-exist.txt");

    const mcpConfig: McpConfig = {
      mcpServers: {},
    };

    const layer = new IntegrationLayer(mcpConfig);

    const result = await layer.dispatch({
      type: "filesystem:read_file",
      path: nonExistentPath,
      triggeredBy: "test-agent",
    });

    expect(result.success).toBe(false);
    expect(result.target).toBe("filesystem");
    expect(result.action).toBe("filesystem:read_file");
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("Filesystem operation failed");
    expect(result.timestamp).toBeTruthy();
  });
});
