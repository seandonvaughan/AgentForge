import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { getRequestModelProfile } from '../model-profiles.js';
import { estimateOpenAiCostUsd } from '../openai-pricing.js';
import { normalizeStrictOutputSchema } from '../output-schema.js';
import {
  CodexAuthError,
  TransportInvalidRequestError,
  classifyCodexCliError,
} from '../transport-errors.js';
import type { CodexAuthResult } from '../codex-auth.js';
import type {
  AgentOutputSchema,
  CodexSandboxMode,
  ExecutionRequest,
  ExecutionResult,
  ExecutionStreamEvent,
  ExecutionStreamOptions,
  ExecutionTransport,
} from '../types.js';

const CODEX_COMMAND = 'codex';
const DEFAULT_CODEX_SANDBOX: CodexSandboxMode = 'workspace-write';

/**
 * Exact message raised when the Codex CLI exits 0 but never emits its final
 * message. This is the ONLY failure the transient retry loop re-runs; every
 * other error (non-zero exit, timeout, abort, spawn failure) propagates as-is.
 */
const CODEX_NO_FINAL_MESSAGE = 'codex CLI completed without a final message';

/**
 * Backoff schedule for the transient no-final-message flake: the invocation is
 * retried up to `length` more times, waiting ~2s then ~5s between attempts.
 */
export const CODEX_NO_FINAL_MESSAGE_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000];

function isCodexNoFinalMessageError(err: unknown): boolean {
  return err instanceof TransportInvalidRequestError && err.message === CODEX_NO_FINAL_MESSAGE;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, ms);
    timer.unref?.();
  });
}

function validateAgainstSchema(
  responseText: string,
  schema: AgentOutputSchema,
): { ok: boolean; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return { ok: false, error: 'Response is not valid JSON' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Response is not a JSON object' };
  }

  const obj = parsed as Record<string, unknown>;
  const required = schema.schema.required ?? [];
  for (const key of required) {
    if (!(key in obj)) {
      return { ok: false, error: `Missing required property: ${key}` };
    }
  }

  return { ok: true };
}

interface CodexInvocationResult {
  stdout: string;
  stderr: string;
  outputText: string;
  durationMs: number;
}

interface ParsedCodexOutput {
  response: string;
  inputTokens: number;
  outputTokens: number;
  webSearchCalls: number;
  remoteSessionId?: string;
  stopReason?: string;
  events: unknown[];
}

export interface CodexCliTransportOptions {
  /**
   * When provided, execute()/executeStreaming() refuse to dispatch unless this
   * resolver reports `authenticated`, throwing a retriable {@link CodexAuthError}
   * otherwise (feeding the runtime auto-switch). Omit to preserve the legacy
   * no-precheck behavior. Inject `resolveCodexAuth` in production wiring.
   */
  authResolver?: (env: NodeJS.ProcessEnv) => CodexAuthResult;
  /** Environment passed to the auth resolver. Defaults to process.env at call time. */
  env?: NodeJS.ProcessEnv;
  /**
   * Injectable backoff sleep used by the transient no-final-message retry.
   * Tests inject an instant resolver; production uses a real (unref'd) timer.
   */
  sleep?: (ms: number) => Promise<void>;
}

export class CodexCliTransport implements ExecutionTransport {
  readonly kind = 'codex-cli' as const;

  private readonly authResolver?: (env: NodeJS.ProcessEnv) => CodexAuthResult;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly sleep: (ms: number) => Promise<void> = defaultSleep;

  constructor(options: CodexCliTransportOptions = {}) {
    if (options.authResolver) this.authResolver = options.authResolver;
    if (options.env) this.env = options.env;
    if (options.sleep) this.sleep = options.sleep;
  }

  /**
   * Refuse to dispatch when an injected auth resolver reports the operator is
   * not authenticated. No-op when no resolver was injected (legacy behavior).
   */
  private assertAuthenticated(): void {
    if (!this.authResolver) return;
    const auth = this.authResolver(this.env ?? process.env);
    if (auth.status !== 'authenticated') {
      throw new CodexAuthError(
        `Codex CLI cannot dispatch: ${auth.reason} (${auth.path})`,
        { authPath: auth.path },
      );
    }
  }

  /**
   * Codex is OPTIONAL auxiliary capacity (Claude-primary): resolution or
   * identity-validation failures report `false` so runs degrade to other
   * providers — never throw, and never let a wrong `codex` binary answer.
   */
  isAvailable(): boolean {
    return verifyCodexBinaryIdentity({ env: this.env ?? process.env }).ok;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    this.assertAuthenticated();
    const profile = getRequestModelProfile(this.kind, request);
    const startedAt = Date.now();

    try {
      const { invocation, parsed } = await this.invokeCodexCliWithRetry(request);
      const response = parsed.response;
      const costWarnings = this.buildCostWarnings(request, parsed.webSearchCalls);
      const result: ExecutionResult = {
        providerKind: this.kind,
        response,
        model: profile.modelId,
        ...(profile.effort ? { effort: profile.effort } : {}),
        usage: {
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
        },
        costUsd: this.estimateCost(
          profile.modelId,
          parsed.inputTokens,
          parsed.outputTokens,
          parsed.webSearchCalls,
        ),
        durationMs: invocation.durationMs || Date.now() - startedAt,
        raw: {
          events: parsed.events,
          stderr: invocation.stderr,
          webSearchCalls: parsed.webSearchCalls,
          ...(costWarnings.length ? { costWarnings } : {}),
        },
        ...(parsed.remoteSessionId ? { remoteSessionId: parsed.remoteSessionId } : {}),
        ...(parsed.stopReason ? { stopReason: parsed.stopReason } : {}),
      };

      if (request.outputSchema) {
        return { ...result, schemaValidation: validateAgainstSchema(response, request.outputSchema) };
      }
      return result;
    } catch (err) {
      throw classifyCodexCliError(err, request.timeoutMs);
    }
  }

  async executeStreaming(
    request: ExecutionRequest,
    options: ExecutionStreamOptions = {},
  ): Promise<ExecutionResult> {
    this.assertAuthenticated();
    const profile = getRequestModelProfile(this.kind, request);
    const startedAt = Date.now();
    this.emitEvent(options, {
      type: 'start',
      data: {
        providerKind: this.kind,
        model: profile.modelId,
        ...(profile.effort ? { effort: profile.effort } : {}),
        sandbox: this.resolveSandbox(request),
      },
    });

    try {
      const { invocation, parsed } = await this.invokeCodexCliWithRetry(request, options);
      const response = parsed.response;
      const costWarnings = this.buildCostWarnings(request, parsed.webSearchCalls);
      const result: ExecutionResult = {
        providerKind: this.kind,
        response,
        model: profile.modelId,
        ...(profile.effort ? { effort: profile.effort } : {}),
        usage: {
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
        },
        costUsd: this.estimateCost(
          profile.modelId,
          parsed.inputTokens,
          parsed.outputTokens,
          parsed.webSearchCalls,
        ),
        durationMs: invocation.durationMs || Date.now() - startedAt,
        raw: {
          events: parsed.events,
          stderr: invocation.stderr,
          webSearchCalls: parsed.webSearchCalls,
          ...(costWarnings.length ? { costWarnings } : {}),
        },
        ...(parsed.remoteSessionId ? { remoteSessionId: parsed.remoteSessionId } : {}),
        ...(parsed.stopReason ? { stopReason: parsed.stopReason } : {}),
      };

      this.emitEvent(options, {
        type: 'usage_delta',
        data: {
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
          costUsd: result.costUsd,
        },
      });

      if (request.outputSchema) {
        return { ...result, schemaValidation: validateAgainstSchema(response, request.outputSchema) };
      }
      return result;
    } catch (err) {
      throw classifyCodexCliError(err, request.timeoutMs);
    }
  }

  /**
   * Invoke the Codex CLI and parse its output, retrying ONLY the transient
   * "completed without a final message" flake (exit 0 with a missing final
   * message) up to {@link CODEX_NO_FINAL_MESSAGE_RETRY_DELAYS_MS} more times
   * with short backoff. Real failures — non-zero exits, timeouts, aborts,
   * spawn errors, invalid requests — propagate immediately without retry.
   */
  private async invokeCodexCliWithRetry(
    request: ExecutionRequest,
    streamOptions: ExecutionStreamOptions = {},
  ): Promise<{ invocation: CodexInvocationResult; parsed: ParsedCodexOutput }> {
    const maxRetries = CODEX_NO_FINAL_MESSAGE_RETRY_DELAYS_MS.length;
    let lastNoFinalMessageError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) {
        const delayMs = CODEX_NO_FINAL_MESSAGE_RETRY_DELAYS_MS[attempt - 1] ?? 5_000;
        // eslint-disable-next-line no-console
        console.warn(
          `[agentforge] ${CODEX_NO_FINAL_MESSAGE}; retrying in ${delayMs}ms ` +
            `(retry ${attempt}/${maxRetries})`,
        );
        await this.sleep(delayMs);
      }

      const invocation = await this.invokeCodexCli(request, streamOptions);
      try {
        return { invocation, parsed: this.parseCodexOutput(invocation.stdout, invocation.outputText) };
      } catch (err) {
        if (!isCodexNoFinalMessageError(err)) throw err;
        lastNoFinalMessageError = err;
      }
    }

    throw lastNoFinalMessageError;
  }

  private async invokeCodexCli(
    request: ExecutionRequest,
    streamOptions: ExecutionStreamOptions = {},
  ): Promise<CodexInvocationResult> {
    const profile = getRequestModelProfile(this.kind, request);
    const timeoutMs = request.timeoutMs ?? 20 * 60 * 1000;
    const runId = `${process.pid}-${randomUUID()}`;
    const lastMessagePath = join(tmpdir(), `agentforge-codex-last-${runId}.txt`);
    const schemaPath = request.outputSchema
      ? join(tmpdir(), `agentforge-codex-schema-${runId}.json`)
      : undefined;

    if (schemaPath && request.outputSchema) {
      if (request.codexResumeSessionId || request.codexResumeLast) {
        throw new TransportInvalidRequestError('codex exec resume does not support outputSchema.');
      }
      await writeFile(
        schemaPath,
        JSON.stringify(normalizeStrictOutputSchema(request.outputSchema).schema),
        'utf8',
      );
    }

    const args = this.buildCodexArgs(request, lastMessagePath, schemaPath);
    const prompt = this.buildPrompt(request);
    const startedAt = Date.now();
    const cwd = this.resolveCwd(request);

    try {
      return await new Promise<CodexInvocationResult>((resolve, reject) => {
        const command = buildCodexSpawnCommand(args);
        const proc = spawn(command.command, command.args, {
          env: command.env ?? { ...process.env },
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });

        let stdout = '';
        let stderr = '';
        let settled = false;
        let lineBuffer = '';
        let chunkIndex = 0;

        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          streamOptions.signal?.removeEventListener('abort', abortHandler);
          fn();
        };

        const abortHandler = () => {
          this.terminateProcessTree(proc);
          finish(() => reject(new Error('codex CLI run was aborted')));
        };

        const timer = setTimeout(() => {
          this.terminateProcessTree(proc);
          finish(() => reject(new Error(`codex CLI timed out after ${timeoutMs}ms`)));
        }, timeoutMs);

        if (streamOptions.signal?.aborted) {
          abortHandler();
          return;
        }
        streamOptions.signal?.addEventListener('abort', abortHandler, { once: true });

        proc.stdout.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          stdout += text;
          lineBuffer += text;
          const lines = lineBuffer.split(/\r?\n/);
          lineBuffer = lines.pop() ?? '';
          for (const line of lines) {
            chunkIndex = this.emitJsonLine(line, streamOptions, chunkIndex);
          }
        });
        proc.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });

        proc.on('error', (err: NodeJS.ErrnoException) => {
          finish(() => {
            if (err.code === 'ENOENT') {
              reject(new Error('codex CLI not found. Install Codex CLI and run codex login.'));
              return;
            }
            reject(err);
          });
        });

        proc.on('close', (code: number | null) => {
          finish(() => {
            if (lineBuffer.trim()) {
              chunkIndex = this.emitJsonLine(lineBuffer, streamOptions, chunkIndex);
              lineBuffer = '';
            }
            if (code !== 0) {
              reject(new Error(
                `codex CLI exited with code ${code}\nstderr: ${stderr.slice(0, 1000)}\nstdout: ${stdout.slice(0, 1000)}`,
              ));
              return;
            }

            void this.readLastMessage(lastMessagePath)
              .then((outputText) => resolve({
                stdout,
                stderr,
                outputText,
                durationMs: Date.now() - startedAt,
              }))
              .catch(reject);
          });
        });

        proc.stdin.on('error', (err: Error) => {
          finish(() => reject(new Error(`Failed to write to codex CLI stdin: ${err.message}`)));
        });
        proc.stdin.write(prompt, 'utf8', (writeErr) => {
          if (writeErr) {
            finish(() => reject(new Error(`stdin write failed: ${writeErr.message}`)));
            return;
          }
          proc.stdin.end();
        });
      });
    } finally {
      await this.unlinkIfExists(lastMessagePath);
      if (schemaPath) await this.unlinkIfExists(schemaPath);
    }
  }

  buildCodexArgs(
    request: ExecutionRequest,
    lastMessagePath: string = join(tmpdir(), `agentforge-codex-last-${process.pid}.txt`),
    schemaPath?: string,
  ): string[] {
    const profile = getRequestModelProfile(this.kind, request);
    const sandbox = this.resolveSandbox(request);
    const args = [
      '--ask-for-approval',
      'never',
    ];

    if (request.codexSearch) {
      args.push('--search');
    }

    args.push('exec');

    if (request.codexResumeSessionId || request.codexResumeLast) {
      args.push('resume');
      this.pushSharedExecOptions(args, request, lastMessagePath, profile.modelId, false);
      if (request.codexResumeLast && !request.codexResumeSessionId) {
        args.push('--last');
      }
      if (request.codexResumeSessionId) {
        args.push(request.codexResumeSessionId);
      }
      if (profile.effort) {
        args.push('-c', `model_reasoning_effort=${profile.effort}`);
      }
      args.push('-');
      return args;
    }

    this.pushSharedExecOptions(args, request, lastMessagePath, profile.modelId, true);
    args.push(
      '--cd', this.resolveCwd(request),
      '--sandbox', sandbox,
    );

    if (process.platform === 'win32' && sandbox === 'workspace-write') {
      args.push('-c', 'windows.sandbox=elevated');
    }

    if (profile.effort) {
      args.push('-c', `model_reasoning_effort=${profile.effort}`);
    }

    if (schemaPath) {
      args.push('--output-schema', schemaPath);
    }

    return args;
  }

  private pushSharedExecOptions(
    args: string[],
    request: ExecutionRequest,
    lastMessagePath: string,
    modelId: string,
    includeWorkspaceOptions: boolean,
  ): void {
    const needsUserConfig = includeWorkspaceOptions && Boolean(request.codexProfile || request.codexProfileV2);
    if (!needsUserConfig) {
      args.push('--ignore-user-config');
    }
    args.push(
      '--ignore-rules',
      '--json',
      '--model', modelId,
      '--output-last-message', lastMessagePath,
    );

    if (request.codexEphemeral) {
      args.push('--ephemeral');
    }
    if (request.codexSkipGitRepoCheck) {
      args.push('--skip-git-repo-check');
    }
    if (includeWorkspaceOptions && request.codexProfile) {
      args.push('--profile', request.codexProfile);
    }
    if (includeWorkspaceOptions && request.codexProfileV2) {
      args.push('--profile-v2', request.codexProfileV2);
    }
    if (includeWorkspaceOptions) {
      for (const dir of request.codexAddDirs ?? []) {
        args.push('--add-dir', dir);
      }
    }
  }

  private buildPrompt(request: ExecutionRequest): string {
    const sandbox = this.resolveSandbox(request);
    const sandboxInstruction = sandbox === 'read-only'
      ? `Codex is running non-interactively with sandbox "${sandbox}". Inspect files as needed, but do not create, edit, delete, or append files. Return the requested result in the final answer.`
      : `Codex is running non-interactively with sandbox "${sandbox}". You may create, edit, and delete files inside the working directory when the task requires it. Do not stop as read-only unless an actual write command fails.`;
    const gitMetadataInstruction = 'Never create, edit, delete, move, or rewrite `.git`, `.git/worktrees`, or git metadata files. Use normal git commands for repository state and keep the allocated worktree metadata intact.';
    const allowedTools = request.allowedTools?.length
      ? `\n\nAllowed tool names requested by AgentForge: ${request.allowedTools.join(', ')}. Use only equivalent Codex capabilities available in this sandbox.`
      : '';
    const schemaHint = request.outputSchema
      ? `\n\nReturn a final JSON object matching this schema: ${JSON.stringify(normalizeStrictOutputSchema(request.outputSchema).schema)}`
      : '';

    return [
      `You are AgentForge agent "${request.agent.name}" (${request.agent.agentId}).`,
      sandboxInstruction,
      '<system>',
      request.agent.systemPrompt,
      '</system>',
      gitMetadataInstruction,
      allowedTools.trim(),
      schemaHint.trim(),
      '<task>',
      request.userContent,
      '</task>',
    ].filter(Boolean).join('\n\n');
  }

  private resolveSandbox(request: ExecutionRequest): CodexSandboxMode {
    return request.codexSandbox ?? DEFAULT_CODEX_SANDBOX;
  }

  private resolveCwd(request: ExecutionRequest): string {
    return resolve(request.cwd ?? process.cwd());
  }

  private parseCodexOutput(stdout: string, outputText: string): ParsedCodexOutput {
    const events = this.parseJsonLines(stdout);
    const inputTokens = this.sumUsage(events, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']);
    const outputTokens = this.sumUsage(events, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']);
    const webSearchCalls = this.countWebSearchCalls(events);
    const response = outputText.trim() || this.extractResponseFromEvents(events);
    const metadata = this.extractMetadata(events);

    if (!response) {
      throw new TransportInvalidRequestError(CODEX_NO_FINAL_MESSAGE, { stdout });
    }

    return {
      response,
      inputTokens,
      outputTokens,
      webSearchCalls,
      events,
      ...(metadata.remoteSessionId ? { remoteSessionId: metadata.remoteSessionId } : {}),
      ...(metadata.stopReason ? { stopReason: metadata.stopReason } : {}),
    };
  }

  private parseJsonLines(stdout: string): unknown[] {
    const events: unknown[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        // Codex --json should be JSONL, but keep the final-message file as source of truth.
      }
    }
    return events;
  }

  private extractResponseFromEvents(events: unknown[]): string {
    const chunks: string[] = [];
    let finalText = '';
    for (const event of events) {
      const text = this.extractText(event);
      if (text) chunks.push(text);
      const candidate = this.extractFinalText(event);
      if (candidate) finalText = candidate;
    }
    return finalText || chunks.join('').trim();
  }

  private extractText(value: unknown): string {
    if (!this.isRecord(value)) return '';
    if (typeof value.text === 'string') return value.text;
    if (typeof value.delta === 'string') return value.delta;
    if (typeof value.message === 'string') return value.message;
    if (typeof value.content === 'string') return value.content;

    const nested = this.isRecord(value.item) ? value.item : this.isRecord(value.message) ? value.message : null;
    if (nested) return this.extractText(nested);

    const content = Array.isArray(value.content) ? value.content : null;
    if (content) {
      return content.map((item) => this.extractText(item)).join('');
    }

    return '';
  }

  private extractFinalText(value: unknown): string {
    if (!this.isRecord(value)) return '';
    for (const key of ['final_output', 'output', 'result', 'last_message']) {
      const candidate = value[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    return '';
  }

  private sumUsage(events: unknown[], keys: string[]): number {
    let total = 0;
    for (const event of events) {
      const usage = this.findUsageRecord(event);
      if (!usage) continue;
      for (const key of keys) {
        const value = usage[key];
        if (typeof value === 'number' && Number.isFinite(value)) total += value;
      }
    }
    return total;
  }

  private findUsageRecord(value: unknown): Record<string, unknown> | null {
    if (!this.isRecord(value)) return null;
    if (this.hasUsageKeys(value)) return value;
    if (this.isRecord(value.usage)) return value.usage;
    if (this.isRecord(value.response) && this.isRecord(value.response.usage)) return value.response.usage;
    return null;
  }

  private hasUsageKeys(value: Record<string, unknown>): boolean {
    return ['input_tokens', 'inputTokens', 'prompt_tokens', 'output_tokens', 'outputTokens', 'completion_tokens']
      .some((key) => typeof value[key] === 'number');
  }

  private countWebSearchCalls(events: unknown[]): number {
    let total = 0;
    for (const event of events) {
      const explicitCount = this.findWebSearchCallCount(event);
      if (explicitCount !== null) {
        total += explicitCount;
        continue;
      }
      if (this.includesWebSearchCallMarker(event)) {
        total += 1;
      }
    }
    return total;
  }

  private findWebSearchCallCount(value: unknown): number | null {
    if (!this.isRecord(value)) return null;
    for (const key of ['web_search_calls', 'webSearchCalls', 'web_search_call_count', 'webSearchCallCount']) {
      const count = value[key];
      if (typeof count === 'number' && Number.isFinite(count)) return count;
    }
    if (this.isRecord(value.usage)) return this.findWebSearchCallCount(value.usage);
    if (this.isRecord(value.response) && this.isRecord(value.response.usage)) {
      return this.findWebSearchCallCount(value.response.usage);
    }
    return null;
  }

  private includesWebSearchCallMarker(value: unknown): boolean {
    if (typeof value === 'string') {
      const normalized = value.toLowerCase();
      return normalized.includes('web_search') && normalized.includes('call');
    }
    if (Array.isArray(value)) {
      return value.some((item) => this.includesWebSearchCallMarker(item));
    }
    if (!this.isRecord(value)) return false;

    for (const key of ['type', 'name', 'tool_name', 'toolName']) {
      if (this.includesWebSearchCallMarker(value[key])) return true;
    }
    return this.includesWebSearchCallMarker(value.item);
  }

  private extractMetadata(events: unknown[]): { remoteSessionId?: string; stopReason?: string } {
    let remoteSessionId: string | undefined;
    let stopReason: string | undefined;
    for (const event of events) {
      if (!this.isRecord(event)) continue;
      if (typeof event.session_id === 'string') remoteSessionId = event.session_id;
      if (typeof event.sessionId === 'string') remoteSessionId = event.sessionId;
      if (typeof event.stop_reason === 'string') stopReason = event.stop_reason;
      if (typeof event.stopReason === 'string') stopReason = event.stopReason;
    }
    return {
      ...(remoteSessionId ? { remoteSessionId } : {}),
      ...(stopReason ? { stopReason } : {}),
    };
  }

  private async readLastMessage(path: string): Promise<string> {
    if (!existsSync(path)) return '';
    return readFile(path, 'utf8');
  }

  private async unlinkIfExists(path: string): Promise<void> {
    try {
      if (existsSync(path)) await unlink(path);
    } catch {
      // Best-effort cleanup of temporary Codex output files.
    }
  }

  private emitJsonLine(
    line: string,
    options: ExecutionStreamOptions,
    chunkIndex: number,
  ): number {
    const trimmed = line.trim();
    if (!trimmed) return chunkIndex;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return chunkIndex;
    }

    this.emitEvent(options, { type: 'codex_json', data: event });
    const usage = this.findUsageRecord(event);
    if (usage) {
      this.emitEvent(options, { type: 'usage_delta', data: usage });
    }

    const text = this.extractStreamingText(event);
    if (text) {
      options.onChunk?.(text, chunkIndex);
      this.emitEvent(options, {
        type: 'text_delta',
        data: { text, content: text, index: chunkIndex },
      });
      return chunkIndex + 1;
    }

    return chunkIndex;
  }

  private extractStreamingText(event: unknown): string {
    if (!this.isRecord(event)) return '';
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'response.output_text.delta' && typeof event.delta === 'string') return event.delta;

    const item = this.isRecord(event.item) ? event.item : null;
    if (!item) return '';
    const itemType = typeof item.type === 'string' ? item.type : '';
    if (!['agent_message', 'message'].includes(itemType)) return '';
    if (typeof item.text === 'string') return item.text;
    return this.extractText(item);
  }

  private emitEvent(options: ExecutionStreamOptions, event: ExecutionStreamEvent): void {
    options.onEvent?.(event);
  }

  private terminateProcessTree(proc: ChildProcessWithoutNullStreams): void {
    if (process.platform === 'win32' && proc.pid) {
      try {
        spawn('taskkill', ['/PID', String(proc.pid), '/T'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        const force = setTimeout(() => {
          try {
            spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
              stdio: 'ignore',
              windowsHide: true,
            });
          } catch {
            // Best-effort forced termination.
          }
        }, 5000);
        force.unref?.();
      } catch {
        proc.kill('SIGTERM');
      }
      return;
    }

    proc.kill('SIGTERM');
    const force = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // Best-effort forced termination.
      }
    }, 5000);
    force.unref?.();
  }

  private buildCostWarnings(request: ExecutionRequest, webSearchCalls: number): string[] {
    if (!request.codexSearch || webSearchCalls > 0) return [];
    return [
      'Web search tool calls may not be represented in Codex JSONL usage; cost may exclude search tool charges.',
    ];
  }

  private estimateCost(
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    webSearchCalls: number,
  ): number {
    return estimateOpenAiCostUsd(modelId, inputTokens, outputTokens, { webSearchCalls });
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}

export interface CodexSpawnCommand {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  launchKind: CodexSpawnLaunchKind;
}

export type CodexSpawnLaunchKind =
  | 'path-command'
  | 'windows-native-package'
  | 'windows-node-entrypoint';

export interface CodexSpawnCommandOptions {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  candidates?: string[];
  env?: NodeJS.ProcessEnv;
  /** Test seam: home directory used for the `~/.agentforge/bin/codex` fallback. */
  homeDir?: string;
  /** Test seam: filesystem existence probe used during binary resolution. */
  exists?: (path: string) => boolean;
}

/** Where the codex executable came from during resolution. */
export type CodexBinarySource = 'env-override' | 'managed-bin' | 'path-lookup';

export interface CodexBinaryResolution {
  /** Executable to spawn: an explicit path for overrides, bare `codex` for PATH lookup. */
  command: string;
  source: CodexBinarySource;
}

export interface CodexBinaryResolutionOptions {
  /** Environment to read `AGENTFORGE_CODEX_BIN` from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Home directory for the managed-bin fallback. Defaults to os.homedir(). */
  homeDir?: string;
  /** Filesystem existence probe. Defaults to fs.existsSync. */
  exists?: (path: string) => boolean;
}

/**
 * Resolve which codex executable AgentForge should spawn. PATH alone is not
 * trustworthy (incident: a purged /tmp shim let an unrelated homebrew `codex`
 * answer), so explicit operator pins win first:
 *
 *   1. `AGENTFORGE_CODEX_BIN` env var (absolute path to the real codex CLI)
 *   2. `~/.agentforge/bin/codex` when it exists (managed install location)
 *   3. bare `codex` PATH lookup (legacy behavior)
 *
 * Pure given injected `env`/`homeDir`/`exists`; never throws.
 */
export function resolveCodexBinary(
  options: CodexBinaryResolutionOptions = {},
): CodexBinaryResolution {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;

  const envOverride = env['AGENTFORGE_CODEX_BIN']?.trim();
  if (envOverride) {
    return { command: envOverride, source: 'env-override' };
  }

  const homeDir = options.homeDir ?? safeHomedir();
  if (homeDir) {
    const managedBin = join(homeDir, '.agentforge', 'bin', 'codex');
    if (exists(managedBin)) {
      return { command: managedBin, source: 'managed-bin' };
    }
  }

  return { command: CODEX_COMMAND, source: 'path-lookup' };
}

function safeHomedir(): string {
  try {
    return homedir();
  } catch {
    return '';
  }
}

export function buildCodexSpawnCommand(
  args: string[],
  options: CodexSpawnCommandOptions = {},
): CodexSpawnCommand {
  const resolution = resolveCodexBinary({
    ...(options.env ? { env: options.env } : {}),
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.exists ? { exists: options.exists } : {}),
  });

  // Explicit operator pins (env var or managed bin dir) win on every platform
  // and bypass PATH/candidate scanning entirely.
  if (resolution.source !== 'path-lookup') {
    return {
      command: resolution.command,
      args,
      ...(options.env ? { env: options.env } : {}),
      launchKind: 'path-command',
    };
  }

  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    return {
      command: CODEX_COMMAND,
      args,
      ...(options.env ? { env: options.env } : {}),
      launchKind: 'path-command',
    };
  }

  const candidates = options.candidates ?? findWindowsCodexCandidates(options.env);
  const nativeExecutable = findWindowsCodexNativeExecutable(candidates, options);
  if (nativeExecutable) {
    return {
      command: nativeExecutable.command,
      args,
      env: nativeExecutable.env,
      launchKind: 'windows-native-package',
    };
  }

  const nodeEntrypoint = findWindowsCodexNodeEntrypoint(candidates);
  if (nodeEntrypoint) {
    return {
      command: process.execPath,
      args: [nodeEntrypoint, ...args],
      ...(options.env ? { env: options.env } : {}),
      launchKind: 'windows-node-entrypoint',
    };
  }

  throw new Error(buildWindowsCodexResolutionError(candidates));
}

export function resolveCodexSpawnLaunchKind(
  args: string[] = ['--version'],
  options: CodexSpawnCommandOptions = {},
): CodexSpawnLaunchKind | undefined {
  try {
    return buildCodexSpawnCommand(args, options).launchKind;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Codex binary identity validation
//
// Exit status 0 on `--version` is not proof the binary is the Codex CLI: an
// unrelated homebrew tool named `codex` answers `--version` with
// `0.1.2505172129` and then burns cycles that die with "completed without a
// final message". The real CLI prints `codex-cli <semver>`. Identity verdicts
// are cached per-process (keyed by the resolved command) so availability
// checks never re-spawn `--version` per call.
// ---------------------------------------------------------------------------

/** What real Codex CLI `--version` output looks like (e.g. `codex-cli 0.135.0`). */
export const CODEX_VERSION_OUTPUT_PATTERN = /codex-cli\s+\d+\.\d+/;

const CODEX_IDENTITY_MAX_PROBE_CHARS = 512;

/**
 * Whether `--version` output looks like the real Codex CLI. Linear-time check
 * on a bounded slice (no ReDoS surface).
 */
export function isCodexVersionOutputValid(versionOutput: string): boolean {
  const head = versionOutput.trim().slice(0, CODEX_IDENTITY_MAX_PROBE_CHARS);
  return head.startsWith('codex-cli ') || CODEX_VERSION_OUTPUT_PATTERN.test(head);
}

export interface CodexVersionProbeResult {
  status: number | null;
  stdout: string;
  error?: Error;
}

export interface CodexBinaryIdentity {
  ok: boolean;
  /** The command that was checked (the resolved path when one is known). */
  command: string;
  /** Human-readable verdict, surfaced through provider availability. */
  reason: string;
  /** Trimmed `--version` output when the probe ran. */
  versionOutput?: string;
}

export interface CodexBinaryIdentityOptions extends CodexSpawnCommandOptions {
  /** Test seam: override the `--version` subprocess probe. */
  runVersion?: (spawnCommand: CodexSpawnCommand) => CodexVersionProbeResult;
  /** Test seam: override PATH location used to name the binary in warnings. */
  locateOnPath?: (command: string, env?: NodeJS.ProcessEnv) => string | undefined;
}

const codexBinaryIdentityCache = new Map<string, CodexBinaryIdentity>();

/** Clear the per-process identity cache (tests, or after repairing an install). */
export function resetCodexBinaryIdentityCache(): void {
  codexBinaryIdentityCache.clear();
}

/**
 * Resolve the codex binary and verify it actually is the Codex CLI by running
 * `--version` and matching {@link CODEX_VERSION_OUTPUT_PATTERN}. Never throws:
 * resolution and validation failures return `ok: false` so the provider
 * reports unavailable and runs degrade gracefully to Claude (Claude-primary,
 * codex is optional auxiliary capacity). Spawned verdicts are cached
 * per-process per resolved command.
 */
export function verifyCodexBinaryIdentity(
  options: CodexBinaryIdentityOptions = {},
): CodexBinaryIdentity {
  let spawnCommand: CodexSpawnCommand;
  try {
    spawnCommand = buildCodexSpawnCommand(['--version'], options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      command: CODEX_COMMAND,
      reason: `codex CLI could not be resolved: ${message}`,
    };
  }

  const cacheKey = [spawnCommand.command, ...spawnCommand.args].join('\u0000');
  const cached = codexBinaryIdentityCache.get(cacheKey);
  if (cached) return cached;

  const identity = computeCodexBinaryIdentity(spawnCommand, options);
  codexBinaryIdentityCache.set(cacheKey, identity);
  return identity;
}

function computeCodexBinaryIdentity(
  spawnCommand: CodexSpawnCommand,
  options: CodexBinaryIdentityOptions,
): CodexBinaryIdentity {
  const runVersion = options.runVersion ?? defaultRunCodexVersion;

  let probe: CodexVersionProbeResult;
  try {
    probe = runVersion(spawnCommand);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      command: spawnCommand.command,
      reason: `codex --version probe failed: ${message}`,
    };
  }

  if (probe.error) {
    return {
      ok: false,
      command: spawnCommand.command,
      reason: `codex --version could not be spawned: ${probe.error.message}`,
    };
  }
  if (probe.status !== 0) {
    return {
      ok: false,
      command: spawnCommand.command,
      reason: `codex --version exited with status ${probe.status ?? 'null'}`,
    };
  }

  const versionOutput = probe.stdout.trim().slice(0, CODEX_IDENTITY_MAX_PROBE_CHARS);
  const firstLine = versionOutput.split(/\r?\n/, 1)[0] ?? '';

  if (!isCodexVersionOutputValid(versionOutput)) {
    const locateOnPath = options.locateOnPath ?? defaultLocateCommandOnPath;
    const resolvedPath = spawnCommand.command === CODEX_COMMAND
      ? locateOnPath(spawnCommand.command, spawnCommand.env ?? options.env) ?? spawnCommand.command
      : spawnCommand.command;
    // eslint-disable-next-line no-console
    console.warn(
      `[agentforge] "${resolvedPath}" does not look like the Codex CLI ` +
        `(--version printed "${firstLine}", expected to match ${CODEX_VERSION_OUTPUT_PATTERN}); ` +
        'treating codex as unavailable.',
    );
    return {
      ok: false,
      command: resolvedPath,
      reason:
        `binary at ${resolvedPath} failed codex identity validation ` +
        `("${firstLine}" does not match ${CODEX_VERSION_OUTPUT_PATTERN})`,
      versionOutput,
    };
  }

  return {
    ok: true,
    command: spawnCommand.command,
    reason: `codex CLI identity verified (${firstLine})`,
    versionOutput,
  };
}

function defaultRunCodexVersion(spawnCommand: CodexSpawnCommand): CodexVersionProbeResult {
  const probe = spawnSync(spawnCommand.command, spawnCommand.args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    ...(spawnCommand.env ? { env: spawnCommand.env } : {}),
  });
  return {
    status: probe.status,
    stdout: typeof probe.stdout === 'string' ? probe.stdout : '',
    ...(probe.error ? { error: probe.error } : {}),
  };
}

/** Name the PATH-resolved binary in diagnostics (e.g. /opt/homebrew/bin/codex). */
function defaultLocateCommandOnPath(
  command: string,
  env?: NodeJS.ProcessEnv,
): string | undefined {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  const probe = spawnSync(locator, [command], {
    encoding: 'utf8',
    windowsHide: true,
    ...(env ? { env } : {}),
  });
  if (probe.status !== 0 || typeof probe.stdout !== 'string') return undefined;
  for (const line of probe.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function findWindowsCodexCandidates(env?: NodeJS.ProcessEnv): string[] {
  const probe = spawnSync('where', ['codex'], {
    encoding: 'utf8',
    windowsHide: true,
    ...(env ? { env } : {}),
  });
  if (probe.status === 0 && typeof probe.stdout === 'string') {
    return probe.stdout
      .split(/\r?\n/)
      .map((candidate) => candidate.trim())
      .filter(Boolean);
  }

  return [];
}

function findWindowsCodexNodeEntrypoint(candidates: string[]): string | null {
  const searchedDirs = new Set<string>();
  for (const candidate of candidates) {
    const baseDir = dirname(candidate);
    if (searchedDirs.has(baseDir)) continue;
    searchedDirs.add(baseDir);
    const entrypoint = join(baseDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(entrypoint)) return entrypoint;
  }
  return null;
}

function findWindowsCodexNativeExecutable(
  candidates: string[],
  options: Pick<CodexSpawnCommandOptions, 'arch' | 'env'> = {},
): { command: string; env: NodeJS.ProcessEnv } | null {
  const arch = options.arch ?? process.arch;
  const targetTriple = arch === 'arm64'
    ? 'aarch64-pc-windows-msvc'
    : arch === 'x64'
      ? 'x86_64-pc-windows-msvc'
      : null;
  if (!targetTriple) return null;

  const platformPackage = arch === 'arm64'
    ? '@openai/codex-win32-arm64'
    : '@openai/codex-win32-x64';

  const searchedPackageRoots = new Set<string>();
  for (const candidate of candidates) {
    const baseDir = dirname(candidate);
    const entrypoint = join(baseDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (!existsSync(entrypoint)) continue;

    const packageRoot = resolve(dirname(entrypoint), '..');
    if (searchedPackageRoots.has(packageRoot)) continue;
    searchedPackageRoots.add(packageRoot);

    const archRoots = [
      join(packageRoot, 'node_modules', platformPackage, 'vendor', targetTriple),
      join(packageRoot, 'vendor', targetTriple),
    ];

    for (const archRoot of archRoots) {
      const executable = join(archRoot, 'codex', 'codex.exe');
      if (!existsSync(executable)) continue;
      return {
        command: executable,
        env: buildWindowsNativeCodexEnv(archRoot, packageRoot, options.env ?? process.env),
      };
    }
  }

  return null;
}

function buildWindowsCodexResolutionError(candidates: string[]): string {
  const suffix = candidates.length
    ? ` Candidates: ${candidates.join(', ')}.`
    : ' No codex candidates were found on PATH.';
  return (
    'Codex CLI launch could not be resolved on Windows. ' +
    'Install Codex CLI from npm or provide a resolvable codex.exe; AgentForge requires ' +
    'a native packaged codex.exe or node entrypoint and refuses ambiguous WindowsApps/npm-shim fallback.' +
    suffix
  );
}

function buildWindowsNativeCodexEnv(
  archRoot: string,
  packageRoot: string,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...baseEnv };
  const pathKey = Object.keys(nextEnv).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const currentPath = nextEnv[pathKey] ?? '';
  const pathDir = join(archRoot, 'path');
  if (existsSync(pathDir)) {
    const parts = currentPath.split(';').filter(Boolean);
    nextEnv[pathKey] = [pathDir, ...parts].join(';');
    nextEnv.PATH = nextEnv[pathKey];
  }
  nextEnv.CODEX_MANAGED_BY_NPM = '1';
  nextEnv.CODEX_MANAGED_PACKAGE_ROOT = realpathSync(packageRoot);
  return nextEnv;
}
