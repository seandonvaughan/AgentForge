/**
 * ReconRunner — invokes a single recon agent, validates the output, and
 * persists the result to `.agentforge/forge/recon/<agentId>.json`.
 *
 * Designed for dependency injection: the `AgentRuntime` is passed in so
 * tests can mock it without hitting a real LLM.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ZodError } from "zod";

import type { ReconAgentId } from "./types.js";
import {
  SubsystemsReportSchema,
  DependenciesReportSchema,
  ConventionsReportSchema,
  DomainReportSchema,
  HistoryReportSchema,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// AgentRuntime interface (loose typing for injection)
// ---------------------------------------------------------------------------

/**
 * Minimal interface for the execution runtime.  The real implementation is
 * `ExecutionTransport`, but we type it loosely here so tests can provide a
 * simple mock without depending on the full transport hierarchy.
 */
export interface AgentRuntime {
  run(
    agentId: string,
    task: string,
    opts?: { responseFormat?: string; systemPrompt?: string },
  ): Promise<{ response: string; [key: string]: unknown }>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RunReconAgentOpts {
  /** Which recon agent to invoke. */
  agentId: ReconAgentId;
  /** System prompt passed to the LLM. */
  prompt: string;
  /** Payload sent as the user message (JSON-stringified). */
  inputs: Record<string, unknown>;
  /** Model tier.  Defaults: code-archaeologist/domain-mapper/failure-historian → sonnet, others → haiku. */
  model?: "sonnet" | "haiku";
  /** Injected runtime — mock this in tests. */
  runtime: AgentRuntime;
  /** Absolute path to the project root (used to derive the output dir). */
  projectRoot: string;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown when the agent response doesn't satisfy the expected Zod schema.
 */
export class ReconValidationError extends Error {
  constructor(
    public readonly agentId: ReconAgentId,
    public readonly offendingOutput: string,
    public readonly zodError: ZodError,
  ) {
    super(
      `Recon agent "${agentId}" produced output that failed schema validation:\n` +
        zodError.message,
    );
    this.name = "ReconValidationError";
  }
}

// ---------------------------------------------------------------------------
// Default model per agent
// ---------------------------------------------------------------------------

const DEFAULT_MODEL: Record<ReconAgentId, "sonnet" | "haiku"> = {
  "code-archaeologist": "sonnet",
  "dep-graph-analyst": "haiku",
  "convention-detective": "haiku",
  "domain-mapper": "sonnet",
  "failure-historian": "sonnet",
};

// ---------------------------------------------------------------------------
// JSON extraction helpers
// ---------------------------------------------------------------------------

/**
 * Try to extract a JSON payload from the agent response string.
 *
 * Strategy:
 * 1. Look for a ```json ... ``` fenced block and parse the interior.
 * 2. Fall back to parsing the whole response body.
 *
 * Throws a SyntaxError if neither strategy yields valid JSON.
 */
function extractJson(raw: string): unknown {
  // Strategy 1: fenced code block
  const fencedMatch = raw.match(/```json\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return JSON.parse(fencedMatch[1].trim());
  }

  // Strategy 2: bare JSON body
  return JSON.parse(raw.trim());
}

// ---------------------------------------------------------------------------
// Schema map
// ---------------------------------------------------------------------------

const SCHEMA_MAP = {
  "code-archaeologist": SubsystemsReportSchema,
  "dep-graph-analyst": DependenciesReportSchema,
  "convention-detective": ConventionsReportSchema,
  "domain-mapper": DomainReportSchema,
  "failure-historian": HistoryReportSchema,
} as const;

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Invoke one recon agent, parse and validate the response, and persist the
 * raw + parsed result to `.agentforge/forge/recon/<agentId>.json`.
 *
 * @returns The validated, typed report object.
 * @throws {ReconValidationError} When the response fails Zod validation.
 * @throws {SyntaxError} When the response contains no parseable JSON.
 */
export async function runReconAgent(opts: RunReconAgentOpts): Promise<unknown> {
  const { agentId, prompt, inputs, runtime, projectRoot } = opts;
  const model = opts.model ?? DEFAULT_MODEL[agentId];

  // 1. Call the runtime
  const userMessage = JSON.stringify(inputs, null, 2);
  const result = await runtime.run(agentId, userMessage, {
    systemPrompt: prompt,
    responseFormat: model,
  });

  const rawResponse = result.response;

  // Persist raw output FIRST so a downstream validation/parse failure
  // still leaves a forensics trail at `.agentforge/forge/recon/<agentId>.json`.
  const reconDir = join(projectRoot, ".agentforge", "forge", "recon");
  await mkdir(reconDir, { recursive: true });
  await writeFile(
    join(reconDir, `${agentId}.json`),
    JSON.stringify(
      {
        raw: rawResponse,
        parsed: null,
        schema_version: 1,
        generated_at: new Date().toISOString(),
        status: "raw-only",
      },
      null,
      2,
    ),
    "utf-8",
  );

  // Extract JSON from response
  const extracted = extractJson(rawResponse);

  // Validate against the Zod schema
  const schema = SCHEMA_MAP[agentId];
  const parseResult = schema.safeParse(extracted);

  if (!parseResult.success) {
    throw new ReconValidationError(agentId, rawResponse, parseResult.error);
  }

  const parsed = parseResult.data;

  // Re-persist with parsed + validated data
  const payload = {
    raw: rawResponse,
    parsed,
    schema_version: 1,
    generated_at: new Date().toISOString(),
    status: "validated",
  };

  await writeFile(
    join(reconDir, `${agentId}.json`),
    JSON.stringify(payload, null, 2),
    "utf-8",
  );

  return parsed;
}
