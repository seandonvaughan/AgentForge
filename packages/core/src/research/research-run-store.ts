import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { writeFileAtomic } from '../team/engine/fs/atomic-write.js';
import type {
  ResearchEvent,
  ResearchIdea,
  ResearchIdeaStatus,
  ResearchPlannedCycle,
  ResearchRisk,
  ResearchRun,
  ResearchRunMode,
} from './types.js';

const SAFE_ID = /^[A-Za-z0-9_-]{8,80}$/;
const DEFAULT_PROMPT = 'Find the next highest-leverage AgentForge product improvements.';

export interface CreateResearchRunInput {
  projectRoot: string;
  prompt?: string;
  mode?: ResearchRunMode;
  maxIdeas?: number;
  tags?: string[];
  sourceCycleId?: string;
}

export interface PlanResearchRunInput {
  projectRoot: string;
  runId: string;
  budgetUsd?: number;
  maxItems?: number;
  maxAgents?: number;
  branchPrefix?: string;
  baseBranch?: string;
  dryRun?: boolean;
  fastMode?: boolean;
  modelCap?: 'opus' | 'sonnet' | 'haiku';
  effortCap?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  fallbackEnabled?: boolean;
}

export function researchRunsDir(projectRoot: string): string {
  return resolve(projectRoot, '.agentforge', 'research-runs');
}

export async function createResearchRun(input: CreateResearchRunInput): Promise<ResearchRun> {
  const projectRoot = resolve(input.projectRoot);
  const now = new Date().toISOString();
  const runId = `rd-${randomUUID()}`;
  const prompt = normalizePrompt(input.prompt);
  const maxIdeas = normalizeMaxIdeas(input.maxIdeas);
  const ideas = generateBootstrapIdeas(prompt, maxIdeas, now);
  const run: ResearchRun = {
    runId,
    projectRoot,
    prompt,
    mode: input.mode ?? 'operator-seeded',
    status: 'ideas-ready',
    tags: normalizeTags(input.tags),
    createdAt: now,
    updatedAt: now,
    ...(input.sourceCycleId ? { sourceCycleId: input.sourceCycleId } : {}),
    ideas,
  };

  await persistResearchRun(run);
  appendResearchEvent(projectRoot, runId, { type: 'research.created', at: now, runId, data: { mode: run.mode } });
  appendResearchEvent(projectRoot, runId, { type: 'research.ideas.ready', at: now, runId, data: { count: ideas.length } });
  return run;
}

export function listResearchRuns(projectRoot: string, limit = 50): ResearchRun[] {
  const dir = researchRunsDir(projectRoot);
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name))
    .map((entry) => readResearchRun(projectRoot, entry.name))
    .filter((run): run is ResearchRun => run !== null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, Math.max(1, Math.min(200, limit)));
}

export function readResearchRun(projectRoot: string, runId: string): ResearchRun | null {
  if (!SAFE_ID.test(runId)) return null;
  const file = join(researchRunsDir(projectRoot), runId, 'run.json');
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as ResearchRun;
    return parsed.runId === runId && Array.isArray(parsed.ideas) ? parsed : null;
  } catch {
    return null;
  }
}

export async function updateResearchIdeaStatus(input: {
  projectRoot: string;
  runId: string;
  ideaId: string;
  status: Extract<ResearchIdeaStatus, 'approved' | 'rejected'>;
  note?: string;
}): Promise<ResearchRun> {
  const run = requireResearchRun(input.projectRoot, input.runId);
  const now = new Date().toISOString();
  let found = false;
  const ideas = run.ideas.map((idea) => {
    if (idea.ideaId !== input.ideaId) return idea;
    found = true;
    return {
      ...idea,
      status: input.status,
      updatedAt: now,
      ...(input.note ? { approvalNote: input.note } : {}),
    };
  });
  if (!found) throw new Error(`Research idea not found: ${input.ideaId}`);

  const updated: ResearchRun = { ...run, ideas, updatedAt: now };
  await persistResearchRun(updated);
  appendResearchEvent(input.projectRoot, input.runId, {
    type: `research.idea.${input.status}`,
    at: now,
    runId: input.runId,
    ideaId: input.ideaId,
    ...(input.note ? { data: { note: input.note } } : {}),
  });
  return updated;
}

export async function planApprovedResearchIdeas(input: PlanResearchRunInput): Promise<ResearchRun> {
  const run = requireResearchRun(input.projectRoot, input.runId);
  const approved = run.ideas.filter((idea) => idea.status === 'approved' || idea.status === 'planned');
  if (approved.length === 0) {
    throw new Error('No approved research ideas are ready to plan');
  }

  const now = new Date().toISOString();
  const plannedIdeaIds = new Set(approved.map((idea) => idea.ideaId));
  const planned = buildPlannedCycle(run, approved, now, input);
  const updated: ResearchRun = {
    ...run,
    status: 'planned',
    updatedAt: now,
    plannedCycle: planned,
    ideas: run.ideas.map((idea) => plannedIdeaIds.has(idea.ideaId)
      ? { ...idea, status: 'planned', updatedAt: now }
      : idea),
  };

  await persistResearchRun(updated);
  appendResearchEvent(input.projectRoot, input.runId, {
    type: 'research.plan.created',
    at: now,
    runId: input.runId,
    data: { ideaIds: planned.ideaIds, cycleRequest: planned.cycleRequest },
  });
  return updated;
}

function requireResearchRun(projectRoot: string, runId: string): ResearchRun {
  const run = readResearchRun(projectRoot, runId);
  if (!run) throw new Error(`Research run not found: ${runId}`);
  return run;
}

async function persistResearchRun(run: ResearchRun): Promise<void> {
  const runDir = join(researchRunsDir(run.projectRoot), run.runId);
  const ideasDir = join(runDir, 'ideas');
  mkdirSync(ideasDir, { recursive: true });
  await writeFileAtomic(join(runDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  for (const idea of run.ideas) {
    await writeFileAtomic(join(ideasDir, `${idea.ideaId}.json`), `${JSON.stringify(idea, null, 2)}\n`);
  }
  if (run.plannedCycle) {
    await writeFileAtomic(join(runDir, 'planned-cycle.json'), `${JSON.stringify(run.plannedCycle, null, 2)}\n`);
  }
}

function appendResearchEvent(projectRoot: string, runId: string, event: ResearchEvent): void {
  const runDir = join(researchRunsDir(projectRoot), runId);
  mkdirSync(runDir, { recursive: true });
  appendFileSync(join(runDir, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf-8');
}

function normalizePrompt(value: string | undefined): string {
  const prompt = value?.trim();
  return prompt && prompt.length > 0 ? prompt.slice(0, 2000) : DEFAULT_PROMPT;
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return ['rd'];
  const normalized = tags.map((tag) => tag.trim()).filter(Boolean);
  return Array.from(new Set(['rd', ...normalized])).slice(0, 16);
}

function normalizeMaxIdeas(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined) return 3;
  return Math.max(1, Math.min(6, value));
}

function generateBootstrapIdeas(prompt: string, maxIdeas: number, now: string): ResearchIdea[] {
  const seeds: Array<Omit<ResearchIdea, 'ideaId' | 'createdAt' | 'updatedAt' | 'status'>> = [
    {
      title: 'Stabilize autonomous cycle completion telemetry',
      problem: 'Cycles can look active after subprocess exit, which weakens operator trust and follow-on automation.',
      hypothesis: 'A single launch contract with terminal events, visible logs, and replayable launch config will raise successful cycle completion rate.',
      expectedImpact: 'Higher cycle reliability and clearer evidence for the next self-improvement wave.',
      risk: 'medium',
      suggestedAgents: ['executor-runtime-engineer', 'fastify-v5-engineer', 'test-engineer'],
      touchedAreas: ['packages/server/src/routes/v5', 'packages/core/src/runtime', '.agentforge/cycles'],
      acceptanceChecks: [
        'cycle launch, resume, cancel, and rerun all persist terminal state',
        'no Windows subprocess console opens during launch',
        'three Codex-backed cycles complete consecutively',
      ],
    },
    {
      title: 'Turn R&D ideas into selectable Launch plans',
      problem: 'Launch currently starts cycles, but it does not let the team research, present, approve, and convert ideas in one workflow.',
      hypothesis: 'First-class idea artifacts and approval actions will make AgentForge usable for product discovery before implementation cycles.',
      expectedImpact: 'Operators can approve individual ideas and convert only selected work into planned cycles.',
      risk: 'low',
      suggestedAgents: ['researcher', 'svelte-cycles-engineer', 'fastify-v5-engineer'],
      touchedAreas: ['packages/core/src/research', 'packages/server/src/routes/v5', 'packages/dashboard/src/routes/cycles/new'],
      acceptanceChecks: [
        'R&D run creates durable idea JSON artifacts',
        'UI can approve or reject each idea independently',
        'approved ideas produce a cycle request without manual copy/paste',
      ],
    },
    {
      title: 'Make agent learning portable across Codex and Claude hosts',
      problem: 'Codex and Claude paths still have separate host surfaces, which can fragment team memory and capability profiles.',
      hypothesis: 'Provider-neutral team and memory records with generated host adapters will let the same team improve in both hosts.',
      expectedImpact: 'The forged team can move between AgentForge Codex and local Claude Code without losing experience.',
      risk: 'high',
      suggestedAgents: ['forge-engine-architect', 'memory-curator', 'plugin-sdk-engineer'],
      touchedAreas: ['packages/core/src/team', 'plugins/agentforge-codex', '.claude/agents'],
      acceptanceChecks: [
        'same team spec emits Codex and Claude host adapters',
        'memory writes are keyed by agent identity, not host',
        'Claude Code compatibility smoke passes after Codex cycles are stable',
      ],
    },
    {
      title: 'Add readiness gates before every high-cost agent invoke',
      problem: 'A bad login, missing build output, or unsupported profile can waste a cycle before useful work starts.',
      hypothesis: 'Preflight checks tied to Launch and CLI execution will fail early with actionable remediation.',
      expectedImpact: 'Lower failed-run rate and fewer half-started cycles.',
      risk: 'medium',
      suggestedAgents: ['cli-engineer', 'executor-runtime-engineer', 'backend-qa'],
      touchedAreas: ['packages/cli/src/commands', 'packages/core/src/runtime', 'packages/dashboard/src/lib/components'],
      acceptanceChecks: [
        'CLI readiness reports exact failing check',
        'Launch disables high-cost run when hard readiness checks fail',
        'mocked readiness failures have focused tests',
      ],
    },
  ];

  return seeds.slice(0, maxIdeas).map((seed, index) => ({
    ...seed,
    ideaId: `idea-${String(index + 1).padStart(2, '0')}`,
    title: prompt.toLowerCase() === DEFAULT_PROMPT.toLowerCase() ? seed.title : `${seed.title}`,
    status: 'proposed',
    createdAt: now,
    updatedAt: now,
  }));
}

function buildPlannedCycle(
  run: ResearchRun,
  ideas: ResearchIdea[],
  plannedAt: string,
  input: PlanResearchRunInput,
): ResearchPlannedCycle {
  const title = ideas.length === 1 ? ideas[0]!.title : `${ideas.length} approved R&D ideas`;
  const tags = Array.from(new Set([...run.tags, 'rd-approved', ...ideas.flatMap((idea) => idea.touchedAreas.map(toTag))]))
    .filter(Boolean)
    .slice(0, 20);
  const acceptance = ideas.flatMap((idea) => idea.acceptanceChecks.map((check) => `- ${check}`)).join('\n');
  const comment = [
    `R&D run ${run.runId}: ${title}`,
    '',
    `Prompt: ${run.prompt}`,
    '',
    'Approved ideas:',
    ...ideas.map((idea) => `- ${idea.ideaId}: ${idea.title}`),
    '',
    'Acceptance checks:',
    acceptance,
  ].join('\n');
  const fastMode = input.fastMode ?? true;
  const effortCap = input.effortCap ?? (fastMode ? 'high' : undefined);

  return {
    plannedAt,
    ideaIds: ideas.map((idea) => idea.ideaId),
    title,
    comment,
    cycleRequest: {
      budgetUsd: normalizePositiveNumber(input.budgetUsd, 25),
      maxItems: normalizePositiveInteger(input.maxItems, Math.max(1, Math.min(ideas.length, 3))),
      maxAgents: normalizePositiveInteger(input.maxAgents, 5),
      dryRun: input.dryRun ?? false,
      branchPrefix: normalizeBranchPrefix(input.branchPrefix),
      baseBranch: normalizeBaseBranch(input.baseBranch),
      fastMode,
      ...(input.modelCap ? { modelCap: input.modelCap } : {}),
      ...(effortCap ? { effortCap } : {}),
      fallbackEnabled: input.fallbackEnabled ?? true,
      tags,
      comment,
    },
  };
}

function normalizePositiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

function normalizeBranchPrefix(value: string | undefined): string {
  const prefix = value?.trim();
  return prefix && prefix.length > 0 ? prefix : 'codex/';
}

function normalizeBaseBranch(value: string | undefined): string {
  const branch = value?.trim();
  return branch && branch.length > 0 ? branch : 'codex/codex-version';
}

function toTag(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}
