import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Shared types — re-exported from the canonical cc-agent-emitter so both the
// invocation path (this file) and the emission path use the same shape.
// ---------------------------------------------------------------------------

export type {
  ClaudeCodeAgentSpec,
  ClaudeCodeAgentSpec as CcAgentSpec, // legacy alias for in-flight callers
} from '../team/engine/builder/cc-agent-emitter.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by `invokeViaClaudeCode` when neither the CLAUDE_CODE_RUNTIME env var
 * nor a `.claude/agents/<agentId>.md` file is present.  Callers should catch
 * this and fall back to the existing CLI path.
 */
export class CcNotAvailableError extends Error {
  readonly agentId: string;

  constructor(agentId: string) {
    super(
      `CC-native invocation not available for agent "${agentId}": ` +
        'CLAUDE_CODE_RUNTIME is not "1" and no .claude/agents/<id>.md file was found. ' +
        'Fall back to the CLI path.',
    );
    this.name = 'CcNotAvailableError';
    this.agentId = agentId;
  }
}

// ---------------------------------------------------------------------------
// Detection helpers (exported for unit-testing without side effects)
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the caller is running inside a Claude Code session.
 *
 * Detection criteria (either is sufficient):
 *   a. `process.env.CLAUDE_CODE_RUNTIME === '1'`
 *   b. `.claude/agents/<agentId>.md` exists on disk under `projectRoot`
 */
export function isCcRuntimeAvailable(agentId: string, projectRoot: string): boolean {
  if (process.env['CLAUDE_CODE_RUNTIME'] === '1') return true;
  const ccAgentFile = join(projectRoot, '.claude', 'agents', `${agentId}.md`);
  return existsSync(ccAgentFile);
}

// ---------------------------------------------------------------------------
// Marker file payload
// ---------------------------------------------------------------------------

export interface CcInvokeMarker {
  agentId: string;
  task: string;
  requestedAt: string;
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export interface CcNativeInvokeResult {
  /**
   * Structured payload echoed back to the orchestrating CC session.
   * The outer session reads this and translates it into an Agent tool call.
   */
  response: string;
  /** Always 'cc-native' so callers can identify this path. */
  via: 'cc-native';
  /** The marker written to disk for the outer CC session to pick up. */
  marker: CcInvokeMarker;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Attempts to invoke an agent via Claude Code's native `Agent` tool path.
 *
 * **Important:** This function itself does NOT call the Agent tool — that has to
 * happen in the *outer* CC turn (this code runs inside an agent run, which
 * cannot recursively invoke Agent).  Instead it:
 *
 * 1. Detects whether a CC session is available (env var OR .claude/agents/ file).
 * 2. Writes a marker file to `.agentforge/cc-invoke-marker-<sessionId>.json`
 *    containing `{ agentId, task, requestedAt }`.
 * 3. Returns a structured payload that the orchestrating CC session can inspect
 *    and convert into a real Agent tool call.
 *
 * When neither detection signal is present, throws `CcNotAvailableError` so the
 * caller can fall back to the existing `claude -p` subprocess path.
 */
export async function invokeViaClaudeCode(opts: {
  agentId: string;
  task: string;
  projectRoot: string;
}): Promise<CcNativeInvokeResult> {
  const { agentId, task, projectRoot } = opts;

  if (!isCcRuntimeAvailable(agentId, projectRoot)) {
    throw new CcNotAvailableError(agentId);
  }

  const sessionId = `cc-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const requestedAt = new Date().toISOString();

  const marker: CcInvokeMarker = { agentId, task, requestedAt, sessionId };

  // Write marker file so the outer CC orchestrator can pick it up and issue the
  // real Agent tool call.  We create the directory if needed (e.g. first run).
  const markerDir = join(projectRoot, '.agentforge');
  mkdirSync(markerDir, { recursive: true });

  const markerPath = join(markerDir, `cc-invoke-marker-${sessionId}.json`);
  writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf8');

  const response = JSON.stringify({
    via: 'cc-native',
    agentId,
    sessionId,
    markerFile: markerPath,
    message:
      `CC-native invoke marker written. The orchestrating Claude Code session ` +
      `should read ${markerPath} and invoke agent "${agentId}" via the Agent tool.`,
  });

  return { response, via: 'cc-native', marker };
}
