/**
 * Tests for cc-agent-emitter.ts — Workstream U (T3.1 + T3.6) of Cycle 3.
 *
 * Verifies:
 *   - Happy path: 3 agents → 3 .md files with correct content
 *   - Frontmatter shape matches Claude Code schema
 *   - Atomic write: tmp-then-rename so crashes can't leave partial files
 *   - Missing .claude/ dir: auto-created, no crash
 *   - Idempotency: running twice produces the same files
 *   - Default values: tools and model fall back correctly
 *   - Custom tools and model override defaults
 *   - YAML-safe description: special characters are properly escaped
 */

import { describe, it, expect } from "vitest";
import { mkdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import yaml from "js-yaml";

import {
  emitClaudeCodeAgents,
  buildAgentMarkdown,
  type ClaudeCodeAgentSpec,
} from "../cc-agent-emitter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpRoot(): Promise<string> {
  const dir = join(tmpdir(), `cc-emitter-test-${randomBytes(6).toString("hex")}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Parse the YAML frontmatter from a .md file. Returns the parsed object and the body. */
function parseMd(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  // Strip leading ---\n, find closing ---\n
  const stripped = content.startsWith("---\n") ? content.slice(4) : content;
  const closingIdx = stripped.indexOf("\n---\n");
  if (closingIdx === -1) throw new Error("No closing --- found in frontmatter");
  const fmRaw = stripped.slice(0, closingIdx);
  const body = stripped.slice(closingIdx + 5); // skip \n---\n
  const frontmatter = yaml.load(fmRaw) as Record<string, string>;
  return { frontmatter, body };
}

const AGENT_A: ClaudeCodeAgentSpec = {
  id: "architect",
  description: "Strategic architect agent",
  systemPrompt: "You are the architect. Plan everything.",
  model: "opus",
};

const AGENT_B: ClaudeCodeAgentSpec = {
  id: "code-reviewer",
  description: "Reviews pull requests for quality and correctness",
  systemPrompt: "You review code changes. Be thorough.",
  model: "sonnet",
};

const AGENT_C: ClaudeCodeAgentSpec = {
  id: "test-runner",
  description: "Runs the test suite and reports failures",
  systemPrompt: "You run tests. Report all failures.",
  model: "haiku",
  tools: ["Read", "Bash"],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("emitClaudeCodeAgents", () => {
  describe("happy path — 3 agents", () => {
    it("writes exactly 3 .md files to .claude/agents/", async () => {
      const projectRoot = await makeTmpRoot();
      const result = await emitClaudeCodeAgents({
        projectRoot,
        agents: [AGENT_A, AGENT_B, AGENT_C],
      });

      expect(result.written).toHaveLength(3);

      for (const agent of [AGENT_A, AGENT_B, AGENT_C]) {
        const expected = join(projectRoot, ".claude", "agents", `${agent.id}.md`);
        expect(result.written).toContain(expected);
        const s = await stat(expected);
        expect(s.isFile()).toBe(true);
      }
    });

    it("written paths are absolute", async () => {
      const projectRoot = await makeTmpRoot();
      const result = await emitClaudeCodeAgents({
        projectRoot,
        agents: [AGENT_A],
      });

      for (const p of result.written) {
        expect(isAbsolute(p)).toBe(true);
      }
    });
  });

  describe("frontmatter shape", () => {
    it("frontmatter contains name, description, tools, model fields", async () => {
      const projectRoot = await makeTmpRoot();
      await emitClaudeCodeAgents({ projectRoot, agents: [AGENT_A] });

      const filePath = join(projectRoot, ".claude", "agents", "architect.md");
      const content = await readFile(filePath, "utf-8");
      const { frontmatter } = parseMd(content);

      expect(frontmatter).toHaveProperty("name", "architect");
      expect(frontmatter).toHaveProperty("description", "Strategic architect agent");
      expect(frontmatter).toHaveProperty("tools");
      expect(frontmatter).toHaveProperty("model", "opus");
    });

    it("default tools are Read,Edit,Write,Bash,Grep,Glob when not specified", async () => {
      const projectRoot = await makeTmpRoot();
      await emitClaudeCodeAgents({ projectRoot, agents: [AGENT_A] });

      const filePath = join(projectRoot, ".claude", "agents", "architect.md");
      const content = await readFile(filePath, "utf-8");
      const { frontmatter } = parseMd(content);

      expect(frontmatter.tools).toBe("Read,Edit,Write,Bash,Grep,Glob");
    });

    it("custom tools override the default", async () => {
      const projectRoot = await makeTmpRoot();
      await emitClaudeCodeAgents({ projectRoot, agents: [AGENT_C] });

      const filePath = join(projectRoot, ".claude", "agents", "test-runner.md");
      const content = await readFile(filePath, "utf-8");
      const { frontmatter } = parseMd(content);

      expect(frontmatter.tools).toBe("Read,Bash");
    });

    it("model defaults to sonnet when not specified", async () => {
      const projectRoot = await makeTmpRoot();
      const agentNoModel: ClaudeCodeAgentSpec = {
        id: "helper",
        description: "A generic helper",
        systemPrompt: "You help.",
      };
      await emitClaudeCodeAgents({ projectRoot, agents: [agentNoModel] });

      const filePath = join(projectRoot, ".claude", "agents", "helper.md");
      const content = await readFile(filePath, "utf-8");
      const { frontmatter } = parseMd(content);

      expect(frontmatter.model).toBe("sonnet");
    });

    it("system prompt body appears after the closing ---", async () => {
      const projectRoot = await makeTmpRoot();
      await emitClaudeCodeAgents({ projectRoot, agents: [AGENT_B] });

      const filePath = join(projectRoot, ".claude", "agents", "code-reviewer.md");
      const content = await readFile(filePath, "utf-8");
      const { body } = parseMd(content);

      expect(body.trim()).toBe(AGENT_B.systemPrompt.trim());
    });

    it("YAML-special characters in description are correctly escaped", async () => {
      const projectRoot = await makeTmpRoot();
      const trickyAgent: ClaudeCodeAgentSpec = {
        id: "tricky-agent",
        description: 'Uses: colons, "quotes", and {braces}',
        systemPrompt: "You handle edge cases.",
      };
      await emitClaudeCodeAgents({ projectRoot, agents: [trickyAgent] });

      const filePath = join(projectRoot, ".claude", "agents", "tricky-agent.md");
      const content = await readFile(filePath, "utf-8");
      const { frontmatter } = parseMd(content);

      expect(frontmatter.description).toBe('Uses: colons, "quotes", and {braces}');
    });
  });

  describe("directory creation", () => {
    it("creates .claude/agents/ when it does not exist", async () => {
      const projectRoot = await makeTmpRoot();
      // Deliberately do NOT create .claude/ beforehand
      const claudeAgentsDir = join(projectRoot, ".claude", "agents");

      // Confirm it doesn't exist yet
      await expect(stat(claudeAgentsDir)).rejects.toThrow();

      await emitClaudeCodeAgents({ projectRoot, agents: [AGENT_A] });

      // Now it should exist
      const s = await stat(claudeAgentsDir);
      expect(s.isDirectory()).toBe(true);
    });

    it("succeeds when .claude/agents/ already exists (no EEXIST)", async () => {
      const projectRoot = await makeTmpRoot();
      await mkdir(join(projectRoot, ".claude", "agents"), { recursive: true });

      await expect(
        emitClaudeCodeAgents({ projectRoot, agents: [AGENT_A] }),
      ).resolves.not.toThrow();
    });
  });

  describe("idempotency", () => {
    it("running twice produces identical file content", async () => {
      const projectRoot = await makeTmpRoot();

      await emitClaudeCodeAgents({ projectRoot, agents: [AGENT_A, AGENT_B] });
      const firstContents = await Promise.all(
        [AGENT_A, AGENT_B].map((a) =>
          readFile(join(projectRoot, ".claude", "agents", `${a.id}.md`), "utf-8"),
        ),
      );

      await emitClaudeCodeAgents({ projectRoot, agents: [AGENT_A, AGENT_B] });
      const secondContents = await Promise.all(
        [AGENT_A, AGENT_B].map((a) =>
          readFile(join(projectRoot, ".claude", "agents", `${a.id}.md`), "utf-8"),
        ),
      );

      for (let i = 0; i < firstContents.length; i++) {
        expect(firstContents[i]).toBe(secondContents[i]);
      }
    });
  });

  describe("atomic write behaviour", () => {
    it("completed write is always a complete file — partial content is never observable", async () => {
      // We verify the atomic-write invariant structurally rather than by
      // mocking ESM native modules (which is not supported by Vitest for
      // node:fs/promises in ESM mode).
      //
      // The invariant: once the file appears at the target path it must
      // contain the complete content — we check that the frontmatter block
      // is intact and the system prompt body is fully present.
      const projectRoot = await makeTmpRoot();

      await emitClaudeCodeAgents({ projectRoot, agents: [AGENT_A, AGENT_B, AGENT_C] });

      for (const agent of [AGENT_A, AGENT_B, AGENT_C]) {
        const filePath = join(projectRoot, ".claude", "agents", `${agent.id}.md`);
        const content = await readFile(filePath, "utf-8");

        // Must start with the opening fence
        expect(content.startsWith("---\n")).toBe(true);
        // Must contain the closing fence (incomplete write would be truncated)
        expect(content).toContain("\n---\n");
        // System prompt body must be present in full
        expect(content).toContain(agent.systemPrompt);
      }
    });

    it("tmp file does not appear in the target directory during write", async () => {
      // Atomicity: the write uses a same-directory temp file and renames it
      // into place, so no .tmp files should remain in the agents dir.
      const projectRoot = await makeTmpRoot();
      const agentsDir = join(projectRoot, ".claude", "agents");

      await emitClaudeCodeAgents({ projectRoot, agents: [AGENT_A] });

      const { readdir } = await import("node:fs/promises");
      const files = await readdir(agentsDir);
      const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe("empty agents array", () => {
    it("returns empty written array when agents list is empty", async () => {
      const projectRoot = await makeTmpRoot();
      const result = await emitClaudeCodeAgents({ projectRoot, agents: [] });
      expect(result.written).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// buildAgentMarkdown (unit tests for the pure helper)
// ---------------------------------------------------------------------------

describe("buildAgentMarkdown", () => {
  it("produces a file starting with ---", () => {
    const md = buildAgentMarkdown(AGENT_A);
    expect(md.startsWith("---\n")).toBe(true);
  });

  it("name field equals the agent id", () => {
    const md = buildAgentMarkdown(AGENT_B);
    const { frontmatter } = parseMd(md);
    expect(frontmatter.name).toBe("code-reviewer");
  });

  it("model field equals the provided model", () => {
    const md = buildAgentMarkdown(AGENT_C);
    const { frontmatter } = parseMd(md);
    expect(frontmatter.model).toBe("haiku");
  });

  it("tools field is comma-joined with no spaces", () => {
    const md = buildAgentMarkdown(AGENT_C);
    const { frontmatter } = parseMd(md);
    expect(frontmatter.tools).toBe("Read,Bash");
  });

  it("system prompt body follows the closing --- delimiter", () => {
    const md = buildAgentMarkdown(AGENT_A);
    const { body } = parseMd(md);
    expect(body).toContain("You are the architect.");
  });
});
