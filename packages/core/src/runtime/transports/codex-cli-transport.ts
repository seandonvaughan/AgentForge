import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequestModelProfile } from '../model-profiles.js';
import { normalizeStrictOutputSchema } from '../output-schema.js';
import {
  TransportInvalidRequestError,
  classifyCodexCliError,
} from '../transport-errors.js';
import type {
  AgentOutputSchema,
  ExecutionRequest,
  ExecutionResult,
  ExecutionStreamEvent,
  ExecutionStreamOptions,
  ExecutionTransport,
} from '../types.js';

const GPT_53_CODEX_INPUT_PER_MILLION = 1.75;
const GPT_53_CODEX_OUTPUT_PER_MILLION = 14.0;
const CODEX_COMMAND = 'codex';

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
  remoteSessionId?: string;
  stopReason?: string;
  events: unknown[];
}

export class CodexCliTransport implements ExecutionTransport {
  readonly kind = 'codex-cli' as const;

  isAvailable(): boolean {
    const probe =
      process.platform === 'win32'
        ? spawnSync('where', ['codex'], { stdio: 'ignore' })
        : spawnSync('which', ['codex'], { stdio: 'ignore' });
    return probe.status === 0;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const profile = getRequestModelProfile(this.kind, request);
    const startedAt = Date.now();

    try {
      const invocation = await this.invokeCodexCli(request);
      const parsed = this.parseCodexOutput(invocation.stdout, invocation.outputText);
      const response = parsed.response;
      const result: ExecutionResult = {
        providerKind: this.kind,
        response,
        model: profile.modelId,
        ...(profile.effort ? { effort: profile.effort } : {}),
        usage: {
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
        },
        costUsd: this.estimateCost(parsed.inputTokens, parsed.outputTokens),
        durationMs: invocation.durationMs || Date.now() - startedAt,
        raw: {
          events: parsed.events,
          stderr: invocation.stderr,
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

  private async invokeCodexCli(request: ExecutionRequest): Promise<CodexInvocationResult> {
    const profile = getRequestModelProfile(this.kind, request);
    const timeoutMs = request.timeoutMs ?? 20 * 60 * 1000;
    const runId = `${process.pid}-${randomUUID()}`;
    const lastMessagePath = join(tmpdir(), `agentforge-codex-last-${runId}.txt`);
    const schemaPath = request.outputSchema
      ? join(tmpdir(), `agentforge-codex-schema-${runId}.json`)
      : undefined;

    if (schemaPath && request.outputSchema) {
      await writeFile(
        schemaPath,
        JSON.stringify(normalizeStrictOutputSchema(request.outputSchema).schema),
        'utf8',
      );
    }

    const args = this.buildCodexArgs(request, lastMessagePath, schemaPath);
    const prompt = this.buildPrompt(request);
    const startedAt = Date.now();

    try {
      return await new Promise<CodexInvocationResult>((resolve, reject) => {
        const command = buildCodexSpawnCommand(args);
        const proc = spawn(command.command, command.args, {
          env: { ...process.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let settled = false;

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
          stdout += chunk.toString('utf8');
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
    const args = [
      'exec',
      '--ignore-user-config',
      '--json',
      '--cd', request.cwd ?? process.cwd(),
      '--sandbox', request.codexSandbox ?? 'workspace-write',
      '--model', profile.modelId,
      '--output-last-message', lastMessagePath,
    ];

    if (profile.effort) {
      args.push('-c', `model_reasoning_effort=${profile.effort}`);
    }

    if (schemaPath) {
      args.push('--output-schema', schemaPath);
    }

    return args;
  }

  private buildPrompt(request: ExecutionRequest): string {
    const allowedTools = request.allowedTools?.length
      ? `\n\nAllowed tool names requested by AgentForge: ${request.allowedTools.join(', ')}. Use only equivalent Codex capabilities available in this sandbox.`
      : '';
    const schemaHint = request.outputSchema
      ? `\n\nReturn a final JSON object matching this schema: ${JSON.stringify(normalizeStrictOutputSchema(request.outputSchema).schema)}`
      : '';

    return [
      `You are AgentForge agent "${request.agent.name}" (${request.agent.agentId}).`,
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

  private parseCodexOutput(stdout: string, outputText: string): ParsedCodexOutput {
    const events = this.parseJsonLines(stdout);
    const inputTokens = this.sumUsage(events, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']);
    const outputTokens = this.sumUsage(events, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']);
    const response = outputText.trim() || this.extractResponseFromEvents(events);
    const metadata = this.extractMetadata(events);

    if (!response) {
      throw new TransportInvalidRequestError('codex CLI completed without a final message', { stdout });
    }

    return {
      response,
      inputTokens,
      outputTokens,
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

  private estimateCost(inputTokens: number, outputTokens: number): number {
    return (
      (inputTokens / 1_000_000) * GPT_53_CODEX_INPUT_PER_MILLION +
      (outputTokens / 1_000_000) * GPT_53_CODEX_OUTPUT_PER_MILLION
    );
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}

function buildCodexSpawnCommand(args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') {
    return { command: CODEX_COMMAND, args };
  }

  return {
    command: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', [CODEX_COMMAND, ...args.map(quoteCmdArg)].join(' ')],
  };
}

function quoteCmdArg(value: string): string {
  if (/^[A-Za-z0-9._=:/\\~\-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}
