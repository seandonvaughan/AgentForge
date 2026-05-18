import type { ExecutionProviderKind, ExecutionRequest, ExecutionTransport, RuntimeMode } from './types.js';

export class ProviderResolver {
  constructor(private readonly transports: ExecutionTransport[]) {}

  async resolve(
    mode: RuntimeMode,
    request: ExecutionRequest,
  ): Promise<{ transport: ExecutionTransport; runtimeModeResolved: RuntimeMode }> {
    const forcedKind = this.kindForForcedMode(mode);
    if (forcedKind) {
      return {
        transport: await this.requireTransport(forcedKind, request),
        runtimeModeResolved: mode,
      };
    }

    if (request.allowedTools?.length) {
      const claudeCompat = await this.findTransport('claude-code-compat', request);
      if (claudeCompat) {
        return { transport: claudeCompat, runtimeModeResolved: 'claude-code-compat' };
      }

      const codexCli = await this.findTransport('codex-cli', request);
      if (codexCli) {
        return { transport: codexCli, runtimeModeResolved: 'codex-cli' };
      }

      throw new Error(
        'Claude Code compatibility or Codex CLI transport is required in auto mode when allowedTools are requested. Install/authenticate Claude Code or Codex CLI, request a compatible runtime explicitly, or remove allowedTools.',
      );
    }

    const sdkTransport = await this.findTransport('anthropic-sdk', request);
    if (sdkTransport) {
      return { transport: sdkTransport, runtimeModeResolved: 'sdk' };
    }

    const claudeCompat = await this.findTransport('claude-code-compat', request);
    if (claudeCompat) {
      return { transport: claudeCompat, runtimeModeResolved: 'claude-code-compat' };
    }

    const codexCli = await this.findTransport('codex-cli', request);
    if (codexCli) {
      return { transport: codexCli, runtimeModeResolved: 'codex-cli' };
    }

    const openaiSdk = await this.findTransport('openai-sdk', request);
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
  ): Promise<ExecutionTransport> {
    const transport = await this.findTransport(kind, request);
    if (!transport) {
      throw new Error(`Requested runtime transport is unavailable: ${kind}`);
    }
    return transport;
  }

  private async findTransport(
    kind: ExecutionTransport['kind'],
    request: ExecutionRequest,
  ): Promise<ExecutionTransport | null> {
    const transport = this.transports.find((candidate) => candidate.kind === kind);
    if (!transport) return null;
    return (await transport.isAvailable(request)) ? transport : null;
  }
}
