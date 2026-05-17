/**
 * Tests for cc-command-emitter.ts — T3.4 of Cycle 3 / v20.0.0.
 *
 * Verifies that `emitClaudeCodeTeamCommands` writes correct slash-command
 * stub files, handles idempotency, skips when .claude/ is absent, and that
 * atomic writes prevent partial files from being observed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  emitClaudeCodeTeamCommands,
  buildCommandMarkdown,
  type TeamCommandSpec,
} from "../cc-command-emitter.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENTS: TeamCommandSpec[] = [
  { id: "react-component-engineer", description: "Builds reusable React components with TypeScript." },
  { id: "sqlite-schema-engineer", description: "Authors and migrates SQLite schemas." },
  { id: "vitest-author", description: "Writes unit and integration tests using Vitest." },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "agentforge-cc-cmd-test-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

/** Create the .claude/ directory (opt-in). */
function createClaudeDir(): void {
  mkdirSync(join(projectRoot, ".claude"), { recursive: true });
}

/** Read the content of a written command file. */
function readCommandFile(agentId: string): string {
  return readFileSync(
    join(projectRoot, ".claude", "commands", `team-${agentId}.md`),
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("emitClaudeCodeTeamCommands", () => {
  it("writes one team-<id>.md file per agent when .claude/ exists", async () => {
    createClaudeDir();

    const { written } = await emitClaudeCodeTeamCommands({
      projectRoot,
      agents: AGENTS,
    });

    expect(written).toHaveLength(3);
    for (const agent of AGENTS) {
      const expectedPath = join(
        projectRoot,
        ".claude",
        "commands",
        `team-${agent.id}.md`,
      );
      expect(written).toContain(expectedPath);
      expect(existsSync(expectedPath)).toBe(true);
    }
  });

  it("frontmatter contains the agent description", async () => {
    createClaudeDir();
    await emitClaudeCodeTeamCommands({ projectRoot, agents: AGENTS });

    const content = readCommandFile("react-component-engineer");
    expect(content).toContain("react-component-engineer");
    expect(content).toContain(
      "Invoke the react-component-engineer agent with a task.",
    );
    expect(content).toContain("argument-hint: <task description>");
  });

  it("command body includes the correct <id> substitution", async () => {
    createClaudeDir();
    await emitClaudeCodeTeamCommands({ projectRoot, agents: AGENTS });

    const content = readCommandFile("sqlite-schema-engineer");
    // Title
    expect(content).toContain("# Team: sqlite-schema-engineer");
    // Body references agent id in backtick invocation
    expect(content).toContain("`sqlite-schema-engineer`");
    // References the .claude/agents/ path
    expect(content).toContain(".claude/agents/sqlite-schema-engineer.md");
    // References $ARGUMENTS placeholder
    expect(content).toContain("$ARGUMENTS");
  });

  it("command body includes the agent's description text", async () => {
    createClaudeDir();
    await emitClaudeCodeTeamCommands({ projectRoot, agents: AGENTS });

    const content = readCommandFile("vitest-author");
    expect(content).toContain(
      "Writes unit and integration tests using Vitest.",
    );
  });

  it("is idempotent — running twice produces identical files", async () => {
    createClaudeDir();

    await emitClaudeCodeTeamCommands({ projectRoot, agents: AGENTS });
    const firstRun = readCommandFile("react-component-engineer");

    await emitClaudeCodeTeamCommands({ projectRoot, agents: AGENTS });
    const secondRun = readCommandFile("react-component-engineer");

    expect(firstRun).toBe(secondRun);

    // Directory should still contain exactly 3 files (no duplicates/extras)
    const files = readdirSync(join(projectRoot, ".claude", "commands"));
    expect(files).toHaveLength(3);
  });

  it("skips silently when .claude/ does not exist", async () => {
    // Do NOT call createClaudeDir() — .claude/ is absent

    const { written } = await emitClaudeCodeTeamCommands({
      projectRoot,
      agents: AGENTS,
    });

    expect(written).toHaveLength(0);
    // Neither .claude/ nor .claude/commands/ should have been created
    expect(existsSync(join(projectRoot, ".claude"))).toBe(false);
    expect(existsSync(join(projectRoot, ".claude", "commands"))).toBe(false);
  });

  it("creates .claude/commands/ if it is absent but .claude/ exists", async () => {
    createClaudeDir();
    // Do NOT create commands/ subdirectory

    const { written } = await emitClaudeCodeTeamCommands({
      projectRoot,
      agents: [{ id: "architect", description: "Strategic architect." }],
    });

    expect(written).toHaveLength(1);
    expect(existsSync(join(projectRoot, ".claude", "commands"))).toBe(true);
  });

  it("returns empty written array for empty agents input", async () => {
    createClaudeDir();

    const { written } = await emitClaudeCodeTeamCommands({
      projectRoot,
      agents: [],
    });

    expect(written).toHaveLength(0);
  });

  it("atomic write: no partial file left on disk for each agent", async () => {
    // We can't simulate a mid-write OS failure cleanly, but we CAN verify
    // that the final file is a complete valid markdown document (i.e. starts
    // with `---` and contains the closing `---`) which would be false for a
    // partial write that stopped before the rename.
    createClaudeDir();
    await emitClaudeCodeTeamCommands({ projectRoot, agents: AGENTS });

    for (const agent of AGENTS) {
      const content = readCommandFile(agent.id);
      expect(content.startsWith("---\n")).toBe(true);
      // Should contain closing frontmatter delimiter
      expect(content).toContain("---\n\n#");
    }
  });
});

// ---------------------------------------------------------------------------
// buildCommandMarkdown unit tests
// ---------------------------------------------------------------------------

describe("buildCommandMarkdown", () => {
  it("produces valid frontmatter block with correct fields", () => {
    const md = buildCommandMarkdown({
      id: "pr-merge-manager",
      description: "Owns the PR queue and handles merge sequencing.",
    });

    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("description: Invoke the pr-merge-manager agent");
    expect(md).toContain("argument-hint: <task description>");
    expect(md).toContain("---\n\n# Team: pr-merge-manager");
  });

  it("includes /agentforge:invoke fallback reference in body", () => {
    const md = buildCommandMarkdown({
      id: "cto",
      description: "Chief technology officer agent.",
    });

    expect(md).toContain("/agentforge:invoke cto");
  });
});

// ---------------------------------------------------------------------------
// End-to-end smoke: forge 2 agents → 2 .claude/commands/team-*.md files
// ---------------------------------------------------------------------------

describe("end-to-end smoke", () => {
  it("forging a fake 2-agent team produces 2 team-*.md files with correct content", async () => {
    createClaudeDir();

    const fakeTeam: TeamCommandSpec[] = [
      {
        id: "fastify-route-engineer",
        description: "Authors Fastify routes with Zod validation.",
      },
      {
        id: "playwright-author",
        description: "Writes Playwright end-to-end tests.",
      },
    ];

    const { written } = await emitClaudeCodeTeamCommands({
      projectRoot,
      agents: fakeTeam,
    });

    expect(written).toHaveLength(2);

    // Verify fastify-route-engineer command
    const fastifyContent = readCommandFile("fastify-route-engineer");
    expect(fastifyContent).toContain("# Team: fastify-route-engineer");
    expect(fastifyContent).toContain(
      "Authors Fastify routes with Zod validation.",
    );
    expect(fastifyContent).toContain(
      ".claude/agents/fastify-route-engineer.md",
    );

    // Verify playwright-author command
    const playwrightContent = readCommandFile("playwright-author");
    expect(playwrightContent).toContain("# Team: playwright-author");
    expect(playwrightContent).toContain(
      "Writes Playwright end-to-end tests.",
    );
    expect(playwrightContent).toContain(".claude/agents/playwright-author.md");

    // Both files should be reachable from the commands directory listing
    const commandFiles = readdirSync(
      join(projectRoot, ".claude", "commands"),
    );
    expect(commandFiles).toContain("team-fastify-route-engineer.md");
    expect(commandFiles).toContain("team-playwright-author.md");
  });
});
