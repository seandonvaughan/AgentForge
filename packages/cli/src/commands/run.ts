import { Command } from 'commander';
import type { CodexSandboxMode, RuntimeMode } from '@agentforge/core';
import {
  invokeAgentRun,
  delegateTask,
  listRunHistory,
  getRunSessionDetails,
} from '@agentforge/core';

const VALID_RUNTIME_MODES: RuntimeMode[] = [
  'auto',
  'sdk',
  'cli',
  'anthropic-sdk',
  'claude-cli',
  'claude-code-compat',
  'codex-cli',
  'openai-sdk',
];

interface InvokeOptions {
  agent: string;
  task: string;
  projectRoot: string;
  runtime: string;
  tool?: string[];
  budget?: string;
  codexSandbox?: string;
  codexSearch?: boolean;
  codexAddDir?: string[];
  codexEphemeral?: boolean;
  codexProfile?: string;
  codexProfileV2?: string;
  codexSkipGitRepoCheck?: boolean;
  codexResume?: string;
  codexResumeLast?: boolean;
}

interface DelegateOptions {
  projectRoot: string;
  runtime: string;
  tool?: string[];
  budget?: string;
  codexSandbox?: string;
  codexSearch?: boolean;
  codexAddDir?: string[];
  codexEphemeral?: boolean;
  codexProfile?: string;
  codexProfileV2?: string;
  codexSkipGitRepoCheck?: boolean;
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
    run.command('delegate').description('Recommend the best generated agent for a task; add --run to execute it'),
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
    program.command('delegate').description('Compatibility alias for run delegate that preserves legacy auto-run behavior'),
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
    .option('--runtime <mode>', 'Execution runtime (auto|sdk|cli|anthropic-sdk|claude-cli|codex-cli|openai-sdk)', 'auto')
    .option('--tool <tool...>', 'Allowed agent tool/capability hints for CLI runtimes')
    .option('--codex-sandbox <mode>', 'Codex sandbox mode (read-only|workspace-write|danger-full-access)')
    .option('--codex-search', 'Enable Codex CLI web search')
    .option('--codex-add-dir <dir...>', 'Additional writable directory for Codex CLI')
    .option('--codex-ephemeral', 'Run Codex CLI without persisting session files')
    .option('--codex-profile <profile>', 'Codex config profile from config.toml')
    .option('--codex-profile-v2 <profile>', 'Codex profile-v2 config layer')
    .option('--codex-skip-git-repo-check', 'Allow Codex CLI outside a Git repository')
    .option('--codex-resume <sessionId>', 'Resume a previous Codex exec session')
    .option('--codex-resume-last', 'Resume the most recent Codex exec session')
    .option('--budget <usd>', 'Budget hint for this run')
    .action(async (invokeOptions: InvokeOptions) => {
      if (options.compatibilityAlias) {
        console.warn('[compat] `invoke` is a compatibility alias. Prefer `run invoke`.');
      }

      const runtimeMode = parseRuntimeMode(invokeOptions.runtime);
      const budgetUsd = parseBudget(invokeOptions.budget);
      const codexSandbox = parseCodexSandbox(invokeOptions.codexSandbox);
      if (!runtimeMode || budgetUsd === null || codexSandbox === null) {
        process.exitCode = 1;
        return;
      }

      try {
        const response = await invokeAgentRun({
          projectRoot: invokeOptions.projectRoot,
          agent: invokeOptions.agent,
          task: invokeOptions.task,
          runtimeMode,
          ...(invokeOptions.tool?.length ? { allowedTools: invokeOptions.tool } : {}),
          ...(budgetUsd !== undefined ? { budgetUsd } : {}),
          ...(codexSandbox ? { codexSandbox } : {}),
          ...(invokeOptions.codexSearch ? { codexSearch: true } : {}),
          ...(invokeOptions.codexAddDir?.length ? { codexAddDirs: invokeOptions.codexAddDir } : {}),
          ...(invokeOptions.codexEphemeral ? { codexEphemeral: true } : {}),
          ...(invokeOptions.codexProfile ? { codexProfile: invokeOptions.codexProfile } : {}),
          ...(invokeOptions.codexProfileV2 ? { codexProfileV2: invokeOptions.codexProfileV2 } : {}),
          ...(invokeOptions.codexSkipGitRepoCheck ? { codexSkipGitRepoCheck: true } : {}),
          ...(invokeOptions.codexResume ? { codexResumeSessionId: invokeOptions.codexResume } : {}),
          ...(invokeOptions.codexResumeLast ? { codexResumeLast: true } : {}),
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
        if (isAgentLookupError(error)) {
          console.error(error.message);
          if (error.availableAgents.length > 0) {
            console.error(`Available:    ${error.availableAgents.map((agent: { agentId: string }) => agent.agentId).join(', ')}`);
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
    .option('--runtime <mode>', 'Execution runtime (auto|sdk|cli|anthropic-sdk|claude-cli|codex-cli|openai-sdk)', 'auto')
    .option('--tool <tool...>', 'Allowed agent tool/capability hints for CLI runtimes')
    .option('--codex-sandbox <mode>', 'Codex sandbox mode when --run uses codex-cli')
    .option('--codex-search', 'Enable Codex CLI web search when --run uses codex-cli')
    .option('--codex-add-dir <dir...>', 'Additional writable directory for Codex CLI when --run uses codex-cli')
    .option('--codex-ephemeral', 'Run Codex CLI without persisting session files when --run uses codex-cli')
    .option('--codex-profile <profile>', 'Codex config profile from config.toml')
    .option('--codex-profile-v2 <profile>', 'Codex profile-v2 config layer')
    .option('--codex-skip-git-repo-check', 'Allow Codex CLI outside a Git repository')
    .option('--budget <usd>', 'Budget hint when running the selected agent')
    .option('--limit <count>', 'Maximum recommendations to show', '5')
    .option('--run', 'Execute the best match instead of recommendation-only')
    .action(async (taskParts: string[], delegateOptions: DelegateOptions) => {
      if (options.compatibilityAlias) {
        console.warn('[compat] `delegate` is a compatibility alias. Prefer `run delegate`.');
      }

      const runtimeMode = parseRuntimeMode(delegateOptions.runtime);
      const budgetUsd = parseBudget(delegateOptions.budget);
      const codexSandbox = parseCodexSandbox(delegateOptions.codexSandbox);
      const limit = parseLimit(delegateOptions.limit, 5);
      const shouldRun = delegateOptions.run ?? options.defaultRun;
      if (!runtimeMode || budgetUsd === null || codexSandbox === null || limit === null) {
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
        const delegated = await delegateTask({
          projectRoot: delegateOptions.projectRoot,
          task,
          limit,
          run: shouldRun,
          runtimeMode,
          ...(delegateOptions.tool?.length ? { allowedTools: delegateOptions.tool } : {}),
          ...(budgetUsd !== undefined ? { budgetUsd } : {}),
          ...(codexSandbox ? { codexSandbox } : {}),
          ...(delegateOptions.codexSearch ? { codexSearch: true } : {}),
          ...(delegateOptions.codexAddDir?.length ? { codexAddDirs: delegateOptions.codexAddDir } : {}),
          ...(delegateOptions.codexEphemeral ? { codexEphemeral: true } : {}),
          ...(delegateOptions.codexProfile ? { codexProfile: delegateOptions.codexProfile } : {}),
          ...(delegateOptions.codexProfileV2 ? { codexProfileV2: delegateOptions.codexProfileV2 } : {}),
          ...(delegateOptions.codexSkipGitRepoCheck ? { codexSkipGitRepoCheck: true } : {}),
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

function parseCodexSandbox(raw?: string): CodexSandboxMode | undefined | null {
  if (raw === undefined) return undefined;
  const valid: CodexSandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];
  if (valid.includes(raw as CodexSandboxMode)) {
    return raw as CodexSandboxMode;
  }

  console.error(`Invalid Codex sandbox mode: ${raw}. Expected one of ${valid.join(', ')}.`);
  return null;
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
  if (providerKind === 'codex-cli') return 'Codex CLI';
  if (providerKind === 'openai-sdk') return 'OpenAI Responses';
  return providerKind ?? 'unknown transport';
}

function formatRuntimeMode(runtimeMode?: string): string {
  if (!runtimeMode) return 'auto';
  if (runtimeMode === 'claude-code-compat') return 'claude compat';
  if (runtimeMode === 'claude-cli' || runtimeMode === 'cli') return 'claude cli';
  return runtimeMode;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function isAgentLookupError(
  error: unknown,
): error is Error & { availableAgents: Array<{ agentId: string }> } {
  return (
    error instanceof Error &&
    error.name === 'AgentLookupError' &&
    'availableAgents' in error &&
    Array.isArray((error as { availableAgents?: unknown }).availableAgents)
  );
}
