import { spawnSync } from 'node:child_process';
import { buildCodexSpawnCommand } from './transports/codex-cli-transport.js';
import type { ExecutionProviderKind, ExecutionRequest, ExecutionTransport, RuntimeMode } from './types.js';

export interface ProviderAvailabilityStatus {
  available: boolean;
  reason: string;
}

export type ProviderAvailabilityMap = Record<ExecutionProviderKind, ProviderAvailabilityStatus>;

export interface ProviderAvailabilityClock {
  now(): number;
}

export interface ProviderAvailabilityOptions {
  ttlMs?: number;
  clock?: ProviderAvailabilityClock;
  probeClaudeCodeCompatAvailable?: () => boolean;
  probeCodexCliAvailability?: (env: NodeJS.ProcessEnv) => ProviderAvailabilityStatus;
}

export interface ProviderResolverOptions {
  env?: NodeJS.ProcessEnv;
  getProviderAvailability?: (
    env: NodeJS.ProcessEnv,
    options?: ProviderAvailabilityOptions,
  ) => ProviderAvailabilityMap;
}

const DEFAULT_PROVIDER_AVAILABILITY_TTL_MS = 30_000;
const SYSTEM_CLOCK: ProviderAvailabilityClock = { now: () => Date.now() };

let providerAvailabilityCache:
  | { expiresAtMs: number; value: ProviderAvailabilityMap }
  | null = null;

export function clearProviderAvailabilityCache(): void {
  providerAvailabilityCache = null;
}

export function getProviderAvailability(
  env: NodeJS.ProcessEnv = process.env,
  options: ProviderAvailabilityOptions = {},
): ProviderAvailabilityMap {
  const clock = options.clock ?? SYSTEM_CLOCK;
  const nowMs = clock.now();
  if (providerAvailabilityCache && nowMs < providerAvailabilityCache.expiresAtMs) {
    return providerAvailabilityCache.value;
  }

  const hasAnthropicKey = hasCredential(env['ANTHROPIC_API_KEY']);
  const hasOpenAiKey = hasCredential(env['OPENAI_API_KEY']);
  const hasClaudeCli = options.probeClaudeCodeCompatAvailable
    ? options.probeClaudeCodeCompatAvailable()
    : probeClaudeCodeCompatAvailable();
  const codexStatus = options.probeCodexCliAvailability
    ? options.probeCodexCliAvailability(env)
    : probeCodexCliAvailability(env);

  const availability: ProviderAvailabilityMap = {
    'anthropic-sdk': hasAnthropicKey
      ? { available: true, reason: 'ANTHROPIC_API_KEY is set.' }
      : { available: false, reason: 'Missing ANTHROPIC_API_KEY.' },
    'claude-code-compat': hasClaudeCli
      ? { available: true, reason: 'claude CLI is on PATH.' }
      : { available: false, reason: 'claude CLI is not on PATH.' },
    'codex-cli': codexStatus,
    'openai-sdk': hasOpenAiKey
      ? { available: true, reason: 'OPENAI_API_KEY is set.' }
      : { available: false, reason: 'Missing OPENAI_API_KEY.' },
  };

  const ttlMs = options.ttlMs ?? DEFAULT_PROVIDER_AVAILABILITY_TTL_MS;
  providerAvailabilityCache = {
    expiresAtMs: nowMs + ttlMs,
    value: availability,
  };
  return availability;
}

export class ProviderResolver {
  constructor(
    private readonly transports: ExecutionTransport[],
    private readonly options: ProviderResolverOptions = {},
  ) {}

  async resolve(
    mode: RuntimeMode,
    request: ExecutionRequest,
  ): Promise<{ transport: ExecutionTransport; runtimeModeResolved: RuntimeMode }> {
    const availability = this.options.getProviderAvailability
      ? this.options.getProviderAvailability(this.options.env ?? process.env)
      : null;
    const forcedKind = this.kindForForcedMode(mode);
    if (forcedKind) {
      return {
        transport: await this.requireTransport(forcedKind, request, availability),
        runtimeModeResolved: mode,
      };
    }

    if (request.allowedTools?.length) {
      const preferredCliTransport = await this.resolvePreferredAllowedToolsTransport(request, availability);
      if (preferredCliTransport) return preferredCliTransport;

      const claudeCompat = await this.findTransport('claude-code-compat', request, availability);
      if (claudeCompat) {
        return { transport: claudeCompat, runtimeModeResolved: 'claude-code-compat' };
      }

      const codexCli = await this.findTransport('codex-cli', request, availability);
      if (codexCli) {
        return { transport: codexCli, runtimeModeResolved: 'codex-cli' };
      }

      throw new Error(
        'Claude Code compatibility or Codex CLI transport is required in auto mode when allowedTools are requested. Install/authenticate Claude Code or Codex CLI, request a compatible runtime explicitly, or remove allowedTools.',
      );
    }

    const preferredAutoTransport = await this.resolvePreferredAutoTransport(request, availability);
    if (preferredAutoTransport) return preferredAutoTransport;

    const sdkTransport = await this.findTransport('anthropic-sdk', request, availability);
    if (sdkTransport) {
      return { transport: sdkTransport, runtimeModeResolved: 'sdk' };
    }

    const claudeCompat = await this.findTransport('claude-code-compat', request, availability);
    if (claudeCompat) {
      return { transport: claudeCompat, runtimeModeResolved: 'claude-code-compat' };
    }

    const codexCli = await this.findTransport('codex-cli', request, availability);
    if (codexCli) {
      return { transport: codexCli, runtimeModeResolved: 'codex-cli' };
    }

    const openaiSdk = await this.findTransport('openai-sdk', request, availability);
    if (openaiSdk) {
      return { transport: openaiSdk, runtimeModeResolved: 'openai-sdk' };
    }

    throw new Error(
      'No execution transport is available. Configure Anthropic/OpenAI credentials, install/authenticate Claude Code, or install/authenticate Codex CLI.',
    );
  }

  private kindForForcedMode(mode: RuntimeMode): ExecutionProviderKind | null {
    if (mode === 'sdk' || mode === 'anthropic-sdk') return 'anthropic-sdk';
    if (mode === 'cli' || mode === 'claude-cli' || mode === 'claude-code-compat') return 'claude-code-compat';
    if (mode === 'codex-cli') return 'codex-cli';
    if (mode === 'openai-sdk') return 'openai-sdk';
    return null;
  }

  private async requireTransport(
    kind: ExecutionTransport['kind'],
    request: ExecutionRequest,
    availability: ProviderAvailabilityMap | null,
  ): Promise<ExecutionTransport> {
    const transport = await this.findTransport(kind, request, availability);
    if (!transport) {
      throw new Error(`Requested runtime transport is unavailable: ${kind}`);
    }
    return transport;
  }

  private async findTransport(
    kind: ExecutionTransport['kind'],
    request: ExecutionRequest,
    availability: ProviderAvailabilityMap | null,
  ): Promise<ExecutionTransport | null> {
    if (!this.isProviderAllowedByAvailability(kind, request, availability)) return null;
    const transport = this.transports.find((candidate) => candidate.kind === kind);
    if (!transport) return null;
    return (await transport.isAvailable(request)) ? transport : null;
  }

  private async resolvePreferredAllowedToolsTransport(
    request: ExecutionRequest,
    availability: ProviderAvailabilityMap | null,
  ): Promise<{ transport: ExecutionTransport; runtimeModeResolved: RuntimeMode } | null> {
    if (!request.preferredProvider) return null;
    if (request.preferredProvider !== 'claude-code-compat' && request.preferredProvider !== 'codex-cli') {
      return null;
    }

    const preferred = await this.findTransport(request.preferredProvider, request, availability);
    if (!preferred) return null;
    return { transport: preferred, runtimeModeResolved: request.preferredProvider };
  }

  private async resolvePreferredAutoTransport(
    request: ExecutionRequest,
    availability: ProviderAvailabilityMap | null,
  ): Promise<{ transport: ExecutionTransport; runtimeModeResolved: RuntimeMode } | null> {
    if (!request.preferredProvider) return null;
    const preferred = await this.findTransport(request.preferredProvider, request, availability);
    if (!preferred) return null;
    return {
      transport: preferred,
      runtimeModeResolved: this.runtimeModeForProvider(request.preferredProvider),
    };
  }

  private isProviderAllowedByAvailability(
    kind: ExecutionProviderKind,
    request: ExecutionRequest,
    availability: ProviderAvailabilityMap | null,
  ): boolean {
    if ((kind === 'anthropic-sdk' || kind === 'openai-sdk') && hasCredential(request.apiKey)) {
      return true;
    }
    return availability ? availability[kind].available : true;
  }

  private runtimeModeForProvider(kind: ExecutionProviderKind): RuntimeMode {
    if (kind === 'anthropic-sdk') return 'sdk';
    return kind;
  }
}

function hasCredential(value: string | undefined): boolean {
  return Boolean(value && value.trim().length > 0);
}

function probeClaudeCodeCompatAvailable(): boolean {
  const probe = process.platform === 'win32'
    ? spawnSync('where', ['claude'], { stdio: 'ignore', windowsHide: true })
    : spawnSync('which', ['claude'], { stdio: 'ignore', windowsHide: true });
  return probe.status === 0;
}

function probeCodexCliAvailability(env: NodeJS.ProcessEnv): ProviderAvailabilityStatus {
  let command;
  try {
    command = buildCodexSpawnCommand(['--version'], { env });
  } catch {
    return {
      available: false,
      reason: 'codex CLI is not on PATH.',
    };
  }

  const versionProbe = spawnSync(command.command, command.args, {
    stdio: 'ignore',
    windowsHide: true,
    ...(command.env ? { env: command.env } : {}),
  });
  if (versionProbe.status !== 0) {
    return {
      available: false,
      reason: 'codex CLI is not executable.',
    };
  }

  let loginCommand;
  try {
    loginCommand = buildCodexSpawnCommand(['login', 'status'], { env });
  } catch {
    return {
      available: false,
      reason: 'codex CLI is not authenticated.',
    };
  }
  const loginProbe = spawnSync(loginCommand.command, loginCommand.args, {
    stdio: 'ignore',
    windowsHide: true,
    ...(loginCommand.env ? { env: loginCommand.env } : {}),
  });
  if (loginProbe.status !== 0) {
    return {
      available: false,
      reason: 'codex CLI is not authenticated.',
    };
  }

  return {
    available: true,
    reason: 'codex CLI is authenticated.',
  };
}
