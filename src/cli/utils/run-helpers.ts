import type {
  RuntimeMode,
  ExecutionProviderKind,
  DelegateTaskResult,
  InvokeAgentRunResult,
} from '@agentforge/core';

/**
 * Emit a deprecation warning to stderr, guiding operators toward canonical
 * package CLI commands. Set AGENTFORGE_SUPPRESS_DEPRECATION=1 to silence
 * these warnings (e.g. in automated tests) without suppressing real errors.
 */
export function warnDeprecation(message: string): void {
  if (process.env.AGENTFORGE_SUPPRESS_DEPRECATION === '1') {
    return;
  }
  console.warn(message);
}

export const VALID_RUNTIME_MODES: RuntimeMode[] = ['auto', 'sdk', 'claude-code-compat'];

interface AgentLookupLikeError extends Error {
  availableAgents: Array<{ agentId: string }>;
}

export function parseRuntimeMode(raw: string): RuntimeMode | null {
  if (VALID_RUNTIME_MODES.includes(raw as RuntimeMode)) {
    return raw as RuntimeMode;
  }
  console.error(
    `Invalid runtime mode: ${raw}. Expected one of ${VALID_RUNTIME_MODES.join(', ')}.`,
  );
  return null;
}

export function parseBudget(raw?: string): number | undefined | null {
  if (raw === undefined) return undefined;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`Invalid budget value: ${raw}`);
    return null;
  }
  return parsed;
}

export function parseLimit(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`Invalid limit value: ${raw}`);
    return null;
  }
  return parsed;
}

export function formatProvider(providerKind?: ExecutionProviderKind): string {
  if (providerKind === 'anthropic-sdk') return 'Anthropic SDK';
  if (providerKind === 'claude-code-compat') return 'Claude Code';
  return providerKind ?? 'unknown transport';
}

export function formatRuntimeMode(runtimeMode?: RuntimeMode): string {
  if (!runtimeMode) return 'auto';
  if (runtimeMode === 'claude-code-compat') return 'claude compat';
  return runtimeMode;
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

export function isAgentLookupError(error: unknown): error is AgentLookupLikeError {
  return (
    error instanceof Error &&
    error.name === 'AgentLookupError' &&
    'availableAgents' in error &&
    Array.isArray((error as { availableAgents?: unknown }).availableAgents)
  );
}

export function printInvokeResponse(response: InvokeAgentRunResult): void {
  console.log(`Agent:        ${response.agent.name} (${response.agent.agentId})`);
  console.log(`Model tier:   ${response.agent.model}`);
  console.log(
    `Runtime:      ${formatRuntimeMode(response.result.runtimeModeResolved)} via ${formatProvider(response.result.providerKind)}`,
  );
  console.log(`Session:      ${response.result.sessionId || '(not persisted)'}`);
  console.log(`Status:       ${response.result.status}`);
  console.log('');
  console.log(response.result.response || '(no response)');
  console.log('');
  console.log(`Input tokens: ${response.result.inputTokens.toLocaleString()}`);
  console.log(`Output tokens:${response.result.outputTokens.toLocaleString()}`);
  console.log(`Cost:         ${formatUsd(response.result.costUsd)}`);

  if (response.result.status === 'failed') {
    if (response.result.error) {
      console.error(`Error:        ${response.result.error}`);
    }
    process.exitCode = 1;
  }
}

export function printDelegateResponse(
  delegated: DelegateTaskResult,
  attemptedRun: boolean,
): void {
  if (delegated.recommendations.length === 0) {
    console.log('No generated agents were found. Run a team generation command first.');
    return;
  }

  console.log(`Task: ${delegated.task}`);
  console.log('');
  console.log('Recommendations:');
  for (const [index, recommendation] of delegated.recommendations.entries()) {
    const marker = index === 0 ? ' <- best match' : '';
    console.log(
      `  ${index + 1}. ${recommendation.name} (${recommendation.agentId}, ${recommendation.model}) ${recommendation.confidence}%${marker}`,
    );
    for (const reason of recommendation.reasons) {
      console.log(`       ${reason}`);
    }
  }

  if (!delegated.invoked) {
    if (!attemptedRun) {
      console.log('');
      console.log(
        '[compat] Recommendation only. Re-run with `--run` or use `agentforge run delegate --run` to execute the best match.',
      );
    }
    return;
  }

  console.log('');
  console.log(
    `Executed: ${delegated.invoked.agent.name} (${delegated.invoked.agent.agentId})`,
  );
  console.log(
    `Runtime:  ${formatRuntimeMode(delegated.invoked.result.runtimeModeResolved)} via ${formatProvider(delegated.invoked.result.providerKind)}`,
  );
  console.log(
    `Session:  ${delegated.invoked.result.sessionId || '(not persisted)'}`,
  );
  console.log('');
  console.log(delegated.invoked.result.response || '(no response)');
  console.log('');
  console.log(`Cost:     ${formatUsd(delegated.invoked.result.costUsd)}`);

  if (delegated.invoked.result.status === 'failed') {
    if (delegated.invoked.result.error) {
      console.error(`Error:    ${delegated.invoked.result.error}`);
    }
    process.exitCode = 1;
  }
}
