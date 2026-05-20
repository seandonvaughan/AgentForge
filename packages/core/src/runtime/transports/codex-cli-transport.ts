import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { getRequestModelProfile } from '../model-profiles.js';
import { estimateOpenAiCostUsd } from '../openai-pricing.js';
import { normalizeStrictOutputSchema } from '../output-schema.js';
import {
  TransportInvalidRequestError,
  classifyCodexCliError,
} from '../transport-errors.js';
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

export class CodexCliTransport implements ExecutionTransport {
  readonly kind = 'codex-cli' as const;

  isAvailable(): boolean {
    const probe =
      process.platform === 'win32'
        ? spawnSync('where', ['codex'], { stdio: 'ignore', windowsHide: true })
        : spawnSync('which', ['codex'], { stdio: 'ignore', windowsHide: true });
    return probe.status === 0;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const profile = getRequestModelProfile(this.kind, request);
    const startedAt = Date.now();

    try {
      const invocation = await this.invokeCodexCli(request);
      const parsed = this.parseCodexOutput(invocation.stdout, invocation.outputText);
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
      const invocation = await this.invokeCodexCli(request, options);
      const parsed = this.parseCodexOutput(invocation.stdout, invocation.outputText);
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
          env: { ...process.env },
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
          fn();
        };

        const timer = setTimeout(() => {
          proc.kill('SIGTERM');
          finish(() => reject(new Error(`codex CLI timed out after ${timeoutMs}ms`)));
        }, timeoutMs);

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
      throw new TransportInvalidRequestError('codex CLI completed without a final message', { stdout });
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

function buildCodexSpawnCommand(args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') {
    return { command: CODEX_COMMAND, args };
  }

  const candidates = findWindowsCodexCandidates();
  const nodeEntrypoint = findWindowsCodexNodeEntrypoint(candidates);
  if (nodeEntrypoint) {
    return { command: process.execPath, args: [nodeEntrypoint, ...args] };
  }

  const executable = candidates.find((candidate) => {
    const normalized = candidate.toLowerCase();
    return normalized.endsWith('.exe') && !normalized.includes('\\windowsapps\\');
  });
  return { command: executable ?? CODEX_COMMAND, args };
}

function findWindowsCodexCandidates(): string[] {
  const probe = spawnSync('where', ['codex'], { encoding: 'utf8', windowsHide: true });
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
