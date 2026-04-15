import type {
  RuntimeMode,
  ExecutionProviderKind,
  DelegateTaskResult,
  InvokeAgentRunResult,
} from '@agentforge/core';

const VALID_RUNTIME_MODES: RuntimeMode[] = ['auto', 'sdk', 'claude-code-compat'];

interface AgentLookupLikeError extends Error {
  availableAgents: Array<{ agentId: string }>;
}

interface InvokeCompatibilityOptions {
  agent: string;
  task: string;
  projectRoot?: string;
  runtime?: string;
  tool?: string[];
  budget?: string;
  loop?: boolean;
}

interface DelegateCompatibilityOptions {
  projectRoot?: string;
  runtime?: string;
  tool?: string[];
  budget?: string;
  limit?: string;
  run?: boolean;
}

export async function invokeRunCompatibility(
  options: InvokeCompatibilityOptions,
): Promise<void> {
  if (options.loop) {
    console.error(
      '[compat] `invoke --loop` is no longer supported. Use `agentforge cycle run`.',
    );
    process.exitCode = 1;
    return;
  }

  const runtimeMode = parseRuntimeMode(options.runtime ?? 'auto');
  const budgetUsd = parseBudget(options.budget);
  if (!runtimeMode || budgetUsd === null) {
    process.exitCode = 1;
    return;
  }

  try {
    const { invokeAgentRun } = await import('@agentforge/core');
    const response = await invokeAgentRun({
      projectRoot: options.projectRoot ?? process.cwd(),
      agent: options.agent,
      task: options.task,
      runtimeMode,
      ...(options.tool?.length ? { allowedTools: options.tool } : {}),
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    });

    printInvokeResponse(response);
  } catch (error) {
    if (isAgentLookupError(error)) {
      console.error(error.message);
      if (error.availableAgents.length > 0) {
        console.error(
          `Available:    ${error.availableAgents
            .map((agent) => agent.agentId)
            .join(', ')}`,
        );
      }
      process.exitCode = 1;
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

export async function delegateRunCompatibility(
  taskParts: string[],
  options: DelegateCompatibilityOptions,
): Promise<void> {
  const runtimeMode = parseRuntimeMode(options.runtime ?? 'auto');
  const budgetUsd = parseBudget(options.budget);
  const limit = parseLimit(options.limit ?? '5');
  if (!runtimeMode || budgetUsd === null || limit === null) {
    process.exitCode = 1;
    return;
  }

  const task = taskParts.join(' ').trim();
  if (!task) {
    console.error('Task is required.');
    process.exitCode = 1;
    return;
  }

  try {
    const { delegateTask } = await import('@agentforge/core');
    const delegated = await delegateTask({
      projectRoot: options.projectRoot ?? process.cwd(),
      task,
      limit,
      run: options.run ?? false,
      runtimeMode,
      ...(options.tool?.length ? { allowedTools: options.tool } : {}),
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    });

    printDelegateResponse(delegated, Boolean(options.run));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

export async function costReportCompatibility(options: {
  projectRoot?: string;
} = {}): Promise<void> {
  try {
    const { generateCostReport } = await import('@agentforge/core');
    const report = await generateCostReport(options.projectRoot ?? process.cwd());

    if (report.source === 'empty') {
      console.log('No package-runtime sessions recorded yet.');
      console.log('');
      console.log('Pricing reference:');
      for (const [model, pricing] of Object.entries(report.pricingReference)) {
        console.log(
          `  ${model}: input $${pricing.input.toFixed(2)} / 1M, output $${pricing.output.toFixed(2)} / 1M`,
        );
      }
      return;
    }

    console.log('AgentForge Cost Report');
    console.log(`Source:       ${report.source}`);
    console.log(`Sessions:     ${report.sessionsRecorded}`);
    console.log(`Agent runs:   ${report.totalAgentRuns}`);
    console.log(`Total spend:  $${report.totalSpentUsd.toFixed(4)}`);

    if (report.perAgent.length > 0) {
      console.log('');
      console.log('Per-agent:');
      for (const agent of report.perAgent) {
        console.log(
          `  ${agent.label}: $${agent.totalUsd.toFixed(4)} across ${agent.runs} run(s)`,
        );
      }
    }

    if (report.perModel.length > 0) {
      console.log('');
      console.log('Per-model:');
      for (const model of report.perModel) {
        console.log(
          `  ${model.label}: $${model.totalUsd.toFixed(4)} across ${model.runs} run(s)`,
        );
      }
    }

    if (report.lastSession) {
      console.log('');
      console.log('Last session:');
      console.log(`  ${report.lastSession.sessionId}`);
      console.log(
        `  status=${report.lastSession.status}  cost=$${report.lastSession.costUsd.toFixed(4)}`,
      );
      console.log(`  started=${report.lastSession.startedAt}`);
      if (report.lastSession.completedAt) {
        console.log(`  completed=${report.lastSession.completedAt}`);
      }
      if (report.lastSession.providerKind || report.lastSession.runtimeModeResolved) {
        console.log(
          `  runtime=${report.lastSession.runtimeModeResolved ?? 'auto'} via ${report.lastSession.providerKind ?? 'unknown transport'}`,
        );
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function printInvokeResponse(response: InvokeAgentRunResult): void {
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

function printDelegateResponse(
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

function parseRuntimeMode(raw: string): RuntimeMode | null {
  if (VALID_RUNTIME_MODES.includes(raw as RuntimeMode)) {
    return raw as RuntimeMode;
  }

  console.error(
    `Invalid runtime mode: ${raw}. Expected one of ${VALID_RUNTIME_MODES.join(', ')}.`,
  );
  return null;
}

function parseBudget(raw?: string): number | undefined | null {
  if (raw === undefined) return undefined;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`Invalid budget value: ${raw}`);
    return null;
  }
  return parsed;
}

function parseLimit(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`Invalid limit value: ${raw}`);
    return null;
  }
  return parsed;
}

function formatProvider(providerKind?: ExecutionProviderKind): string {
  if (providerKind === 'anthropic-sdk') return 'Anthropic SDK';
  if (providerKind === 'claude-code-compat') return 'Claude Code';
  return providerKind ?? 'unknown transport';
}

function formatRuntimeMode(runtimeMode?: RuntimeMode): string {
  if (!runtimeMode) return 'auto';
  if (runtimeMode === 'claude-code-compat') return 'claude compat';
  return runtimeMode;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function isAgentLookupError(error: unknown): error is AgentLookupLikeError {
  return (
    error instanceof Error &&
    error.name === 'AgentLookupError' &&
    'availableAgents' in error &&
    Array.isArray((error as { availableAgents?: unknown }).availableAgents)
  );
}
