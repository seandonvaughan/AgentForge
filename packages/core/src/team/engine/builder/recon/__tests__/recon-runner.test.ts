/**
 * Unit tests for runReconAgent.
 *
 * Uses an injected mock AgentRuntime — no real LLM calls.
 * Tests cover:
 *  - Prompt assembly (system prompt + JSON user message)
 *  - JSON extraction from ```json fenced block
 *  - JSON extraction from bare response body
 *  - Successful Zod validation + file persistence
 *  - ReconValidationError on schema mismatch
 *  - SyntaxError on unparseable response
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runReconAgent, ReconValidationError } from "../recon-runner.js";
import type { AgentRuntime } from "../recon-runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "agentforge-recon-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Build a mock runtime that always returns the given response string. */
function mockRuntime(response: string): AgentRuntime & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async run(agentId, task, opts) {
      calls.push({ agentId, task, opts });
      return { response };
    },
  };
}

// ---------------------------------------------------------------------------
// Valid fixture payloads
// ---------------------------------------------------------------------------

const VALID_SUBSYSTEMS_PAYLOAD = {
  subsystems: [
    {
      name: "api-routes",
      path: "packages/server/src/routes",
      description: "REST route handlers.",
      public_surface: ["registerRoutes"],
      owner_hint: "api-engineer",
    },
  ],
};

const VALID_DEPS_PAYLOAD = {
  package_manager: "pnpm",
  prod_deps: [{ name: "fastify", version: "^4.0.0", category: "framework", in_use_proven: true }],
  dev_deps: [],
  framework_signals: [{ name: "fastify", evidence_files: ["src/server.ts"], confidence: 0.99 }],
};

const VALID_CONVENTIONS_PAYLOAD = {
  linter_rules: [],
  test_pattern: ["**/__tests__/*.test.ts"],
  file_layout: ["kebab-case"],
  import_style: "ESM with .js extensions",
};

const VALID_DOMAIN_PAYLOAD = {
  product_name: "AgentForge",
  one_liner: "Forges specialized AI agent teams.",
  user_personas: ["developers"],
  core_primitives: ["Agent", "Cycle"],
  domain_vocabulary: ["forge", "cycle"],
  non_goals: [],
};

const VALID_HISTORY_PAYLOAD = {
  recurring_bug_patterns: [{ pattern: "Missing .js extension", count: 2, last_seen: "2026-05-14" }],
  gate_rejection_themes: ["hallucinated paths"],
  cost_outliers: [],
  high_value_subsystems: ["packages/core/src/runtime"],
};

// ---------------------------------------------------------------------------
// JSON extraction: fenced block
// ---------------------------------------------------------------------------

describe("runReconAgent — JSON extraction", () => {
  it("extracts JSON from a ```json fenced block", async () => {
    const fenced = `Here is my analysis:\n\`\`\`json\n${JSON.stringify(VALID_SUBSYSTEMS_PAYLOAD)}\n\`\`\`\nDone.`;
    const runtime = mockRuntime(fenced);
    const result = await runReconAgent({
      agentId: "code-archaeologist",
      prompt: "You are a code archaeologist.",
      inputs: { projectRoot: tmpRoot },
      runtime,
      projectRoot: tmpRoot,
    });
    expect((result as typeof VALID_SUBSYSTEMS_PAYLOAD).subsystems).toHaveLength(1);
  });

  it("falls back to bare JSON when no fenced block present", async () => {
    const bare = JSON.stringify(VALID_SUBSYSTEMS_PAYLOAD);
    const runtime = mockRuntime(bare);
    const result = await runReconAgent({
      agentId: "code-archaeologist",
      prompt: "You are a code archaeologist.",
      inputs: { projectRoot: tmpRoot },
      runtime,
      projectRoot: tmpRoot,
    });
    expect((result as typeof VALID_SUBSYSTEMS_PAYLOAD).subsystems).toHaveLength(1);
  });

  it("throws SyntaxError when response is not JSON", async () => {
    const runtime = mockRuntime("I could not analyze the project.");
    await expect(
      runReconAgent({
        agentId: "code-archaeologist",
        prompt: "You are a code archaeologist.",
        inputs: {},
        runtime,
        projectRoot: tmpRoot,
      }),
    ).rejects.toThrow(SyntaxError);
  });
});

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

describe("runReconAgent — prompt assembly", () => {
  it("passes the system prompt to the runtime", async () => {
    const runtime = mockRuntime(JSON.stringify(VALID_SUBSYSTEMS_PAYLOAD));
    const systemPrompt = "You are a specialist.";
    await runReconAgent({
      agentId: "code-archaeologist",
      prompt: systemPrompt,
      inputs: { foo: "bar" },
      runtime,
      projectRoot: tmpRoot,
    });
    const call = runtime.calls[0] as { opts: { systemPrompt: string } };
    expect(call.opts.systemPrompt).toBe(systemPrompt);
  });

  it("JSON-stringifies inputs as the user message", async () => {
    const runtime = mockRuntime(JSON.stringify(VALID_SUBSYSTEMS_PAYLOAD));
    const inputs = { projectRoot: "/tmp/project", directoryTree: "src/" };
    await runReconAgent({
      agentId: "code-archaeologist",
      prompt: "sys",
      inputs,
      runtime,
      projectRoot: tmpRoot,
    });
    const call = runtime.calls[0] as { task: string };
    expect(JSON.parse(call.task)).toEqual(inputs);
  });
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("runReconAgent — schema validation", () => {
  it("validates code-archaeologist output against SubsystemsReportSchema", async () => {
    const runtime = mockRuntime(JSON.stringify(VALID_SUBSYSTEMS_PAYLOAD));
    const result = await runReconAgent({
      agentId: "code-archaeologist",
      prompt: "sys",
      inputs: {},
      runtime,
      projectRoot: tmpRoot,
    });
    expect(result).toMatchObject({ subsystems: expect.any(Array) });
  });

  it("validates dep-graph-analyst output against DependenciesReportSchema", async () => {
    const runtime = mockRuntime(JSON.stringify(VALID_DEPS_PAYLOAD));
    const result = await runReconAgent({
      agentId: "dep-graph-analyst",
      prompt: "sys",
      inputs: {},
      runtime,
      projectRoot: tmpRoot,
    });
    expect(result).toMatchObject({ package_manager: "pnpm" });
  });

  it("validates convention-detective output against ConventionsReportSchema", async () => {
    const runtime = mockRuntime(JSON.stringify(VALID_CONVENTIONS_PAYLOAD));
    const result = await runReconAgent({
      agentId: "convention-detective",
      prompt: "sys",
      inputs: {},
      runtime,
      projectRoot: tmpRoot,
    });
    expect(result).toMatchObject({ import_style: "ESM with .js extensions" });
  });

  it("validates domain-mapper output against DomainReportSchema", async () => {
    const runtime = mockRuntime(JSON.stringify(VALID_DOMAIN_PAYLOAD));
    const result = await runReconAgent({
      agentId: "domain-mapper",
      prompt: "sys",
      inputs: {},
      runtime,
      projectRoot: tmpRoot,
    });
    expect(result).toMatchObject({ product_name: "AgentForge" });
  });

  it("validates failure-historian output against HistoryReportSchema", async () => {
    const runtime = mockRuntime(JSON.stringify(VALID_HISTORY_PAYLOAD));
    const result = await runReconAgent({
      agentId: "failure-historian",
      prompt: "sys",
      inputs: {},
      runtime,
      projectRoot: tmpRoot,
    });
    expect(result).toMatchObject({ recurring_bug_patterns: expect.any(Array) });
  });

  it("throws ReconValidationError when schema mismatch", async () => {
    // Send a DependenciesReport payload for a code-archaeologist agent
    const wrongPayload = JSON.stringify({ package_manager: "pnpm", prod_deps: [], dev_deps: [], framework_signals: [] });
    const runtime = mockRuntime(wrongPayload);
    await expect(
      runReconAgent({
        agentId: "code-archaeologist",
        prompt: "sys",
        inputs: {},
        runtime,
        projectRoot: tmpRoot,
      }),
    ).rejects.toThrow(ReconValidationError);
  });

  it("includes the offending output in ReconValidationError", async () => {
    const badJson = JSON.stringify({ unexpected: true });
    const runtime = mockRuntime(badJson);
    let caught: ReconValidationError | null = null;
    try {
      await runReconAgent({
        agentId: "code-archaeologist",
        prompt: "sys",
        inputs: {},
        runtime,
        projectRoot: tmpRoot,
      });
    } catch (err) {
      if (err instanceof ReconValidationError) caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught?.offendingOutput).toBe(badJson);
    expect(caught?.agentId).toBe("code-archaeologist");
  });
});

// ---------------------------------------------------------------------------
// File persistence
// ---------------------------------------------------------------------------

describe("runReconAgent — file persistence", () => {
  it("writes the result to .agentforge/forge/recon/<agentId>.json", async () => {
    const runtime = mockRuntime(JSON.stringify(VALID_SUBSYSTEMS_PAYLOAD));
    await runReconAgent({
      agentId: "code-archaeologist",
      prompt: "sys",
      inputs: {},
      runtime,
      projectRoot: tmpRoot,
    });
    const filePath = join(tmpRoot, ".agentforge", "forge", "recon", "code-archaeologist.json");
    expect(existsSync(filePath)).toBe(true);
  });

  it("persisted file has raw, parsed, schema_version, and generated_at fields", async () => {
    const runtime = mockRuntime(JSON.stringify(VALID_SUBSYSTEMS_PAYLOAD));
    await runReconAgent({
      agentId: "code-archaeologist",
      prompt: "sys",
      inputs: {},
      runtime,
      projectRoot: tmpRoot,
    });
    const filePath = join(tmpRoot, ".agentforge", "forge", "recon", "code-archaeologist.json");
    const content = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(content).toHaveProperty("raw");
    expect(content).toHaveProperty("parsed");
    expect(content.schema_version).toBe(1);
    expect(typeof content.generated_at).toBe("string");
  });

  it("persisted parsed matches the validated output", async () => {
    const runtime = mockRuntime(JSON.stringify(VALID_SUBSYSTEMS_PAYLOAD));
    const result = await runReconAgent({
      agentId: "code-archaeologist",
      prompt: "sys",
      inputs: {},
      runtime,
      projectRoot: tmpRoot,
    });
    const filePath = join(tmpRoot, ".agentforge", "forge", "recon", "code-archaeologist.json");
    const content = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(content.parsed).toEqual(result);
  });

  it("creates parent directories if they do not exist", async () => {
    const runtime = mockRuntime(JSON.stringify(VALID_HISTORY_PAYLOAD));
    // projectRoot with no pre-existing .agentforge dir
    await runReconAgent({
      agentId: "failure-historian",
      prompt: "sys",
      inputs: {},
      runtime,
      projectRoot: tmpRoot,
    });
    const filePath = join(tmpRoot, ".agentforge", "forge", "recon", "failure-historian.json");
    expect(existsSync(filePath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Default model routing
// ---------------------------------------------------------------------------

describe("runReconAgent — default model", () => {
  it.each([
    ["code-archaeologist", "sonnet"],
    ["dep-graph-analyst", "haiku"],
    ["convention-detective", "haiku"],
    ["domain-mapper", "sonnet"],
    ["failure-historian", "sonnet"],
  ] as const)(
    "%s defaults to %s model",
    async (agentId, expectedModel) => {
      const payloads: Record<string, unknown> = {
        "code-archaeologist": VALID_SUBSYSTEMS_PAYLOAD,
        "dep-graph-analyst": VALID_DEPS_PAYLOAD,
        "convention-detective": VALID_CONVENTIONS_PAYLOAD,
        "domain-mapper": VALID_DOMAIN_PAYLOAD,
        "failure-historian": VALID_HISTORY_PAYLOAD,
      };
      const runtime = mockRuntime(JSON.stringify(payloads[agentId]));
      await runReconAgent({
        agentId,
        prompt: "sys",
        inputs: {},
        runtime,
        projectRoot: tmpRoot,
      });
      const call = runtime.calls[0] as { opts: { responseFormat: string } };
      expect(call.opts.responseFormat).toBe(expectedModel);
    },
  );

  it("respects an explicit model override", async () => {
    const runtime = mockRuntime(JSON.stringify(VALID_SUBSYSTEMS_PAYLOAD));
    await runReconAgent({
      agentId: "code-archaeologist",
      prompt: "sys",
      inputs: {},
      model: "haiku",
      runtime,
      projectRoot: tmpRoot,
    });
    const call = runtime.calls[0] as { opts: { responseFormat: string } };
    expect(call.opts.responseFormat).toBe("haiku");
  });
});
