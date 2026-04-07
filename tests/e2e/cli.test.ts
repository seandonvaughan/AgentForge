import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as yaml from "js-yaml";

// Helper to get the CLI binary path
const CLI_BINARY = "node";
const CLI_SCRIPT = join(
  process.cwd(),
  "dist/cli/index.js"
);

// Helper to run CLI commands with stdin/stdout/stderr control
function runCLI(
  args: string[],
  {
    cwd = process.cwd(),
    stdin = "",
    timeout = 60000,
  }: {
    cwd?: string;
    stdin?: string;
    timeout?: number;
  } = {}
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(CLI_BINARY, [CLI_SCRIPT, ...args], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      timeout,
    });

    let stdout = "";
    let stderr = "";
    let timeoutHandle: NodeJS.Timeout | null = null;
    let resolved = false;

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (exitCode: number | null) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (!resolved) {
        resolved = true;
        resolve({ exitCode, stdout, stderr });
      }
    });

    proc.on("error", (err: Error) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (!resolved) {
        resolved = true;
        resolve({
          exitCode: 1,
          stdout,
          stderr: stderr + err.message,
        });
      }
    });

    if (stdin) {
      proc.stdin?.write(stdin);
    }
    proc.stdin?.end();

    timeoutHandle = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        resolve({
          exitCode: 124,
          stdout,
          stderr: stderr + "\n[TIMEOUT]",
        });
      }
    }, timeout);
  });
}

// Helper to create temporary directory
function createTempDir(): string {
  return require("fs").mkdtempSync(join(tmpdir(), "agentforge-e2e-"));
}

// Helper to remove directory recursively
async function removeDir(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch {
    // Ignore errors if directory doesn't exist
  }
}

// Helper to validate YAML syntax
function isValidYaml(content: string): boolean {
  try {
    yaml.load(content);
    return true;
  } catch {
    return false;
  }
}

describe("CLI E2E Tests", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    // Clean up all temp directories created during tests
    for (const dir of tempDirs) {
      await removeDir(dir);
    }
    tempDirs.length = 0;
  });

  describe("genesis", () => {
    it("produces valid team.yaml with --yes flag (no approval prompt)", async () => {
      const tempDir = createTempDir();
      tempDirs.push(tempDir);

      // Create source files so discovery detects codebase state
      // (avoids interactive interview which requires TTY)
      await fs.writeFile(
        join(tempDir, "package.json"),
        JSON.stringify({
          name: "test-project",
          version: "1.0.0",
          description: "Test project for E2E testing",
        }, null, 2)
      );

      // Create a source file to trigger codebase detection
      await fs.writeFile(
        join(tempDir, "index.js"),
        'console.log("Hello from test project");'
      );

      const result = await runCLI(["genesis", "--yes"], { cwd: tempDir });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("Error");

      // Verify .agentforge/team.yaml exists
      const teamYamlPath = join(tempDir, ".agentforge", "team.yaml");
      const teamYamlExists = await fs
        .stat(teamYamlPath)
        .then(() => true)
        .catch(() => false);

      expect(teamYamlExists).toBe(true);

      // Verify it's valid YAML
      const teamYamlContent = await fs.readFile(teamYamlPath, "utf-8");
      let teamYaml: unknown;
      try {
        teamYaml = yaml.load(teamYamlContent);
      } catch (err) {
        throw new Error(`Failed to parse team.yaml: ${err instanceof Error ? err.message : String(err)}`);
      }

      expect(teamYaml).toBeDefined();

      // Verify it has essential team structure
      const typedYaml = teamYaml as Record<string, unknown>;
      expect(typedYaml).toHaveProperty("name");
      expect(typedYaml).toHaveProperty("model_routing");
      expect(typedYaml).toHaveProperty("agents");
    });

    it("respects --yes flag and skips approval gate", async () => {
      const tempDir = createTempDir();
      tempDirs.push(tempDir);

      // Create source files to avoid interactive interview
      await fs.writeFile(
        join(tempDir, "package.json"),
        JSON.stringify({
          name: "test-project-2",
          version: "1.0.0",
          description: "Another test project",
        }, null, 2)
      );

      await fs.writeFile(
        join(tempDir, "main.js"),
        'console.log("Test");'
      );

      const result = await runCLI(["genesis", "--yes"], { cwd: tempDir });

      // With --yes, should complete without asking for approval
      expect(result.exitCode).toBe(0);

      // Verify that team was written (indicating approval was auto-accepted)
      const teamYamlPath = join(tempDir, ".agentforge", "team.yaml");
      const teamYamlExists = await fs
        .stat(teamYamlPath)
        .then(() => true)
        .catch(() => false);

      expect(teamYamlExists).toBe(true);

      // Verify completion message
      expect(result.stdout).toContain("Genesis complete");
    });

    it.skip("with interactive approval response 'n' does NOT create .agentforge/", async () => {
      // This test is skipped because proper stdin handling for readline/promises
      // requires a TTY, which is not available in spawn with stdio: pipe mode.
      // In a real scenario, this would be tested with a dedicated CLI testing library
      // (e.g., oclif testing framework or similar) that handles TTY simulation.
      const tempDir = createTempDir();
      tempDirs.push(tempDir);

      // Create a package.json to skip interview
      await fs.writeFile(
        join(tempDir, "package.json"),
        JSON.stringify({ name: "test" }, null, 2)
      );

      // Send 'n' to deny approval - this won't work without a real TTY
      const result = await runCLI(["genesis"], {
        cwd: tempDir,
        stdin: "n\n",
        timeout: 10000,
      });

      // This test demonstrates the limitation of testing interactive CLI with spawn
      expect(result.exitCode).toBe(0);
    });
  });

  describe("forge", () => {
    it("analyzes TypeScript project and writes team.yaml with model routing", async () => {
      // v6.5.1: previously ran against process.cwd() (the real AgentForge
      // repo), which mutated the live .agentforge/ directory and forced
      // cycle-runner to ship a TEST_POLLUTION_PATTERNS workaround. Now we
      // seed a minimal TypeScript project inside an os.tmpdir() workspace.
      const projectDir = createTempDir();
      tempDirs.push(projectDir);

      await fs.writeFile(
        join(projectDir, "package.json"),
        JSON.stringify({
          name: "ts-forge-test",
          version: "1.0.0",
          devDependencies: { typescript: "^5.0.0" },
        }, null, 2)
      );
      await fs.writeFile(
        join(projectDir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { target: "es2022" } }, null, 2)
      );
      await fs.mkdir(join(projectDir, "src"), { recursive: true });
      await fs.writeFile(
        join(projectDir, "src", "index.ts"),
        "export const hello = (name: string): string => `hi ${name}`;\n"
      );

      const result = await runCLI(["forge"], { cwd: projectDir });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("Error");

      // Verify .agentforge/team.yaml exists
      const teamYamlPath = join(projectDir, ".agentforge", "team.yaml");
      const teamYamlExists = await fs
        .stat(teamYamlPath)
        .then(() => true)
        .catch(() => false);

      expect(teamYamlExists).toBe(true);

      // Verify it's valid YAML with required structure
      const teamYamlContent = await fs.readFile(teamYamlPath, "utf-8");
      let teamYaml: unknown;
      try {
        teamYaml = yaml.load(teamYamlContent);
      } catch (err) {
        throw new Error(`Failed to parse team.yaml: ${err instanceof Error ? err.message : String(err)}`);
      }

      expect(teamYaml).toBeDefined();

      // Verify model_routing exists with model tiers
      const typedYaml = teamYaml as Record<string, unknown>;
      const modelRouting = typedYaml.model_routing as Record<string, unknown>;

      expect(modelRouting).toBeDefined();
      expect(modelRouting).toHaveProperty("opus");
      expect(modelRouting).toHaveProperty("sonnet");
      expect(modelRouting).toHaveProperty("haiku");
    });

    it("--dry-run outputs plan without writing .agentforge/ directory", async () => {
      const tempDir = createTempDir();
      tempDirs.push(tempDir);

      // Create a minimal project structure
      await fs.writeFile(
        join(tempDir, "package.json"),
        JSON.stringify({
          name: "dry-run-test",
          version: "1.0.0",
        }, null, 2)
      );

      const result = await runCLI(["forge", "--dry-run"], { cwd: tempDir });

      expect(result.exitCode).toBe(0);

      // Verify output includes dry-run indicator
      expect(result.stdout).toContain("dry-run");

      // Verify .agentforge/ directory is NOT created
      const agentforgeDir = join(tempDir, ".agentforge");
      const agentforgeDirExists = await fs
        .stat(agentforgeDir)
        .then(() => true)
        .catch(() => false);

      expect(agentforgeDirExists).toBe(false);
    });

    it("--dry-run prints team composition plan with model assignments", async () => {
      const tempDir = createTempDir();
      tempDirs.push(tempDir);

      // Create a project with TypeScript to ensure detection
      await fs.writeFile(
        join(tempDir, "package.json"),
        JSON.stringify({
          name: "composition-test",
          version: "1.0.0",
          devDependencies: {
            typescript: "^5.0.0",
          },
        }, null, 2)
      );

      const result = await runCLI(["forge", "--dry-run"], { cwd: tempDir });

      expect(result.exitCode).toBe(0);

      // Verify output contains composition information
      expect(result.stdout).toContain("dry-run");

      // Check for either "Agents:" or model assignment output
      const hasAgentInfo = result.stdout.includes("Agents:") ||
                          result.stdout.includes("agents") ||
                          result.stdout.includes("Model");
      expect(hasAgentInfo).toBe(true);

      // Ensure no actual files were written
      const agentforgeDir = join(tempDir, ".agentforge");
      const dirExists = await fs
        .stat(agentforgeDir)
        .then(() => true)
        .catch(() => false);

      expect(dirExists).toBe(false);
    });
  });

  describe("team command", () => {
    it("exits cleanly when .agentforge/ does not exist", async () => {
      const tempDir = createTempDir();
      tempDirs.push(tempDir);

      const result = await runCLI(["team"], { cwd: tempDir });

      // Should exit cleanly or with informative message
      // (exact behavior depends on implementation)
      expect(result.exitCode).toBeLessThanOrEqual(1);
    });
  });

  describe("help and version", () => {
    it("--help prints usage information", async () => {
      const result = await runCLI(["--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("agentforge");
      expect(result.stdout).toContain("Usage");
    });

    it("--version prints version number", async () => {
      const result = await runCLI(["--version"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/\d+\.\d+\.\d+/); // Semantic version format
    });
  });
});
