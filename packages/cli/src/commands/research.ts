import { Command } from 'commander';
import {
  createResearchRun,
  listResearchRuns,
  planApprovedResearchIdeas,
  readResearchRun,
  updateResearchIdeaStatus,
} from '@agentforge/core';

interface ProjectOptions {
  projectRoot: string;
  json?: boolean;
}

interface ProposeOptions extends ProjectOptions {
  prompt?: string;
  autonomous?: boolean;
  maxIdeas?: string;
  tags?: string;
}

interface DecisionOptions extends ProjectOptions {
  note?: string;
}

interface PlanOptions extends ProjectOptions {
  budgetUsd?: string;
  maxItems?: string;
  maxAgents?: string;
  branchPrefix?: string;
  baseBranch?: string;
  dryRun?: boolean;
  fastMode?: boolean;
  modelCap?: string;
  effortCap?: string;
}

export function registerResearchCommand(program: Command): void {
  const research = program
    .command('research')
    .alias('rd')
    .description('Create, approve, and convert R&D ideas into AgentForge cycle plans');

  research
    .command('propose')
    .description('Create a durable R&D run with selectable idea artifacts')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--prompt <text>', 'Research prompt or product direction')
    .option('--autonomous', 'Let the team propose ideas without an operator seed')
    .option('--max-ideas <count>', 'Number of ideas to produce, 1-6', '3')
    .option('--tags <tags>', 'Comma-separated tags')
    .option('--json', 'Print machine-readable JSON')
    .action(async (opts: ProposeOptions) => {
      const maxIdeas = parsePositiveInt(opts.maxIdeas, 'max-ideas');
      if (maxIdeas === null) return;
      const run = await createResearchRun({
        projectRoot: opts.projectRoot,
        ...(opts.prompt ? { prompt: opts.prompt } : {}),
        mode: opts.autonomous ? 'autonomous' : 'operator-seeded',
        maxIdeas,
        tags: parseTags(opts.tags),
      });
      printRun(run, opts.json);
    });

  research
    .command('list')
    .description('List recent R&D runs')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--json', 'Print machine-readable JSON')
    .action((opts: ProjectOptions) => {
      const runs = listResearchRuns(opts.projectRoot);
      if (opts.json) {
        console.log(JSON.stringify(runs, null, 2));
        return;
      }
      if (runs.length === 0) {
        console.log('(no research runs recorded)');
        return;
      }
      for (const run of runs) {
        const approved = run.ideas.filter((idea) => idea.status === 'approved' || idea.status === 'planned').length;
        console.log(`${run.runId}  ${run.status}  ideas=${run.ideas.length} approved=${approved}`);
        console.log(`  prompt=${run.prompt}`);
      }
    });

  research
    .command('show <runId>')
    .description('Show one R&D run')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--json', 'Print machine-readable JSON')
    .action((runId: string, opts: ProjectOptions) => {
      const run = readResearchRun(opts.projectRoot, runId);
      if (!run) {
        console.error(`Research run not found: ${runId}`);
        process.exitCode = 1;
        return;
      }
      printRun(run, opts.json);
    });

  research
    .command('approve <runId> <ideaId>')
    .description('Approve one idea for conversion into a planned cycle')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--note <text>', 'Approval note')
    .option('--json', 'Print machine-readable JSON')
    .action(async (runId: string, ideaId: string, opts: DecisionOptions) => {
      await runDecision(runId, ideaId, opts, 'approved');
    });

  research
    .command('reject <runId> <ideaId>')
    .description('Reject one idea')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--note <text>', 'Rejection note')
    .option('--json', 'Print machine-readable JSON')
    .action(async (runId: string, ideaId: string, opts: DecisionOptions) => {
      await runDecision(runId, ideaId, opts, 'rejected');
    });

  research
    .command('plan <runId>')
    .description('Convert approved ideas into a cycle launch request')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--budget-usd <usd>', 'Cycle budget override')
    .option('--max-items <count>', 'Cycle max item count')
    .option('--max-agents <count>', 'Cycle max agent count')
    .option('--branch-prefix <prefix>', 'Cycle branch prefix')
    .option('--base-branch <branch>', 'Cycle base branch')
    .option('--dry-run', 'Plan as dry-run cycle')
    .option('--no-fast-mode', 'Disable the fast parallel high-effort launch preset')
    .option('--model-cap <tier>', 'Capability tier cap: opus, sonnet, haiku')
    .option('--effort-cap <effort>', 'Reasoning effort cap: low, medium, high, xhigh, max')
    .option('--json', 'Print machine-readable JSON')
    .action(async (runId: string, opts: PlanOptions) => {
      const parsed = parsePlanOptions(opts);
      if (!parsed) return;
      try {
        const run = await planApprovedResearchIdeas({ projectRoot: opts.projectRoot, runId, ...parsed });
        if (opts.json) {
          console.log(JSON.stringify(run.plannedCycle, null, 2));
          return;
        }
        console.log(`Planned cycle for ${run.runId}`);
        console.log(`  title=${run.plannedCycle?.title ?? '(none)'}`);
        console.log(`  ideas=${run.plannedCycle?.ideaIds.join(', ') ?? '(none)'}`);
        console.log(`  branchPrefix=${run.plannedCycle?.cycleRequest.branchPrefix}`);
        console.log(`  baseBranch=${run.plannedCycle?.cycleRequest.baseBranch}`);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}

async function runDecision(
  runId: string,
  ideaId: string,
  opts: DecisionOptions,
  status: 'approved' | 'rejected',
): Promise<void> {
  try {
    const run = await updateResearchIdeaStatus({
      projectRoot: opts.projectRoot,
      runId,
      ideaId,
      status,
      ...(opts.note ? { note: opts.note } : {}),
    });
    printRun(run, opts.json);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function printRun(run: NonNullable<ReturnType<typeof readResearchRun>>, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(run, null, 2));
    return;
  }
  console.log(`Research run: ${run.runId}`);
  console.log(`Status:       ${run.status}`);
  console.log(`Mode:         ${run.mode}`);
  console.log(`Prompt:       ${run.prompt}`);
  console.log('');
  for (const idea of run.ideas) {
    console.log(`${idea.ideaId}  ${idea.status}  ${idea.title}`);
    console.log(`  risk=${idea.risk}  agents=${idea.suggestedAgents.join(', ')}`);
    console.log(`  ${idea.expectedImpact}`);
  }
}

function parsePositiveInt(raw: string | undefined, label: string): number | null {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`Invalid ${label}: ${raw}`);
    process.exitCode = 1;
    return null;
  }
  return value;
}

function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map((tag) => tag.trim()).filter(Boolean);
}

function parsePlanOptions(opts: PlanOptions): Omit<Parameters<typeof planApprovedResearchIdeas>[0], 'projectRoot' | 'runId'> | null {
  const output: Omit<Parameters<typeof planApprovedResearchIdeas>[0], 'projectRoot' | 'runId'> = {};
  const budgetUsd = parseOptionalNumber(opts.budgetUsd, 'budget-usd');
  if (budgetUsd === null) return null;
  if (budgetUsd !== undefined) output.budgetUsd = budgetUsd;
  const maxItems = parseOptionalInt(opts.maxItems, 'max-items');
  if (maxItems === null) return null;
  if (maxItems !== undefined) output.maxItems = maxItems;
  const maxAgents = parseOptionalInt(opts.maxAgents, 'max-agents');
  if (maxAgents === null) return null;
  if (maxAgents !== undefined) output.maxAgents = maxAgents;
  if (opts.branchPrefix) output.branchPrefix = opts.branchPrefix;
  if (opts.baseBranch) output.baseBranch = opts.baseBranch;
  if (opts.dryRun) output.dryRun = true;
  output.fastMode = opts.fastMode ?? true;
  if (opts.modelCap) {
    if (opts.modelCap !== 'opus' && opts.modelCap !== 'sonnet' && opts.modelCap !== 'haiku') {
      console.error('Invalid model-cap: expected opus, sonnet, or haiku');
      process.exitCode = 1;
      return null;
    }
    output.modelCap = opts.modelCap;
  }
  if (opts.effortCap) {
    if (opts.effortCap !== 'low' && opts.effortCap !== 'medium' && opts.effortCap !== 'high' && opts.effortCap !== 'xhigh' && opts.effortCap !== 'max') {
      console.error('Invalid effort-cap: expected low, medium, high, xhigh, or max');
      process.exitCode = 1;
      return null;
    }
    output.effortCap = opts.effortCap;
  }
  return output;
}

function parseOptionalNumber(raw: string | undefined, label: string): number | null | undefined {
  if (raw === undefined) return undefined;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`Invalid ${label}: ${raw}`);
    process.exitCode = 1;
    return null;
  }
  return value;
}

function parseOptionalInt(raw: string | undefined, label: string): number | null | undefined {
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`Invalid ${label}: ${raw}`);
    process.exitCode = 1;
    return null;
  }
  return value;
}
