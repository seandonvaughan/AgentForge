import type { WorkspaceAdapter } from '@agentforge/db';
import type {
  AgentRuntimeConfig,
  ProviderSwitchEvent,
  RunOptions,
  RunResult,
} from '../agent-runtime/types.js';
import { MODEL_IDS } from '../agent-runtime/types.js';
import { resolveMode } from './execution-service-mode.js';
import type { ExecutionServiceMode } from './execution-service-mode.js';
import { resolveProviderModelProfiles } from './model-profiles.js';
import { ProviderResolver } from './provider-resolver.js';
import { RuntimeSession } from './runtime-session.js';
import { isRetriableTransportError } from './transport-errors.js';
import { AnthropicSdkTransport } from './transports/anthropic-sdk-transport.js';
import { ClaudeCodeCompatTransport } from './transports/claude-code-compat-transport.js';
import {
  CodexCliTransport,
  verifyCodexBinaryIdentity,
} from './transports/codex-cli-transport.js';
import { OpenAiSdkTransport } from './transports/openai-sdk-transport.js';
import type {
  ExecutionProviderKind,
  ExecutionRequest,
  ExecutionResult,
  ExecutionStreamEvent,
  ExecutionStreamOptions,
  ExecutionTransport,
} from './types.js';

export interface ExecutionServiceOptions {
  /**
   * Explicit transport list. When provided, `AGENTFORGE_RUNTIME` and
   * `autonomous.yaml` are ignored — the caller is responsible for
   * selecting the right transports.  This is the escape hatch used by
   * tests and by specialised factory functions.
   */
  transports?: ExecutionTransport[];
  /**
   * Override the env/config resolution for the active mode.  Useful in
   * tests that want to check mode-filtering without touching `process.env`.
   */
  mode?: ExecutionServiceMode;
  /**
   * Project root used when reading `.agentforge/autonomous.yaml`.
   * Defaults to `process.cwd()`.  Has no effect when `options.transports`
   * is provided explicitly (caller controls transport selection).
   */
  projectRoot?: string;
}

export class ExecutionService {
  private readonly resolver: ProviderResolver;
  /** The active ExecutionServiceMode resolved at construction time. */
  private readonly _mode: ExecutionServiceMode;
  private readonly projectRoot: string;

  constructor(options: ExecutionServiceOptions = {}) {
    this.projectRoot = options.projectRoot ?? process.cwd();
    // When the caller provides an explicit transport list we skip mode
    // resolution entirely — backward-compatible with all existing call sites
    // and tests that pass `{ transports: [...] }`.
    if (options.transports !== undefined) {
      this.resolver = new ProviderResolver(options.transports);
      // Treat explicit transports as 'auto' for introspection purposes
      this._mode = options.mode ?? 'auto';
      return;
    }

    // Resolve the active mode: explicit option > env var > config file > 'auto'
    const mode =
      options.mode !== undefined
        ? options.mode
        : resolveMode(process.env, this.projectRoot);

    this._mode = mode;

    // Build the transport list filtered to only include what the mode allows.
    // This is the key change that makes `AGENTFORGE_RUNTIME=sdk` guarantee no
    // CLI subprocess paths are ever registered (AgentForge Cloud requirement).
    let transports: ExecutionTransport[];
    if (mode === 'sdk' || mode === 'anthropic-sdk') {
      transports = [new AnthropicSdkTransport()];
    } else if (mode === 'cli' || mode === 'claude-cli' || mode === 'claude-code-compat') {
      transports = [new ClaudeCodeCompatTransport()];
    } else if (mode === 'codex-cli') {
      transports = [new CodexCliTransport()];
    } else if (mode === 'openai-sdk') {
      transports = [new OpenAiSdkTransport()];
    } else {
      // 'auto' — Claude-primary, codex-auxiliary (2026-06-06). The Claude
      // transports (tool-capable claude-code-compat + text-only anthropic-sdk)
      // and the OpenAI SDK transport are ALWAYS registered. The codex-cli
      // transport is registered ONLY when the binary passes identity validation
      // (verifyCodexBinaryIdentity), so a missing/wrong `codex` on PATH degrades
      // gracefully to Claude instead of registering a transport that would fail
      // mid-cycle. The verdict is cached per-process inside the transport module,
      // so this adds no subprocess spawns beyond the existing availability probe.
      transports = [
        new AnthropicSdkTransport(),
        new ClaudeCodeCompatTransport(),
        new OpenAiSdkTransport(),
      ];
      if (verifyCodexBinaryIdentity().ok) {
        transports.push(new CodexCliTransport());
      }
    }

    this.resolver = new ProviderResolver(transports);
  }

  /**
   * The `ExecutionServiceMode` that was active at construction time.
   * Can be used for introspection, logging, and dashboard display.
   */
  get mode(): ExecutionServiceMode {
    return this._mode;
  }

  async run(
    config: AgentRuntimeConfig,
    opts: RunOptions,
    adapter?: WorkspaceAdapter,
    apiKey?: string,
  ): Promise<RunResult> {
    const startedAt = new Date().toISOString();
    // Per-call model override (adaptive routing): use the requested tier for
    // THIS call without mutating the shared, cached agent config object.
    const cfg = opts.capabilityTier && opts.capabilityTier !== config.model
      ? { ...config, model: opts.capabilityTier }
      : config;
    const modelId = MODEL_IDS[cfg.model];
    const request = this.buildRequest(cfg, opts, modelId, apiKey);
    const session = new RuntimeSession({
      agentId: config.agentId,
      task: opts.task,
      model: modelId,
      capabilityTier: cfg.model,
      startedAt,
      ...(adapter ? { adapter } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
    });

    session.start();
    const requestedMode = opts.runtimeMode ?? config.runtimeMode ?? 'auto';

    // Auto-switch path: an ordered provider preference enables failover across
    // providers on classified-retriable errors.
    if (opts.providerPreference && opts.providerPreference.length > 0) {
      return this.runWithFailover(opts.providerPreference, request, session, modelId);
    }

    try {
      const { transport, runtimeModeResolved } = await this.resolver.resolve(requestedMode, request);
      try {
        const execution = await transport.execute(request);
        return session.completeSuccess(execution, runtimeModeResolved);
      } catch (error) {
        return session.completeFailure(modelId, runtimeModeResolved, error, transport.kind);
      }
    } catch (error) {
      return session.completeFailure(modelId, requestedMode, error);
    }
  }

  /**
   * Try each provider in the ordered preference list, switching to the next
   * eligible transport ONLY on a classified-retriable error. A non-retriable
   * error (e.g. invalid request) surfaces immediately with no switch. The same
   * transport is never tried twice (resolveOrdered de-duplicates). The returned
   * RunResult.providerKind is whichever transport actually produced the result
   * (proving real re-dispatch), and providerSwitches records each hop.
   */
  private async runWithFailover(
    preference: ExecutionProviderKind[],
    request: ExecutionRequest,
    session: RuntimeSession,
    modelId: string,
  ): Promise<RunResult> {
    const candidates = await this.resolver.resolveOrdered(request, preference);
    if (candidates.length === 0) {
      return session.completeFailure(
        modelId,
        'auto',
        new Error(`No available transport among provider preference: ${preference.join(', ')}`),
      );
    }

    // W4 — jittered exponential backoff on rate-limit errors BEFORE switching
    // providers: a 429 usually clears in seconds, and an immediate switch
    // trades the requested tier (fable/opus) for a fallback when waiting
    // would have kept it. Base is env-tunable so tests run at 1ms.
    const backoffBaseMs = Number(process.env['AGENTFORGE_BACKOFF_BASE_MS'] ?? '2000');
    const maxInPlaceRetries = 2;
    const isRateLimitError = (err: unknown): boolean => {
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      return /\b(?:429|rate\s*limit(?:ed)?|rate-limit(?:ed)?|throttl(?:e|ed|ing)|overloaded)\b/.test(msg);
    };
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

    const switches: ProviderSwitchEvent[] = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const { transport, runtimeModeResolved } = candidates[i]!;
      let lastError: unknown;
      let surfaced: RunResult | null = null;
      for (let attempt = 0; attempt <= maxInPlaceRetries; attempt += 1) {
        try {
          const execution = await transport.execute(request);
          const result = session.completeSuccess(
            switches.length > 0 ? { ...execution, providerSwitches: switches } : execution,
            runtimeModeResolved,
          );
          return switches.length > 0 ? { ...result, providerSwitches: switches } : result;
        } catch (error) {
          lastError = error;
          if (isRateLimitError(error) && attempt < maxInPlaceRetries) {
            const delay = backoffBaseMs * 2 ** attempt * (0.5 + Math.random() * 0.5);
            // delay 0 (AGENTFORGE_BACKOFF_BASE_MS=0) skips the timer entirely —
            // required under vi.useFakeTimers, where a real setTimeout never fires.
            if (delay > 0) await sleep(delay);
            continue; // retry the SAME transport
          }
          if (isRetriableTransportError(error) && candidates[i + 1]) {
            break; // fall through to the provider switch below
          }
          surfaced = session.completeFailure(modelId, runtimeModeResolved, error, transport.kind);
          break;
        }
      }
      if (surfaced) {
        return switches.length > 0 ? { ...surfaced, providerSwitches: switches } : surfaced;
      }
      const next = candidates[i + 1];
      if (next) {
        switches.push({
          from: transport.kind,
          to: next.transport.kind,
          reason: lastError instanceof Error ? lastError.message : String(lastError),
        });
        continue;
      }
      const result = session.completeFailure(modelId, runtimeModeResolved, lastError, transport.kind);
      return switches.length > 0 ? { ...result, providerSwitches: switches } : result;
    }

    // Unreachable: the final candidate always returns via success or the
    // no-next failure branch above. Satisfy the type checker defensively.
    return session.completeFailure(modelId, 'auto', new Error('Provider failover exhausted'));
  }

  async runStreaming(
    config: AgentRuntimeConfig,
    opts: RunOptions & ExecutionStreamOptions,
    adapter?: WorkspaceAdapter,
    apiKey?: string,
  ): Promise<RunResult> {
    const startedAt = new Date().toISOString();
    // Per-call model override (adaptive routing): use the requested tier for
    // THIS call without mutating the shared, cached agent config object.
    const cfg = opts.capabilityTier && opts.capabilityTier !== config.model
      ? { ...config, model: opts.capabilityTier }
      : config;
    const modelId = MODEL_IDS[cfg.model];
    const request = this.buildRequest(cfg, opts, modelId, apiKey);
    const session = new RuntimeSession({
      agentId: config.agentId,
      task: opts.task,
      model: modelId,
      capabilityTier: cfg.model,
      startedAt,
      ...(adapter ? { adapter } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
    });

    session.start();
    const requestedMode = opts.runtimeMode ?? config.runtimeMode ?? 'auto';

    try {
      const { transport, runtimeModeResolved } = await this.resolver.resolve(requestedMode, request);
      try {
        const execution = await this.executeWithStreamingFallback(transport, request, opts);
        const result = session.completeSuccess(execution, runtimeModeResolved);
        this.emitEvent(opts, { type: 'done', data: result });
        return result;
      } catch (error) {
        this.emitError(opts, error, transport.kind);
        const result = session.completeFailure(modelId, runtimeModeResolved, error, transport.kind);
        this.emitEvent(opts, { type: 'done', data: result });
        return result;
      }
    } catch (error) {
      this.emitError(opts, error);
      const result = session.completeFailure(modelId, requestedMode, error);
      this.emitEvent(opts, { type: 'done', data: result });
      return result;
    }
  }

  private async executeWithStreamingFallback(
    transport: ExecutionTransport,
    request: ExecutionRequest,
    opts: ExecutionStreamOptions,
  ): Promise<ExecutionResult> {
    if (!transport.executeStreaming) {
      const execution = await transport.execute(request);
      if (execution.response) {
        this.emitChunk(opts, execution.response, 0);
      }
      return execution;
    }

    let emittedChunks = 0;
    const streamOptions: ExecutionStreamOptions = {
      ...opts,
      onChunk: (text, index) => {
        emittedChunks += 1;
        opts.onChunk?.(text, index);
      },
      onEvent: (event) => {
        if (event.type === 'text_delta' || event.type === 'chunk') emittedChunks += 1;
        opts.onEvent?.(event);
      },
    };

    const execution = await transport.executeStreaming(request, streamOptions);
    if (emittedChunks === 0 && execution.response) {
      this.emitChunk(opts, execution.response, 0);
    }
    return execution;
  }

  private emitChunk(opts: ExecutionStreamOptions, text: string, index: number): void {
    opts.onChunk?.(text, index);
    this.emitEvent(opts, {
      type: 'text_delta',
      data: { text, content: text, index },
    });
  }

  private emitError(
    opts: ExecutionStreamOptions,
    error: unknown,
    providerKind?: ExecutionTransport['kind'],
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.emitEvent(opts, {
      type: 'error',
      data: {
        error: message,
        ...(providerKind ? { providerKind } : {}),
      },
    });
  }

  private emitEvent(opts: ExecutionStreamOptions, event: ExecutionStreamEvent): void {
    opts.onEvent?.(event);
  }

  private mergeAllowedTools(
    allowedTools?: string[],
    requiredTools?: string[],
  ): string[] | undefined {
    const merged = [...new Set([...(allowedTools ?? []), ...(requiredTools ?? [])])];
    if (merged.length > 0) return merged;
    return allowedTools !== undefined ? [] : undefined;
  }

  private buildRequest(
    config: AgentRuntimeConfig,
    opts: RunOptions,
    modelId: string,
    apiKey?: string,
  ): ExecutionRequest {
    const userContent = opts.context
      ? `<context>\n${opts.context}\n</context>\n\n${opts.task}`
      : opts.task;
    const profileRoot = opts.cwd ?? this.projectRoot;
    const allowedTools = this.mergeAllowedTools(opts.allowedTools, config.requiredTools);

    return {
      agent: {
        agentId: config.agentId,
        name: config.name,
        model: config.model,
        systemPrompt: config.systemPrompt,
        workspaceId: config.workspaceId,
      },
      task: opts.task,
      userContent,
      modelId,
      ...(opts.preferredProvider ? { preferredProvider: opts.preferredProvider } : {}),
      providerModelProfiles: resolveProviderModelProfiles(config.model, config.effort, process.env, profileRoot),
      maxTokens: config.maxTokens ?? 8096,
      ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
      ...(allowedTools !== undefined ? { allowedTools } : {}),
      ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
      ...(opts.budgetUsd !== undefined ? { budgetUsd: opts.budgetUsd } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(config.effort ? { effort: config.effort } : {}),
      ...(config.outputSchema ? { outputSchema: config.outputSchema } : {}),
      ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.codexSandbox ? { codexSandbox: opts.codexSandbox } : {}),
      ...(opts.codexSearch !== undefined ? { codexSearch: opts.codexSearch } : {}),
      ...(opts.codexAddDirs?.length ? { codexAddDirs: opts.codexAddDirs } : {}),
      ...(opts.codexEphemeral !== undefined ? { codexEphemeral: opts.codexEphemeral } : {}),
      ...(opts.codexProfile ? { codexProfile: opts.codexProfile } : {}),
      ...(opts.codexProfileV2 ? { codexProfileV2: opts.codexProfileV2 } : {}),
      ...(opts.codexSkipGitRepoCheck !== undefined ? { codexSkipGitRepoCheck: opts.codexSkipGitRepoCheck } : {}),
      ...(opts.codexResumeSessionId ? { codexResumeSessionId: opts.codexResumeSessionId } : {}),
      ...(opts.codexResumeLast !== undefined ? { codexResumeLast: opts.codexResumeLast } : {}),
      ...(opts.enableFallback !== undefined ? { enableFallback: opts.enableFallback } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    };
  }
}
