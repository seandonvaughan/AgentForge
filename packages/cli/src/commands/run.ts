import { Command } from 'commander';
import type { RuntimeMode } from '@agentforge/core';

const VALID_RUNTIME_MODES: RuntimeMode[] = ['auto', 'sdk', 'claude-code-compat'];

interface InvokeOptions {
  agent: string;
  task: string;
  projectRoot: string;
  runtime: string;
  tool?: string[];
  budget?: string;
}

interface DelegateOptions {
  projectRoot: string;
  runtime: string;
  tool?: string[];
  budget?: string;
  limit: string;
  run?: boolean;
}

interface HistoryOptions {
  projectRoot: string;
  limit: string;
}

interface ShowOptions {
  projectRoot: string;
}

export function registerRunCommand(program: Command): void {
  const run = program
    .command('run')
    .description('Run agents and inspect package-runtime execution history');

  registerInvokeCommand(
    run.command('invoke').description('Invoke a generated agent through the package runtime'),
    { compatibilityAlias: false },
  );

  registerDelegateCommand(
    run.command('delegate').description('Recommend the best generated agent for a task'),
    { compatibilityAlias: false, defaultRun: false },
  );

  run
    .command('history')
    .description('Show package-runtime execution history')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--limit <count>', 'Maximum rows to show', '20')
    .action(runHistoryAction);

  run
    .command('show <sessionId>')
    .description('Show details for one package-runtime execution session')
    .option('--project-root <path>', 'Project root', process.cwd())
    .action(runShowAction);

  registerInvokeCommand(
    program.command('invoke').description('Compatibility alias for run invoke'),
    { compatibilityAlias: true },
  );

  registerDelegateCommand(
    program.command('delegate').description('Compatibility alias for run delegate'),
    { compatibilityAlias: true, defaultRun: true },
  );
}

function registerInvokeCommand(
  command: Command,
  options: { compatibilityAlias: boolean },
): void {
  command
    .requiredOption('--agent <agent>', 'Generated agent id or name')
    .requiredOption('--task <task>', 'Task description')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--runtime <mode>', 'Execution runtime (auto|sdk|claude-code-compat)', 'auto')
    .option('--tool <tool...>', 'Allowed Claude Code tools for claude-code-compat mode')
    .option('--budget <usd>', 'Budget hint for this run')
    .action(async (invokeOptions: InvokeOptions) => {
      if (options.compatibilityAlias) {
        console.warn('[compat] `invoke` is a compatibility alias. Prefer `run invoke`.');
      }

      const runtimeMode = parseRuntimeMode(invokeOptions.runtime);
      const budgetUsd = parseBudget(invokeOptions.budget);
      if (!runtimeMode || budgetUsd === null) {
        process.exitCode = 1;
        return;
      }

      try {
        const { AgentLookupError, invokeAgentRun } = await import('@agentforge/core');
        const response = await invokeAgentRun({
          projectRoot: invokeOptions.projectRoot,
          agent: invokeOptions.agent,
          task: invokeOptions.task,
          runtimeMode,
          ...(invokeOptions.tool?.length ? { allowedTools: invokeOptions.tool } : {}),
          ...(budgetUsd !== undefined ? { budgetUsd } : {}),
        });

        console.log(`Agent:        ${response.agent.name} (${response.agent.agentId})`);
        console.log(`Model tier:   ${response.agent.model}`);
        console.log(`Runtime:      ${formatRuntimeMode(response.result.runtimeModeResolved)} via ${formatProvider(response.result.providerKind)}`);
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
      } catch (error) {
        if (error instanceof Error && error.name === 'AgentLookupError') {
          const lookup = error as InstanceType<typeof AgentLookupError>;
          console.error(error.message);
          if (lookup.availableAgents.length > 0) {
            console.error(`Available:    ${lookup.availableAgents.map((agent) => agent.agentId).join(', ')}`);
          }
          process.exitCode = 1;
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        process.exitCode = 1;
      }
    });
}

function registerDelegateCommand(
  command: Command,
  options: { compatibilityAlias: boolean; defaultRun: boolean },
): void {
  command
    .argument('<task...>', 'Task description')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--runtime <mode>', 'Execution runtime (auto|sdk|claude-code-compat)', 'auto')
    .option('--tool <tool...>', 'Allowed Claude Code tools for claude-code-compat mode')
    .option('--budget <usd>', 'Budget hint when running the selected agent')
    .option('--limit <count>', 'Maximum recommendations to show', '5')
    .option('--run', 'Execute the best match instead of recommendation-only')
    .action(async (taskParts: string[], delegateOptions: DelegateOptions) => {
      if (options.compatibilityAlias) {
        console.warn('[compat] `delegate` is a compatibility alias. Prefer `run delegate`.');
      }

      const runtimeMode = parseRuntimeMode(delegateOptions.runtime);
      const budgetUsd = parseBudget(delegateOptions.budget);
      const limit = parseLimit(delegateOptions.limit, 5);
      const shouldRun = delegateOptions.run ?? options.defaultRun;
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
          projectRoot: delegateOptions.projectRoot,
          task,
          limit,
          run: shouldRun,
          runtimeMode,
          ...(delegateOptions.tool?.length ? { allowedTools: delegateOptions.tool } : {}),
          ...(budgetUsd !== undefined ? { budgetUsd } : {}),
        });

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

        if (delegated.invoked) {
          console.log('');
          console.log(`Executed: ${delegated.invoked.agent.name} (${delegated.invoked.agent.agentId})`);
          console.log(`Runtime:  ${formatRuntimeMode(delegated.invoked.result.runtimeModeResolved)} via ${formatProvider(delegated.invoked.result.providerKind)}`);
          console.log(`Session:  ${delegated.invoked.result.sessionId || '(not persisted)'}`);
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        process.exitCode = 1;
      }
    });
}

async function runHistoryAction(options: HistoryOptions): Promise<void> {
  const limit = parseLimit(options.limit, 20);
  if (limit === null) {
    process.exitCode = 1;
    return;
  }

  try {
    const { listRunHistory } = await import('@agentforge/core');
    const runs = await listRunHistory(options.projectRoot, limit);

    if (runs.length === 0) {
      console.log('(no package-runtime sessions recorded)');
      return;
    }

    for (const run of runs) {
      console.log(`${run.sessionId}  ${run.agentId}  ${run.status}`);
      console.log(`  model=${run.model ?? 'unknown'}  cost=${formatUsd(run.costUsd)}  runtime=${formatRuntimeMode(run.runtimeModeResolved)} via ${formatProvider(run.providerKind)}`);
      console.log(`  started=${run.startedAt}${run.completedAt ? `  completed=${run.completedAt}` : ''}`);
      console.log(`  task=${truncate(run.task, 120)}`);
      if (run.outcomeSummary) {
        console.log(`  summary=${truncate(run.outcomeSummary, 160)}`);
      }
      console.log('');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function runShowAction(sessionId: string, options: ShowOptions): Promise<void> {
  try {
    const { getRunSessionDetails } = await import('@agentforge/core');
    const details = await getRunSessionDetails(options.projectRoot, sessionId);

    if (!details) {
      console.error(`Session not found: ${sessionId}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Session:      ${details.sessionId}`);
    console.log(`Agent:        ${details.agentId}`);
    console.log(`Status:       ${details.status}`);
    console.log(`Model:        ${details.model ?? 'unknown'}`);
    console.log(`Runtime:      ${formatRuntimeMode(details.runtimeModeResolved)} via ${formatProvider(details.providerKind)}`);
    console.log(`Started:      ${details.startedAt}`);
    if (details.completedAt) {
      console.log(`Completed:    ${details.completedAt}`);
    }
    console.log(`Input tokens: ${details.inputTokens.toLocaleString()}`);
    console.log(`Output tokens:${details.outputTokens.toLocaleString()}`);
    console.log(`Cost:         ${formatUsd(details.costUsd)}`);
    console.log(`Task:         ${details.task}`);

    if (details.outcomeSummary) {
      console.log(`Summary:      ${details.outcomeSummary}`);
    }

    if (details.decisionEvents.length > 0) {
      console.log('');
      console.log('Decision events:');
      for (const event of details.decisionEvents) {
        console.log(`  - ${event.createdAt}  ${event.type}  ${event.summary}`);
        if (event.rationale) {
          console.log(`    ${truncate(event.rationale, 180)}`);
        }
      }
    }

    if (details.recentTests.length > 0) {
      console.log('');
      console.log('Recent tests:');
      for (const test of details.recentTests) {
        console.log(`  - ${test.observedAt}  ${test.status}  ${test.testName ?? test.filePath ?? '(unnamed test)'}`);
        if (test.message) {
          console.log(`    ${truncate(test.message, 180)}`);
        }
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function parseRuntimeMode(raw: string): RuntimeMode | null {
  if (VALID_RUNTIME_MODES.includes(raw as RuntimeMode)) {
    return raw as RuntimeMode;
  }

  console.error(`Invalid runtime mode: ${raw}. Expected one of ${VALID_RUNTIME_MODES.join(', ')}.`);
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

function parseLimit(raw: string, fallback: number): number | null {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`Invalid limit value: ${raw}`);
    return null;
  }
  return parsed ?? fallback;
}

function formatProvider(providerKind?: string): string {
  if (providerKind === 'anthropic-sdk') return 'Anthropic SDK';
  if (providerKind === 'claude-code-compat') return 'Claude Code';
  return providerKind ?? 'unknown transport';
}

function formatRuntimeMode(runtimeMode?: string): string {
  if (!runtimeMode) return 'auto';
  if (runtimeMode === 'claude-code-compat') return 'claude compat';
  return runtimeMode;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
