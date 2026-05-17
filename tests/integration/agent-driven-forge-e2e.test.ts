/**
 * E2E integration test for the agent-driven forge pipeline (Phase A–D).
 *
 * Mocks the AgentRuntime so no real API calls are made. Runs the full
 * forgeTeamAgentDriven() pipeline against a tmp copy of the
 * tests/fixtures/external-project-sample/ fixture and verifies every
 * output artifact produced by each phase.
 *
 * Constraints:
 *   - No real LLM calls — FixtureRuntime returns canned JSON responses.
 *   - Must complete in under 60 seconds wall-clock.
 *   - Does NOT modify the fixture directory (uses mkdtempSync copy).
 *   - Does NOT modify any pipeline source files.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  cpSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import yaml from 'js-yaml';

import { forgeTeamAgentDriven } from '../../packages/core/src/team/engine/builder/agent-driven-forge.js';
import { buildSourceCorpus } from '../../packages/core/src/team/engine/builder/source-corpus.js';
import { emitClaudeCodeTeamCommands } from '../../packages/core/src/team/engine/builder/cc-command-emitter.js';
import type { AgentRuntime } from '../../packages/core/src/agent-runtime/agent-runtime.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Canned responses — shaped to satisfy each Zod schema
// ---------------------------------------------------------------------------

const CANNED_SUBSYSTEMS = {
  subsystems: [
    {
      name: 'server',
      path: 'src',
      description: 'Fastify HTTP server entry point.',
      public_surface: ['server'],
      owner_hint: 'api-engineer',
    },
    {
      name: 'users-handler',
      path: 'src/handlers',
      description: 'User resource CRUD route handlers validated with Zod.',
      public_surface: ['usersRoutes'],
      owner_hint: 'api-engineer',
    },
  ],
};

const CANNED_DEPENDENCIES = {
  package_manager: 'npm',
  prod_deps: [
    { name: 'fastify', version: '^4.26.0', category: 'web-framework', in_use_proven: true },
    { name: 'zod', version: '^3.22.4', category: 'validation', in_use_proven: true },
  ],
  dev_deps: [
    { name: 'typescript', version: '^5.3.3', category: 'build', in_use_proven: true },
    { name: 'vitest', version: '^1.3.1', category: 'testing', in_use_proven: true },
  ],
  framework_signals: [
    { name: 'fastify', evidence_files: ['src/server.ts', 'src/handlers/users.ts'], confidence: 0.99 },
    { name: 'zod', evidence_files: ['src/handlers/users.ts'], confidence: 0.98 },
  ],
};

const CANNED_CONVENTIONS = {
  formatter: 'prettier',
  linter: 'eslint',
  linter_rules: ['no-console', '@typescript-eslint/recommended'],
  test_runner: 'vitest',
  test_pattern: ['**/*.test.ts'],
  file_layout: ['kebab-case'],
  import_style: 'ESM with .js extensions',
  error_handling_pattern: 'throw + Fastify reply.code()',
};

const CANNED_DOMAIN = {
  product_name: 'demo',
  one_liner: 'Tiny Fastify users API',
  user_personas: ['backend developers', 'API consumers'],
  core_primitives: ['User', 'Route', 'Handler'],
  domain_vocabulary: ['fastify', 'zod', 'route', 'plugin', 'schema', 'typescript', 'node'],
  non_goals: ['database persistence', 'authentication'],
};

const CANNED_HISTORY = {
  recurring_bug_patterns: [
    { pattern: 'Missing .js ESM extension on imports', count: 3, last_seen: '2026-05-01' },
  ],
  gate_rejection_themes: ['missing error handling'],
  cost_outliers: [],
  high_value_subsystems: ['src/handlers'],
};

// ---------------------------------------------------------------------------
// Synthesis response — a full TeamPlan with 13 agents including pr-merge-manager
// ---------------------------------------------------------------------------

function buildSynthesisTeamPlan() {
  const agents = [
    {
      id: 'architect',
      tier: 'opus',
      category: 'strategic',
      owns_subsystems: ['src'],
      capability_tags: ['architecture', 'typescript', 'fastify', 'design'],
      system_prompt: 'You are the architect for this Fastify TypeScript users API. Your domain covers the overall system design, Fastify plugin architecture, and TypeScript patterns. You work exclusively in Node.js and TypeScript.',
      auto_include_files: [],
      learnings_seed: ['Fastify plugins use async functions', 'Zod validates request/response schemas'],
    },
    {
      id: 'api-engineer',
      tier: 'sonnet',
      category: 'implementation',
      owns_subsystems: ['src/handlers'],
      capability_tags: ['fastify', 'rest-api', 'route-handler', 'typescript'],
      system_prompt: 'You are the API engineer for this Fastify users API. You own the route handlers in src/handlers/. You implement Fastify routes using Zod schemas for validation. Stack: Node.js + TypeScript + Fastify + Zod.',
      auto_include_files: [],
      learnings_seed: ['Fastify routes use typed generics for Params/Body/Query'],
    },
    {
      id: 'validation-engineer',
      tier: 'sonnet',
      category: 'implementation',
      owns_subsystems: ['src/handlers'],
      capability_tags: ['zod', 'validation', 'schema', 'typescript'],
      system_prompt: 'You are the validation engineer. You own Zod schema definitions and ensure all incoming/outgoing data is validated. Project uses Zod v3 with TypeScript strict mode.',
      auto_include_files: [],
      learnings_seed: ['z.infer<typeof Schema> extracts the TypeScript type'],
    },
    {
      id: 'test-engineer',
      tier: 'sonnet',
      category: 'quality',
      owns_subsystems: ['src'],
      capability_tags: ['vitest', 'testing', 'typescript', 'fastify-inject'],
      system_prompt: 'You are the test engineer. You write Vitest tests for Fastify routes using fastify.inject(). All test files use .test.ts extension.',
      auto_include_files: [],
      learnings_seed: ['Fastify inject() tests routes without starting a real HTTP server'],
    },
    {
      id: 'type-guardian',
      tier: 'haiku',
      category: 'quality',
      owns_subsystems: ['src'],
      capability_tags: ['typescript', 'types', 'strict-mode', 'inference'],
      system_prompt: 'You are the TypeScript type guardian. You enforce strict TypeScript, catch type errors, and ensure all Zod schemas have their inferred types extracted via z.infer<>.',
      auto_include_files: [],
      learnings_seed: ['noUncheckedIndexedAccess catches undefined index access'],
    },
    {
      id: 'security-auditor',
      tier: 'sonnet',
      category: 'quality',
      owns_subsystems: ['src'],
      capability_tags: ['security', 'audit', 'node', 'fastify'],
      system_prompt: 'You are the security auditor. You review Fastify routes for injection risks, missing input validation, and unsafe error responses. Node.js security best practices apply.',
      auto_include_files: [],
      learnings_seed: ['Fastify sends stack traces in error replies by default in dev mode'],
    },
    {
      id: 'devops-engineer',
      tier: 'haiku',
      category: 'utility',
      owns_subsystems: [],
      capability_tags: ['ci', 'build', 'typescript-compile', 'node'],
      system_prompt: 'You are the DevOps engineer. You own the build pipeline: tsc compilation, vitest test runs, and any CI workflows. Stack: Node.js + TypeScript.',
      auto_include_files: [],
      learnings_seed: ['tsc --noEmit validates types without producing output'],
    },
    {
      id: 'dependency-auditor',
      tier: 'haiku',
      category: 'utility',
      owns_subsystems: [],
      capability_tags: ['dependencies', 'npm', 'audit', 'fastify', 'zod'],
      system_prompt: 'You are the dependency auditor. You track fastify and zod versions, run npm audit, and flag CVEs. The project uses fastify ^4 and zod ^3.',
      auto_include_files: [],
      learnings_seed: ['fastify ^4 requires Node.js >= 14.6.0'],
    },
    {
      id: 'pr-merge-manager',
      tier: 'sonnet',
      category: 'utility',
      owns_subsystems: [],
      capability_tags: ['git', 'merge', 'rebase', 'pr-queue', 'conflict-resolution'],
      system_prompt: 'You are the PR merge manager for this Fastify TypeScript users API. You own the PR queue, rebase branches onto main, squash fixup commits, and resolve trivial merge conflicts. Never force-push to main.',
      auto_include_files: [],
      learnings_seed: [],
    },
    {
      id: 'documentation-writer',
      tier: 'haiku',
      category: 'utility',
      owns_subsystems: [],
      capability_tags: ['documentation', 'readme', 'openapi', 'typescript'],
      system_prompt: 'You are the documentation writer. You maintain the README, generate OpenAPI specs from Fastify route schemas, and document TypeScript interfaces.',
      auto_include_files: [],
      learnings_seed: ['Fastify has built-in Swagger/OpenAPI support via @fastify/swagger'],
    },
    {
      id: 'performance-engineer',
      tier: 'sonnet',
      category: 'implementation',
      owns_subsystems: ['src'],
      capability_tags: ['performance', 'fastify', 'node', 'profiling'],
      system_prompt: 'You are the performance engineer. You profile Fastify route throughput, optimize middleware chains, and ensure the in-memory user store access patterns are efficient.',
      auto_include_files: [],
      learnings_seed: ['Fastify benchmarks at ~76k req/sec on simple routes'],
    },
    {
      id: 'error-handler',
      tier: 'haiku',
      category: 'implementation',
      owns_subsystems: ['src'],
      capability_tags: ['error-handling', 'fastify', 'http-errors', 'typescript'],
      system_prompt: 'You are the error handling specialist. You own Fastify error handlers, ensure 4xx/5xx responses are properly typed, and prevent stack traces from leaking in production.',
      auto_include_files: [],
      learnings_seed: ['Fastify setErrorHandler() intercepts all unhandled errors'],
    },
    {
      id: 'schema-registry',
      tier: 'haiku',
      category: 'utility',
      owns_subsystems: ['src/handlers'],
      capability_tags: ['zod', 'schema', 'registry', 'typescript', 'validation'],
      system_prompt: 'You are the schema registry agent. You centralise all Zod schemas, ensure no schema is defined twice, and export a single registry object consumed by all route handlers.',
      auto_include_files: [],
      learnings_seed: ['Centralising Zod schemas prevents drift between route and model definitions'],
    },
  ];

  return {
    team_name: 'demo-fastify-team',
    agents,
  };
}

// ---------------------------------------------------------------------------
// FixtureRuntime — mock AgentRuntime with canned responses
// ---------------------------------------------------------------------------

/**
 * Detects whether a `.run({ task })` call is for recon or synthesis.
 *
 * Synthesis: the task string includes "## Recon Results" (built by
 * buildUserMessage() in synthesis.ts).
 *
 * Recon agents: the task is a JSON-stringified inputs object — it DOES NOT
 * contain "## Recon Results".
 *
 * Within recon, we detect which agent by checking the `context` (system prompt)
 * passed via `opts.context` in the adapter. We can also distinguish by the
 * task content: code-archaeologist has "projectRoot", dep-graph-analyst has
 * "sourceCorpus" with the file list, etc.
 */
function detectReconAgentFromContext(context: string | undefined): string {
  if (!context) return 'code-archaeologist';
  const lower = context.toLowerCase();
  if (lower.includes('code-archaeologist') || lower.includes('archaeologist')) return 'code-archaeologist';
  if (lower.includes('dep-graph') || lower.includes('dependency') || lower.includes('dependencies')) return 'dep-graph-analyst';
  if (lower.includes('convention') || lower.includes('linter') || lower.includes('formatter')) return 'convention-detective';
  if (lower.includes('domain') || lower.includes('product') || lower.includes('persona')) return 'domain-mapper';
  if (lower.includes('failure') || lower.includes('historian') || lower.includes('bug pattern')) return 'failure-historian';
  return 'code-archaeologist';
}

const RECON_RESPONSES: Record<string, unknown> = {
  'code-archaeologist': CANNED_SUBSYSTEMS,
  'dep-graph-analyst': CANNED_DEPENDENCIES,
  'convention-detective': CANNED_CONVENTIONS,
  'domain-mapper': CANNED_DOMAIN,
  'failure-historian': CANNED_HISTORY,
};

class FixtureRuntime {
  public calls: Array<{ task: string; context?: string }> = [];

  async run(opts: { task: string; context?: string }): Promise<{
    sessionId: string;
    response: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    startedAt: string;
    completedAt: string;
    status: 'completed';
  }> {
    this.calls.push({ task: opts.task, context: opts.context });

    const isSynthesis = opts.task.includes('## Recon Results');

    let responsePayload: unknown;
    if (isSynthesis) {
      responsePayload = buildSynthesisTeamPlan();
    } else {
      // Recon call — detect which agent via the system prompt (context)
      const agentId = detectReconAgentFromContext(opts.context);
      responsePayload = RECON_RESPONSES[agentId] ?? RECON_RESPONSES['code-archaeologist'];
    }

    const responseJson = JSON.stringify(responsePayload, null, 2);
    const response = `\`\`\`json\n${responseJson}\n\`\`\``;

    return {
      sessionId: `fixture-session-${Date.now()}`,
      response,
      model: 'claude-sonnet-4-6',
      inputTokens: 100,
      outputTokens: 200,
      costUsd: 0.001,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: 'completed',
    };
  }
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// Run the entire forge pipeline once in beforeAll; all tests read artifacts.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, '../fixtures/external-project-sample');

let tmpDir: string;
let suiteStartMs: number;

beforeAll(async () => {
  suiteStartMs = Date.now();

  // Copy fixture to a fresh tmp dir so the test can mutate freely
  tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-e2e-adf-'));
  cpSync(FIXTURE_DIR, tmpDir, { recursive: true });

  // Ensure .claude dir exists (needed for CC agent/command emitters)
  mkdirSync(join(tmpDir, '.claude'), { recursive: true });
  writeFileSync(join(tmpDir, '.claude', '.gitkeep'), '');

  // git init so git-related tools don't fail
  try {
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.email', 'test@agentforge.test'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.name', 'AgentForge E2E Test'], { cwd: tmpDir });
    await execFileAsync('git', ['add', '-A'], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-m', 'Initial commit'], { cwd: tmpDir });
  } catch {
    // Non-fatal — git operations may fail in restricted CI environments
  }

  // ── Run the full agent-driven forge pipeline (Phases A–D) ──────────────────
  const runtime = new FixtureRuntime();
  const corpusResult = await buildSourceCorpus({ projectRoot: tmpDir });
  const forgeResult = await forgeTeamAgentDriven({
    projectRoot: tmpDir,
    runtime: runtime as unknown as AgentRuntime,
    sourceCorpus: corpusResult.files,
  });

  // ── Emit slash commands (.claude/commands/team-*.md) ───────────────────────
  // forgeTeamAgentDriven doesn't call the command emitter — callers do.
  await emitClaudeCodeTeamCommands({
    projectRoot: tmpDir,
    agents: forgeResult.teamPlan.agents.map((a) => ({
      id: a.id,
      description: a.capability_tags.slice(0, 5).join(', '),
    })),
  });
}, 45_000);

afterAll(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Suite 1 — Phase A: Recon agent JSON persistence
// ---------------------------------------------------------------------------

describe('Phase A — recon artifact persistence', () => {
  const RECON_AGENT_IDS = [
    'code-archaeologist',
    'dep-graph-analyst',
    'convention-detective',
    'domain-mapper',
    'failure-historian',
  ] as const;

  it('writes all 5 recon JSONs under .agentforge/forge/recon/', () => {
    const reconDir = join(tmpDir, '.agentforge', 'forge', 'recon');
    expect(existsSync(reconDir)).toBe(true);

    for (const agentId of RECON_AGENT_IDS) {
      const filePath = join(reconDir, `${agentId}.json`);
      expect(existsSync(filePath), `Missing recon file for ${agentId}`).toBe(true);
    }
  });

  it('each recon JSON has status=validated and a non-null parsed field', async () => {
    const reconDir = join(tmpDir, '.agentforge', 'forge', 'recon');
    for (const agentId of RECON_AGENT_IDS) {
      const filePath = join(reconDir, `${agentId}.json`);
      if (!existsSync(filePath)) continue; // previous test would have caught this
      const content = JSON.parse(readFileSync(filePath, 'utf8'));
      expect(content.status, `${agentId} status`).toBe('validated');
      expect(content.parsed, `${agentId} parsed`).not.toBeNull();
      expect(content.schema_version, `${agentId} schema_version`).toBe(1);
    }
  });

  it('domain-mapper recon JSON has correct product_name and one_liner', () => {
    const filePath = join(tmpDir, '.agentforge', 'forge', 'recon', 'domain-mapper.json');
    const content = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(content.parsed.product_name).toBe('demo');
    expect(content.parsed.one_liner).toBe('Tiny Fastify users API');
  });

  it('dep-graph-analyst recon JSON lists fastify and zod as prod deps', () => {
    const filePath = join(tmpDir, '.agentforge', 'forge', 'recon', 'dep-graph-analyst.json');
    const content = JSON.parse(readFileSync(filePath, 'utf8'));
    const depNames = content.parsed.prod_deps.map((d: { name: string }) => d.name);
    expect(depNames).toContain('fastify');
    expect(depNames).toContain('zod');
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Phase B: Synthesis output artifacts
// ---------------------------------------------------------------------------

describe('Phase B — synthesis output artifacts', () => {
  it('writes team-plan.json under .agentforge/forge/', () => {
    const filePath = join(tmpDir, '.agentforge', 'forge', 'team-plan.json');
    expect(existsSync(filePath)).toBe(true);
    const plan = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(plan.team_name).toBe('demo-fastify-team');
    expect(Array.isArray(plan.agents)).toBe(true);
  });

  it('team-plan.json contains 12 or more agents', () => {
    const filePath = join(tmpDir, '.agentforge', 'forge', 'team-plan.json');
    const plan = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(plan.agents.length).toBeGreaterThanOrEqual(12);
  });

  it('team-plan.json includes pr-merge-manager', () => {
    const filePath = join(tmpDir, '.agentforge', 'forge', 'team-plan.json');
    const plan = JSON.parse(readFileSync(filePath, 'utf8'));
    const ids = plan.agents.map((a: { id: string }) => a.id);
    expect(ids).toContain('pr-merge-manager');
  });

  it('all agent IDs in team-plan.json are kebab-case', () => {
    const filePath = join(tmpDir, '.agentforge', 'forge', 'team-plan.json');
    const plan = JSON.parse(readFileSync(filePath, 'utf8'));
    const kebabRe = /^[a-z0-9-]+$/;
    for (const agent of plan.agents as Array<{ id: string }>) {
      expect(agent.id, `${agent.id} is not kebab-case`).toMatch(kebabRe);
    }
  });

  it('writes 12+ per-agent YAML files under .agentforge/agents/', () => {
    const agentsDir = join(tmpDir, '.agentforge', 'agents');
    expect(existsSync(agentsDir)).toBe(true);
    const yamlFiles = readdirSync(agentsDir).filter((f) => f.endsWith('.yaml'));
    expect(yamlFiles.length).toBeGreaterThanOrEqual(12);
  });

  it('each agent YAML is valid YAML with a name field', () => {
    const agentsDir = join(tmpDir, '.agentforge', 'agents');
    const yamlFiles = readdirSync(agentsDir).filter((f) => f.endsWith('.yaml'));
    for (const file of yamlFiles) {
      const raw = readFileSync(join(agentsDir, file), 'utf8');
      const parsed = yaml.load(raw) as Record<string, unknown>;
      expect(typeof parsed['name'], `${file} name field`).toBe('string');
    }
  });

  it('writes 12+ CC agent .md files under .claude/agents/', () => {
    const claudeAgentsDir = join(tmpDir, '.claude', 'agents');
    expect(existsSync(claudeAgentsDir)).toBe(true);
    const mdFiles = readdirSync(claudeAgentsDir).filter((f) => f.endsWith('.md'));
    expect(mdFiles.length).toBeGreaterThanOrEqual(12);
  });

  it('each CC agent .md has valid YAML frontmatter with name and description', () => {
    const claudeAgentsDir = join(tmpDir, '.claude', 'agents');
    const mdFiles = readdirSync(claudeAgentsDir).filter((f) => f.endsWith('.md'));
    for (const file of mdFiles) {
      const raw = readFileSync(join(claudeAgentsDir, file), 'utf8');
      // Extract YAML frontmatter between --- delimiters
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
      expect(fmMatch, `${file} missing frontmatter`).not.toBeNull();
      const fm = yaml.load(fmMatch![1]) as Record<string, unknown>;
      expect(typeof fm['name'], `${file} name`).toBe('string');
      expect(typeof fm['description'], `${file} description`).toBe('string');
    }
  });

  it('writes team.yaml under .agentforge/', () => {
    const teamYamlPath = join(tmpDir, '.agentforge', 'team.yaml');
    expect(existsSync(teamYamlPath)).toBe(true);
    const parsed = yaml.load(readFileSync(teamYamlPath, 'utf8')) as Record<string, unknown>;
    expect(typeof parsed['name']).toBe('string');
    expect(typeof parsed['forged_at']).toBe('string');
    expect(parsed['forged_by']).toBe('agentforge-synthesis');
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — Phase C: Validation report
// ---------------------------------------------------------------------------

describe('Phase C — validation report', () => {
  it('writes validation-report.json under .agentforge/forge/', () => {
    const filePath = join(tmpDir, '.agentforge', 'forge', 'validation-report.json');
    expect(existsSync(filePath)).toBe(true);
  });

  it('validation-report.json has valid=true (no ERRORs from canned agents)', () => {
    const filePath = join(tmpDir, '.agentforge', 'forge', 'validation-report.json');
    const report = JSON.parse(readFileSync(filePath, 'utf8'));
    // Canned agents have no auto_include_files or path refs in prompts → no ERRORs
    expect(report.valid).toBe(true);
  });

  it('validation-report.json has agentsChecked >= 12', () => {
    const filePath = join(tmpDir, '.agentforge', 'forge', 'validation-report.json');
    const report = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(report.agentsChecked).toBeGreaterThanOrEqual(12);
  });

  it('validation-report.json has a generatedAt ISO timestamp', () => {
    const filePath = join(tmpDir, '.agentforge', 'forge', 'validation-report.json');
    const report = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(() => new Date(report.generatedAt)).not.toThrow();
    expect(new Date(report.generatedAt).getFullYear()).toBeGreaterThan(2024);
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — Phase D: Routing index
// ---------------------------------------------------------------------------

describe('Phase D — routing index', () => {
  it('writes routing-index.json under .agentforge/', () => {
    const filePath = join(tmpDir, '.agentforge', 'routing-index.json');
    expect(existsSync(filePath)).toBe(true);
  });

  it('routing-index.json has agents array with 12+ entries', () => {
    const filePath = join(tmpDir, '.agentforge', 'routing-index.json');
    const index = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(Array.isArray(index.agents)).toBe(true);
    expect(index.agents.length).toBeGreaterThanOrEqual(12);
  });

  it('routing-index.json includes pr-merge-manager', () => {
    const filePath = join(tmpDir, '.agentforge', 'routing-index.json');
    const index = JSON.parse(readFileSync(filePath, 'utf8'));
    const ids = index.agents.map((a: { id: string }) => a.id);
    expect(ids).toContain('pr-merge-manager');
  });

  it('routing-index.json has a team_name and generated_at', () => {
    const filePath = join(tmpDir, '.agentforge', 'routing-index.json');
    const index = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(typeof index.team_name).toBe('string');
    expect(typeof index.generated_at).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — Slash commands
// ---------------------------------------------------------------------------

describe('Slash commands — .claude/commands/team-*.md', () => {
  it('writes 12+ team-*.md command files under .claude/commands/', () => {
    const commandsDir = join(tmpDir, '.claude', 'commands');
    expect(existsSync(commandsDir)).toBe(true);
    const teamCommands = readdirSync(commandsDir).filter((f) => f.startsWith('team-') && f.endsWith('.md'));
    expect(teamCommands.length).toBeGreaterThanOrEqual(12);
  });

  it('each team command file is non-empty', () => {
    const commandsDir = join(tmpDir, '.claude', 'commands');
    const teamCommands = readdirSync(commandsDir).filter((f) => f.startsWith('team-') && f.endsWith('.md'));
    for (const file of teamCommands) {
      const content = readFileSync(join(commandsDir, file), 'utf8');
      expect(content.length, `${file} should be non-empty`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — Content quality: no Python/Ruby/Rails/Django refs in agent prompts
// ---------------------------------------------------------------------------

describe('Content quality — framework specificity', () => {
  const FORBIDDEN_FRAMEWORKS = ['django', 'fastapi', 'flask', 'rails', 'laravel', 'spring boot'];

  it('no agent system_prompt mentions Python-only or Rails frameworks', () => {
    const filePath = join(tmpDir, '.agentforge', 'forge', 'team-plan.json');
    const plan = JSON.parse(readFileSync(filePath, 'utf8'));
    for (const agent of plan.agents as Array<{ id: string; system_prompt: string }>) {
      const lower = (agent.system_prompt ?? '').toLowerCase();
      for (const fw of FORBIDDEN_FRAMEWORKS) {
        expect(lower, `Agent ${agent.id} mentions "${fw}"`).not.toContain(fw);
      }
    }
  });

  it('no CC agent .md file mentions Python-only or Rails frameworks', () => {
    const claudeAgentsDir = join(tmpDir, '.claude', 'agents');
    const mdFiles = readdirSync(claudeAgentsDir).filter((f) => f.endsWith('.md'));
    for (const file of mdFiles) {
      const lower = readFileSync(join(claudeAgentsDir, file), 'utf8').toLowerCase();
      for (const fw of FORBIDDEN_FRAMEWORKS) {
        expect(lower, `${file} mentions "${fw}"`).not.toContain(fw);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 7 — Team composition correctness
// ---------------------------------------------------------------------------

describe('Team composition', () => {
  it('pr-merge-manager is present in team.yaml agents', () => {
    const teamYamlPath = join(tmpDir, '.agentforge', 'team.yaml');
    const raw = readFileSync(teamYamlPath, 'utf8');
    // pr-merge-manager should appear somewhere in the YAML (in one of the buckets)
    expect(raw).toContain('pr-merge-manager');
  });

  it('team-plan.json return value contains pr-merge-manager (verifies pipeline return)', () => {
    // The team-plan.json is written by synthesizeTeam from the return value of
    // forgeTeamAgentDriven — so checking it here is equivalent to checking the return value.
    const filePath = join(tmpDir, '.agentforge', 'forge', 'team-plan.json');
    const plan = JSON.parse(readFileSync(filePath, 'utf8'));
    const ids = plan.agents.map((a: { id: string }) => a.id);
    expect(ids).toContain('pr-merge-manager');
  });

  it('validation report valid: true (return value of forgeTeamAgentDriven.validation)', () => {
    const filePath = join(tmpDir, '.agentforge', 'forge', 'validation-report.json');
    const report = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(report.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 8 — Wall-clock budget
// ---------------------------------------------------------------------------

describe('wall-clock budget', () => {
  it('entire test suite (setup + all pipelines) completes in under 60 seconds', () => {
    const totalMs = Date.now() - suiteStartMs;
    // eslint-disable-next-line no-console
    console.log(`[e2e] agent-driven-forge total wall-clock: ${totalMs}ms`);
    expect(totalMs).toBeLessThan(60_000);
  });
});
