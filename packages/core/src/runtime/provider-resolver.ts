import type { ExecutionRequest, ExecutionTransport, RuntimeMode } from './types.js';

export class ProviderResolver {
  constructor(private readonly transports: ExecutionTransport[]) {}

  async resolve(
    mode: RuntimeMode,
    request: ExecutionRequest,
  ): Promise<{ transport: ExecutionTransport; runtimeModeResolved: RuntimeMode }> {
    if (mode === 'sdk') {
      return {
        transport: await this.requireTransport('anthropic-sdk', request),
        runtimeModeResolved: 'sdk',
      };
    }

    if (mode === 'claude-code-compat') {
      return {
        transport: await this.requireTransport('claude-code-compat', request),
        runtimeModeResolved: 'claude-code-compat',
      };
    }

    if (request.allowedTools?.length) {
      const claudeCompat = await this.findTransport('claude-code-compat', request);
      if (claudeCompat) {
        return { transport: claudeCompat, runtimeModeResolved: 'claude-code-compat' };
      }

      throw new Error(
        'Claude Code compatibility transport is required when allowedTools are requested. Install/authenticate Claude Code or remove allowedTools.',
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

    throw new Error(
      'No execution transport is available. Configure Anthropic SDK credentials or install/authenticate Claude Code.',
    );
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
