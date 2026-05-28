import type { ProviderAvailabilityMap } from './provider-availability.js';
import type { ExecutionProviderKind, ExecutionRequest, ExecutionTransport, RuntimeMode } from './types.js';

export class ProviderResolver {
  /**
   * @param transports   Candidate transports, tried in their declared order.
   * @param availability Optional env-based availability snapshot provider. When
   *                     supplied, any provider it reports as `available: false`
   *                     is excluded from selection even if a transport instance
   *                     exists. Omitted in tests/contexts that rely solely on
   *                     each transport's own `isAvailable` probe.
   */
  constructor(
    private readonly transports: ExecutionTransport[],
    private readonly availability?: () => ProviderAvailabilityMap,
  ) {}

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
      const preferredCliTransport = await this.resolvePreferredAllowedToolsTransport(request);
      if (preferredCliTransport) return preferredCliTransport;

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

    const preferredAutoTransport = await this.resolvePreferredAutoTransport(request);
    if (preferredAutoTransport) return preferredAutoTransport;

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

  /**
   * Resolve an ordered provider preference list to the ordered, eligible
   * transports backing it — for the auto-switch path. Each preference kind is
   * mapped to its transport only when both the availability snapshot (item 2)
   * and the transport's own isAvailable() accept it; unavailable or unknown
   * kinds are skipped, and duplicate kinds are de-duplicated so the same
   * transport is never offered (or retried) twice.
   */
  async resolveOrdered(
    request: ExecutionRequest,
    preference: ExecutionProviderKind[],
  ): Promise<Array<{ transport: ExecutionTransport; runtimeModeResolved: RuntimeMode }>> {
    const seen = new Set<ExecutionProviderKind>();
    const ordered: Array<{ transport: ExecutionTransport; runtimeModeResolved: RuntimeMode }> = [];
    for (const kind of preference) {
      if (seen.has(kind)) continue;
      seen.add(kind);
      const transport = await this.findTransport(kind, request);
      if (!transport) continue;
      ordered.push({ transport, runtimeModeResolved: this.runtimeModeForProvider(kind) });
    }
    return ordered;
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
    if (this.availability?.()[kind]?.available === false) return null;
    const transport = this.transports.find((candidate) => candidate.kind === kind);
    if (!transport) return null;
    return (await transport.isAvailable(request)) ? transport : null;
  }

  private async resolvePreferredAllowedToolsTransport(
    request: ExecutionRequest,
  ): Promise<{ transport: ExecutionTransport; runtimeModeResolved: RuntimeMode } | null> {
    if (!request.preferredProvider) return null;
    if (request.preferredProvider !== 'claude-code-compat' && request.preferredProvider !== 'codex-cli') {
      return null;
    }

    const preferred = await this.findTransport(request.preferredProvider, request);
    if (!preferred) return null;
    return { transport: preferred, runtimeModeResolved: request.preferredProvider };
  }

  private async resolvePreferredAutoTransport(
    request: ExecutionRequest,
  ): Promise<{ transport: ExecutionTransport; runtimeModeResolved: RuntimeMode } | null> {
    if (!request.preferredProvider) return null;
    const preferred = await this.findTransport(request.preferredProvider, request);
    if (!preferred) return null;
    return {
      transport: preferred,
      runtimeModeResolved: this.runtimeModeForProvider(request.preferredProvider),
    };
  }

  private runtimeModeForProvider(kind: ExecutionProviderKind): RuntimeMode {
    if (kind === 'anthropic-sdk') return 'sdk';
    return kind;
  }
}
